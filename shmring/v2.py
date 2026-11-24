"""v2 writer and reader. v1 classes are not modified.

publish() never waits on a reader. overwrite always stores the new frame.
return hands the frame back when a live retainer still occupies the slot.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Callable, NamedTuple

from . import _protocol_v2 as P
from ._atomic import View, mono_ns
from ._platform import Segment, unlink
from .errors import CapacityError, ChecksumError, ProtocolError, ShmRingError


def _byte_view(data) -> memoryview:
    try:
        return memoryview(data).cast("B")
    except (TypeError, ValueError):
        return memoryview(bytes(data)).cast("B")


def _parse_overflow(value) -> int:
    if value in (P.OVERFLOW_OVERWRITE, "overwrite", "Overwrite"):
        return P.OVERFLOW_OVERWRITE
    if value in (P.OVERFLOW_RETURN, "return", "Return"):
        return P.OVERFLOW_RETURN
    raise ProtocolError("overflow must be 'overwrite' or 'return'")


def _parse_role(value) -> int:
    if value in (P.ROLE_OBSERVER, "observer"):
        return P.ROLE_OBSERVER
    if value in (P.ROLE_RETAINER, "retainer"):
        return P.ROLE_RETAINER
    raise ProtocolError("role must be 'observer' or 'retainer'")


class PublishResult(NamedTuple):
    accepted: bool
    frame_id: int | None


class FrameV2(NamedTuple):
    seq: int
    stamp: int
    payload: bytes
    meta: bytes


class Gap(NamedTuple):
    dropped: int
    next_seq: int


class BatchV2(NamedTuple):
    frames: list[FrameV2]
    gap: Gap | None


class WriterInfoV2(NamedTuple):
    name: str
    capacity: int
    slot_count: int
    slot_size: int
    meta_capacity: int
    payload_capacity: int
    protocol_version: int
    overflow: str
    checksum: bool
    stale_ms: int


class ShmRingWriterV2:
    """Create a v2 segment and publish without waiting on readers."""

    def __init__(
        self,
        name: str,
        capacity: int = 8 * 1024 * 1024,
        slot_count: int = 4,
        meta_capacity: int = 256,
        overflow: str = "overwrite",
        stale_ms: int = P.DEFAULT_STALE_MS,
        checksum: bool = True,
        replace: bool = False,
    ):
        policy = _parse_overflow(overflow)
        algo = P.CHECKSUM_CRC32 if checksum else P.CHECKSUM_NONE
        self._layout = P.compute_layout(
            capacity, slot_count, meta_capacity, policy, algo, stale_ms
        )
        self._lock = threading.Lock()
        self._closed = False
        self._W = 0
        self._view: View | None = None
        self._seg: Segment | None = None
        try:
            self._seg = Segment(name, capacity, create=True)
        except FileExistsError as exc:
            if not replace:
                raise ShmRingError(
                    f"segment {name!r} already exists; unlink it or pass replace=True"
                ) from exc
            try:
                unlink(name)
                self._seg = Segment(name, capacity, create=True)
            except FileExistsError:
                self._seg = Segment(name, create=False)
                self._adopt_existing(exc)
        self._view = View(self._seg.buf)
        self._epoch = int.from_bytes(os.urandom(8), "little", signed=True) or 1
        self._init_segment()

    def _adopt_existing(self, exc: BaseException) -> None:
        try:
            existing = P.unpack_global(self._seg.buf)
        except ProtocolError:
            self._seg.close()
            raise
        want = self._layout
        if (
            existing["capacity"] != want["capacity"]
            or existing["slot_count"] != want["slot_count"]
            or existing["meta_capacity"] != want["meta_capacity"]
        ):
            self._seg.close()
            raise ShmRingError(
                f"existing segment {self._seg.name!r} has a different geometry; "
                "close all holders and unlink it before recreating"
            ) from exc
        self._layout = existing

    def _init_segment(self) -> None:
        buf = self._seg.buf
        buf[:P.HEADER_SIZE] = b"\x00" * P.HEADER_SIZE
        buf[:P.GLOBAL.size] = P.pack_global(self._layout, self._epoch, os.getpid())
        view = self._view
        view.store_i64(P.WRITE_POS_OFFSET, 0)
        view.store_i64(P.WRITER_HEARTBEAT_OFFSET, mono_ns())
        view.store_i32(P.RETAINER_SLOT_OFFSET, -1)
        for i in range(P.MAX_READERS):
            base = P.reader_offset(i)
            view.store_i64(base + 0, -1)
            view.store_i64(base + 8, 0)
            view.store_i64(base + 16, 0)
            view.store_i32(base + 24, 0)  # role
            view.store_i32(base + 28, P.STATE_EMPTY)
        L = self._layout
        for i in range(L["slot_count"]):
            base = P.slot_base(i, L["slot_size"])
            view.store_i64(base, 0)  # seqlock even
            buf[base + 8: base + 8 + P.SLOT_BODY.size] = P.pack_slot_body(-1, 0, 0, 0, 0)
        self._W = 0

    def _require(self) -> View:
        if self._closed or self._view is None:
            raise ShmRingError("writer is closed")
        return self._view

    @property
    def info(self) -> WriterInfoV2:
        L = self._layout
        return WriterInfoV2(
            self._seg.name, L["capacity"], L["slot_count"], L["slot_size"],
            L["meta_capacity"], L["payload_capacity"], P.VERSION,
            "return" if L["overflow_policy"] else "overwrite",
            L["checksum_algo"] == P.CHECKSUM_CRC32,
            L["stale_ms"],
        )

    @property
    def payload_capacity(self) -> int:
        return self._layout["payload_capacity"]

    @property
    def meta_capacity(self) -> int:
        return self._layout["meta_capacity"]

    def heartbeat(self) -> None:
        view = self._require()
        with self._lock:
            view.store_i64(P.WRITER_HEARTBEAT_OFFSET, mono_ns())

    def _live_retainer_pos(self, view: View) -> int | None:
        if self._layout["overflow_policy"] != P.OVERFLOW_RETURN:
            return None
        idx = view.load_i32(P.RETAINER_SLOT_OFFSET)
        if idx < 0 or idx >= P.MAX_READERS:
            return None
        base = P.reader_offset(idx)
        if view.load_i32(base + 28) != P.STATE_ACTIVE:
            return None
        if view.load_i32(base + 24) != P.ROLE_RETAINER:
            return None
        hb = view.load_i64(base + 8)
        if mono_ns() - hb >= self._layout["stale_ms"] * 1_000_000:
            return None
        return view.load_i64(base + 0)

    def publish(self, payload, meta=b"", stamp: int | None = None) -> PublishResult:
        pview = _byte_view(payload)
        mview = _byte_view(meta)
        L = self._layout
        if pview.nbytes > L["payload_capacity"]:
            raise CapacityError(
                f"payload {pview.nbytes} B exceeds slot capacity {L['payload_capacity']} B"
            )
        if mview.nbytes > L["meta_capacity"]:
            raise CapacityError(
                f"meta {mview.nbytes} B exceeds meta capacity {L['meta_capacity']} B"
            )
        view = self._require()
        with self._lock:
            view.store_i64(P.WRITER_HEARTBEAT_OFFSET, mono_ns())
            W = self._W
            held = self._live_retainer_pos(view)
            if held is not None and W - held >= L["slot_count"]:
                return PublishResult(False, None)
            base = P.slot_base(W % L["slot_count"], L["slot_size"])
            seqlock = view.load_i64(base)
            view.store_i64(base, seqlock + 1)  # odd
            buf = self._seg.buf
            po = L["payload_offset"]
            buf[base + po: base + po + pview.nbytes] = pview
            if mview.nbytes:
                buf[base + P.SLOT_HEADER_SIZE: base + P.SLOT_HEADER_SIZE + mview.nbytes] = mview
            checksum = (
                P.crc32(mview.tobytes(), pview.tobytes())
                if L["checksum_algo"] == P.CHECKSUM_CRC32 else 0
            )
            ts = int(time.time() * 1000) if stamp is None else int(stamp)
            buf[base + 8: base + 8 + P.SLOT_BODY.size] = P.pack_slot_body(
                W, ts, pview.nbytes, mview.nbytes, checksum
            )
            view.store_i64(base, seqlock + 2)  # even
            view.store_i64(P.WRITE_POS_OFFSET, W + 1)
            self._W = W + 1
            return PublishResult(True, W)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._view is not None:
            self._view.close()
            self._view = None
        if self._seg is not None:
            self._seg.close()
            self._seg = None

    def unlink(self) -> None:
        """Detach and delete the OS object. Windows removes it when the last handle closes."""
        if self._closed:
            return
        self._closed = True
        if self._view is not None:
            self._view.close()
            self._view = None
        seg = self._seg
        self._seg = None
        if seg is not None:
            seg.unlink()

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()


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
                frame = self._reader.latest()
            except Exception as exc:
                self.error = exc
                self._stop.set()
                return
            if frame is not None and frame.seq != last:
                last = frame.seq
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


class ShmRingReaderV2:
    """Attach to a v2 segment. read() does not advance the shared cursor."""

    def __init__(self, name: str, role: str = "observer", join: str = "tip", retries: int = 8):
        self._role = _parse_role(role)
        if join not in ("tip", "window"):
            raise ProtocolError("join must be 'tip' or 'window'")
        self._retries = retries
        self._closed = False
        self._seg = Segment(name, create=False)
        try:
            self._layout = P.unpack_global(self._seg.buf)
            self._view = View(self._seg.buf)
        except Exception:
            self._seg.close()
            raise
        self._epoch = self._layout["writer_epoch"]
        self._index = -1
        self._subs: list[_Subscription] = []
        try:
            self._claim(join)
        except Exception:
            self._view.close()
            self._seg.close()
            raise

    def _claim(self, join: str) -> None:
        view = self._view
        W = view.load_i64(P.WRITE_POS_OFFSET)
        if join == "tip":
            pos = W
        else:
            pos = max(0, W - self._layout["slot_count"])
        for i in range(P.MAX_READERS):
            base = P.reader_offset(i)
            if not view.cas_i32(base + 28, P.STATE_EMPTY, P.STATE_CLAIMING):
                continue
            try:
                if self._role == P.ROLE_RETAINER:
                    if not view.cas_i32(P.RETAINER_SLOT_OFFSET, -1, i):
                        raise ShmRingError("a retainer is already attached to this segment")
                generation = view.load_i64(base + 16) + 1
                view.store_i64(base + 16, generation)
                view.store_i32(base + 24, self._role)
                pid = os.getpid() & 0xFFFFFFFF
                # pid sits at +32 as a plain u32; written before state becomes active.
                self._seg.buf[base + 32: base + 36] = pid.to_bytes(4, "little")
                view.store_i64(base + 8, mono_ns())
                view.store_i64(base + 0, pos)
                view.store_i32(base + 28, P.STATE_ACTIVE)
            except Exception:
                view.store_i32(base + 28, P.STATE_EMPTY)
                view.store_i64(base + 0, -1)
                if self._role == P.ROLE_RETAINER and view.load_i32(P.RETAINER_SLOT_OFFSET) == i:
                    view.store_i32(P.RETAINER_SLOT_OFFSET, -1)
                raise
            self._index = i
            self._cursor = pos
            self._base = base
            return
        raise ShmRingError(f"no free v2 reader slot (max {P.MAX_READERS})")

    @property
    def info(self):
        L = self._layout
        return {
            "name": self._seg.name,
            "capacity": L["capacity"],
            "slot_count": L["slot_count"],
            "slot_size": L["slot_size"],
            "meta_capacity": L["meta_capacity"],
            "payload_capacity": L["payload_capacity"],
            "protocol_version": P.VERSION,
            "overflow": "return" if L["overflow_policy"] else "overwrite",
            "slotCount": L["slot_count"],
        }

    @property
    def read_pos(self) -> int:
        return self._cursor

    def heartbeat(self) -> None:
        self._check_open()
        self._view.store_i64(self._base + 8, mono_ns())

    def writer_alive(self) -> bool:
        self._check_open()
        hb = self._view.load_i64(P.WRITER_HEARTBEAT_OFFSET)
        if hb <= 0:
            return False
        return mono_ns() - hb < self._layout["stale_ms"] * 1_000_000

    def _check_open(self) -> None:
        if self._closed:
            raise ShmRingError("reader is closed")
        epoch = P.GLOBAL.unpack_from(self._seg.buf, 0)[14]
        if epoch != self._epoch:
            raise ProtocolError("writer epoch changed; re-attach to this segment")

    def _gap(self, R: int, W: int) -> Gap | None:
        span = self._layout["slot_count"]
        if W - R > span:
            oldest = W - span
            return Gap(oldest - R, oldest)
        return None

    def _peek(self, R: int):
        view = self._view
        L = self._layout
        for _ in range(self._retries):
            W = view.load_i64(P.WRITE_POS_OFFSET)
            if R >= W:
                return None
            gap = self._gap(R, W)
            if gap is not None:
                return gap
            base = P.slot_base(R % L["slot_count"], L["slot_size"])
            s1 = view.load_i64(base)
            if s1 & 1:
                continue
            body = P.unpack_slot_body(self._seg.buf, base + 8)
            if body["slot_seq"] != R:
                continue
            length, meta_len = body["length"], body["meta_len"]
            if not (0 <= length <= L["payload_capacity"]):
                continue
            if not (0 <= meta_len <= L["meta_capacity"]):
                continue
            po = L["payload_offset"]
            buf = self._seg.buf
            payload = bytes(buf[base + po: base + po + length])
            meta = bytes(buf[base + P.SLOT_HEADER_SIZE: base + P.SLOT_HEADER_SIZE + meta_len]) if meta_len else b""
            s2 = view.load_i64(base)
            if s1 != s2:
                continue
            if L["checksum_algo"] == P.CHECKSUM_CRC32 and P.crc32(meta, payload) != body["checksum"]:
                raise ChecksumError(f"checksum mismatch on frame {R}")
            return FrameV2(R, body["stamp"], payload, meta)
        W = view.load_i64(P.WRITE_POS_OFFSET)
        if R >= W:
            return None
        gap = self._gap(R, W)
        if gap is not None:
            return gap
        return None

    def latest(self):
        """Copy the newest published frame. Does not move the cursor."""
        self._check_open()
        self.heartbeat()
        view = self._view
        L = self._layout
        for _ in range(self._retries):
            W = view.load_i64(P.WRITE_POS_OFFSET)
            if W <= 0:
                return None
            seq = W - 1
            base = P.slot_base(seq % L["slot_count"], L["slot_size"])
            s1 = view.load_i64(base)
            if s1 & 1:
                continue
            body = P.unpack_slot_body(self._seg.buf, base + 8)
            if body["slot_seq"] != seq:
                continue
            length, meta_len = body["length"], body["meta_len"]
            if not (0 <= length <= L["payload_capacity"]):
                continue
            if not (0 <= meta_len <= L["meta_capacity"]):
                continue
            po = L["payload_offset"]
            buf = self._seg.buf
            payload = bytes(buf[base + po: base + po + length])
            meta = bytes(buf[base + P.SLOT_HEADER_SIZE: base + P.SLOT_HEADER_SIZE + meta_len]) if meta_len else b""
            s2 = view.load_i64(base)
            if s1 != s2:
                continue
            if L["checksum_algo"] == P.CHECKSUM_CRC32 and P.crc32(meta, payload) != body["checksum"]:
                raise ChecksumError(f"checksum mismatch on frame {seq}")
            return FrameV2(seq, body["stamp"], payload, meta)
        return None

    def subscribe(self, callback: Callable, interval_ms: float = 2.0) -> _Subscription:
        """Call ``callback(frame)`` in this process when a newer frame is published.

        The loop polls every ``interval_ms`` (default 2). Each call receives a
        copy of the newest frame only. The read cursor is left where it is.
        ``stop()`` on the returned object ends the loop. ``close()`` stops it too.
        """
        if interval_ms < 0:
            raise ValueError("interval_ms must be >= 0")
        self._check_open()
        sub = _Subscription(self, callback, interval_ms / 1000.0)
        self._subs.append(sub)
        sub.start()
        return sub

    def read(self):
        self._check_open()
        self.heartbeat()
        return self._peek(self._cursor)

    def read_batch(self, limit: int | None = None) -> BatchV2:
        self._check_open()
        self.heartbeat()
        frames: list[FrameV2] = []
        R = self._cursor
        while limit is None or len(frames) < limit:
            item = self._peek(R)
            if item is None or isinstance(item, Gap):
                return BatchV2(frames, item if isinstance(item, Gap) else None)
            frames.append(item)
            R += 1
        return BatchV2(frames, None)

    def commit(self, seq: int) -> None:
        self._check_open()
        if seq != self._cursor:
            raise ProtocolError(
                f"commit({seq}) but the next frame is {self._cursor}"
            )
        self._cursor = seq + 1
        self._view.store_i64(self._base + 0, self._cursor)
        self.heartbeat()

    def skip_to(self, seq: int) -> None:
        self._check_open()
        if seq <= self._cursor:
            raise ProtocolError(
                f"skip_to({seq}) must move forward from {self._cursor}"
            )
        self._cursor = seq
        self._view.store_i64(self._base + 0, seq)
        self.heartbeat()

    def close(self) -> None:
        if self._closed:
            return
        for sub in list(getattr(self, "_subs", ())):
            sub.stop()
        self._closed = True
        try:
            if self._index >= 0 and self._view is not None:
                if self._role == P.ROLE_RETAINER:
                    if self._view.load_i32(P.RETAINER_SLOT_OFFSET) == self._index:
                        self._view.store_i32(P.RETAINER_SLOT_OFFSET, -1)
                self._view.store_i32(self._base + 28, P.STATE_EMPTY)
                self._view.store_i64(self._base + 0, -1)
        finally:
            if self._view is not None:
                self._view.close()
                self._view = None
            if self._seg is not None:
                self._seg.close()
                self._seg = None

    detach = close

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()
