"""shmring — a lock-free, cross-language shared-memory ring buffer.

Single writer, many readers, no HTTP, no polling requests, no locks.
Wire format is specified in PROTOCOL.md.

Quick start (Python writer)::

    from shmring import ShmRingWriter
    with ShmRingWriter("demo", capacity=8 * 1024 * 1024) as w:
        w.publish(b"hello", meta=b"topic=a")

Quick start (Python reader)::

    from shmring import ShmRingReader
    with ShmRingReader("demo") as r:
        frame = r.read()
        print(frame.payload, frame.meta)
"""

from ._platform import normalize_name, unlink
from ._protocol import (
    DEFAULT_CAPACITY,
    DEFAULT_META_CAPACITY,
    DEFAULT_SLOT_COUNT,
    HEADER_SIZE,
    MAGIC,
    SLOT_HEADER_SIZE,
    VERSION as PROTOCOL_VERSION,
)
from .errors import CapacityError, ChecksumError, ProtocolError, SegmentNotFound, ShmRingError
from .reader import Batch, Frame, ShmRingReader
from .v2 import (
    BatchV2,
    FrameV2,
    Gap,
    PublishResult,
    ShmRingReaderV2,
    ShmRingWriterV2,
    WriterInfoV2,
)
from .writer import ShmRingWriter, WriterInfo

__version__ = "0.2.0"

__all__ = [
    "ShmRingWriter", "ShmRingReader", "Frame", "Batch", "WriterInfo",
    "ShmRingWriterV2", "ShmRingReaderV2", "FrameV2", "Gap", "BatchV2",
    "PublishResult", "WriterInfoV2",
    "ShmRingError", "ProtocolError", "SegmentNotFound", "CapacityError", "ChecksumError",
    "normalize_name", "unlink",
    "MAGIC", "PROTOCOL_VERSION", "HEADER_SIZE", "SLOT_HEADER_SIZE",
    "DEFAULT_CAPACITY", "DEFAULT_SLOT_COUNT", "DEFAULT_META_CAPACITY",
    "__version__",
]
