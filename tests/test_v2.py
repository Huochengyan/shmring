"""v2: python -m unittest tests.test_v2"""

from __future__ import annotations

import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import shmring
from shmring import (
    ChecksumError, Gap, ProtocolError, ShmRingReader, ShmRingReaderV2,
    ShmRingWriterV2, unlink,
)
from shmring import _protocol_v2 as P


class V2Tests(unittest.TestCase):
    def setUp(self):
        self.names = []
        self.cleanup = []

    def tearDown(self):
        for obj in reversed(self.cleanup):
            try:
                obj.close()
            except Exception:
                pass
        for name in self.names:
            try:
                unlink(name)
            except Exception:
                pass

    def name(self) -> str:
        n = "shmring_v2_" + str(time.time_ns() % 10**12)
        self.names.append(n)
        try:
            unlink(n)
        except Exception:
            pass
        return n

    def writer(self, name, **kw):
        kw.setdefault("capacity", 256 * 1024)
        kw.setdefault("slot_count", 4)
        kw.setdefault("meta_capacity", 64)
        kw.setdefault("replace", True)
        w = ShmRingWriterV2(name, **kw)
        self.cleanup.append(w)
        return w

    def reader(self, name, **kw):
        r = ShmRingReaderV2(name, **kw)
        self.cleanup.append(r)
        return r

    def test_round_trip_and_commit_does_not_repeat(self):
        name = self.name()
        w = self.writer(name)
        r = self.reader(name, join="tip")
        result = w.publish(b"hello", b"meta", stamp=42)
        self.assertTrue(result.accepted)
        self.assertEqual(result.frame_id, 0)
        frame = r.read()
        self.assertEqual(frame.seq, 0)
        self.assertEqual(frame.payload, b"hello")
        self.assertEqual(frame.meta, b"meta")
        self.assertEqual(frame.stamp, 42)
        again = r.read()
        self.assertEqual(again.payload, b"hello")
        r.commit(0)
        self.assertIsNone(r.read())

    def test_batch_then_commit(self):
        name = self.name()
        w = self.writer(name, slot_count=4)
        r = self.reader(name, join="window")
        for i in range(3):
            w.publish(f"f{i}".encode(), f"m{i}".encode())
        batch = r.read_batch()
        self.assertIsNone(batch.gap)
        self.assertEqual([f.seq for f in batch.frames], [0, 1, 2])
        for frame in batch.frames:
            r.commit(frame.seq)
        self.assertEqual(r.read_batch().frames, [])

    def test_slow_observer_gaps_only_itself(self):
        name = self.name()
        w = self.writer(name, slot_count=2)
        fast = self.reader(name, join="tip")
        slow = self.reader(name, join="tip")
        seen = []
        for i in range(3):
            w.publish(f"f{i}".encode())
            frame = fast.read()
            seen.append(frame.payload)
            fast.commit(frame.seq)
        self.assertEqual(seen, [b"f0", b"f1", b"f2"])
        self.assertIsNone(fast.read())
        gap = slow.read()
        self.assertEqual(gap, Gap(1, 1))
        slow.skip_to(gap.next_seq)
        rest = []
        while True:
            item = slow.read()
            if item is None:
                break
            self.assertNotIsInstance(item, Gap)
            rest.append(item.payload)
            slow.commit(item.seq)
        self.assertEqual(rest, [b"f1", b"f2"])

    def test_publish_does_not_wait_on_a_slow_reader(self):
        name = self.name()
        w = self.writer(name, slot_count=2)
        self.reader(name, join="tip")
        began = time.perf_counter()
        for i in range(200):
            result = w.publish(b"x")
            self.assertTrue(result.accepted)
        self.assertLess(time.perf_counter() - began, 0.5)

    def test_return_without_retainer_always_accepts(self):
        name = self.name()
        w = self.writer(name, slot_count=2, overflow="return")
        for i in range(6):
            self.assertTrue(w.publish(f"{i}".encode()).accepted)

    def test_return_hands_frame_back_until_commit_or_stale(self):
        name = self.name()
        w = self.writer(name, slot_count=2, overflow="return", stale_ms=80)
        retainer = self.reader(name, role="retainer", join="tip")
        self.assertTrue(w.publish(b"a").accepted)
        self.assertTrue(w.publish(b"b").accepted)
        base = P.slot_base(0, w.info.slot_size)
        before = bytes(w._seg.buf[base: base + 32])
        rejected = w.publish(b"c")
        self.assertFalse(rejected.accepted)
        self.assertIsNone(rejected.frame_id)
        self.assertEqual(bytes(w._seg.buf[base: base + 32]), before)
        frame = retainer.read()
        retainer.commit(frame.seq)
        self.assertTrue(w.publish(b"c").accepted)
        self.assertFalse(w.publish(b"d").accepted)
        time.sleep(0.12)
        self.assertTrue(w.publish(b"d").accepted)

    def test_second_retainer_is_rejected(self):
        name = self.name()
        self.writer(name, overflow="return")
        self.reader(name, role="retainer")
        with self.assertRaises(shmring.ShmRingError):
            self.reader(name, role="retainer")

    def test_checksum_mismatch_does_not_advance(self):
        name = self.name()
        w = self.writer(name)
        r = self.reader(name, join="tip")
        w.publish(b"abcdef")
        # payload starts at slot header (64) + meta_capacity (64)
        off = P.slot_base(0, w.info.slot_size) + P.SLOT_HEADER_SIZE + 64
        w._seg.buf[off] = (w._seg.buf[off] ^ 0xFF) & 0xFF
        with self.assertRaises(ChecksumError):
            r.read()
        self.assertEqual(r.read_pos, 0)

    def test_v1_reader_rejects_v2_segment(self):
        name = self.name()
        self.writer(name)
        with self.assertRaises(ProtocolError):
            ShmRingReader(name)

    def test_subscribe_delivers_latest_without_moving_cursor(self):
        name = self.name()
        w = self.writer(name)
        r = self.reader(name, join="tip")
        seen = []
        sub = r.subscribe(seen.append, interval_ms=5)
        for i in range(3):
            w.publish(bytes([i]))
        deadline = time.time() + 1
        while time.time() < deadline and (not seen or seen[-1].seq != 2):
            time.sleep(0.01)
        sub.stop()
        self.assertTrue(seen)
        self.assertEqual(seen[-1].seq, 2)
        self.assertEqual(seen[-1].payload, bytes([2]))
        self.assertEqual([frame.seq for frame in seen], sorted(frame.seq for frame in seen))
        self.assertEqual(r.read_pos, 0)
        self.assertEqual(r.read().seq, 0)
        w.publish(b"after")
        time.sleep(0.05)
        self.assertEqual(seen[-1].seq, 2)

    def test_overwrite_ignores_retainer(self):
        name = self.name()
        w = self.writer(name, slot_count=2, overflow="overwrite")
        self.reader(name, role="retainer", join="tip")
        for i in range(5):
            self.assertTrue(w.publish(b"z").accepted)


if __name__ == "__main__":
    unittest.main()
