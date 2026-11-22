#!/usr/bin/env python3
"""Cross-language interop peer (Python side). Not part of the public API.

Usage:
  python scripts/peer.py --role writer --name X --count 7 --hold 8
  python scripts/peer.py --role reader --name X
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from shmring import ShmRingReader, ShmRingWriter, unlink  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--role", choices=["writer", "reader"], required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--count", type=int, default=7)
    ap.add_argument("--hold", type=float, default=8.0)
    ap.add_argument("--capacity", type=int, default=1024 * 1024)
    ap.add_argument("--slots", type=int, default=4)
    ap.add_argument("--meta", type=int, default=64)
    args = ap.parse_args()

    if args.role == "writer":
        try:
            unlink(args.name)
        except Exception:
            pass
        w = ShmRingWriter(
            args.name, capacity=args.capacity, slot_count=args.slots,
            meta_capacity=args.meta, replace=True,
        )
        for i in range(args.count):
            w.publish(f"py-frame-{i}".encode(), f"py-meta-{i}".encode())
        print("READY", flush=True)
        try:
            time.sleep(args.hold)
        finally:
            w.close()
        return

    r = ShmRingReader(args.name)
    f = r.read()
    if f is None:
        print(json.dumps({"error": "no frame"}), flush=True)
        sys.exit(1)
    b = r.read_batch(since=-1)
    print(json.dumps({
        "latest": {
            "frameId": f.frame_id,
            "payload": f.payload.decode("utf-8", "replace"),
            "meta": f.meta.decode("utf-8", "replace"),
            "seqEven": f.seq % 2 == 0,
        },
        "batchIds": [x.frame_id for x in b.frames],
        "batchPayloads": [x.payload.decode("utf-8", "replace") for x in b.frames],
        "batchMetas": [x.meta.decode("utf-8", "replace") for x in b.frames],
        "dropped": b.dropped,
        "newest": b.newest,
        "info": {k: v for k, v in r.info.items() if isinstance(v, (int, str))},
    }), flush=True)
    r.close()


if __name__ == "__main__":
    main()
