'use strict';

// Wire protocol v2. See V2_DESIGN.md. v1 stays in protocol.js.
const { ProtocolError } = require('./errors');

const MAGIC = 0x524d4853;
const VERSION = 2;
const HEADER_SIZE = 1024;
const ENDIAN_TAG = 0x0102;
const SLOT_HEADER_SIZE = 64;
const MAX_READERS = 8;
const READER_SLOT_SIZE = 64;
const READERS_OFFSET = 192;
const WRITE_POS_OFFSET = 64;
const WRITER_HEARTBEAT_OFFSET = 128;
const RETAINER_SLOT_OFFSET = 136;

const OVERWRITE = 0;
const RETURN = 1;
const CHECKSUM_NONE = 0;
const CHECKSUM_CRC32 = 1;
const ROLE_OBSERVER = 0;
const ROLE_RETAINER = 1;
const STATE_EMPTY = 0;
const STATE_ACTIVE = 1;
const STATE_CLAIMING = 2;
const DEFAULT_STALE_MS = 1000;

function dvOf(buf) {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

function parseOverflow(value) {
  if (value === OVERWRITE || value === 'overwrite') return OVERWRITE;
  if (value === RETURN || value === 'return') return RETURN;
  throw new ProtocolError("overflow must be 'overwrite' or 'return'");
}

function parseRole(value) {
  if (value === ROLE_OBSERVER || value === 'observer' || value == null) return ROLE_OBSERVER;
  if (value === ROLE_RETAINER || value === 'retainer') return ROLE_RETAINER;
  throw new ProtocolError("role must be 'observer' or 'retainer'");
}

function computeLayout(capacity, slotCount, metaCapacity, overflow, checksumAlgo, staleMs) {
  if (slotCount < 1 || metaCapacity < 0) {
    throw new ProtocolError('slotCount must be >= 1 and metaCapacity >= 0');
  }
  if (overflow !== OVERWRITE && overflow !== RETURN) {
    throw new ProtocolError(`overflow policy ${overflow} is not 0 or 1`);
  }
  if (checksumAlgo !== CHECKSUM_NONE && checksumAlgo !== CHECKSUM_CRC32) {
    throw new ProtocolError(`checksum algo ${checksumAlgo} is not 0 or 1`);
  }
  if (overflow === RETURN && staleMs < 1) {
    throw new ProtocolError('return policy requires staleMs >= 1');
  }
  if (staleMs < 0) throw new ProtocolError('staleMs must be >= 0');
  const minSlot = SLOT_HEADER_SIZE + metaCapacity + 1;
  if (capacity < HEADER_SIZE + slotCount * minSlot) {
    throw new ProtocolError(`capacity ${capacity} too small for ${slotCount} slots`);
  }
  const slotSize = Math.floor((capacity - HEADER_SIZE) / slotCount);
  const payloadOffset = SLOT_HEADER_SIZE + metaCapacity;
  if (slotSize <= payloadOffset) throw new ProtocolError('each slot has no room for payload');
  return {
    capacity, slotCount, slotSize, metaCapacity, payloadOffset,
    payloadCapacity: slotSize - payloadOffset,
    overflow, checksumAlgo, staleMs,
  };
}

function writeGlobal(layout, epoch, pid) {
  const buf = Buffer.alloc(64);
  const dv = dvOf(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint16(4, VERSION, true);
  dv.setUint16(6, HEADER_SIZE, true);
  dv.setUint16(8, ENDIAN_TAG, true);
  dv.setUint16(10, 0, true);
  dv.setUint32(12, layout.capacity, true);
  dv.setUint32(16, layout.slotCount, true);
  dv.setUint32(20, layout.slotSize, true);
  dv.setUint32(24, layout.metaCapacity, true);
  dv.setUint32(28, layout.payloadOffset, true);
  dv.setUint32(32, MAX_READERS, true);
  dv.setUint32(36, layout.overflow, true);
  dv.setUint32(40, layout.checksumAlgo, true);
  dv.setUint32(44, layout.staleMs, true);
  dv.setBigInt64(48, BigInt(epoch), true);
  dv.setBigInt64(56, BigInt(pid), true);
  return buf;
}

function readGlobal(buf) {
  if (!buf || buf.length < 64) throw new ProtocolError('global header shorter than 64 bytes');
  const dv = dvOf(buf);
  const magic = dv.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new ProtocolError(`bad magic 0x${magic.toString(16).padStart(8, '0')} (not a shmring segment)`);
  }
  const version = dv.getUint16(4, true);
  if (version !== VERSION) {
    throw new ProtocolError(`unsupported protocol version ${version} (lib speaks v${VERSION})`);
  }
  const headerSize = dv.getUint16(6, true);
  const endian = dv.getUint16(8, true);
  if (headerSize !== HEADER_SIZE || endian !== ENDIAN_TAG) {
    throw new ProtocolError(`layout/endian mismatch (header=${headerSize}, endian=0x${endian.toString(16)})`);
  }
  const capacity = dv.getUint32(12, true);
  const slotCount = dv.getUint32(16, true);
  const slotSize = dv.getUint32(20, true);
  const metaCapacity = dv.getUint32(24, true);
  const payloadOffset = dv.getUint32(28, true);
  const maxReaders = dv.getUint32(32, true);
  const overflow = dv.getUint32(36, true);
  const checksumAlgo = dv.getUint32(40, true);
  const staleMs = dv.getUint32(44, true);
  if (maxReaders !== MAX_READERS) {
    throw new ProtocolError(`max_readers ${maxReaders} != ${MAX_READERS}`);
  }
  const layout = computeLayout(capacity, slotCount, metaCapacity, overflow, checksumAlgo, staleMs);
  if (layout.slotSize !== slotSize || layout.payloadOffset !== payloadOffset) {
    throw new ProtocolError('geometry does not match capacity');
  }
  layout.writerEpoch = dv.getBigInt64(48, true);
  layout.writerPid = dv.getBigInt64(56, true);
  return layout;
}

function writeSlotBody(slotSeq, stamp, length, metaLen, checksum) {
  const buf = Buffer.alloc(32);
  const dv = dvOf(buf);
  dv.setBigInt64(0, BigInt(slotSeq), true);
  dv.setBigInt64(8, BigInt(stamp), true);
  dv.setUint32(16, length, true);
  dv.setUint32(20, metaLen, true);
  dv.setUint32(24, checksum >>> 0, true);
  dv.setUint32(28, 0, true);
  return buf;
}

function readSlotBody(buf) {
  const dv = dvOf(buf);
  return {
    slotSeq: Number(dv.getBigInt64(0, true)),
    stamp: Number(dv.getBigInt64(8, true)),
    length: dv.getUint32(16, true),
    metaLen: dv.getUint32(20, true),
    checksum: dv.getUint32(24, true),
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32Update(buf, seed = 0) {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function crc32(meta, payload) {
  return crc32Update(payload, crc32Update(meta));
}

function readerOffset(index) {
  return READERS_OFFSET + index * READER_SLOT_SIZE;
}

function slotBase(index, slotSize) {
  return HEADER_SIZE + index * slotSize;
}

module.exports = {
  MAGIC, VERSION, HEADER_SIZE, ENDIAN_TAG, SLOT_HEADER_SIZE, MAX_READERS,
  WRITE_POS_OFFSET, WRITER_HEARTBEAT_OFFSET, RETAINER_SLOT_OFFSET,
  OVERWRITE, RETURN, CHECKSUM_NONE, CHECKSUM_CRC32,
  ROLE_OBSERVER, ROLE_RETAINER, STATE_EMPTY, STATE_ACTIVE, STATE_CLAIMING,
  DEFAULT_STALE_MS,
  parseOverflow, parseRole, computeLayout, writeGlobal, readGlobal,
  writeSlotBody, readSlotBody, crc32, readerOffset, slotBase,
};
