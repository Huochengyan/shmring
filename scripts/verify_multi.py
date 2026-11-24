#!/usr/bin/env python3
"""跨语言、多段端到端验证：5 路合成帧写端（Python）→ 5 个 reader（Node）。

与 scripts/interop.js 的双向对拍互补：这里验证的是「同一进程多段并发写」
在真实跨进程读端下依然成立，且每帧 meta 能正确把 cam_id 送到另一侧。

    python scripts/verify_multi.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(
    ROOT, "examples", "electron-multi-camera", "python", "server.py"
)
PNG_SIGNATURE_HEX = "89504e470d0a1a0a"

NODE_CODE = r"""
const shm = require(process.argv[1]);
const names = JSON.parse(process.argv[2]);
const out = names.map((n, i) => {
  const r = new shm.ShmRingReaderV2(n, { join: 'window' });
  const b = r.readBatch();
  const f = b.frames.length ? b.frames[b.frames.length - 1] : null;
  r.close();
  return {
    cam: i + 1,
    frames: b.frames.length,
    newest: f ? f.seq : -1,
    dropped: b.gap ? b.gap.dropped : 0,
    bytes: f ? f.payload.length : 0,
    meta: f ? f.meta.toString() : '',
    png: f ? f.payload.slice(0, 8).toString('hex') : '',
  };
});
console.log(JSON.stringify(out));
"""


def main() -> int:
    prefix = "shmring_verify_" + os.urandom(3).hex()
    names = [f"{prefix}_{i + 1}" for i in range(5)]
    env = dict(os.environ)
    env["PYTHONUNBUFFERED"] = "1"

    server = subprocess.Popen(
        [
            sys.executable,
            SERVER,
            "--names", ",".join(names),
            "--cam-count", "5",
            "--fps", "30",
            "--buffer-kb", "512",
            "--stats-interval", "1",
        ],
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        time.sleep(1.5)  # 等 5 个段的全局头写完并产出若干帧
        result = subprocess.run(
            ["node", "-e", NODE_CODE, os.path.join(ROOT, "index.js"), json.dumps(names)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=20,
        )
        if result.returncode != 0:
            print("NODE FAILED:", result.stdout, result.stderr, file=sys.stderr)
            return 1
        rows = json.loads(result.stdout.strip().splitlines()[-1])
        assert len(rows) == 5, f"expected 5 segments, got {len(rows)}"
        # join=window 读到当前还在环里的帧。dropped 只在窗口起点之前有空洞时非 0。
        for row in rows:
            cam = row["cam"]
            assert row["frames"] > 0, f"cam {cam}: no frames read"
            assert row["newest"] >= 0, f"cam {cam}: no published frame"
            assert row["png"] == PNG_SIGNATURE_HEX, f"cam {cam}: bad PNG signature"
            assert row["bytes"] > 1000, f"cam {cam}: payload too small"
            meta = json.loads(row["meta"])
            assert meta["cam"] == cam, f"cam {cam}: meta cam mismatch {meta}"
            assert meta["mime"] == "image/png", f"cam {cam}: wrong mime"
            assert meta["w"] == 640 and meta["h"] == 360, f"cam {cam}: wrong size"
            print(
                f"  cam {cam}: newest={row['newest']} frames={row['frames']} "
                f"dropped={row['dropped']} bytes={row['bytes']} meta={row['meta']}"
            )
        print("VERIFY PASS (5/5 segments, Python writer -> Node reader)")
        return 0
    finally:
        server.terminate()
        try:
            out, _ = server.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            out, _ = server.communicate()
        first = "\n".join(out.splitlines()[:3])
        if first:
            print("[python 写端] " + first.replace("\n", "\n[python 写端] "))


if __name__ == "__main__":
    raise SystemExit(main())
