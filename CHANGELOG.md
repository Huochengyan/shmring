# Changelog

All notable changes to this project are documented here.
The wire format is versioned independently in [PROTOCOL.md](PROTOCOL.md).

## Unreleased

- Added [`V2_DESIGN.md`](V2_DESIGN.md): a design-only document (no code) that
  records the v1 0.1.0 baseline with exact code/protocol references, the v1
  cleanup list for 0.2.0 (no wire change), and the full v1 -> v2 change table
  for a lossless queue: shared `write_pos`/`read_pos[]` cursors, reader
  write-back, backpressure/spill on full, acquire/release atomics, CRC32,
  block sequence numbers, writer liveness, delivery semantics, header draft,
  pseudocode, compatibility rules and acceptance criteria. Linked from
  `README.md` (roadmap + protocol section); included in npm/sdist manifests.
- Added `.github/workflows/publish.yml` for Trusted Publishing (OIDC) from
  GitHub Actions starting with 0.1.1: `v*` tag triggers, `id-token: write`,
  no token or secret in the repo, automatic provenance. Deliberately omits
  `registry-url` on `setup-node` (it injects a `NODE_AUTH_TOKEN` placeholder
  that prevents the OIDC exchange) and pins npm CLI >= 11.5.1.
- Documented the release flow in `README.md`: the 0.1.0 npm first publish must
  be interactive with 2FA (`npm login` + OTP). Bypass-2FA granular tokens can
  no longer direct-publish (GitHub Changelog 2026-07-31; `npm publish` returns
  E403), and Trusted Publishing is CI-only with a chicken-and-egg requirement
  that the package already exist. Also lists the one-time npmjs.com
  trusted-publisher settings and the 48-hour binding window for 0.1.1+.
- Normalized `repository.url` to the `git+https://` form npm expects, removing
  the `npm publish` auto-correct warning.
- Clarified positioning in `README.md` with a new "适用场景与不适用" section:
  decision criteria, direct-use scenarios, adaptation requirements for continuous
  streams (blocking, sequence numbers, CRC32, independent persistence), and
  explicit non-use cases (lossless recording, reliable delivery, multi-writer,
  cross-machine, ARM, unattended long-running).
- Replaced the misleading `zero-copy` keyword with `low-latency` in both
  `package.json` and `pyproject.toml`. The reader always copies payload/meta
  into an independent buffer (see PROTOCOL.md section 7); the remaining mentions
  of zero-copy views in docs are explicit warnings against that pattern.
- Added a second showcase at [`examples/electron-multi-camera/`](examples/electron-multi-camera/):
  one Python process publishing 5 independent named segments with pre-generated
  synthetic PNG frames, one Electron 2ms loop scanning 5 readers, a single batched
  IPC send and a 5-up Canvas grid with per-camera fps / frame age / dropped / online
  stats. It demonstrates that the library has no process-level mutable state and
  that N writer instances can publish concurrently as long as each owns its own
  segment.
- Added [`scripts/bench_multi.py`](scripts/bench_multi.py): 1-vs-N concurrent
  publish benchmark with latency percentiles, reader frame age / dropped counts
  and a GIL scaling ratio. Measured on Windows: 5 cameras at 30 fps each =
  147.2 fps total, 0 dropped, 1.41 ms avg frame age; unlimited publish reaches
  5.47 GB/s (0.76x the single-writer rate, i.e. no GIL-parallel speedup).
- Added [`scripts/verify_multi.py`](scripts/verify_multi.py): cross-language
  end-to-end check that starts the 5-segment Python writer and reads all five
  segments from Node, asserting PNG payload, meta `cam_id` / mime / size.
- Added quick benchmark + 5-segment cross-language verify steps to the CI matrix.
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
