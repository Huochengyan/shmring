"""Exception types raised by shmring."""

from __future__ import annotations


class ShmRingError(Exception):
    """Base class for all shmring errors."""


class ProtocolError(ShmRingError):
    """Segment header failed validation (wrong magic, version, geometry, endianness)."""


class SegmentNotFound(ShmRingError):
    """No shared memory segment exists under the given name."""


class CapacityError(ShmRingError):
    """Payload or meta exceeds the slot capacity configured at create() time."""


class ChecksumError(ShmRingError):
    """Slot checksum did not match the copied payload and meta. Cursor is unchanged."""
