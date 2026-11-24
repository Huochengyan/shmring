'use strict';

// Node unit tests: npm test  (node --test test/)
const test = require('node:test');
const assert = require('node:assert/strict');
const shm = require('../index.js');

const CAP = 256 * 1024;
let seq = 0;
function freshName() {
  return `shmring_jstest_${process.pid}_${Date.now()}_${seq++}`;
}
function makeWriter(name, opts = {}) {
  return new shm.ShmRingWriter(name, {
    capacity: CAP, slotCount: 4, metaCapacity: 64, ...opts,
  });
}

test('latest frame and meta round-trip', () => {
  const name = freshName();
  const w = makeWriter(name);
  for (let i = 0; i < 7; i++) {
    assert.equal(w.publish(Buffer.from(`frame-${i}`), Buffer.from(`meta${i}`)), i);
  }
  const r = new shm.ShmRingReader(name);
  const f = r.read();
  assert.ok(f);
  assert.equal(f.frameId, 6);
  assert.equal(f.payload.toString(), 'frame-6');
  assert.equal(f.meta.toString(), 'meta6');
  assert.equal(f.seq % 2, 0);
  r.close(); w.close();
});

test('batch keeps only the newest slotCount frames', () => {
  const name = freshName();
  const w = makeWriter(name);
  for (let i = 0; i < 7; i++) w.publish(Buffer.from(`f${i}`));
  const r = new shm.ShmRingReader(name);
  const b = r.readBatch(-1);
  assert.deepEqual(b.frames.map((x) => x.frameId), [3, 4, 5, 6]);
  assert.equal(b.dropped, 3);
  assert.equal(b.newest, 6);
  assert.equal(r.readBatch().frames.length, 0);
  r.close(); w.close();
});

test('binary payload and empty meta survive', () => {
  const name = freshName();
  const w = makeWriter(name);
  const payload = Buffer.from([...Array(256).keys(), 0, 255, 0x89, 0x50, 0x4e, 0x47]);
  w.publish(payload);
  const r = new shm.ShmRingReader(name);
  const f = r.read();
  assert.deepEqual(f.payload, payload);
  assert.equal(f.meta.length, 0);
  r.close(); w.close();
});

test('capacity guard throws a typed error', () => {
  const name = freshName();
  const w = makeWriter(name);
  assert.throws(
    () => w.publish(Buffer.alloc(w.payloadCapacity + 1)),
    (e) => e.name === 'CapacityError'
  );
  assert.throws(
    () => w.publish(Buffer.from('ok'), Buffer.alloc(w.metaCapacity + 1)),
    (e) => e.name === 'CapacityError'
  );
  w.close();
});

test('protocol rejects a corrupted magic', () => {
  const name = freshName();
  const w = makeWriter(name);
  w.m.write(0, Buffer.from('NOPE'));
  assert.throws(
    () => new shm.ShmRingReader(name),
    (e) => e.name === 'ProtocolError' && /magic/i.test(e.message)
  );
  w.m.write(0, Buffer.from([0x53, 0x48, 0x4d, 0x52]));
  w.close();
});

test('seqlock skips a write-in-progress frame', () => {
  const name = freshName();
  const w = makeWriter(name);
  w.publish(Buffer.from('ok'));
  const P = require('../lib/protocol.js');
  w.m.write(0, P.writeGlobal(w.layout, w.seq + 1n, w.frameId, w.stamp));
  const r = new shm.ShmRingReader(name);
  assert.equal(r.read(), null);
  w.m.write(0, P.writeGlobal(w.layout, w.seq, w.frameId, w.stamp));
  assert.equal(r.read().payload.toString(), 'ok');
  r.close(); w.close();
});

test('attaching a missing segment throws a typed error', () => {
  assert.throws(
    () => new shm.ShmRingReader(`shmring_missing_${process.pid}_${Date.now()}`),
    (e) => e.name === 'SegmentNotFound'
  );
});

test('subscribe delivers the newest frame without moving the batch cursor', async () => {
  const name = freshName();
  const w = makeWriter(name);
  const r = new shm.ShmRingReader(name);
  const seen = [];
  const sub = r.subscribe((frame) => seen.push(frame), 5);
  w.publish(Buffer.from('one'));
  w.publish(Buffer.from('two'));
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && (seen.length === 0 || seen[seen.length - 1].payload.toString() !== 'two')) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  sub.stop();
  assert.ok(seen.length > 0);
  assert.equal(seen[seen.length - 1].frameId, 1);
  assert.equal(seen[seen.length - 1].payload.toString(), 'two');
  assert.equal(r.lastFrameId, -1);
  r.close();
  w.close();
});

test('normalizeName adds a POSIX slash and rejects bad names', () => {
  assert.equal(shm.normalizeName('demo', true), '/demo');
  assert.equal(shm.normalizeName('demo', false), 'demo');
  assert.throws(() => shm.normalizeName('a/b'), TypeError);
});
