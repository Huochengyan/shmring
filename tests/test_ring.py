"""Python unit tests: python -m unittest discover -s tests -v"""

from __future__ import annotations

import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import shmring
from shmring import ShmRingReader, ShmRingWriter, unlink
from shmring import _protocol as P


class RingTests(unittest.TestCase):
    def setUp(self):
        self.name = "shmring_pytest_" + str(int(time.time_ns() % 10**9))
        self.cleanup = []
        try:
            unlink(self.name)
        except Exception:
            pass

    def tearDown(self):
        for obj in reversed(self.cleanup):
            try:
                obj.close()
            except Exception:
                pass
        try:
            unlink(self.name)
        except Exception:
            pass

    def writer(self, **kw):
        w = ShmRingWriter(self.name, capacity=256 * 1024, slot_count=4,
                          meta_capacity=64, **kw)
        self.cleanup.append(w)
        return w

    def test_latest_frame_and_meta(self):
        w = self.writer()
        for i in range(7):
            self.assertEqual(w.publish(b"frame-%d" % i, b"meta%d" % i), i)
        r = ShmRingReader(self.name)
        self.cleanup.append(r)
        f = r.read()
        self.assertIsNotNone(f)
        self.assertEqual(f.frame_id, 6)
        self.assertEqual(f.payload, b"frame-6")
        self.assertEqual(f.meta, b"meta6")
        self.assertEqual(f.seq % 2, 0)

    def test_batch_is_a_window_not_a_queue(self):
        w = self.writer()
        for i in range(7):
            w.publish(b"f%d" % i)
        r = ShmRingReader(self.name)
        self.cleanup.append(r)
        b = r.read_batch(since=-1)
        self.assertEqual([f.frame_id for f in b.frames], [3, 4, 5, 6])
        self.assertEqual(b.dropped, 3)
        self.assertEqual(b.newest, 6)
        # cursor advances; a second call returns nothing new
        self.assertEqual(r.read_batch().frames, [])

    def test_binary_payload_and_empty_meta(self):
        w = self.writer()
        payload = bytes(range(256)) + b"\x00\xff\x89PNG"
        w.publish(payload)
        r = ShmRingReader(self.name)
        self.cleanup.append(r)
        f = r.read()
        self.assertEqual(f.payload, payload)
        self.assertEqual(f.meta, b"")

    def test_capacity_guard(self):
        w = self.writer()
        with self.assertRaises(shmring.CapacityError):
            w.publish(b"x" * (w.payload_capacity + 1))
        with self.assertRaises(shmring.CapacityError):
            w.publish(b"ok", meta=b"m" * (w.meta_capacity + 1))

    def test_protocol_rejects_wrong_magic(self):
        w = self.writer()
        w._seg.buf[0:4] = b"NOPE"
        with self.assertRaises(shmring.ProtocolError):
            ShmRingReader(self.name)
        w._seg.buf[0:4] = P.MAGIC.to_bytes(4, "little")

    def test_protocol_rejects_wrong_version(self):
        w = self.writer()
        w._seg.buf[4:6] = (99).to_bytes(2, "little")
        with self.assertRaises(shmring.ProtocolError):
            ShmRingReader(self.name)
        w._seg.buf[4:6] = P.VERSION.to_bytes(2, "little")

    def test_seqlock_skips_write_in_progress(self):
        w = self.writer()
        w.publish(b"ok")
        # Force an odd seq (writer mid-publish) and verify the reader refuses it.
        P.pack_global(w._seg.buf, w._layout, w._seq + 1, w._frame_id, w._stamp)
        r = ShmRingReader(self.name)
        self.cleanup.append(r)
        self.assertIsNone(r.read())
        P.pack_global(w._seg.buf, w._layout, w._seq, w._frame_id, w._stamp)
        self.assertEqual(r.read().payload, b"ok")

    def test_multiple_readers_have_independent_cursors(self):
        w = self.writer()
        for i in range(3):
            w.publish(b"f%d" % i)
        r1 = ShmRingReader(self.name)
        r2 = ShmRingReader(self.name)
        self.cleanup.extend([r1, r2])
        self.assertEqual([f.frame_id for f in r1.read_batch(since=-1).frames], [0, 1, 2])
        self.assertEqual([f.frame_id for f in r2.read_batch(since=-1).frames], [0, 1, 2])

    def test_missing_segment(self):
        with self.assertRaises(shmring.SegmentNotFound):
            ShmRingReader("shmring_definitely_missing_" + str(time.time_ns()))

    def test_replace_existing_segment(self):
        self.writer().publish(b"old")
        w2 = ShmRingWriter(self.name, capacity=256 * 1024, slot_count=4,
                           meta_capacity=64, replace=True)
        self.cleanup.append(w2)
        w2.publish(b"new")
        r = ShmRingReader(self.name)
        self.cleanup.append(r)
        self.assertEqual(r.read().payload, b"new")

    def test_subscribe_delivers_newest_frame(self):
        w = self.writer()
        r = ShmRingReader(self.name)
        self.cleanup.append(r)
        seen = []
        sub = r.subscribe(seen.append, interval_ms=5)
        w.publish(b"one")
        w.publish(b"two")
        deadline = time.time() + 1
        while time.time() < deadline and (not seen or seen[-1].payload != b"two"):
            time.sleep(0.01)
        sub.stop()
        self.assertTrue(seen)
        self.assertEqual(seen[-1].frame_id, 1)
        self.assertEqual(seen[-1].payload, b"two")
        self.assertEqual(r.last_frame_id, -1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
