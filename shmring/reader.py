"""Multi-reader side of the ring."""

from __future__ import annotations

import threading
from typing import Callable, NamedTuple

from . import _protocol as P
from ._platform import Segment
from .errors import ShmRingError


class Frame(NamedTuple):
    frame_id: int
    stamp: int
    payload: bytes
    meta: bytes
    seq: int


class Batch(NamedTuple):
    frames: list[Frame]
    dropped: int
    newest: int


class _Subscription:
    """In-process poll that delivers the newest frame. stop() ends it."""

    def __init__(self, reader, callback: Callable, interval_s: float):
        self._reader = reader
        self._callback = callback
        self._interval_s = interval_s
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="shmring-subscribe", daemon=True)
        self.error: BaseException | None = None

    def start(self) -> None:
        self._thread.start()

    def _run(self) -> None:
        last = None
        while not self._stop.is_set():
            try:
                frame = self._reader.read()
            except Exception as exc:
                self.error = exc
                self._stop.set()
                return
            if frame is not None and frame.frame_id != last:
                last = frame.frame_id
                try:
                    self._callback(frame)
                except Exception as exc:
                    self.error = exc
                    self._stop.set()
                    return
            self._stop.wait(self._interval_s)

    def stop(self) -> None:
        self._stop.set()
        if threading.current_thread() is not self._thread and self._thread.is_alive():
            self._thread.join(timeout=2)


class ShmRingReader:
    """Attach to an existing segment and read frames.

    A reader keeps its own ``last_frame_id`` cursor. ``read_batch()`` advances
    it; ``read()`` does not. Multiple readers may attach to the same segment.
    """

    def __init__(self, name: str, retries: int = 8):
        self._seg = Segment(name, create=False)
        self._retries = retries
        self._last = -1
        self._subs: list[_Subscription] = []
        self._closed = False
        try:
            # 写者可能还没写完全局头，magic 校验会抛错；此时要关掉映射，
            # 否则 attach 重试会泄漏句柄 / memoryview 导出。
            self._layout = P.unpack_global(self._seg.buf)
        except Exception:
            self._seg.close()
            raise

    @property
    def info(self):
        return dict(self._layout, name=self._seg.name, protocol_version=P.VERSION)

    @property
    def last_frame_id(self) -> int:
        return self._last

    def _read_slot(self, fid: int, g: dict) -> Frame | None:
        L = g
        base = P.HEADER_SIZE + (fid % L["slot_count"]) * L["slot_size"]
        s = P.unpack_slot(self._seg.buf, base)
        if s["frame_id"] != fid:
            return None  # slot already overwritten by a newer frame
        length, meta_len = s["length"], s["meta_len"]
        if not (0 <= length <= L["payload_capacity"]):
            return None
        if not (0 <= meta_len <= L["meta_capacity"]):
            return None
        po = L["payload_offset"]
        buf = self._seg.buf
        # Copy out: the mapping may be overwritten by the next publish().
        payload = bytes(buf[base + po: base + po + length])
        meta = (
            bytes(buf[base + P.SLOT_HEADER_SIZE: base + P.SLOT_HEADER_SIZE + meta_len])
            if meta_len else b""
        )
        return Frame(fid, s["stamp"], payload, meta, int(L["seq"]))

    def read(self) -> Frame | None:
        """Read the newest complete frame, or None if empty / all attempts tore."""
        for _ in range(self._retries):
            g = P.unpack_global(self._seg.buf)
            if g["seq"] & 1 or g["frame_id"] < 0:
                continue
            fid = g["frame_id"]
            frame = self._read_slot(fid, g)
            if frame is None:
                continue
            g2 = P.unpack_global(self._seg.buf)
            if g2["seq"] != g["seq"] or g2["frame_id"] != fid:
                continue
            return frame
        return None

    def subscribe(self, callback: Callable, interval_ms: float = 2.0) -> _Subscription:
        """Call ``callback(frame)`` in this process when a newer frame is published.

        Polls every ``interval_ms`` (default 2) and passes a copy of the newest
        frame. ``read_batch()`` keeps its own cursor. ``stop()`` ends the loop.
        """
        if interval_ms < 0:
            raise ValueError("interval_ms must be >= 0")
        if self._closed:
            raise ShmRingError("reader is closed")
        sub = _Subscription(self, callback, interval_ms / 1000.0)
        self._subs.append(sub)
        sub.start()
        return sub

    def read_batch(self, since: int | None = None) -> Batch:
        """Read every frame newer than ``since`` that is still in the ring.

        Returns ``dropped`` = how many frames the reader missed (overwritten).
        The whole batch is discarded if the seqlock changed mid-read.
        """
        cursor = self._last if since is None else since
        g = P.unpack_global(self._seg.buf)
        if g["seq"] & 1 or g["frame_id"] < 0:
            return Batch([], 0, g["frame_id"])
        newest = g["frame_id"]
        first = max(cursor + 1, newest - g["slot_count"] + 1)
        frames = []
        for fid in range(first, newest + 1):
            frame = self._read_slot(fid, g)
            if frame is not None:
                frames.append(frame)

        g2 = P.unpack_global(self._seg.buf)
        if g2["seq"] != g["seq"] or g2["frame_id"] != newest:
            return Batch([], 0, newest)

        self._last = newest
        dropped = max(0, newest - cursor - len(frames))
        return Batch(frames, dropped, newest)

    def close(self) -> None:
        if self._closed:
            return
        for sub in list(self._subs):
            sub.stop()
        self._closed = True
        self._seg.close()

    # Node-side naming symmetry
    detach = close

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()
