"""Wire protocol v1 constants and validation. See PROTOCOL.md (authoritative)."""

from __future__ import annotations

import struct
from typing import Any

MAGIC = 0x524D4853  # bytes b"SHMR" read as little-endian u32
VERSION = 1
HEADER_SIZE = 64
ENDIAN_TAG = 0x0102
SLOT_HEADER_SIZE = 32

DEFAULT_CAPACITY = 8 * 1024 * 1024
DEFAULT_SLOT_COUNT = 4
DEFAULT_META_CAPACITY = 256

HEAD = struct.Struct("<IHHHHI")                 # 0..15, immutable layout prefix
GLOBAL = struct.Struct("<IHHHHIqqqiiii8x")     # 0..63
SLOT = struct.Struct("<qqiiIi")                # 32 bytes


def compute_layout(capacity: int, slot_count: int, meta_capacity: int) -> dict[str, int]:
    """Derive slot geometry; raise ValueError on impossible geometry."""
    if capacity < HEADER_SIZE + slot_count * (SLOT_HEADER_SIZE + meta_capacity + 1):
        raise ValueError(
            f"capacity {capacity} too small for {slot_count} slots with "
            f"meta_capacity={meta_capacity}"
        )
    if slot_count < 1 or meta_capacity < 0:
        raise ValueError("slot_count must be >= 1 and meta_capacity >= 0")
    slot_size = (capacity - HEADER_SIZE) // slot_count
    payload_offset = SLOT_HEADER_SIZE + meta_capacity
    if slot_size <= payload_offset:
        raise ValueError("each slot has no room for payload")
    return {
        "capacity": capacity,
        "slot_count": slot_count,
        "slot_size": slot_size,
        "meta_capacity": meta_capacity,
        "payload_offset": payload_offset,
        "payload_capacity": slot_size - payload_offset,
    }


def pack_global(
    buf: Any,
    layout: dict[str, int],
    seq: int,
    frame_id: int,
    stamp: int,
    flags: int = 0,
) -> None:
    GLOBAL.pack_into(
        buf, 0,
        MAGIC, VERSION, HEADER_SIZE, ENDIAN_TAG, flags, layout["capacity"],
        seq, frame_id, stamp,
        layout["slot_count"], layout["slot_size"],
        layout["meta_capacity"], layout["payload_offset"],
    )


def unpack_global(buf: Any) -> dict[str, int]:
    """Read and fully validate the 64-byte global header."""
    (
        magic, version, header_size, endian, flags, capacity,
        seq, frame_id, stamp,
        slot_count, slot_size, meta_capacity, payload_offset,
    ) = GLOBAL.unpack_from(buf, 0)

    from .errors import ProtocolError

    if magic != MAGIC:
        raise ProtocolError(
            f"bad magic 0x{magic:08x}; this segment is not shmring "
            "(stale segment or wrong name?)"
        )
    if version != VERSION:
        raise ProtocolError(f"unsupported protocol version {version} (this lib speaks v{VERSION})")
    if header_size != HEADER_SIZE or endian != ENDIAN_TAG:
        raise ProtocolError(
            f"layout/endian mismatch (header_size={header_size}, endian=0x{endian:04x})"
        )
    if capacity < HEADER_SIZE + slot_count * (SLOT_HEADER_SIZE + 1) or slot_count < 1:
        raise ProtocolError(f"invalid geometry: capacity={capacity} slot_count={slot_count}")
    if slot_size <= SLOT_HEADER_SIZE + meta_capacity or meta_capacity < 0:
        raise ProtocolError(f"invalid geometry: slot_size={slot_size} meta_capacity={meta_capacity}")
    if payload_offset != SLOT_HEADER_SIZE + meta_capacity:
        raise ProtocolError(f"invalid payload_offset={payload_offset}")

    return {
        "magic": magic, "version": version, "flags": flags,
        "capacity": capacity, "seq": seq, "frame_id": frame_id, "stamp": stamp,
        "slot_count": slot_count, "slot_size": slot_size,
        "meta_capacity": meta_capacity, "payload_offset": payload_offset,
        "payload_capacity": slot_size - payload_offset,
    }


def pack_slot(
    buf: Any, base: int, frame_id: int, stamp: int, length: int, meta_len: int
) -> None:
    SLOT.pack_into(buf, base, frame_id, stamp, length, meta_len, 0, 0)


def unpack_slot(buf: Any, base: int) -> dict[str, int]:
    fid, stamp, length, meta_len, checksum, flags = SLOT.unpack_from(buf, base)
    return {
        "frame_id": fid, "stamp": stamp, "length": length,
        "meta_len": meta_len, "checksum": checksum, "flags": flags,
    }
