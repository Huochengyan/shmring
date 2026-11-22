# Changelog

All notable changes to this project are documented here.
The wire format is versioned independently in [PROTOCOL.md](PROTOCOL.md).

## Unreleased

- Added a full Electron camera showcase at [`examples/electron-camera/`](examples/electron-camera/):
  Python `ShmRingWriter` + Electron `ShmRingReader.readBatch()` + Canvas, with
  `width/height/mime` carried in per-frame `meta`. The demo no longer implements
  any wire protocol of its own.
- Fixed a handle leak in `ShmRingReader` (both Python and Node): if the segment
  exists but the global header is not written yet, `magic` validation throws and
  the already-open mapping is now closed before the caller retries attach.
- `examples/` is now included in the npm tarball and sdist, so the
  `example:read` / `example:write` scripts work after installing the package.
- `pyproject.toml` uses the SPDX `license = "MIT"` string and drops the
  deprecated license classifier (setuptools deprecation, due 2027-02-18).

## 0.1.0 (2026-11-22)

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
- Published to PyPI; npm package not yet released (first publish needs a
  one-time manual authentication).
