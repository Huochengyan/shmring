"""Single-writer side of the ring."""

from __future__ import annotations

import threading
import time
from typing import NamedTuple

from . import _protocol as P
from ._platform import Segment, unlink
from .errors import CapacityError, ShmRingError


def _byte_view(data) -> memoryview:
    try:
        return memoryview(data).cast("B")
    except (TypeError, ValueError):
        return memoryview(bytes(data)).cast("B")


class WriterInfo(NamedTuple):
    name: str
    capacity: int
    slot_count: int
    slot_size: int
    meta_capacity: int
    payload_capacity: int
    protocol_version: int


class ShmRingWriter:
    """Create and publish into a named shmring segment.

    Only **one** writer may publish into a segment at a time. ``publish()`` is
    safe to call from multiple threads (serialized internally), not from
    multiple processes.
    """

    def __init__(
        self,
        name: str,
        capacity: int = P.DEFAULT_CAPACITY,
        slot_count: int = P.DEFAULT_SLOT_COUNT,
        meta_capacity: int = P.DEFAULT_META_CAPACITY,
        replace: bool = False,
    ):
        self._layout = P.compute_layout(capacity, slot_count, meta_capacity)
        try:
            self._seg = Segment(name, capacity, create=True)
        except FileExistsError as exc:
            if not replace:
                raise ShmRingError(
                    f"segment {name!r} already exists; call shmring.unlink(name) "
                    "first or pass replace=True"
                ) from exc
            try:
                unlink(name)
                self._seg = Segment(name, capacity, create=True)
            except FileExistsError:
                # Windows has no shm_unlink: a live holder keeps the kernel
                # object alive, so the name cannot be freed. Re-attach and
                # reset the existing segment in place instead.
                self._seg = Segment(name, create=False)
                existing = P.unpack_global(self._seg.buf)
                if (
                    existing["capacity"] != capacity
                    or existing["slot_count"] != slot_count
                    or existing["meta_capacity"] != meta_capacity
                ):
                    self._seg.close()
                    raise ShmRingError(
                        f"existing segment {name!r} has a different geometry; "
                        "close all holders and unlink it before recreating"
                    ) from exc
                self._layout = {
                    k: existing[k]
                    for k in (
                        "capacity", "slot_count", "slot_size",
                        "meta_capacity", "payload_offset", "payload_capacity",
                    )
                }

        self._lock = threading.Lock()
        self._seq = 0
        self._frame_id = -1
        self._stamp = 0
        buf = self._seg.buf
        with self._lock:
            P.pack_global(buf, self._layout, 0, -1, 0)
            for i in range(self._layout["slot_count"]):
                P.pack_slot(
                    buf, P.HEADER_SIZE + i * self._layout["slot_size"], -1, 0, 0, 0
                )

    @property
    def info(self) -> WriterInfo:
        L = self._layout
        return WriterInfo(
            self._seg.name, L["capacity"], L["slot_count"], L["slot_size"],
            L["meta_capacity"], L["payload_capacity"], P.VERSION,
        )

    @property
    def payload_capacity(self) -> int:
        return self._layout["payload_capacity"]

    @property
    def meta_capacity(self) -> int:
        return self._layout["meta_capacity"]

    def publish(self, payload, meta=b"", stamp: int | None = None) -> int:
        """Publish one opaque frame. Returns the assigned frame_id.

        ``payload`` / ``meta`` accept any buffer-protocol object. The frame is
        copied into the shared segment, so the caller may reuse its buffer.
        """
        pview = _byte_view(payload)
        mview = _byte_view(meta)
        L = self._layout
        if pview.nbytes > L["payload_capacity"]:
            raise CapacityError(
                f"payload {pview.nbytes} B exceeds slot capacity "
                f"{L['payload_capacity']} B"
            )
        if mview.nbytes > L["meta_capacity"]:
            raise CapacityError(
                f"meta {mview.nbytes} B exceeds meta capacity {L['meta_capacity']} B"
            )

        buf = self._seg.buf
        with self._lock:
            fid = self._frame_id + 1
            ts = int(time.time() * 1000) if stamp is None else int(stamp)
            base = P.HEADER_SIZE + (fid % L["slot_count"]) * L["slot_size"]
            po = L["payload_offset"]

            # 1) announce write-in-progress (odd seq), keep old frame_id
            P.pack_global(buf, L, self._seq + 1, self._frame_id, self._stamp)
            # 2) payload, then meta, then slot header LAST
            buf[base + po: base + po + pview.nbytes] = pview
            if mview.nbytes:
                buf[base + P.SLOT_HEADER_SIZE: base + P.SLOT_HEADER_SIZE + mview.nbytes] = mview
            P.pack_slot(buf, base, fid, ts, pview.nbytes, mview.nbytes)
            # 3) commit: even seq + new frame_id in one shot
            self._seq += 2
            self._frame_id = fid
            self._stamp = ts
            P.pack_global(buf, L, self._seq, fid, ts)
            return fid

    def close(self) -> None:
        self._seg.close()

    def unlink(self) -> None:
        """Detach and delete the OS object (no-op on Windows)."""
        self._seg.unlink()

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()
