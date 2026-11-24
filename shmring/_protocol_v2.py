"""Wire protocol v2. See V2_DESIGN.md.

v1 (PROTOCOL.md) is unchanged. A v1 reader rejects version 2 and the reverse.
"""

from __future__ import annotations

import struct
import zlib

from .errors import ProtocolError

MAGIC = 0x524D4853
VERSION = 2
HEADER_SIZE = 1024
ENDIAN_TAG = 0x0102
SLOT_HEADER_SIZE = 64
MAX_READERS = 8
READER_SLOT_SIZE = 64
READERS_OFFSET = 192
WRITE_POS_OFFSET = 64
WRITER_HEARTBEAT_OFFSET = 128
# Reserved word in the heartbeat cache line. -1 means no retainer.
RETAINER_SLOT_OFFSET = 136

OVERFLOW_OVERWRITE = 0
OVERFLOW_RETURN = 1
CHECKSUM_NONE = 0
CHECKSUM_CRC32 = 1

ROLE_OBSERVER = 0
ROLE_RETAINER = 1
STATE_EMPTY = 0
STATE_ACTIVE = 1
STATE_CLAIMING = 2

DEFAULT_STALE_MS = 1000

# First 64 bytes are immutable after create. write_pos lives on the next line.
GLOBAL = struct.Struct("<IHHHHIIIIIIIIIqq")
SLOT_BODY = struct.Struct("<qqIIII")  # at slot+8; seqlock at slot+0 is atomic


def compute_layout(
    capacity: int,
    slot_count: int,
    meta_capacity: int,
    overflow: int,
    checksum_algo: int,
    stale_ms: int,
) -> dict:
    if slot_count < 1 or meta_capacity < 0:
        raise ProtocolError("slot_count must be >= 1 and meta_capacity >= 0")
    if overflow not in (OVERFLOW_OVERWRITE, OVERFLOW_RETURN):
        raise ProtocolError(f"overflow policy {overflow} is not 0 (overwrite) or 1 (return)")
    if checksum_algo not in (CHECKSUM_NONE, CHECKSUM_CRC32):
        raise ProtocolError(f"checksum algo {checksum_algo} is not 0 or 1")
    if overflow == OVERFLOW_RETURN and stale_ms < 1:
        raise ProtocolError("return policy requires stale_ms >= 1")
    if stale_ms < 0:
        raise ProtocolError("stale_ms must be >= 0")
    min_slot = SLOT_HEADER_SIZE + meta_capacity + 1
    if capacity < HEADER_SIZE + slot_count * min_slot:
        raise ProtocolError(
            f"capacity {capacity} too small for {slot_count} slots with "
            f"meta_capacity={meta_capacity}"
        )
    slot_size = (capacity - HEADER_SIZE) // slot_count
    payload_offset = SLOT_HEADER_SIZE + meta_capacity
    if slot_size <= payload_offset:
        raise ProtocolError("each slot has no room for payload")
    return {
        "capacity": capacity,
        "slot_count": slot_count,
        "slot_size": slot_size,
        "meta_capacity": meta_capacity,
        "payload_offset": payload_offset,
        "payload_capacity": slot_size - payload_offset,
        "overflow_policy": overflow,
        "checksum_algo": checksum_algo,
        "stale_ms": stale_ms,
    }


def pack_global(layout: dict, epoch: int, pid: int) -> bytes:
    return GLOBAL.pack(
        MAGIC, VERSION, HEADER_SIZE, ENDIAN_TAG, 0, layout["capacity"],
        layout["slot_count"], layout["slot_size"], layout["meta_capacity"],
        layout["payload_offset"], MAX_READERS, layout["overflow_policy"],
        layout["checksum_algo"], layout["stale_ms"], epoch, pid,
    )


def unpack_global(buf) -> dict:
    if len(buf) < HEADER_SIZE:
        raise ProtocolError(f"segment shorter than v2 header ({len(buf)} < {HEADER_SIZE})")
    fields = GLOBAL.unpack_from(buf, 0)
    (
        magic, version, header_size, endian, flags, capacity,
        slot_count, slot_size, meta_capacity, payload_offset,
        max_readers, overflow, checksum_algo, stale_ms, epoch, pid,
    ) = fields
    if magic != MAGIC:
        raise ProtocolError(
            f"bad magic 0x{magic:08x} (not a shmring segment)"
        )
    if version != VERSION:
        raise ProtocolError(
            f"unsupported protocol version {version} (this lib speaks v{VERSION})"
        )
    if header_size != HEADER_SIZE or endian != ENDIAN_TAG:
        raise ProtocolError(
            f"layout/endian mismatch (header={header_size}, endian=0x{endian:x})"
        )
    if max_readers != MAX_READERS:
        raise ProtocolError(f"max_readers {max_readers} != {MAX_READERS}")
    layout = compute_layout(capacity, slot_count, meta_capacity, overflow, checksum_algo, stale_ms)
    if layout["slot_size"] != slot_size or layout["payload_offset"] != payload_offset:
        raise ProtocolError(
            f"geometry does not match capacity "
            f"(slot_size={slot_size}, payload_offset={payload_offset})"
        )
    if capacity < HEADER_SIZE + slot_count * slot_size:
        raise ProtocolError("capacity smaller than header plus slots")
    layout["flags"] = flags
    layout["writer_epoch"] = epoch
    layout["writer_pid"] = pid
    return layout


def pack_slot_body(slot_seq: int, stamp: int, length: int, meta_len: int, checksum: int) -> bytes:
    return SLOT_BODY.pack(slot_seq, stamp, length, meta_len, checksum, 0)


def unpack_slot_body(buf, offset: int) -> dict:
    slot_seq, stamp, length, meta_len, checksum, flags = SLOT_BODY.unpack_from(buf, offset)
    return {
        "slot_seq": slot_seq,
        "stamp": stamp,
        "length": length,
        "meta_len": meta_len,
        "checksum": checksum,
        "flags": flags,
    }


def crc32(meta: bytes, payload: bytes) -> int:
    return zlib.crc32(payload, zlib.crc32(meta)) & 0xFFFFFFFF


def reader_offset(index: int) -> int:
    return READERS_OFFSET + index * READER_SLOT_SIZE


def slot_base(slot_index: int, slot_size: int) -> int:
    return HEADER_SIZE + slot_index * slot_size
