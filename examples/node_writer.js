'use strict';

// Minimal Node writer. Run in one terminal, then
// `python examples/python_reader.py shmring_example_js` in another.
const shm = require('../index.js');

const NAME = 'shmring_example_js';
try { shm.unlink(NAME); } catch (_) { /* Windows: no-op */ }
const w = new shm.ShmRingWriter(NAME, { capacity: 1024 * 1024 });
console.log(`writing to ${NAME} (${w.payloadCapacity} B/frame), 10s ...`);

let i = 0;
const timer = setInterval(() => {
  w.publish(Buffer.from(`node-frame-${i}`), Buffer.from('{"src":"node"}'));
  i += 1;
}, 33);

setTimeout(() => {
  clearInterval(timer);
  w.close();
  console.log('done');
}, 10000);
