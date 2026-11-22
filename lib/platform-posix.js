'use strict';

// POSIX backend: shm_open + ftruncate + mmap via koffi (pure-JS FFI).
//
// NOTE: this backend is exercised by CI on Linux/macOS. The local development
// machine is Windows, so it is written against the platform ABI but must be
// verified by the cross-platform test matrix before a release.

const koffi = require('koffi');
const { ShmRingError, SegmentNotFound, SegmentExists } = require('./errors');

const isMac = process.platform === 'darwin';
const LIBC = isMac ? 'libSystem.B.dylib' : 'libc.so.6';
let libc;
try {
  libc = koffi.load(LIBC);
} catch (_) {
  libc = koffi.load(isMac ? '/usr/lib/libSystem.B.dylib' : LIBC);
}

const shm_open = libc.func('int shm_open(str name, int oflag, uint32_t mode)');
const shm_unlink = libc.func('int shm_unlink(str name)');
const ftruncate = libc.func('int ftruncate(int fd, int64_t length)');
const lseek = libc.func('int64_t lseek(int fd, int64_t offset, int whence)');
const mmap = libc.func(
  'void *mmap(void *addr, size_t len, int prot, int flags, int fd, int64_t offset)'
);
const munmap = libc.func('int munmap(void *addr, size_t len)');
const closeFd = libc.func('int close(int fd)');
const memcpy = libc.func('void *memcpy(void *dst, void *src, size_t n)');

// O_* flags differ between Linux and Darwin; O_RDONLY/O_RDWR are both 0/2.
const O = isMac
  ? { RDONLY: 0, RDWR: 2, CREAT: 0x0200, EXCL: 0x0800 }
  : { RDONLY: 0, RDWR: 2, CREAT: 0x0040, EXCL: 0x0080 };
const PROT_READ = 1;
const PROT_WRITE = 2;
const MAP_SHARED = 1;
const SEEK_END = 2;
const MODE = 0o600;
const MAP_FAILED = 0xffffffffffffffffn;

function toBuffer(x) {
  if (Buffer.isBuffer(x)) return x;
  if (ArrayBuffer.isView(x)) return Buffer.from(x.buffer, x.byteOffset, x.byteLength);
  if (typeof x === 'string') return Buffer.from(x, 'utf8');
  return Buffer.from(x);
}

function makeMapping(native, base, addr, size, writable) {
  let closed = false;
  const m = {
    addr, size, writable,
    read(offset, length) {
      if (offset < 0 || length < 0 || (m.size && offset + length > m.size)) {
        throw new RangeError(`shared memory out of bounds: offset=${offset} length=${length} size=${m.size}`);
      }
      const out = Buffer.allocUnsafe(length);
      memcpy(out, addr + BigInt(offset), length);
      return out;
    },
    write(offset, src) {
      const b = toBuffer(src);
      if (offset < 0 || (m.size && offset + b.length > m.size)) {
        throw new RangeError(`shared memory out of bounds: offset=${offset} length=${b.length} size=${m.size}`);
      }
      memcpy(addr + BigInt(offset), b, b.length);
    },
    close() {
      if (closed) return;
      closed = true;
      munmap(base, m.size || 0);
    },
    unlink() {
      shm_unlink(native);
    },
  };
  return m;
}

function open(logical, native, opts = {}) {
  const { create = false, writable = false, capacity = 0 } = opts;
  const flags = create
    ? (O.RDWR | O.CREAT | O.EXCL)
    : (writable ? O.RDWR : O.RDONLY);
  const fd = shm_open(native, flags, create ? MODE : 0);
  if (fd < 0) {
    if (create) {
      throw new SegmentExists(
        `shm_open("${native}") failed (fd=${fd}); a segment with this name may already exist`
      );
    }
    throw new SegmentNotFound(`no shared memory segment named ${logical} ("${native}")`);
  }

  let size;
  try {
    if (create) {
      if (!capacity) throw new ShmRingError('capacity is required when create=true');
      if (ftruncate(fd, capacity) < 0) {
        throw new ShmRingError(`ftruncate(${capacity}) failed`);
      }
      size = capacity;
    } else {
      size = Number(lseek(fd, 0n, SEEK_END));
      if (!(size > 0)) throw new ShmRingError(`segment ${logical} has invalid size ${size}`);
    }
    const prot = writable ? (PROT_READ | PROT_WRITE) : PROT_READ;
    const base = mmap(null, size, prot, MAP_SHARED, fd, 0n);
    if (!base) throw new ShmRingError(`mmap failed for ${native}`);
    let addr;
    try {
      addr = BigInt(koffi.address(base));
    } catch (_) {
      throw new ShmRingError(`mmap returned an unusable pointer for ${native}`);
    }
    if (addr === MAP_FAILED || addr === -1n) {
      throw new ShmRingError(`mmap returned MAP_FAILED for ${native}`);
    }
    return makeMapping(native, base, addr, size, writable);
  } catch (err) {
    if (create) shm_unlink(native);
    throw err;
  } finally {
    closeFd(fd); // the mapping stays valid after the descriptor is closed
  }
}

function unlink(_logical, native) {
  return shm_unlink(native) === 0;
}

module.exports = { open, unlink, toBuffer };
