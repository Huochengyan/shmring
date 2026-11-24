# Changelog

All notable changes to this project are documented here.
The wire format is versioned independently in [PROTOCOL.md](PROTOCOL.md).

## Unreleased

- Added `subscribe(callback)` on v1 and v2 readers in Python and Node. A
  process-local loop polls every 2 ms by default and hands the newest frame
  copy to the callback. It does not move the read cursor or run inside
  `publish()`.
- Recorded a Windows run of `scripts/bench_multi.py` (v1, 40960-byte frames,
  2026-11-24): paced case 21.2 fps for 1 lane and 106.7 fps for 5 lanes, 0
  dropped; unlimited publish 245924 fps and 145448 fps (0.59×).
- Aligned the README, `V2_DESIGN.md`, and the five-camera example with the
  code. PyPI still serves 0.1.0. v2 CRC32 is on by default. v1 and v2 are both
  single-writer. The example documents the 160-channel series lane and the
  editable scan interval. v2 atomics are machine-code stubs, not
  `InterlockedExchange64`.

## 0.2.0 (2026-11-24)

- Implemented v2 in Python (`ShmRingWriterV2` / `ShmRingReaderV2`) and Node.
  `publish()` never waits: `overwrite` stores the frame, `return` hands it back
  when a live retainer still holds the slot. Observers do not affect the writer.
  Header is 1024 bytes; offset 136 is `retainer_slot` (`-1` when none).
  The five-camera example uses v2. `--real-camera` puts a real camera on lane 0
  and falls back to a synthetic PNG when ffmpeg or a device is missing.
  `scripts/verify_multi.py` stays on synthetic frames. `scripts/interop_v2.js`
  checks Python and Node against each other.
- Revised [`V2_DESIGN.md`](V2_DESIGN.md). v2 does not
  block the writer on a slow reader and does not spill inside the library.
  `publish()` returns immediately: `overwrite` stores the new frame and a
  lagging reader observes a gap on its own cursor; `return` hands that frame
  back to the caller when a live retainer still occupies the slot. Observers
  never affect the writer. Header is 1024 bytes with `write_pos` on its own
  cache line, per-slot seqlock, optional CRC32, and monotonic heartbeats.
  Linked from `README.md`; included in npm/sdist manifests.
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
