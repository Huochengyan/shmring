# Changelog

All notable changes to this project are documented here.
The wire format is versioned independently in [PROTOCOL.md](PROTOCOL.md).

## 0.1.0 (unreleased)

Initial extraction from the `electron-python-camera-demo` prototype.

- Protocol v1: 64-byte global header with `magic` / `version` / `endian` /
  `capacity` validation, 32-byte slot headers, N-slot ring, explicit seqlock.
- Python package: `ShmRingWriter` / `ShmRingReader`, POSIX + Windows backends,
  `resource_tracker` workaround, typed errors, `unlink()` cleanup.
- Node package: `ShmRingWriter` / `ShmRingReader` via `koffi` pure-JS FFI,
  Win32 (`CreateFileMappingW` / `OpenFileMappingW`) and POSIX
  (`shm_open` / `ftruncate` / `mmap`) backends. Uses `address + memcpy`
  instead of `koffi.view()` to avoid Electron's N-API crash.
- Generic opaque byte frames with optional `meta` (image-specific fields
  deliberately left to the application).
- Cross-language conformance test (`scripts/interop.js`), Python unittest
  suite, Node `node:test` suite, three-platform CI matrix.

### Known gaps

- Linux / macOS backends are covered by CI but not yet verified on real
  hardware by the maintainers.
- ARM / weak memory-order platforms unverified.
- Node side has no `replace` / in-place reset yet.
- Not yet published to PyPI / npm.
