'use strict';

const isWindows = process.platform === 'win32';
let _impl = null;

// Lazy: requiring the POSIX backend on Windows would try to load libc.so.6
// at module load time and crash before any platform check happens.
function getPlatform() {
  if (!_impl) {
    _impl = isWindows
      ? require('./platform-win32')
      : require('./platform-posix');
  }
  return _impl;
}

function toBuffer(x) {
  return getPlatform().toBuffer(x);
}

/** Logical name (no slash) -> OS object name. */
function normalizeName(name, forPosix = !isWindows) {
  if (!name || typeof name !== 'string' || name.includes('/') || name.includes('\\')) {
    throw new TypeError('name must be a non-empty string without / or \\');
  }
  if (!forPosix) return name;
  const native = '/' + name;
  if (process.platform === 'darwin' && Buffer.byteLength(native, 'utf8') > 31) {
    throw new RangeError(`POSIX/macOS shared memory name too long (${Buffer.byteLength(native)} bytes, max 31)`);
  }
  return native;
}

/** Open (create or attach) a segment by logical name. */
function open(name, opts = {}) {
  const logical = normalizeName(name, false); // validates; Windows form (no slash)
  const native = normalizeName(name);         // POSIX form (leading slash)
  return getPlatform().open(logical, native, opts);
}

/** Remove a segment by logical name (best-effort cleanup after a crash). */
function unlink(name) {
  const logical = normalizeName(name, false);
  const native = normalizeName(name);
  return getPlatform().unlink(logical, native);
}

module.exports = { isWindows, getPlatform, normalizeName, open, unlink, toBuffer };
