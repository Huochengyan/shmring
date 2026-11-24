'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const shm = require('../index.js');

const CAP = 256 * 1024;
let n = 0;
function fresh() {
  return `shmring_v2js_${process.pid}_${Date.now()}_${n++}`;
}

function writer(name, opts = {}) {
  return new shm.ShmRingWriterV2(name, {
    capacity: CAP, slotCount: 4, metaCapacity: 64, replace: true, ...opts,
  });
}

test('commit is explicit and checksummed meta round-trips', () => {
  const name = fresh();
  const w = writer(name);
  const r = new shm.ShmRingReaderV2(name, { join: 'tip' });
  assert.deepEqual(w.publish(Buffer.from('hello'), Buffer.from('meta'), 7), { accepted: true, frameId: 0 });
  const f = r.read();
  assert.equal(f.seq, 0);
  assert.equal(f.payload.toString(), 'hello');
  assert.equal(f.meta.toString(), 'meta');
  assert.equal(f.stamp, 7);
  r.commit(0);
  assert.equal(r.read(), null);
  r.close();
  w.unlink();
});

test('slow observer gaps only itself', () => {
  const name = fresh();
  const w = writer(name, { slotCount: 2 });
  const fast = new shm.ShmRingReaderV2(name, { join: 'tip' });
  const slow = new shm.ShmRingReaderV2(name, { join: 'tip' });
  const seen = [];
  for (let i = 0; i < 3; i++) {
    w.publish(Buffer.from(`f${i}`));
    const frame = fast.read();
    seen.push(frame.payload.toString());
    fast.commit(frame.seq);
  }
  assert.deepEqual(seen, ['f0', 'f1', 'f2']);
  const gap = slow.read();
  assert.equal(gap.dropped, 1);
  assert.equal(gap.nextSeq, 1);
  slow.skipTo(gap.nextSeq);
  const rest = [];
  for (;;) {
    const item = slow.read();
    if (!item) break;
    rest.push(item.payload.toString());
    slow.commit(item.seq);
  }
  assert.deepEqual(rest, ['f1', 'f2']);
  fast.close(); slow.close(); w.unlink();
});

test('return rejects while a live retainer holds the slot', () => {
  const name = fresh();
  const w = writer(name, { slotCount: 2, overflow: 'return', staleMs: 80 });
  const retainer = new shm.ShmRingReaderV2(name, { role: 'retainer', join: 'tip' });
  assert.equal(w.publish(Buffer.from('a')).accepted, true);
  assert.equal(w.publish(Buffer.from('b')).accepted, true);
  assert.equal(w.publish(Buffer.from('c')).accepted, false);
  const frame = retainer.read();
  retainer.commit(frame.seq);
  assert.equal(w.publish(Buffer.from('c')).accepted, true);
  retainer.close();
  w.unlink();
});

test('v1 reader rejects a v2 segment', () => {
  const name = fresh();
  const w = writer(name);
  assert.throws(() => new shm.ShmRingReader(name), shm.ProtocolError);
  w.unlink();
});

test('checksum mismatch does not advance', () => {
  const name = fresh();
  const w = writer(name);
  const r = new shm.ShmRingReaderV2(name, { join: 'tip' });
  w.publish(Buffer.from('abcdef'));
  const off = 1024 + 64 + 64; // header + slot header + meta capacity
  const byte = w.m.read(off, 1);
  byte[0] ^= 0xff;
  w.m.write(off, byte);
  assert.throws(() => r.read(), shm.ChecksumError);
  assert.equal(r.readPos, 0);
  r.close();
  w.unlink();
});
