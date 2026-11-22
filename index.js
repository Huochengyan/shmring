'use strict';

/**
 * shmring — lock-free, cross-language shared-memory ring buffer.
 *
 *   const { ShmRingWriter, ShmRingReader } = require('shmring');
 *   const w = new ShmRingWriter('demo');
 *   w.publish(Buffer.from('hello'), Buffer.from('topic=a'));
 *   const r = new ShmRingReader('demo');
 *   console.log(r.read().payload.toString());
 *
 * Wire format: PROTOCOL.md. Single writer, many readers, no HTTP, no locks.
 */

const P = require('./lib/protocol');
const { ShmRingWriter, ShmRingReader } = require('./lib/ring');
const platform = require('./lib/platform');
const errors = require('./lib/errors');

module.exports = {
  ShmRingWriter,
  ShmRingReader,
  unlink: platform.unlink,
  normalizeName: platform.normalizeName,
  isWindows: platform.isWindows,
  MAGIC: P.MAGIC,
  PROTOCOL_VERSION: P.VERSION,
  HEADER_SIZE: P.HEADER_SIZE,
  SLOT_HEADER_SIZE: P.SLOT_HEADER_SIZE,
  DEFAULT_CAPACITY: P.DEFAULT_CAPACITY,
  DEFAULT_SLOT_COUNT: P.DEFAULT_SLOT_COUNT,
  DEFAULT_META_CAPACITY: P.DEFAULT_META_CAPACITY,
  ...errors,
  version: '0.1.0',
};
