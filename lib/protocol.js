'use strict';

// Wire protocol v1 — see PROTOCOL.md (authoritative).
const { ProtocolError } = require('./errors');

const MAGIC = 0x524d4853;       // b"SHMR" as LE u32
const VERSION = 1;
const HEADER_SIZE = 64;
const ENDIAN_TAG = 0x0102;
const SLOT_HEADER_SIZE = 32;
const DEFAULT_CAPACITY = 8 * 1024 * 1024;
const DEFAULT_SLOT_COUNT = 4;
const DEFAULT_META_CAPACITY = 256;

function dvOf(buf) {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
}

function computeLayout(capacity, slotCount, metaCapacity) {
  if (slotCount < 1 || metaCapacity < 0) {
    throw new ProtocolError('slotCount must be >= 1 and metaCapacity >= 0');
  }
  if (capacity < HEADER_SIZE + slotCount * (SLOT_HEADER_SIZE + metaCapacity + 1)) {
    throw new ProtocolError(`capacity ${capacity} too small for ${slotCount} slots`);
  }
  const slotSize = Math.floor((capacity - HEADER_SIZE) / slotCount);
  const payloadOffset = SLOT_HEADER_SIZE + metaCapacity;
  if (slotSize <= payloadOffset) {
    throw new ProtocolError('each slot has no room for payload');
  }
  return {
    capacity, slotCount, slotSize, metaCapacity, payloadOffset,
    payloadCapacity: slotSize - payloadOffset,
  };
}

function readGlobal(buf) {
  if (!buf || buf.length < HEADER_SIZE) {
    throw new ProtocolError('global header shorter than 64 bytes');
  }
  const dv = dvOf(buf);
  const magic = dv.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new ProtocolError(
      `bad magic 0x${magic.toString(16).padStart(8, '0')} (not a shmring segment)`
    );
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
  const seq = dv.getBigInt64(16, true);
  const frameId = Number(dv.getBigInt64(24, true));
  const stamp = Number(dv.getBigInt64(32, true));
  const slotCount = dv.getInt32(40, true);
  const slotSize = dv.getInt32(44, true);
  const metaCapacity = dv.getInt32(48, true);
  const payloadOffset = dv.getInt32(52, true);
  if (slotCount < 1 || capacity < HEADER_SIZE + slotCount * (SLOT_HEADER_SIZE + 1)) {
    throw new ProtocolError(`invalid geometry: capacity=${capacity} slotCount=${slotCount}`);
  }
  if (slotSize <= SLOT_HEADER_SIZE + metaCapacity || metaCapacity < 0) {
    throw new ProtocolError(`invalid geometry: slotSize=${slotSize} metaCapacity=${metaCapacity}`);
  }
  if (payloadOffset !== SLOT_HEADER_SIZE + metaCapacity) {
    throw new ProtocolError(`invalid payloadOffset=${payloadOffset}`);
  }
  return {
    magic, version, flags: dv.getUint16(10, true), capacity, seq, frameId, stamp,
    slotCount, slotSize, metaCapacity, payloadOffset,
    payloadCapacity: slotSize - payloadOffset,
  };
}

function writeGlobal(layout, seq, frameId, stamp) {
  const b = Buffer.alloc(HEADER_SIZE);
  const dv = dvOf(b);
  dv.setUint32(0, MAGIC, true);
  dv.setUint16(4, VERSION, true);
  dv.setUint16(6, HEADER_SIZE, true);
  dv.setUint16(8, ENDIAN_TAG, true);
  dv.setUint16(10, 0, true);
  dv.setUint32(12, layout.capacity, true);
  dv.setBigInt64(16, BigInt(seq), true);
  dv.setBigInt64(24, BigInt(frameId), true);
  dv.setBigInt64(32, BigInt(stamp), true);
  dv.setInt32(40, layout.slotCount, true);
  dv.setInt32(44, layout.slotSize, true);
  dv.setInt32(48, layout.metaCapacity, true);
  dv.setInt32(52, layout.payloadOffset, true);
  return b;
}

function readSlot(buf, base) {
  const dv = dvOf(buf);
  return {
    frameId: Number(dv.getBigInt64(base + 0, true)),
    stamp: Number(dv.getBigInt64(base + 8, true)),
    length: dv.getInt32(base + 16, true),
    metaLen: dv.getInt32(base + 20, true),
    checksum: dv.getUint32(base + 24, true),
    flags: dv.getInt32(base + 28, true),
  };
}

function writeSlot(frameId, stamp, length, metaLen) {
  const b = Buffer.alloc(SLOT_HEADER_SIZE);
  const dv = dvOf(b);
  dv.setBigInt64(0, BigInt(frameId), true);
  dv.setBigInt64(8, BigInt(stamp), true);
  dv.setInt32(16, length, true);
  dv.setInt32(20, metaLen, true);
  dv.setUint32(24, 0, true);
  dv.setInt32(28, 0, true);
  return b;
}

module.exports = {
  MAGIC, VERSION, HEADER_SIZE, ENDIAN_TAG, SLOT_HEADER_SIZE,
  DEFAULT_CAPACITY, DEFAULT_SLOT_COUNT, DEFAULT_META_CAPACITY,
  computeLayout, readGlobal, writeGlobal, readSlot, writeSlot, dvOf,
};
