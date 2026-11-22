"""Multi-reader side of the ring."""

from __future__ import annotations

from typing import NamedTuple

from . import _protocol as P
from ._platform import Segment


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


class ShmRingReader:
    """Attach to an existing segment and read frames.

    A reader keeps its own ``last_frame_id`` cursor. ``read_batch()`` advances
    it; ``read()`` does not. Multiple readers may attach to the same segment.
    """

    def __init__(self, name: str, retries: int = 8):
        self._seg = Segment(name, create=False)
        self._retries = retries
        self._last = -1
        self._layout = P.unpack_global(self._seg.buf)

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
        self._seg.close()

    # Node-side naming symmetry
    detach = close

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()
