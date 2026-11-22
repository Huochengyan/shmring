'use strict';

// Windows backend: named file-mapping objects in the session kernel namespace.
// Uses koffi (pure-JS FFI, no node-gyp / C++ addon).
//
// IMPORTANT: never use koffi.view() on the mapped pointer. In Electron's
// embedded Node it triggers `napi_is_detached_arraybuffer` FATAL ERROR.
// Always copy with memcpy(buf, addr + offset, len).

const koffi = require('koffi');
const { ShmRingError, SegmentNotFound, SegmentExists } = require('./errors');

const k32 = koffi.load('kernel32.dll');
const CreateFileMappingW = k32.func(
  'void *CreateFileMappingW(uint64_t hFile, void *lpAttr, uint32_t protect, uint32_t hi, uint32_t lo, str16 name)'
);
const OpenFileMappingW = k32.func(
  'void *OpenFileMappingW(uint32_t access, bool inherit, str16 name)'
);
const MapViewOfFile = k32.func(
  'void *MapViewOfFile(void *h, uint32_t access, uint32_t hi, uint32_t lo, size_t bytes)'
);
const UnmapViewOfFile = k32.func('bool UnmapViewOfFile(void *base)');
const CloseHandle = k32.func('bool CloseHandle(void *h)');
const GetLastError = k32.func('uint32_t GetLastError()');
const memcpy = koffi.load('msvcrt.dll').func('void *memcpy(void *dst, void *src, size_t n)');

const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const PAGE_READWRITE = 0x04;
const FILE_MAP_READ = 0x0004;
const FILE_MAP_WRITE = 0x0002;
const ERROR_ALREADY_EXISTS = 183;

function toBuffer(x) {
  if (Buffer.isBuffer(x)) return x;
  if (ArrayBuffer.isView(x)) return Buffer.from(x.buffer, x.byteOffset, x.byteLength);
  if (typeof x === 'string') return Buffer.from(x, 'utf8');
  return Buffer.from(x);
}

function makeMapping(handle, base, addr, size, writable) {
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
      try { UnmapViewOfFile(base); } finally { CloseHandle(handle); }
    },
    unlink() {
      // Windows file mappings are refcounted by the kernel: closing the last
      // handle removes the object. There is no separate shm_unlink().
    },
  };
  return m;
}

function open(logical, _native, opts = {}) {
  const { create = false, writable = false, capacity = 0 } = opts;
  const access = writable ? (FILE_MAP_READ | FILE_MAP_WRITE) : FILE_MAP_READ;
  let handle = null;

  if (create) {
    if (!capacity) throw new ShmRingError('capacity is required when create=true');
    handle = CreateFileMappingW(
      INVALID_HANDLE_VALUE, null, PAGE_READWRITE, 0, capacity, logical
    );
    if (!handle) {
      throw new ShmRingError(`CreateFileMappingW failed, GetLastError=${GetLastError()}`);
    }
    if (GetLastError() === ERROR_ALREADY_EXISTS) {
      CloseHandle(handle);
      throw new SegmentExists(
        `segment ${logical} already exists; close every holder or call unlink()`
      );
    }
  } else {
    handle = OpenFileMappingW(access, false, logical);
    if (!handle) {
      throw new SegmentNotFound(
        `no shared memory segment named ${logical} (GetLastError=${GetLastError()})`
      );
    }
  }

  // bytes=0 maps the whole object, so attach does not need to know its size.
  const base = MapViewOfFile(handle, access, 0, 0, create ? capacity : 0);
  if (!base) {
    const err = GetLastError();
    CloseHandle(handle);
    throw new ShmRingError(`MapViewOfFile failed, GetLastError=${err}`);
  }
  const addr = BigInt(koffi.address(base));
  // size is filled in from the global header by ShmRingReader after attach.
  return makeMapping(handle, base, addr, create ? capacity : 0, writable);
}

function unlink(_logical, _native) {
  // Windows: no explicit unlink; the object disappears once all handles close.
  return false;
}

module.exports = { open, unlink, toBuffer };
