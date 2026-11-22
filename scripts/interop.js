'use strict';

// Cross-language conformance test: start a peer process that owns the segment,
// then read it from the other language. Run from the repo root:
//   node scripts/interop.js
// Requires `python` on PATH (override with PYTHON=...) and koffi installed.

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const shm = require('../index.js');

const ROOT = path.resolve(__dirname, '..');
const PY = process.env.PYTHON || 'python';
const NODE = process.execPath;
const ENV = { ...process.env };

function waitReady(child, label) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`${label}: timeout waiting READY (${buf})`)), 20000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('READY')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', (d) => process.stderr.write(`[${label}] ${d}`));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${label}: exited early code=${code} stdout=${buf}`));
    });
  });
}

function collectJson(child, label) {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`${label}: exited ${code}: ${err}${out}`));
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      try {
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch (_) {
        reject(new Error(`${label}: bad JSON: ${out} ${err}`));
      }
    });
  });
}

function spawnPeer(exe, args, label) {
  return spawn(exe, args, { cwd: ROOT, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function casePythonWritesNodeReads() {
  const name = 'shmring_interop_py2js';
  const peer = spawnPeer(PY, [path.join(ROOT, 'scripts/peer.py'), '--role', 'writer',
    '--name', name, '--count', '7', '--hold', '10'], 'py-writer');
  try {
    await waitReady(peer, 'py-writer');
    const r = new shm.ShmRingReader(name);
    const f = r.read();
    assert(f, 'expected a frame');
    assert.strictEqual(f.frameId, 6);
    assert.strictEqual(f.payload.toString(), 'py-frame-6');
    assert.strictEqual(f.meta.toString(), 'py-meta-6');
    assert.strictEqual(f.seq % 2, 0);
    const b = r.readBatch(-1);
    assert.deepStrictEqual(b.frames.map((x) => x.frameId), [3, 4, 5, 6]);
    assert.deepStrictEqual(b.frames.map((x) => x.meta.toString()),
      ['py-meta-3', 'py-meta-4', 'py-meta-5', 'py-meta-6']);
    assert.strictEqual(b.dropped, 3);
    console.log('CASE A PASS  Python writer -> Node reader: latest #6, batch [3..6], dropped 3');
    r.close();
  } finally {
    peer.kill();
  }
}

async function caseNodeWritesPythonReads() {
  const name = 'shmring_interop_js2py';
  const peer = spawnPeer(NODE, [path.join(ROOT, 'scripts/peer.js'), '--role', 'writer',
    '--name', name, '--count', '7', '--hold', '10'], 'node-writer');
  try {
    await waitReady(peer, 'node-writer');
    const reader = spawnPeer(PY, [path.join(ROOT, 'scripts/peer.py'), '--role', 'reader',
      '--name', name], 'py-reader');
    const out = await collectJson(reader, 'py-reader');
    assert.strictEqual(out.latest.frameId, 6);
    assert.strictEqual(out.latest.payload, 'node-frame-6');
    assert.strictEqual(out.latest.meta, 'node-meta-6');
    assert.strictEqual(out.latest.seqEven, true);
    assert.deepStrictEqual(out.batchIds, [3, 4, 5, 6]);
    assert.deepStrictEqual(out.batchPayloads,
      ['node-frame-3', 'node-frame-4', 'node-frame-5', 'node-frame-6']);
    assert.strictEqual(out.dropped, 3);
    console.log('CASE B PASS  Node writer -> Python reader: latest #6, batch [3..6], dropped 3');
  } finally {
    peer.kill();
  }
}

(async () => {
  await casePythonWritesNodeReads();
  await new Promise((r) => setTimeout(r, 300)); // let the killed peer release handles
  await caseNodeWritesPythonReads();
  console.log('INTEROP PASS (2/2)');
})().catch((err) => {
  console.error('INTEROP FAIL:', err.message);
  process.exit(1);
});
