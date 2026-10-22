'use strict';
// Decoder output contract (2026-10-22). Every decode result the worker posts
// — FT8, FT4, FT2, native or WASM — must already be screen-ready:
//   db: a whole number   dt: a finite number (or null)   df: a finite number
//   text: a non-empty string
// FT4's measured SNR reached the screen as "+10.9874995727539" in 1.12.0 and
// 1.13.0 because only the FT8 path rounded. This drives the REAL worker
// (lib/ft8-worker.js) the way the engine does: encode a message, place it in
// a slot of noise, decode, and check every field of every result.
//
// Uses whichever decoder this machine has: the native addon when built
// (npm run build-ft8), else the WASM decoders — both must keep the contract.
const assert = require('assert');
const path = require('path');
const { Worker } = require('worker_threads');

const SR = 12000;
// Slot lengths and where the signal starts, as the engine hands them over.
const MODES = {
  FT8: { encode: 'encode', decode: 'decode', slot: 15 * SR, at: Math.round(0.5 * SR), text: 'CQ K1ABC FN42' },
  FT4: { encode: 'ft4-encode', decode: 'ft4-decode', slot: Math.round(7.5 * SR), at: Math.round(0.5 * SR), text: 'W2XYZ K1ABC -12' },
  FT2: { encode: 'ft2-encode', decode: 'ft2-decode', slot: 45000, at: 0, text: 'CQ K3SBP FN20' },
};

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + e.message); }
}

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

async function runPath(forceWasm) {
  const w = new Worker(path.join(__dirname, '..', 'lib', 'ft8-worker.js'), {
    stdout: true, stderr: true,
    env: { ...process.env, POTACAT_NO_NATIVE_FT8: forceWasm ? '1' : '' },
  });
  let nextId = 1;
  const pending = new Map();
  let ready;
  const readyP = new Promise((res) => { ready = res; });
  w.on('message', (m) => {
    if (m.type === 'ready') { ready(m); return; }
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p(m); }
  });
  w.on('error', (e) => { console.log('  FAIL worker error: ' + e.message); process.exit(1); });
  const ask = (msg) => new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, res);
    setTimeout(() => { if (pending.delete(id)) rej(new Error(msg.type + ' timed out')); }, 60000);
    w.postMessage({ ...msg, id });
  });

  const info = await Promise.race([readyP, new Promise((_, rej) => setTimeout(() => rej(new Error('worker not ready')), 60000))]);
  const via = info.native ? 'native' : 'WASM';
  if (!forceWasm && !info.native) { await w.terminate(); console.log('  skip native decoder not built here (npm run build-ft8)'); return; }
  console.log(`decode contract — ${via} decoders`);

  for (const [mode, m] of Object.entries(MODES)) {
    const enc = await ask({ type: m.encode, text: m.text, frequency: 1234.5 });
    if (!enc || enc.type !== 'encode-result' || !enc.samples) {
      check(`${via} ${mode}: encoder available`, () => assert.fail(`no ${mode} encoder in this worker (${enc && (enc.message || enc.type)})`));
      continue;
    }
    const sig = new Float32Array(enc.samples);
    // Two signal levels: a strong one (float SNRs well above 10 dB, the
    // reported case) and a weak one, each in its own noise.
    for (const [label, gain, seed] of [['strong', 0.5, 7], ['weak', 0.08, 11]]) {
      const r = rng(seed);
      const buf = new Float32Array(m.slot);
      for (let i = 0; i < buf.length; i++) buf[i] = 0.05 * gauss(r);
      for (let i = 0; i < sig.length && m.at + i < buf.length; i++) buf[m.at + i] += gain * sig[i];
      const res = await ask({ type: m.decode, samples: buf.buffer, seedCall: 'K1ABC', myCall: '', dxCall: '', budgetMs: 0 });
      const results = (res && res.results) || [];
      check(`${via} ${mode} ${label}: decoded the message`, () => {
        assert.ok(results.some(d => String(d.text || '').trim() === m.text), `got ${JSON.stringify(results.map(d => d.text))}`);
      });
      check(`${via} ${mode} ${label}: every result is screen-ready (whole dB, numeric dt/df, text)`, () => {
        for (const d of results) {
          assert.ok(Number.isInteger(d.db), `db ${JSON.stringify(d.db)} is not a whole number (${d.text})`);
          assert.ok(d.dt === null || d.dt === undefined || Number.isFinite(d.dt), `dt ${JSON.stringify(d.dt)} (${d.text})`);
          assert.ok(Number.isFinite(d.df), `df ${JSON.stringify(d.df)} (${d.text})`);
          assert.ok(typeof d.text === 'string' && d.text.trim().length > 0, `empty text`);
        }
      });
    }
  }
  await w.terminate();
}

(async () => {
  await runPath(false); // the native addon, when this machine has it built
  await runPath(true);  // the WASM fallback (what CI and an addon-less install run)
  console.log('');
  console.log('decode contract: ' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('  FAIL ' + e.message); process.exit(1); });
