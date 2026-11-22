#!/usr/bin/env python3
"""Minimal Python reader: attach to a segment written by any language."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from shmring import ShmRingReader  # noqa: E402

NAME = sys.argv[1] if len(sys.argv) > 1 else "shmring_example_js"
with ShmRingReader(NAME) as r:
    f = r.read()
    if f is None:
        print("no frame yet")
    else:
        print(f"frame #{f.frame_id}  payload={f.payload!r}  meta={f.meta!r}")
    b = r.read_batch(since=-1)
    print(f"batch {[x.frame_id for x in b.frames]}  dropped={b.dropped}")
