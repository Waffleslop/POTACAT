'use strict';
// The WASM encoders take <bracketed> hashed calls (VK4KTW, 2026-11-13).
//
// JTCAT replied to HS0GWL/M with "<HS0GWL/M> VK4KTW". His native addon had
// not loaded, the ft8js WASM encoder printed "Cannot parse message!" and
// returned null, and the rig never keyed. The WASM path now strips the
// brackets (lib/ft-wasm-text.js) and ft8_lib hashes the call itself.
//
// This drives the REAL worker on the WASM path (POTACAT_NO_NATIVE_FT8=1):
// every bracketed reply must encode in FT8, FT4 and FT2, a standard message
// must be untouched, and what goes out must decode back to the same message.
// When the native addon is built here, it also checks that the native decoder,
// seeded with HS0GWL/M's own call, reads the WASM signal as the full message
// and that the WASM FT8 signal is the native one sample for sample.
const assert = require('assert');
const path = require('path');
const { Worker } = require('worker_threads');
const { forWasmEncoder } = require('../lib/ft-wasm-text');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('forWasmEncoder');
check('strips the brackets of a hashed call', () => {
  assert.strictEqual(forWasmEncoder('<HS0GWL/M> VK4KTW'), 'HS0GWL/M VK4KTW');
  assert.strictEqual(forWasmEncoder('HS0GWL/M <VK4KTW>'), 'HS0GWL/M VK4KTW');
  assert.strictEqual(forWasmEncoder('<HS0GWL/M> VK4KTW RR73'), 'HS0GWL/M VK4KTW RR73');
});
check('leaves a standard message alone', () => {
  assert.strictEqual(forWasmEncoder('K1ABC W9XYZ EN37'), 'K1ABC W9XYZ EN37');
  assert.strictEqual(forWasmEncoder('CQ K3SBP FN20'), 'CQ K3SBP FN20');
});
check('tolerates empty input', () => {
  assert.strictEqual(forWasmEncoder(''), '');
  assert.strictEqual(forWasmEncoder(null), '');
});

const SR = 12000;
const MODES = {
  FT8: { encode: 'encode', decode: 'decode', slot: 15 * SR, at: Math.round(0.5 * SR) },
  FT4: { encode: 'ft4-encode', decode: 'ft4-decode', slot: Math.round(7.5 * SR), at: Math.round(0.5 * SR) },
  FT2: { encode: 'ft2-encode', decode: 'ft2-decode', slot: 45000, at: 0 },
};
const BRACKETED = ['<HS0GWL/M> VK4KTW', 'HS0GWL/M <VK4KTW>', '<HS0GWL/M> VK4KTW -10', '<HS0GWL/M> VK4KTW RR73'];
const STANDARD = 'K1ABC W9XYZ EN37';
// What the WASM decoder may show for a hashed call it has not heard in full.
const ROUND_TRIP = /^<(HS0GWL\/M|\.\.\.)> VK4KTW -10$/;

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function inSlot(m, sig) {
  const r = rng(7);
  const buf = new Float32Array(m.slot);
  for (let i = 0; i < buf.length; i++) buf[i] = 0.05 * gauss(r);
  for (let i = 0; i < sig.length && m.at + i < buf.length; i++) buf[m.at + i] += 0.5 * sig[i];
  return buf;
}

function startWorker(forceWasm) {
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
  const info = Promise.race([readyP, new Promise((_, rej) => setTimeout(() => rej(new Error('worker not ready')), 60000))]);
  return { w, ask, info };
}

(async () => {
  let ft8jsMissing = null;
  try { await import('ft8js'); }
  catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND' && /'ft8js'/.test(e.message)) ft8jsMissing = 'ft8js package not installed here (npm install)';
    else throw e;
  }

  const wasm = startWorker(true);
  const info = await wasm.info;
  console.log('WASM worker');
  check('ready names why the native addon is not in use', () => {
    assert.strictEqual(info.native, false);
    assert.ok(/POTACAT_NO_NATIVE_FT8/.test(info.nativeError || ''), `nativeError ${JSON.stringify(info.nativeError)}`);
  });

  const wasmSamples = {};
  for (const [mode, m] of Object.entries(MODES)) {
    if (mode === 'FT8' && ft8jsMissing) { console.log(`  skip FT8 (${ft8jsMissing})`); continue; }
    for (const text of [...BRACKETED, STANDARD]) {
      const enc = await wasm.ask({ type: m.encode, text, frequency: 1500 });
      check(`${mode} WASM encodes "${text}"`, () => {
        assert.ok(enc && enc.type === 'encode-result' && enc.samples && enc.samples.length > 0, `got ${JSON.stringify(enc && (enc.message || enc.samples))}`);
      });
      if (enc && enc.samples) wasmSamples[mode + ' ' + text] = new Float32Array(enc.samples);
    }
    const report = wasmSamples[mode + ' <HS0GWL/M> VK4KTW -10'];
    if (report) {
      const res = await wasm.ask({ type: m.decode, samples: inSlot(m, report).buffer, seedCall: '', myCall: '', dxCall: '', budgetMs: 0 });
      const texts = ((res && res.results) || []).map(d => String(d.text || '').trim());
      check(`${mode} WASM round trip: "<HS0GWL/M> VK4KTW -10" decodes as the same message`, () => {
        assert.ok(texts.some(t => ROUND_TRIP.test(t)), `got ${JSON.stringify(texts)}`);
      });
    }
    const std = wasmSamples[mode + ' ' + STANDARD];
    if (std) {
      const res = await wasm.ask({ type: m.decode, samples: inSlot(m, std).buffer, seedCall: '', myCall: '', dxCall: '', budgetMs: 0 });
      const texts = ((res && res.results) || []).map(d => String(d.text || '').trim());
      check(`${mode} WASM round trip: "${STANDARD}" unchanged`, () => {
        assert.ok(texts.includes(STANDARD), `got ${JSON.stringify(texts)}`);
      });
    }
  }
  await wasm.w.terminate();

  // What the other station sees: the native decoder knows its own call's hash.
  const nat = startWorker(false);
  const ninfo = await nat.info;
  if (!ninfo.native) {
    console.log('  skip native cross-check (native addon not built here: npm run build-ft8)');
  } else {
    console.log('native cross-check');
    for (const mode of ['FT8', 'FT4']) {
      const sig = wasmSamples[mode + ' <HS0GWL/M> VK4KTW -10'];
      if (!sig) continue;
      const m = MODES[mode];
      const res = await nat.ask({ type: m.decode, samples: inSlot(m, sig).buffer, seedCall: 'HS0GWL/M', myCall: '', dxCall: '', budgetMs: 0 });
      const texts = ((res && res.results) || []).map(d => String(d.text || '').trim());
      check(`${mode}: HS0GWL/M's decoder reads the WASM signal as "<HS0GWL/M> VK4KTW -10"`, () => {
        assert.ok(texts.includes('<HS0GWL/M> VK4KTW -10'), `got ${JSON.stringify(texts)}`);
      });
    }
    const wsig = wasmSamples['FT8 <HS0GWL/M> VK4KTW -10'];
    if (wsig) {
      const enc = await nat.ask({ type: 'encode', text: '<HS0GWL/M> VK4KTW -10', frequency: 1500 });
      check('FT8: the WASM signal is the native signal sample for sample', () => {
        const nsig = new Float32Array(enc.samples);
        let max = 0;
        for (let i = 0; i < nsig.length; i++) max = Math.max(max, Math.abs(nsig[i] - wsig[i]));
        assert.ok(max < 1e-3, `max sample difference ${max}`);
      });
    }
  }
  await nat.w.terminate();

  console.log('');
  console.log('ft8 wasm bracket: ' + passed + ' passed, ' + failures.length + ' failed');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log('  FAIL ' + e.message); process.exit(1); });
