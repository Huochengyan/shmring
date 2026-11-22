#!/usr/bin/env python3
"""Minimal Python writer: publish 30 fps-ish frames for 10 seconds.

Run this in one terminal, then `node examples/node_reader.js` in another.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from shmring import ShmRingWriter, unlink  # noqa: E402

NAME = "shmring_example"
try:
    unlink(NAME)
except Exception:
    pass

w = ShmRingWriter(NAME, capacity=1024 * 1024, replace=True)
print(f"writing to {NAME!r} ({w.info.payload_capacity} B/frame), 10s ...", flush=True)
try:
    for i in range(300):
        w.publish(f"py-frame-{i}".encode(), meta=b'{"src":"python"}')
        time.sleep(0.033)
finally:
    w.close()
print("done", flush=True)
