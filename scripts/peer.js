'use strict';

// Cross-language interop peer (Node side). Not part of the public API.
// Usage:
//   node scripts/peer.js --role writer --name X --count 7 --hold 8
//   node scripts/peer.js --role reader --name X

const shm = require('../index.js');

function parseArgs(argv) {
  const out = { role: null, name: null, count: 7, hold: 8, capacity: 1024 * 1024, slots: 4, meta: 64, v2: 0 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    const raw = argv[i + 1];
    out[key] = ['count', 'hold', 'capacity', 'slots', 'meta', 'v2'].includes(key) ? Number(raw) : raw;
  }
  return out;
}

const a = parseArgs(process.argv.slice(2));
if (!a.role || !a.name) {
  console.error('usage: peer.js --role writer|reader --name X');
  process.exit(2);
}

if (a.v2) {
  if (a.role === 'writer') {
    try { shm.unlink(a.name); } catch (_) { /* Windows: no-op */ }
    const w = new shm.ShmRingWriterV2(a.name, {
      capacity: a.capacity, slotCount: a.slots, metaCapacity: a.meta, replace: true,
    });
    for (let i = 0; i < a.count; i++) {
      w.publish(Buffer.from(`node-frame-${i}`), Buffer.from(`node-meta-${i}`));
    }
    console.log('READY');
    setTimeout(() => { w.close(); process.exit(0); }, a.hold * 1000);
  } else {
    const r = new shm.ShmRingReaderV2(a.name, { join: 'window' });
    const b = r.readBatch();
    for (const frame of b.frames) r.commit(frame.seq);
    console.log(JSON.stringify({
      seqs: b.frames.map((x) => x.seq),
      payloads: b.frames.map((x) => x.payload.toString('utf8')),
      metas: b.frames.map((x) => x.meta.toString('utf8')),
      gap: b.gap,
    }));
    r.close();
  }
} else if (a.role === 'writer') {
  try { shm.unlink(a.name); } catch (_) { /* Windows: no-op */ }
  const w = new shm.ShmRingWriter(a.name, {
    capacity: a.capacity, slotCount: a.slots, metaCapacity: a.meta,
  });
  for (let i = 0; i < a.count; i++) {
    w.publish(Buffer.from(`node-frame-${i}`), Buffer.from(`node-meta-${i}`));
  }
  console.log('READY');
  setTimeout(() => {
    w.close();
    process.exit(0);
  }, a.hold * 1000);
} else {
  const r = new shm.ShmRingReader(a.name);
  const f = r.read();
  if (!f) {
    console.log(JSON.stringify({ error: 'no frame' }));
    process.exit(1);
  }
  const b = r.readBatch(-1);
  console.log(JSON.stringify({
    latest: {
      frameId: f.frameId,
      payload: f.payload.toString('utf8'),
      meta: f.meta.toString('utf8'),
      seqEven: f.seq % 2 === 0,
    },
    batchIds: b.frames.map((x) => x.frameId),
    batchPayloads: b.frames.map((x) => x.payload.toString('utf8')),
    batchMetas: b.frames.map((x) => x.meta.toString('utf8')),
    dropped: b.dropped,
    newest: b.newest,
  }));
  r.close();
}
