'use strict';

// v2 cross-language check. Run from the repo root: node scripts/interop_v2.js

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const shm = require('../index.js');

const ROOT = path.resolve(__dirname, '..');
const PY = process.env.PYTHON || 'python';
const NODE = process.execPath;
const ENV = { ...process.env, PYTHONUNBUFFERED: '1' };

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

function spawnPeer(exe, args) {
  return spawn(exe, args, { cwd: ROOT, env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function casePythonWritesNodeReads() {
  const name = 'shmring_v2_interop_py2js';
  const peer = spawnPeer(PY, [path.join(ROOT, 'scripts/peer.py'), '--v2', '--role', 'writer',
    '--name', name, '--count', '7', '--hold', '10']);
  try {
    await waitReady(peer, 'py-writer');
    const r = new shm.ShmRingReaderV2(name, { join: 'window' });
    const b = r.readBatch();
    assert.deepStrictEqual(b.frames.map((f) => f.seq), [3, 4, 5, 6]);
    assert.deepStrictEqual(b.frames.map((f) => f.payload.toString()),
      ['py-frame-3', 'py-frame-4', 'py-frame-5', 'py-frame-6']);
    assert.deepStrictEqual(b.frames.map((f) => f.meta.toString()),
      ['py-meta-3', 'py-meta-4', 'py-meta-5', 'py-meta-6']);
    assert.equal(b.gap, null);
    r.close();
    console.log('CASE A PASS  Python v2 writer -> Node v2 reader: window [3..6]');
  } finally {
    peer.kill();
  }
}

async function caseNodeWritesPythonReads() {
  const name = 'shmring_v2_interop_js2py';
  const peer = spawnPeer(NODE, [path.join(ROOT, 'scripts/peer.js'), '--v2', '1', '--role', 'writer',
    '--name', name, '--count', '7', '--hold', '10']);
  try {
    await waitReady(peer, 'node-writer');
    const reader = spawnPeer(PY, [path.join(ROOT, 'scripts/peer.py'), '--v2', '--role', 'reader',
      '--name', name]);
    const out = await collectJson(reader, 'py-reader');
    assert.deepStrictEqual(out.seqs, [3, 4, 5, 6]);
    assert.deepStrictEqual(out.payloads, ['node-frame-3', 'node-frame-4', 'node-frame-5', 'node-frame-6']);
    assert.deepStrictEqual(out.metas, ['node-meta-3', 'node-meta-4', 'node-meta-5', 'node-meta-6']);
    assert.equal(out.gap, null);
    console.log('CASE B PASS  Node v2 writer -> Python v2 reader: window [3..6]');
  } finally {
    peer.kill();
  }
}

(async () => {
  await casePythonWritesNodeReads();
  await new Promise((r) => setTimeout(r, 300));
  await caseNodeWritesPythonReads();
  console.log('INTEROP V2 PASS (2/2)');
})().catch((err) => {
  console.error('INTEROP V2 FAIL:', err.message);
  process.exit(1);
});
