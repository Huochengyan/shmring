"""OS-level named shared memory, wrapped so callers never see platform quirks.

Two quirks matter in practice:

1. POSIX ``shm_open`` needs a leading slash, Windows file mappings must not have
   one. Callers always pass a *logical* name (no slash); ``normalize_name``
   handles the difference for the Node side.
2. Python 3.8-3.12 ``resource_tracker`` unlinks a POSIX segment when *any*
   Python process that attached to it exits. We unregister on attach; on 3.13+
   we use the native ``track=False`` instead.
"""

from __future__ import annotations

import os
import sys
from multiprocessing import shared_memory

from .errors import SegmentNotFound


def is_windows() -> bool:
    return os.name == "nt"


def normalize_name(name: str, for_posix: bool) -> str:
    """Return the OS-level object name for a logical name."""
    if not name or "/" in name or "\\" in name:
        raise ValueError("name must be non-empty and contain no '/' or '\\\\'")
    if not for_posix:
        return name
    native = "/" + name
    # macOS PSHMNAMLEN is ~31 bytes including the leading slash.
    if sys.platform == "darwin" and len(native.encode("utf-8")) > 31:
        raise ValueError(
            f"POSIX/macOS shared memory name too long ({len(native)} bytes, max 31)"
        )
    return native


def _open_kwargs(create: bool) -> dict:
    kwargs: dict = {"create": create}
    if sys.version_info >= (3, 13):
        kwargs["track"] = False
    return kwargs


def _untrack(shm: shared_memory.SharedMemory) -> None:
    if os.name != "posix" or sys.version_info >= (3, 13):
        return
    try:
        from multiprocessing import resource_tracker
        resource_tracker.unregister(shm._name, "shared_memory")
    except Exception:
        # Private API; on CPython variants where it differs the worst case is
        # that a stale segment survives until explicit unlink().
        pass


class Segment:
    """A mapped named shared memory segment (read-write)."""

    def __init__(self, name: str, capacity: int | None = None, create: bool = False):
        self._shm = None
        try:
            if create:
                if capacity is None:
                    raise ValueError("capacity is required when create=True")
                self._shm = shared_memory.SharedMemory(
                    name=name, size=capacity, **_open_kwargs(True)
                )
            else:
                self._shm = shared_memory.SharedMemory(
                    name=name, **_open_kwargs(False)
                )
        except FileNotFoundError as exc:
            raise SegmentNotFound(f"no shared memory segment named {name!r}") from exc
        _untrack(self._shm)
        self.name = name
        self.capacity = len(self._shm.buf)

    @property
    def buf(self):
        return self._shm.buf

    def close(self) -> None:
        if self._shm is not None:
            try:
                self._shm.close()
            finally:
                self._shm = None

    def unlink(self) -> None:
        """Detach and remove the OS object. No-op on Windows (refcounted)."""
        if self._shm is None:
            return
        try:
            self._shm.unlink()
        finally:
            self.close()

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()


def unlink(name: str) -> None:
    """Remove a segment by logical name, e.g. to clean up after a crash."""
    try:
        shm = shared_memory.SharedMemory(name=name, **_open_kwargs(False))
    except FileNotFoundError as exc:
        raise SegmentNotFound(f"no shared memory segment named {name!r}") from exc
    _untrack(shm)
    try:
        shm.unlink()
    finally:
        shm.close()
