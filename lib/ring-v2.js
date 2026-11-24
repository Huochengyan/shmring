'use strict';

const crypto = require('crypto');
const P = require('./protocol-v2');
const platform = require('./platform');
const { bind, monoNs } = require('./atomic');
const { CapacityError, ChecksumError, ProtocolError, SegmentExists, ShmRingError } = require('./errors');
const { toBuffer } = platform;

function num(value) {
  const n = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(n)) throw new ProtocolError(`sequence ${value} exceeds 2^53`);
  return n;
}

class ShmRingWriterV2 {
  constructor(name, opts = {}) {
    const capacity = opts.capacity ?? 8 * 1024 * 1024;
    const slotCount = opts.slotCount ?? 4;
    const metaCapacity = opts.metaCapacity ?? 256;
    const overflow = P.parseOverflow(opts.overflow ?? 'overwrite');
    const checksum = opts.checksum !== false;
    const staleMs = opts.staleMs ?? P.DEFAULT_STALE_MS;
    this.layout = P.computeLayout(
      capacity, slotCount, metaCapacity, overflow,
      checksum ? P.CHECKSUM_CRC32 : P.CHECKSUM_NONE, staleMs,
    );
    this.name = name;
    this.closed = false;
    this.W = 0n;
    this.m = this._open(name, Boolean(opts.replace));
    this.atom = bind(this.m.addr);
    this.epoch = signedEpoch();
    this._init();
  }

  _open(name, replace) {
    try {
      return platform.open(name, { create: true, writable: true, capacity: this.layout.capacity });
    } catch (error) {
      if (!replace || !(error instanceof SegmentExists)) throw error;
      try { platform.unlink(name); } catch (_) { /* Windows has no unlink */ }
      try {
        return platform.open(name, { create: true, writable: true, capacity: this.layout.capacity });
      } catch (again) {
        if (!(again instanceof SegmentExists)) throw again;
        const existing = platform.open(name, { create: false, writable: true });
        existing.size = this.layout.capacity;
        const got = P.readGlobal(existing.read(0, 64));
        if (got.capacity !== this.layout.capacity
            || got.slotCount !== this.layout.slotCount
            || got.metaCapacity !== this.layout.metaCapacity) {
          existing.close();
          throw new ShmRingError(
            `existing segment ${name} has a different geometry; unlink it before recreating`,
          );
        }
        this.layout = got;
        return existing;
      }
    }
  }

  _init() {
    const zero = Buffer.alloc(P.HEADER_SIZE);
    this.m.write(0, zero);
    this.m.write(0, P.writeGlobal(this.layout, this.epoch, process.pid));
    const a = this.atom;
    a.storeI64(P.WRITE_POS_OFFSET, 0);
    a.storeI64(P.WRITER_HEARTBEAT_OFFSET, monoNs());
    a.storeI32(P.RETAINER_SLOT_OFFSET, -1);
    for (let i = 0; i < P.MAX_READERS; i++) {
      const base = P.readerOffset(i);
      a.storeI64(base, -1);
      a.storeI64(base + 8, 0);
      a.storeI64(base + 16, 0);
      a.storeI32(base + 24, 0);
      a.storeI32(base + 28, P.STATE_EMPTY);
    }
    const L = this.layout;
    for (let i = 0; i < L.slotCount; i++) {
      const base = P.slotBase(i, L.slotSize);
      a.storeI64(base, 0);
      this.m.write(base + 8, P.writeSlotBody(-1, 0, 0, 0, 0));
    }
    this.W = 0n;
  }

  get info() {
    const L = this.layout;
    return {
      name: this.name,
      capacity: L.capacity,
      slotCount: L.slotCount,
      slotSize: L.slotSize,
      metaCapacity: L.metaCapacity,
      payloadCapacity: L.payloadCapacity,
      protocolVersion: P.VERSION,
      overflow: L.overflow ? 'return' : 'overwrite',
      checksum: L.checksumAlgo === P.CHECKSUM_CRC32,
      staleMs: L.staleMs,
    };
  }

  get payloadCapacity() { return this.layout.payloadCapacity; }
  get metaCapacity() { return this.layout.metaCapacity; }

  heartbeat() {
    this._require();
    this.atom.storeI64(P.WRITER_HEARTBEAT_OFFSET, monoNs());
  }

  _require() {
    if (this.closed) throw new ShmRingError('writer is closed');
  }

  _liveRetainerPos() {
    if (this.layout.overflow !== P.RETURN) return null;
    const idx = this.atom.loadI32(P.RETAINER_SLOT_OFFSET);
    if (idx < 0 || idx >= P.MAX_READERS) return null;
    const base = P.readerOffset(idx);
    if (this.atom.loadI32(base + 28) !== P.STATE_ACTIVE) return null;
    if (this.atom.loadI32(base + 24) !== P.ROLE_RETAINER) return null;
    const hb = this.atom.loadI64(base + 8);
    if (monoNs() - hb >= BigInt(this.layout.staleMs) * 1000000n) return null;
    return this.atom.loadI64(base);
  }

  publish(payload, meta = Buffer.alloc(0), stamp = null) {
    this._require();
    const p = toBuffer(payload);
    const m = toBuffer(meta);
    const L = this.layout;
    if (p.length > L.payloadCapacity) {
      throw new CapacityError(`payload ${p.length} B exceeds slot capacity ${L.payloadCapacity} B`);
    }
    if (m.length > L.metaCapacity) {
      throw new CapacityError(`meta ${m.length} B exceeds meta capacity ${L.metaCapacity} B`);
    }
    this.atom.storeI64(P.WRITER_HEARTBEAT_OFFSET, monoNs());
    const held = this._liveRetainerPos();
    if (held !== null && this.W - held >= BigInt(L.slotCount)) {
      return { accepted: false, frameId: null };
    }
    const W = this.W;
    const base = P.slotBase(Number(W % BigInt(L.slotCount)), L.slotSize);
    const seqlock = this.atom.loadI64(base);
    this.atom.storeI64(base, seqlock + 1n);
    this.m.write(base + L.payloadOffset, p);
    if (m.length) this.m.write(base + P.SLOT_HEADER_SIZE, m);
    const checksum = L.checksumAlgo === P.CHECKSUM_CRC32 ? P.crc32(m, p) : 0;
    const ts = stamp === null ? Date.now() : Math.trunc(stamp);
    this.m.write(base + 8, P.writeSlotBody(W, ts, p.length, m.length, checksum));
    this.atom.storeI64(base, seqlock + 2n);
    this.atom.storeI64(P.WRITE_POS_OFFSET, W + 1n);
    this.W = W + 1n;
    return { accepted: true, frameId: num(W) };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.m.close();
  }

  unlink() {
    if (this.closed) return;
    this.closed = true;
    this.m.unlink();
    this.m.close();
  }
}

class ShmRingReaderV2 {
  constructor(name, opts = {}) {
    this.name = name;
    this.role = P.parseRole(opts.role);
    this.join = opts.join ?? 'tip';
    if (this.join !== 'tip' && this.join !== 'window') {
      throw new ProtocolError("join must be 'tip' or 'window'");
    }
    this.retries = opts.retries ?? 8;
    this.closed = false;
    this.m = platform.open(name, { create: false, writable: true });
    try {
      const head = this.m.read(0, 64);
      this.layout = P.readGlobal(head);
      this.m.size = this.layout.capacity;
      this.atom = bind(this.m.addr);
      this.epoch = this.layout.writerEpoch;
      this._claim();
    } catch (error) {
      this.m.close();
      throw error;
    }
  }

  _claim() {
    const W = this.atom.loadI64(P.WRITE_POS_OFFSET);
    const pos = this.join === 'tip'
      ? W
      : (W > BigInt(this.layout.slotCount) ? W - BigInt(this.layout.slotCount) : 0n);
    for (let i = 0; i < P.MAX_READERS; i++) {
      const base = P.readerOffset(i);
      if (!this.atom.casI32(base + 28, P.STATE_EMPTY, P.STATE_CLAIMING)) continue;
      try {
        if (this.role === P.ROLE_RETAINER) {
          if (!this.atom.casI32(P.RETAINER_SLOT_OFFSET, -1, i)) {
            throw new ShmRingError('a retainer is already attached to this segment');
          }
        }
        const generation = this.atom.loadI64(base + 16) + 1n;
        this.atom.storeI64(base + 16, generation);
        this.atom.storeI32(base + 24, this.role);
        const pid = Buffer.alloc(4);
        pid.writeUInt32LE(process.pid >>> 0);
        this.m.write(base + 32, pid);
        this.atom.storeI64(base + 8, monoNs());
        this.atom.storeI64(base, pos);
        this.atom.storeI32(base + 28, P.STATE_ACTIVE);
      } catch (error) {
        this.atom.storeI32(base + 28, P.STATE_EMPTY);
        this.atom.storeI64(base, -1n);
        if (this.role === P.ROLE_RETAINER && this.atom.loadI32(P.RETAINER_SLOT_OFFSET) === i) {
          this.atom.storeI32(P.RETAINER_SLOT_OFFSET, -1);
        }
        throw error;
      }
      this.index = i;
      this.cursor = pos;
      this.base = base;
      return;
    }
    throw new ShmRingError(`no free v2 reader slot (max ${P.MAX_READERS})`);
  }

  get info() {
    const L = this.layout;
    return {
      name: this.name,
      capacity: L.capacity,
      slotCount: L.slotCount,
      slotSize: L.slotSize,
      metaCapacity: L.metaCapacity,
      payloadCapacity: L.payloadCapacity,
      protocolVersion: P.VERSION,
      overflow: L.overflow ? 'return' : 'overwrite',
    };
  }

  get readPos() { return num(this.cursor); }

  heartbeat() {
    this._open();
    this.atom.storeI64(this.base + 8, monoNs());
  }

  get writerAlive() {
    this._open();
    const hb = this.atom.loadI64(P.WRITER_HEARTBEAT_OFFSET);
    if (hb <= 0n) return false;
    return monoNs() - hb < BigInt(this.layout.staleMs) * 1000000n;
  }

  _open() {
    if (this.closed) throw new ShmRingError('reader is closed');
    const epoch = this.m.read(48, 8).readBigInt64LE(0);
    if (epoch !== this.epoch) {
      throw new ProtocolError('writer epoch changed; re-attach to this segment');
    }
  }

  _gap(R, W) {
    const span = BigInt(this.layout.slotCount);
    if (W - R > span) {
      const oldest = W - span;
      return { dropped: num(oldest - R), nextSeq: num(oldest) };
    }
    return null;
  }

  _peek(R) {
    const L = this.layout;
    for (let attempt = 0; attempt < this.retries; attempt++) {
      const W = this.atom.loadI64(P.WRITE_POS_OFFSET);
      if (R >= W) return null;
      const gap = this._gap(R, W);
      if (gap) return gap;
      const base = P.slotBase(Number(R % BigInt(L.slotCount)), L.slotSize);
      const s1 = this.atom.loadI64(base);
      if (s1 & 1n) continue;
      const body = P.readSlotBody(this.m.read(base + 8, 32));
      if (BigInt(body.slotSeq) !== R) continue;
      if (body.length > L.payloadCapacity || body.metaLen > L.metaCapacity) continue;
      const payload = body.length ? this.m.read(base + L.payloadOffset, body.length) : Buffer.alloc(0);
      const meta = body.metaLen ? this.m.read(base + P.SLOT_HEADER_SIZE, body.metaLen) : Buffer.alloc(0);
      const s2 = this.atom.loadI64(base);
      if (s1 !== s2) continue;
      if (L.checksumAlgo === P.CHECKSUM_CRC32 && P.crc32(meta, payload) !== body.checksum) {
        throw new ChecksumError(`checksum mismatch on frame ${R}`);
      }
      return {
        seq: num(R),
        frameId: num(R),
        stamp: body.stamp,
        payload,
        meta,
      };
    }
    const W = this.atom.loadI64(P.WRITE_POS_OFFSET);
    if (R >= W) return null;
    return this._gap(R, W);
  }

  read() {
    this._open();
    this.heartbeat();
    return this._peek(this.cursor);
  }

  readBatch(limit = null) {
    this._open();
    this.heartbeat();
    const frames = [];
    let R = this.cursor;
    while (limit === null || frames.length < limit) {
      const item = this._peek(R);
      if (item === null) return { frames, gap: null };
      if (item.dropped !== undefined && item.seq === undefined) return { frames, gap: item };
      frames.push(item);
      R += 1n;
    }
    return { frames, gap: null };
  }

  commit(seq) {
    this._open();
    if (BigInt(seq) !== this.cursor) {
      throw new ProtocolError(`commit(${seq}) but the next frame is ${this.cursor}`);
    }
    this.cursor += 1n;
    this.atom.storeI64(this.base, this.cursor);
    this.heartbeat();
  }

  skipTo(seq) {
    this._open();
    const next = BigInt(seq);
    if (next <= this.cursor) {
      throw new ProtocolError(`skipTo(${seq}) must move forward from ${this.cursor}`);
    }
    this.cursor = next;
    this.atom.storeI64(this.base, next);
    this.heartbeat();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.index !== undefined) {
        if (this.role === P.ROLE_RETAINER && this.atom.loadI32(P.RETAINER_SLOT_OFFSET) === this.index) {
          this.atom.storeI32(P.RETAINER_SLOT_OFFSET, -1);
        }
        this.atom.storeI32(this.base + 28, P.STATE_EMPTY);
        this.atom.storeI64(this.base, -1n);
      }
    } finally {
      this.m.close();
    }
  }
}

function signedEpoch() {
  const buf = crypto.randomBytes(8);
  const value = buf.readBigInt64LE(0);
  return value === 0n ? 1n : value;
}

module.exports = { ShmRingWriterV2, ShmRingReaderV2 };
