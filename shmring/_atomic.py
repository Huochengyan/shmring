"""Cross-process 64/32-bit atomics for v2.

Windows does not export InterlockedExchange64 (it is a compiler intrinsic).
POSIX libatomic is used when the symbols exist; otherwise the same machine-code
stubs as Windows are mapped executable. Locked xchg / CASAL / SWPAL are full
barriers, which is what the seqlock odd transition requires.
"""

from __future__ import annotations

import ctypes
import mmap
import os
import sys


def _i64(value: int) -> int:
    value &= 0xFFFFFFFFFFFFFFFF
    if value >= 0x8000000000000000:
        value -= 0x10000000000000000
    return value


def _i32(value: int) -> int:
    value &= 0xFFFFFFFF
    if value >= 0x80000000:
        value -= 0x100000000
    return value


def _u32_word(size64: bool, rs: int, rt: int, rn: int, *, cas: bool) -> bytes:
    """Little-endian CASAL (cas=True) or SWPAL (cas=False)."""
    if cas:
        # 1 size 001000 1 L 1 | Rs | o0 | 11111 | Rn | Rt
        top = 0b1
        top = (top << 1) | (0b1 if size64 else 0b0)
        top = (top << 9) | 0b001000111  # bits 29-21, L=1
        word = top << 21
        word |= (rs & 31) << 16
        word |= 1 << 15  # o0 = release
        word |= 0b11111 << 10
        word |= (rn & 31) << 5
        word |= rt & 31
    else:
        # 1 size 111000 A R 1 | Rs | 100000 | Rn | Rt
        top = 0b1
        top = (top << 1) | (0b1 if size64 else 0b0)
        top = (top << 9) | 0b111000111  # bits 29-21, A=1 R=1
        word = top << 21
        word |= (rs & 31) << 16
        word |= 0b100000 << 10
        word |= (rn & 31) << 5
        word |= rt & 31
    return word.to_bytes(4, "little")


_DMB_ISH = bytes([0xBF, 0x3B, 0x03, 0xD5])
_RET = bytes([0xC0, 0x03, 0x5F, 0xD6])
_MOV_X0_X2 = bytes([0xE0, 0x03, 0x02, 0xAA])
_MOV_W0_W2 = bytes([0xE0, 0x03, 0x02, 0x2A])


def _arm_stub(size64: bool, cas: bool) -> bytes:
    # x0 = ptr, x1 = exchange/store value, x2 = comparand (CAS only).
    # Result comes back in Rs (x2 for CAS, chosen Rt=x2 for SWP) then moves to x0.
    if cas:
        body = _u32_word(size64, rs=2, rt=1, rn=0, cas=True)
    else:
        body = _u32_word(size64, rs=1, rt=2, rn=0, cas=False)
    return body + _DMB_ISH + (_MOV_X0_X2 if size64 else _MOV_W0_W2) + _RET


def _machine_code() -> dict[str, bytes]:
    machine = os.uname().machine if hasattr(os, "uname") else ""
    arm = machine in ("arm64", "aarch64") or platform_machine() == "arm64"
    if arm:
        return {
            "xchg64": _arm_stub(True, False),
            "cas64": _arm_stub(True, True),
            "xchg32": _arm_stub(False, False),
            "cas32": _arm_stub(False, True),
        }
    if sys.platform == "win32":
        return {
            "xchg64": bytes([0x48, 0x8B, 0xC2, 0x48, 0x87, 0x01, 0xC3]),
            "cas64": bytes([0x4C, 0x89, 0xC0, 0xF0, 0x48, 0x0F, 0xB1, 0x11, 0xC3]),
            "xchg32": bytes([0x89, 0xD0, 0x87, 0x01, 0xC3]),
            "cas32": bytes([0x44, 0x89, 0xC0, 0xF0, 0x0F, 0xB1, 0x11, 0xC3]),
        }
    # System V AMD64: rdi, rsi, rdx.
    return {
        "xchg64": bytes([0x48, 0x89, 0xF0, 0x48, 0x87, 0x07, 0xC3]),
        "cas64": bytes([0x48, 0x89, 0xD0, 0xF0, 0x48, 0x0F, 0xB1, 0x37, 0xC3]),
        "xchg32": bytes([0x89, 0xF0, 0x87, 0x07, 0xC3]),
        "cas32": bytes([0x89, 0xD0, 0xF0, 0x0F, 0xB1, 0x37, 0xC3]),
    }


def platform_machine() -> str:
    return getattr(os, "uname", lambda: None) and "" or ""


class _Ops:
    def xchg64(self, addr: int, value: int) -> int: ...
    def cas64(self, addr: int, exchange: int, comparand: int) -> int: ...
    def xchg32(self, addr: int, value: int) -> int: ...
    def cas32(self, addr: int, exchange: int, comparand: int) -> int: ...


def _try_libatomic() -> _Ops | None:
    if sys.platform == "win32":
        return None
    candidates = []
    if sys.platform == "darwin":
        candidates = ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib"]
    else:
        candidates = ["libatomic.so.1", "libatomic.so", "libc.so.6"]
    for name in candidates:
        try:
            lib = ctypes.CDLL(name)
            exchange8 = lib.__atomic_exchange_8
            cmpxchg8 = lib.__atomic_compare_exchange_8
            exchange4 = lib.__atomic_exchange_4
            cmpxchg4 = lib.__atomic_compare_exchange_4
        except (OSError, AttributeError):
            continue
        SEQ = 5
        exchange8.argtypes = [ctypes.c_void_p, ctypes.c_uint64, ctypes.c_int]
        exchange8.restype = ctypes.c_uint64
        exchange4.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int]
        exchange4.restype = ctypes.c_uint32
        cmpxchg8.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint64), ctypes.c_uint64,
            ctypes.c_bool, ctypes.c_int, ctypes.c_int,
        ]
        cmpxchg8.restype = ctypes.c_bool
        cmpxchg4.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32), ctypes.c_uint32,
            ctypes.c_bool, ctypes.c_int, ctypes.c_int,
        ]
        cmpxchg4.restype = ctypes.c_bool

        class LibOps:
            def xchg64(self, addr, value):
                return _i64(exchange8(addr, value & 0xFFFFFFFFFFFFFFFF, SEQ))

            def cas64(self, addr, exchange, comparand):
                exp = ctypes.c_uint64(comparand & 0xFFFFFFFFFFFFFFFF)
                cmpxchg8(addr, ctypes.byref(exp), exchange & 0xFFFFFFFFFFFFFFFF, False, SEQ, SEQ)
                return _i64(exp.value)

            def xchg32(self, addr, value):
                return _i32(exchange4(addr, value & 0xFFFFFFFF, SEQ))

            def cas32(self, addr, exchange, comparand):
                exp = ctypes.c_uint32(comparand & 0xFFFFFFFF)
                cmpxchg4(addr, ctypes.byref(exp), exchange & 0xFFFFFFFF, False, SEQ, SEQ)
                return _i32(exp.value)

        return LibOps()
    return None


def _map_stubs() -> _Ops:
    pieces = _machine_code()
    blob = bytearray()
    offsets = {}
    nop = bytes([0x1F, 0x20, 0x03, 0xD5]) if _arm() else b"\x90"
    for name in ("xchg64", "cas64", "xchg32", "cas32"):
        while len(blob) % 16:
            blob += nop
        offsets[name] = len(blob)
        blob += pieces[name]
    if sys.platform == "win32":
        k32 = ctypes.WinDLL("kernel32")
        k32.VirtualAlloc.restype = ctypes.c_void_p
        k32.VirtualAlloc.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.c_uint32]
        k32.VirtualProtect.argtypes = [
            ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32)
        ]
        mem = k32.VirtualAlloc(None, len(blob), 0x3000, 0x04)
        if not mem:
            raise OSError("VirtualAlloc failed for atomic stubs")
        ctypes.memmove(mem, bytes(blob), len(blob))
        old = ctypes.c_uint32()
        if not k32.VirtualProtect(mem, len(blob), 0x20, ctypes.byref(old)):
            raise OSError("VirtualProtect failed for atomic stubs")
        base = mem
        holder = None
    else:
        mm = mmap.mmap(-1, 4096, prot=mmap.PROT_READ | mmap.PROT_WRITE)
        mm.write(bytes(blob))
        base = ctypes.addressof(ctypes.c_char.from_buffer(mm))
        libc = ctypes.CDLL(None)
        # PROT_READ | PROT_EXEC = 5. Page-align the address.
        page = base & ~4095
        if libc.mprotect(ctypes.c_void_p(page), 4096, 5) != 0:
            raise OSError("mprotect RX failed for atomic stubs")
        holder = mm
    X64 = ctypes.CFUNCTYPE(ctypes.c_int64, ctypes.c_void_p, ctypes.c_int64)
    C64 = ctypes.CFUNCTYPE(ctypes.c_int64, ctypes.c_void_p, ctypes.c_int64, ctypes.c_int64)
    X32 = ctypes.CFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_int32)
    C32 = ctypes.CFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_int32, ctypes.c_int32)
    fns = {
        "xchg64": X64(base + offsets["xchg64"]),
        "cas64": C64(base + offsets["cas64"]),
        "xchg32": X32(base + offsets["xchg32"]),
        "cas32": C32(base + offsets["cas32"]),
    }

    class StubOps:
        def xchg64(self, addr, value):
            return _i64(fns["xchg64"](addr, _i64(value)))

        def cas64(self, addr, exchange, comparand):
            return _i64(fns["cas64"](addr, _i64(exchange), _i64(comparand)))

        def xchg32(self, addr, value):
            return _i32(fns["xchg32"](addr, _i32(value)))

        def cas32(self, addr, exchange, comparand):
            return _i32(fns["cas32"](addr, _i32(exchange), _i32(comparand)))

    StubOps._holder = holder  # type: ignore[attr-defined]
    StubOps._fns = fns  # type: ignore[attr-defined]
    return StubOps()


def _arm() -> bool:
    mach = (getattr(sys, "implementation", None) and "") or ""
    name = os.environ.get("PROCESSOR_ARCHITECTURE", "")
    uname = ""
    if hasattr(os, "uname"):
        try:
            uname = os.uname().machine
        except Exception:
            uname = ""
    return uname in ("arm64", "aarch64") or name.lower() in ("arm64", "aarch64")


_OPS: _Ops | None = None


def _ops() -> _Ops:
    global _OPS
    if _OPS is None:
        _OPS = _try_libatomic() or _map_stubs()
    return _OPS


class View:
    """Atomics over a writable buffer that must stay alive."""

    def __init__(self, buf):
        self._anchor = (ctypes.c_char * len(buf)).from_buffer(buf)
        self._base = ctypes.addressof(self._anchor)
        self._ops = _ops()

    def close(self) -> None:
        self._anchor = None

    def _addr(self, offset: int) -> int:
        return self._base + offset

    def load_i64(self, offset: int) -> int:
        # CAS(0, 0) returns the previous value and does not change it.
        return self._ops.cas64(self._addr(offset), 0, 0)

    def store_i64(self, offset: int, value: int) -> None:
        self._ops.xchg64(self._addr(offset), value)

    def load_i32(self, offset: int) -> int:
        return self._ops.cas32(self._addr(offset), 0, 0)

    def store_i32(self, offset: int, value: int) -> None:
        self._ops.xchg32(self._addr(offset), value)

    def cas_i32(self, offset: int, expected: int, desired: int) -> bool:
        prev = self._ops.cas32(self._addr(offset), desired, expected)
        return prev == _i32(expected)


def mono_ns() -> int:
    """Machine-wide monotonic nanoseconds. Same epoch in every process."""
    if sys.platform == "win32":
        k32 = ctypes.WinDLL("kernel32")
        freq = ctypes.c_int64()
        now = ctypes.c_int64()
        k32.QueryPerformanceFrequency(ctypes.byref(freq))
        k32.QueryPerformanceCounter(ctypes.byref(now))
        return now.value * 1_000_000_000 // freq.value
    clk = 6 if sys.platform == "darwin" else 1  # CLOCK_MONOTONIC

    class Timespec(ctypes.Structure):
        _fields_ = [("tv_sec", ctypes.c_int64), ("tv_nsec", ctypes.c_int64)]

    ts = Timespec()
    libc = ctypes.CDLL(None)
    if libc.clock_gettime(clk, ctypes.byref(ts)) != 0:
        raise OSError("clock_gettime(CLOCK_MONOTONIC) failed")
    return ts.tv_sec * 1_000_000_000 + ts.tv_nsec
