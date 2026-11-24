'use strict';

// Cross-process atomics. Interlocked* is not exported from kernel32 (compiler
// intrinsic), so each platform maps a few instructions and calls them.
// xchg / CASAL / SWPAL are full barriers: the seqlock odd store must not sink
// below the payload writes that follow the call.

const koffi = require('koffi');

const XCHG64 = koffi.proto('int64 Xchg64(uintptr_t ptr, int64 value)');
const CAS64 = koffi.proto('int64 Cas64(uintptr_t ptr, int64 exchange, int64 comparand)');
const XCHG32 = koffi.proto('int32 Xchg32(uintptr_t ptr, int32 value)');
const CAS32 = koffi.proto('int32 Cas32(uintptr_t ptr, int32 exchange, int32 comparand)');

function signed64(v) {
  let n = typeof v === 'bigint' ? v : BigInt(v);
  if (n > 0x7fffffffffffffffn) n -= 0x10000000000000000n;
  if (n < -0x8000000000000000n) n += 0x10000000000000000n;
  return n;
}

function signed32(v) {
  let n = Number(BigInt(v) & 0xffffffffn);
  if (n >= 0x80000000) n -= 0x100000000;
  return n;
}

function u32(word) {
  return word >>> 0;
}

function armWord(size64, rs, rt, rn, cas) {
  // JS bitwise ops are signed 32-bit, so the instruction word is built with BigInt.
  let top = 1n;
  top = (top << 1n) | (size64 ? 1n : 0n);
  top = (top << 9n) | (cas ? 0b001000111n : 0b111000111n);
  let word = top << 21n;
  word |= BigInt(rs & 31) << 16n;
  if (cas) {
    word |= 1n << 15n;
    word |= 0b11111n << 10n;
  } else {
    word |= 0b100000n << 10n;
  }
  word |= BigInt(rn & 31) << 5n;
  word |= BigInt(rt & 31);
  return Number(word & 0xffffffffn);
}

function le32(word) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(u32(word));
  return b;
}

function machineCode() {
  const arm = process.arch === 'arm64';
  if (arm) {
    const dmb = le32(0xd5033bbf);
    const ret = le32(0xd65f03c0);
    const movX = le32(0xaa0203e0);
    const movW = le32(0x2a0203e0);
    const stub = (size64, cas) => Buffer.concat([
      le32(armWord(size64, cas ? 2 : 1, cas ? 1 : 2, 0, cas)),
      dmb,
      size64 ? movX : movW,
      ret,
    ]);
    return {
      xchg64: stub(true, false),
      cas64: stub(true, true),
      xchg32: stub(false, false),
      cas32: stub(false, true),
    };
  }
  if (process.platform === 'win32') {
    return {
      xchg64: Buffer.from([0x48, 0x8b, 0xc2, 0x48, 0x87, 0x01, 0xc3]),
      cas64: Buffer.from([0x4c, 0x89, 0xc0, 0xf0, 0x48, 0x0f, 0xb1, 0x11, 0xc3]),
      xchg32: Buffer.from([0x89, 0xd0, 0x87, 0x01, 0xc3]),
      cas32: Buffer.from([0x44, 0x89, 0xc0, 0xf0, 0x0f, 0xb1, 0x11, 0xc3]),
    };
  }
  return {
    xchg64: Buffer.from([0x48, 0x89, 0xf0, 0x48, 0x87, 0x07, 0xc3]),
    cas64: Buffer.from([0x48, 0x89, 0xd0, 0xf0, 0x48, 0x0f, 0xb1, 0x37, 0xc3]),
    xchg32: Buffer.from([0x89, 0xf0, 0x87, 0x07, 0xc3]),
    cas32: Buffer.from([0x89, 0xd0, 0xf0, 0x0f, 0xb1, 0x37, 0xc3]),
  };
}

function concatAligned(parts) {
  const out = [];
  const offsets = {};
  let len = 0;
  const nop = process.arch === 'arm64'
    ? Buffer.from([0x1f, 0x20, 0x03, 0xd5])
    : Buffer.from([0x90]);
  for (const name of ['xchg64', 'cas64', 'xchg32', 'cas32']) {
    while (len % 16) {
      out.push(nop);
      len += nop.length;
    }
    offsets[name] = len;
    out.push(parts[name]);
    len += parts[name].length;
  }
  return { blob: Buffer.concat(out), offsets };
}

let fns = null;

function install() {
  if (fns) return fns;
  const { blob, offsets } = concatAligned(machineCode());
  let base;
  if (process.platform === 'win32') {
    const k32 = koffi.load('kernel32.dll');
    const VirtualAlloc = k32.func('uint64 VirtualAlloc(uintptr_t addr, uintptr_t size, uint32_t type, uint32_t prot)');
    const VirtualProtect = k32.func('bool VirtualProtect(uintptr_t addr, uintptr_t size, uint32_t prot, _Out_ uint32_t *old)');
    const memcpy = koffi.load('msvcrt.dll').func('void *memcpy(uintptr_t dst, void *src, size_t n)');
    base = BigInt(VirtualAlloc(0, 4096, 0x3000, 0x04));
    memcpy(base, blob, blob.length);
    const old = [0];
    if (!VirtualProtect(base, 4096, 0x20, old)) {
      throw new Error('VirtualProtect failed for atomic stubs');
    }
  } else {
    const isMac = process.platform === 'darwin';
    const libc = koffi.load(isMac ? 'libSystem.B.dylib' : 'libc.so.6');
    const mmap = libc.func('uintptr_t mmap(uintptr_t addr, uintptr_t len, int prot, int flags, int fd, int64_t off)');
    const mprotect = libc.func('int mprotect(uintptr_t addr, uintptr_t len, int prot)');
    const memcpy = libc.func('void *memcpy(uintptr_t dst, void *src, size_t n)');
    const PROT_READ = 1;
    const PROT_WRITE = 2;
    const PROT_EXEC = 4;
    const MAP_PRIVATE = 2;
    const MAP_ANON = isMac ? 0x1000 : 0x20;
    let flags = MAP_PRIVATE | MAP_ANON;
    let prot = PROT_READ | PROT_WRITE;
    if (isMac && process.arch === 'arm64') {
      flags |= 0x0800; // MAP_JIT
      prot |= PROT_EXEC;
    }
    base = BigInt(mmap(0, 4096, prot, flags, -1, 0));
    if (base === 0xffffffffffffffffn || base < 0n) {
      throw new Error('mmap failed for atomic stubs');
    }
    if (isMac && process.arch === 'arm64') {
      const unlock = libc.func('void pthread_jit_write_protect_np(int enable)');
      unlock(0);
      memcpy(base, blob, blob.length);
      unlock(1);
    } else {
      memcpy(base, blob, blob.length);
      if (mprotect(base, 4096, PROT_READ | PROT_EXEC) !== 0) {
        throw new Error('mprotect RX failed for atomic stubs');
      }
    }
  }
  fns = {
    xchg64: koffi.decode(base + BigInt(offsets.xchg64), XCHG64),
    cas64: koffi.decode(base + BigInt(offsets.cas64), CAS64),
    xchg32: koffi.decode(base + BigInt(offsets.xchg32), XCHG32),
    cas32: koffi.decode(base + BigInt(offsets.cas32), CAS32),
  };
  return fns;
}

function ops() {
  return fns || install();
}

function bind(addr) {
  const base = BigInt(addr);
  return {
    loadI64(offset) {
      return signed64(ops().cas64(base + BigInt(offset), 0n, 0n));
    },
    storeI64(offset, value) {
      ops().xchg64(base + BigInt(offset), signed64(value));
    },
    loadI32(offset) {
      return signed32(ops().cas32(base + BigInt(offset), 0, 0));
    },
    storeI32(offset, value) {
      ops().xchg32(base + BigInt(offset), signed32(value));
    },
    casI32(offset, expected, desired) {
      const prev = signed32(ops().cas32(base + BigInt(offset), signed32(desired), signed32(expected)));
      return prev === signed32(expected);
    },
  };
}

let mono = null;
function monoNs() {
  if (!mono) mono = makeMono();
  return mono();
}

function makeMono() {
  if (process.platform === 'win32') {
    const k32 = koffi.load('kernel32.dll');
    const qpc = k32.func('bool QueryPerformanceCounter(_Out_ int64 *c)');
    const qpf = k32.func('bool QueryPerformanceFrequency(_Out_ int64 *f)');
    const freqBox = [0n];
    if (!qpf(freqBox)) throw new Error('QueryPerformanceFrequency failed');
    const freq = BigInt(freqBox[0]);
    return () => {
      const now = [0n];
      qpc(now);
      return (BigInt(now[0]) * 1000000000n) / freq;
    };
  }
  const isMac = process.platform === 'darwin';
  const libc = koffi.load(isMac ? 'libSystem.B.dylib' : 'libc.so.6');
  const Timespec = koffi.struct('ShmTimespec', { sec: 'int64', nsec: 'int64' });
  const clock_gettime = libc.func('int clock_gettime(int clk, _Out_ ShmTimespec *ts)');
  const clk = isMac ? 6 : 1;
  return () => {
    const ts = {};
    if (clock_gettime(clk, ts) !== 0) throw new Error('clock_gettime failed');
    return BigInt(ts.sec) * 1000000000n + BigInt(ts.nsec);
  };
}

module.exports = { bind, monoNs, signed64 };
