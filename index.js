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
const V2 = require('./lib/protocol-v2');
const { ShmRingWriter, ShmRingReader } = require('./lib/ring');
const { ShmRingWriterV2, ShmRingReaderV2 } = require('./lib/ring-v2');
const platform = require('./lib/platform');
const errors = require('./lib/errors');

module.exports = {
  ShmRingWriter,
  ShmRingReader,
  ShmRingWriterV2,
  ShmRingReaderV2,
  unlink: platform.unlink,
  normalizeName: platform.normalizeName,
  isWindows: platform.isWindows,
  MAGIC: P.MAGIC,
  PROTOCOL_VERSION: P.VERSION,
  PROTOCOL_VERSION_V2: V2.VERSION,
  HEADER_SIZE: P.HEADER_SIZE,
  SLOT_HEADER_SIZE: P.SLOT_HEADER_SIZE,
  DEFAULT_CAPACITY: P.DEFAULT_CAPACITY,
  DEFAULT_SLOT_COUNT: P.DEFAULT_SLOT_COUNT,
  DEFAULT_META_CAPACITY: P.DEFAULT_META_CAPACITY,
  ...errors,
  version: '0.2.0',
};
