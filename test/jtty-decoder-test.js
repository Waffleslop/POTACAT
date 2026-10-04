#!/usr/bin/env node
'use strict';
// JTTY receiver (lib/jtty/decoder.js), Phase 2 of docs/jtty-integration-plan.md.
// Acceptance: WSJT-X's own sample recording decodes to the text WSJT-X shows
// (test/fixtures/jtty/README.md); our encoder's output decodes clean and in
// noise at sjtty's SNR definition; pure noise decodes nothing.
// Run: node test/jtty-decoder-test.js  (SNR sweep: JTTY_SWEEP=1)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const J = require('../lib/jtty');
const { JttyDecoder, NCHUNK } = require('../lib/jtty/decoder');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e).split('\n')[0]); }
}
console.log('JTTY decoder');

// sjtty's noise model: signal amplitude A = sqrt(2*2500/6000) * 10^(snr/20)
// against unit-variance Gaussian noise per 12 kHz sample; snr is in 2500 Hz.
let seed = 0x9E3779B9;
function randn() {
  let u = 0, v = 0;
  do { seed = (seed * 1664525 + 1013904223) >>> 0; u = seed / 4294967296; } while (u === 0);
  seed = (seed * 1664525 + 1013904223) >>> 0; v = seed / 4294967296;
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function channel(pcm, snrDb, leadSec, tailSec, noise) {
  const lead = Math.round(leadSec * 12000), tail = Math.round(tailSec * 12000);
  const out = new Float32Array(lead + pcm.length + tail);
  const A = snrDb == null ? 0.5 : Math.sqrt(2 * 2500 / 6000) * Math.pow(10, snrDb / 20);
  for (let i = 0; i < pcm.length; i++) out[lead + i] = A * pcm[i];
  if (snrDb != null || noise) for (let i = 0; i < out.length; i++) out[i] += randn();
  // Keep the decoder's full-scale assumption: sjtty writes gain*wave at 100/32767 of full scale
  const scale = 1 / 300;
  for (let i = 0; i < out.length; i++) out[i] *= scale;
  return out;
}
function readWav(file) {
  const b = fs.readFileSync(file);
  assert.strictEqual(b.toString('ascii', 0, 4), 'RIFF');
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4), len = b.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(pos + 10), rate: b.readUInt32LE(pos + 12), bits: b.readUInt16LE(pos + 22) };
    if (id === 'data') data = b.subarray(pos + 8, pos + 8 + len);
    pos += 8 + len + (len & 1);
  }
  assert.ok(fmt && data, 'wav chunks');
  assert.strictEqual(fmt.rate, 12000); assert.strictEqual(fmt.channels, 1); assert.strictEqual(fmt.bits, 16);
  const n = data.length >> 1, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = data.readInt16LE(2 * i) / 32768;
  return out;
}
const completes = (ups) => ups.filter((u) => u.complete);

test('a clean one-frame message decodes at the right frequency and time', () => {
  const e = J.encode('CQ K1ABC CQ', { f0: 1500 });
  const d = new JttyDecoder({ qsoFreq: 1500 });
  const ups = d.decodeAll(channel(e.pcm, null, 1.0, 1.0));
  const c = completes(ups);
  assert.strictEqual(c.length, 1, JSON.stringify(ups));
  assert.strictEqual(c[0].text, 'CQ K1ABC CQ');
  assert.ok(Math.abs(c[0].freqHz - 1500) < 1.5, 'freq ' + c[0].freqHz);
  assert.ok(Math.abs(c[0].tStart - 1.0) < 0.02, 'tStart ' + c[0].tStart);
});

test('a multi-frame message is assembled in order with EOM, structured and text frames mixed', () => {
  for (const [msg, f0] of [['TU NOW JA6DEF 599 102', 1500], ['K1ABC HELLO 599 MA', 1500], ['THE QUICK BROWN FOX', 1500]]) {
    const e = J.encode(msg, { f0 });
    const d = new JttyDecoder({ qsoFreq: 1500 });
    const c = completes(d.decodeAll(channel(e.pcm, null, 0.7, 1.0)));
    assert.strictEqual(c.length, 1, msg + ': ' + JSON.stringify(c));
    assert.strictEqual(c[0].text, msg);
  }
});

test('a signal outside the QSO window is found by the band windows', () => {
  const e = J.encode('WB9XYZ 599 123', { f0: 2210 });
  const d = new JttyDecoder({ qsoFreq: 1500 });
  const c = completes(d.decodeAll(channel(e.pcm, null, 0.5, 1.0)));
  assert.strictEqual(c.length, 1, JSON.stringify(c));
  assert.strictEqual(c[0].text, 'WB9XYZ 599 123');
  assert.ok(Math.abs(c[0].freqHz - 2210) < 2, 'freq ' + c[0].freqHz);
});

test('two signals at once: the stronger is subtracted and the weaker found', () => {
  const a = J.encode('CQ K1ABC CQ', { f0: 1500 }), b = J.encode('WB9XYZ', { f0: 1540 });
  const mixed = channel(a.pcm, null, 0.5, 1.0);
  for (let i = 0; i < b.pcm.length; i++) mixed[6000 + 3000 + i] += 0.25 * b.pcm[i] / 300;
  const d = new JttyDecoder({ qsoFreq: 1500 });
  const texts = completes(d.decodeAll(mixed)).map((u) => u.text).sort();
  assert.deepStrictEqual(texts, ['CQ K1ABC CQ', 'WB9XYZ']);
});

test('noise: decodes at 0, -5 and -10 dB (sjtty SNR, 2500 Hz)', () => {
  for (const snr of [0, -5, -10]) {
    let ok = 0;
    for (let trial = 0; trial < 3; trial++) {
      const e = J.encode('CQ K1ABC CQ', { f0: 1500 });
      const d = new JttyDecoder({ qsoFreq: 1500 });
      if (completes(d.decodeAll(channel(e.pcm, snr, 0.8, 1.0))).some((u) => u.text === 'CQ K1ABC CQ')) ok++;
    }
    assert.strictEqual(ok, 3, snr + ' dB: ' + ok + ' of 3');
  }
});

test('30 s of noise decodes nothing', () => {
  const d = new JttyDecoder({ qsoFreq: 1500 });
  const ups = d.decodeAll(channel(new Float32Array(0), null, 30, 0, true));
  assert.strictEqual(ups.length, 0, JSON.stringify(ups));
});

test('the WSJT-X sample recording decodes to what WSJT-X shows', () => {
  const pcm = readWav(path.join(__dirname, 'fixtures', 'jtty', '260807_134110.wav'));
  const d = new JttyDecoder({ qsoFreq: 1500, qsoTol: 50 });
  const t0 = Date.now();
  const ups = d.decodeAll(pcm);
  const ms = Date.now() - t0;
  const c = completes(ups);
  console.log('       sample: ' + (pcm.length / 12000).toFixed(1) + ' s of audio in ' + ms + ' ms; ' + JSON.stringify(c.map((u) => [u.text, u.freqHz, u.tStart.toFixed(2), u.snrDb])));
  assert.ok(c.some((u) => u.text === 'RAN ALL NIGHT ON BAND NOISE - NO FALSE DECODES!'), 'expected text not decoded');
  const hit = c.find((u) => u.text === 'RAN ALL NIGHT ON BAND NOISE - NO FALSE DECODES!');
  assert.ok(Math.abs(hit.freqHz - 1507) < 3, 'freq ' + hit.freqHz);
  assert.strictEqual(c.filter((u) => u.text !== hit.text).length, 0, 'no other complete messages');
});

test('on sjtty\'s -16 dB files the decoder makes rjtty\'s decisions, file by file', () => {
  const dir = path.join(__dirname, 'fixtures', 'jtty', 'sjtty-16dB');
  const v = JSON.parse(fs.readFileSync(path.join(dir, 'verdicts.json'), 'utf8'));
  for (const [file, rjttyDecoded] of Object.entries(v.verdicts)) {
    const d = new JttyDecoder({ qsoFreq: v.f0, qsoTol: 50 });
    const ours = completes(d.decodeAll(readWav(path.join(dir, file)))).some((u) => u.text === v.message);
    assert.strictEqual(ours, rjttyDecoded, file + ': rjtty ' + (rjttyDecoded ? 'decoded' : 'did not decode') + ', we ' + (ours ? 'did' : 'did not'));
  }
});

if (process.env.JTTY_SWEEP) {
  console.log('\nSNR sweep (sjtty definition, 2500 Hz), 10 trials each:');
  for (const snr of [-8, -10, -12, -13, -14, -15, -16]) {
    let ok = 0; const t0 = Date.now();
    for (let trial = 0; trial < 10; trial++) {
      const e = J.encode('CQ K1ABC CQ', { f0: 1500 });
      const d = new JttyDecoder({ qsoFreq: 1500, bandWindows: false });
      if (completes(d.decodeAll(channel(e.pcm, snr, 0.8, 0.8))).some((u) => u.text === 'CQ K1ABC CQ')) ok++;
    }
    console.log('  ' + snr + ' dB: ' + ok + '/10  (' + Math.round((Date.now() - t0) / 10) + ' ms per trial)');
  }
}

console.log(`\nJTTY decoder: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
