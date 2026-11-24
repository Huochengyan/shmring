'use strict';

const P = require('./protocol');
const platform = require('./platform');
const { CapacityError } = require('./errors');
const { toBuffer } = platform;

function makeInfo(name, L) {
  return {
    name,
    capacity: L.capacity,
    slotCount: L.slotCount,
    slotSize: L.slotSize,
    metaCapacity: L.metaCapacity,
    payloadCapacity: L.payloadCapacity,
    protocolVersion: P.VERSION,
  };
}

class ShmRingWriter {
  /** Create a new segment. Only one writer process may publish at a time. */
  constructor(name, opts = {}) {
    const capacity = opts.capacity ?? P.DEFAULT_CAPACITY;
    const slotCount = opts.slotCount ?? P.DEFAULT_SLOT_COUNT;
    const metaCapacity = opts.metaCapacity ?? P.DEFAULT_META_CAPACITY;
    const L = P.computeLayout(capacity, slotCount, metaCapacity);
    this.layout = L;
    this.name = name;
    this.m = platform.open(name, { create: true, writable: true, capacity });
    this.seq = 0n;
    this.frameId = -1;
    this.stamp = 0;

    this.m.write(0, P.writeGlobal(L, 0n, -1, 0));
    for (let i = 0; i < L.slotCount; i++) {
      this.m.write(
        P.HEADER_SIZE + i * L.slotSize,
        P.writeSlot(-1, 0, 0, 0)
      );
    }
  }

  get info() { return makeInfo(this.name, this.layout); }
  get payloadCapacity() { return this.layout.payloadCapacity; }
  get metaCapacity() { return this.layout.metaCapacity; }

  /** Publish one opaque frame; returns the assigned frameId. */
  publish(payload, meta = Buffer.alloc(0), stamp = null) {
    const p = toBuffer(payload);
    const m = toBuffer(meta);
    const L = this.layout;
    if (p.length > L.payloadCapacity) {
      throw new CapacityError(`payload ${p.length} B exceeds slot capacity ${L.payloadCapacity} B`);
    }
    if (m.length > L.metaCapacity) {
      throw new CapacityError(`meta ${m.length} B exceeds meta capacity ${L.metaCapacity} B`);
    }

    const fid = this.frameId + 1;
    const ts = stamp === null ? Date.now() : Math.trunc(stamp);
    const base = P.HEADER_SIZE + (fid % L.slotCount) * L.slotSize;

    // 1) write-in-progress (odd seq), keep the old frameId
    this.m.write(0, P.writeGlobal(L, this.seq + 1n, this.frameId, this.stamp));
    // 2) payload, then meta, then slot header LAST
    this.m.write(base + L.payloadOffset, p);
    if (m.length) this.m.write(base + P.SLOT_HEADER_SIZE, m);
    this.m.write(base, P.writeSlot(fid, ts, p.length, m.length));
    // 3) commit: even seq + new frameId
    this.seq += 2n;
    this.frameId = fid;
    this.stamp = ts;
    this.m.write(0, P.writeGlobal(L, this.seq, fid, ts));
    return fid;
  }

  close() { this.m.close(); }
  unlink() { this.m.unlink(); this.m.close(); }
}

class ShmRingReader {
  /** Attach to an existing segment. Each reader keeps its own cursor. */
  constructor(name, opts = {}) {
    this.name = name;
    this.retries = opts.retries ?? 8;
    this.m = platform.open(name, { writable: false });
    try {
      // Segment 刚创建时写者可能还没写完全局头，magic 校验会抛错。
      // 此时必须关闭已打开的映射句柄，否则 attach 重试会泄漏句柄。
      const g = P.readGlobal(this.m.read(0, P.HEADER_SIZE));
      this.m.size = g.capacity; // Win32 attaches without knowing the size
      this.layout = g;
    } catch (error) {
      this.m.close();
      throw error;
    }
    this.last = -1;
    this.closed = false;
    this._subs = [];
  }

  get info() { return makeInfo(this.name, this.layout); }
  get lastFrameId() { return this.last; }

  _readSlot(fid, g) {
    const base = P.HEADER_SIZE + (fid % g.slotCount) * g.slotSize;
    const s = P.readSlot(this.m.read(base, P.SLOT_HEADER_SIZE), 0);
    if (s.frameId !== fid) return null; // overwritten by a newer frame
    if (!(s.length >= 0 && s.length <= g.payloadCapacity)) return null;
    if (!(s.metaLen >= 0 && s.metaLen <= g.metaCapacity)) return null;
    const payload = this.m.read(base + g.payloadOffset, s.length);
    const meta = s.metaLen
      ? this.m.read(base + P.SLOT_HEADER_SIZE, s.metaLen)
      : Buffer.alloc(0);
    return {
      frameId: fid, stamp: s.stamp, payload, meta, seq: Number(g.seq),
    };
  }

  /** Read the newest complete frame, or null. */
  read() {
    for (let i = 0; i < this.retries; i++) {
      const g = P.readGlobal(this.m.read(0, P.HEADER_SIZE));
      if (g.seq % 2n !== 0n || g.frameId < 0) continue;
      const f = this._readSlot(g.frameId, g);
      if (!f) continue;
      const g2 = P.readGlobal(this.m.read(0, P.HEADER_SIZE));
      if (g2.seq !== g.seq || g2.frameId !== g.frameId) continue;
      return f;
    }
    return null;
  }

  /**
   * Call `callback(frame)` in this process when a newer frame is published.
   * Polls every `intervalMs` (default 2) and passes a copy of the newest frame.
   * `stop()` on the returned object ends the loop. `close()` stops it too.
   */
  subscribe(callback, intervalMs = 2) {
    if (this.closed) throw new Error('reader is closed');
    if (!(intervalMs >= 0)) throw new Error('intervalMs must be >= 0');
    let stopped = false;
    let last = null;
    let timer = null;
    const sub = {
      error: null,
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
    };
    const tick = () => {
      if (stopped || this.closed) return;
      try {
        const frame = this.read();
        if (frame && frame.frameId !== last) {
          last = frame.frameId;
          callback(frame);
        }
      } catch (error) {
        sub.error = error;
        sub.stop();
        return;
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };
    this._subs.push(sub);
    tick();
    return sub;
  }

  /** Read every frame newer than `since` that is still in the ring. */
  readBatch(since = null) {
    const cursor = since === null ? this.last : since;
    const g = P.readGlobal(this.m.read(0, P.HEADER_SIZE));
    if (g.seq % 2n !== 0n || g.frameId < 0) {
      return { frames: [], dropped: 0, newest: g.frameId };
    }
    const newest = g.frameId;
    const first = Math.max(cursor + 1, newest - g.slotCount + 1);
    const frames = [];
    for (let fid = first; fid <= newest; fid++) {
      const f = this._readSlot(fid, g);
      if (f) frames.push(f);
    }
    const g2 = P.readGlobal(this.m.read(0, P.HEADER_SIZE));
    if (g2.seq !== g.seq || g2.frameId !== newest) {
      return { frames: [], dropped: 0, newest };
    }
    this.last = newest;
    return {
      frames,
      dropped: Math.max(0, newest - cursor - frames.length),
      newest,
    };
  }

  close() {
    if (this.closed) return;
    for (const sub of this._subs) sub.stop();
    this.closed = true;
    this.m.close();
  }
  detach() { this.close(); }
}

module.exports = { ShmRingWriter, ShmRingReader };
