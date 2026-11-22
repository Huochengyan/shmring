'use strict';

// Minimal Node reader: attach to a segment written by any language.
const shm = require('../index.js');

const NAME = process.argv[2] || 'shmring_example';
const r = new shm.ShmRingReader(NAME);
const f = r.read();
if (!f) {
  console.log('no frame yet');
} else {
  console.log(`frame #${f.frameId}  payload=${f.payload.toString()}  meta=${f.meta.toString()}`);
}
const b = r.readBatch(-1);
console.log(`batch ${b.frames.map((x) => x.frameId).join(',')}  dropped=${b.dropped}`);
r.detach();
