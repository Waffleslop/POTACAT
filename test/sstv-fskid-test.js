#!/usr/bin/env node
'use strict';
// SSTV FSK ID (lib/sstv-fskid.js): the callsign MMSSTV/QSSTV send after a
// picture, decoded so the SSTV window can fill "their call" for a reply.
// Format and sources are at the top of the module (MMSSTV OutputFSKID /
// WriteFSK: 2100 Hz guard, 1900 Hz start bit, 6-bit LSB-first symbols at
// 22 ms, 0x2A call 0x01 xsum).
// Run: node test/sstv-fskid-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { FskIdDecoder, encodeFskId, isCallsign } = require('../lib/sstv-fskid');
const { encodeImage } = require('../lib/sstv-worker');
const { MODES } = require('../lib/sstv-modes');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s + 0.5) / 4294967296; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r()); }

/** Signal with padding, then white noise at `snrDb` measured in a 3 kHz band. */
function channel(sig, sr, { snrDb = null, lead = 0.4, tail = 0.4, seed = 1 } = {}) {
  const pre = Math.round(sr * lead), post = Math.round(sr * tail);
  const out = new Float32Array(pre + sig.length + post);
  out.set(sig, pre);
  if (snrDb != null) {
    const amp = 0.5, pSig = amp * amp / 2;
    const pNoise3k = pSig / Math.pow(10, snrDb / 10);
    const sigma = Math.sqrt(pNoise3k * (sr / 2) / 3000);
    const r = lcg(seed);
    for (let i = 0; i < out.length; i++) out[i] += sigma * gauss(r);
  }
  return out;
}
function decodeAll(samples, sr, block = 1024) {
  const d = new FskIdDecoder({ sampleRate: sr });
  const calls = [];
  for (let i = 0; i < samples.length; i += block) for (const c of d.push(samples.subarray(i, i + block))) calls.push(c.call);
  return calls;
}

console.log('SSTV FSK ID');

test('the encoder follows MMSSTV: 0x2A, call-0x20, 0x01, xsum, LSB first, 22 ms bits', () => {
  const sr = 12000;
  const w = encodeFskId('K3SBP', sr);
  // guard 100 + start 22 + (1 + 5 + 1 + 1) symbols * 6 bits * 22 + guard 100
  const expectMs = 100 + 22 + 8 * 6 * 22 + 100;
  assert.strictEqual(w.length, Math.round(sr * expectMs / 1000));
  // Read back the bits by tone at each bit centre (independent of the decoder).
  const toneAt = (ms, hz) => {
    const c = Math.round(sr * ms / 1000), h = Math.round(sr * 0.008);
    let re = 0, im = 0;
    for (let k = c - h; k <= c + h; k++) { re += w[k] * Math.cos(2 * Math.PI * hz * k / sr); im += w[k] * Math.sin(2 * Math.PI * hz * k / sr); }
    return re * re + im * im;
  };
  const bitAt = (i) => (toneAt(122 + (i + 0.5) * 22, 1900) > toneAt(122 + (i + 0.5) * 22, 2100) ? 1 : 0);
  const sym = (s) => { let v = 0; for (let b = 0; b < 6; b++) v |= bitAt(s * 6 + b) << b; return v; };
  assert.strictEqual(toneAt(50, 2100) > toneAt(50, 1900), true, 'guard is 2100 Hz');
  assert.strictEqual(toneAt(111, 1900) > toneAt(111, 2100), true, 'start bit is 1900 Hz');
  const got = [0, 1, 2, 3, 4, 5, 6, 7].map(sym);
  const chars = 'K3SBP'.split('').map((c) => c.charCodeAt(0) - 0x20);
  const xs = chars.reduce((a, b) => a ^ b, 0);
  assert.deepStrictEqual(got, [0x2a, ...chars, 0x01, xs]);
});

test('round trip at 12 kHz, 44.1 kHz and 48 kHz, in blocks of odd sizes', () => {
  for (const sr of [12000, 44100, 48000]) for (const block of [128, 1000, 4096]) {
    const calls = decodeAll(channel(encodeFskId('K3SBP', sr), sr), sr, block);
    assert.deepStrictEqual(calls, ['K3SBP'], `${sr} Hz, block ${block}: ${JSON.stringify(calls)}`);
  }
});

test('portable and long calls, and several IDs in one stream', () => {
  const sr = 48000;
  for (const call of ['VK3/G4ABC', 'W1AW', 'JA1ZZZ/QRP', 'N4ABC']) {
    assert.deepStrictEqual(decodeAll(channel(encodeFskId(call, sr), sr), sr), [call], call);
  }
  const a = channel(encodeFskId('G0XYZ', sr), sr), b = channel(encodeFskId('KW4FM', sr), sr);
  const both = new Float32Array(a.length + b.length); both.set(a); both.set(b, a.length);
  assert.deepStrictEqual(decodeAll(both, sr), ['G0XYZ', 'KW4FM']);
});

test('mistuning of +/-50 Hz (a station off frequency) still decodes', () => {
  for (const sr of [12000, 48000]) for (const off of [-50, -25, 25, 50]) {
    const calls = decodeAll(channel(encodeFskId('OH3JA', sr, { offsetHz: off }), sr), sr);
    assert.deepStrictEqual(calls, ['OH3JA'], `${sr} Hz, offset ${off}`);
  }
});

// Noise: SNR in a 3 kHz band, 20 seeds each. The floor below is what the
// decoder reliably achieves; the failure mode under it is "no call", never a
// wrong one (asserted separately).
const SNRS = [20, 10, 6, 3, 0, -3, -6];
const results = {};
test('noise: decodes at 0 dB and above every time, never a wrong call at any SNR', () => {
  const sr = 12000;
  for (const snr of SNRS) {
    let ok = 0, wrong = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const calls = decodeAll(channel(encodeFskId('LZ3AW', sr), sr, { snrDb: snr, seed }), sr);
      if (calls.length === 1 && calls[0] === 'LZ3AW') ok++;
      wrong += calls.filter((c) => c !== 'LZ3AW').length;
    }
    results[snr] = ok;
    assert.strictEqual(wrong, 0, `${wrong} wrong calls at ${snr} dB`);
    if (snr >= 0) assert.strictEqual(ok, 20, `${ok}/20 at ${snr} dB`);
  }
  console.log('       decoded of 20 by SNR (dB in 3 kHz): ' + SNRS.map((s) => `${s}: ${results[s]}`).join(', '));
});

test('junk before and after (a chirp, a 1500 Hz tone, silence) does not get in the way', () => {
  const sr = 44100;
  const junk = new Float32Array(sr);
  for (let i = 0; i < junk.length; i++) junk[i] = 0.4 * Math.sin(2 * Math.PI * (1200 + 1100 * i / junk.length) * i / sr);
  const tone = new Float32Array(sr * 0.3).map((_, i) => 0.4 * Math.sin(2 * Math.PI * 1500 * i / sr));
  const id = encodeFskId('EA8BB', sr);
  const all = new Float32Array(junk.length + tone.length + id.length + junk.length);
  let o = 0; for (const s of [junk, tone, id, junk]) { all.set(s, o); o += s.length; }
  assert.deepStrictEqual(decodeAll(all, sr), ['EA8BB']);
});

test('a garbled frame is rejected: bad checksum, missing header, no end marker', () => {
  const sr = 12000;
  const w = encodeFskId('K5MGY', sr);
  // Flip one data bit in the middle of the call (swap its tone) -> checksum fails.
  const flip = (buf, bitIndex) => {
    const out = Float32Array.from(buf);
    const start = Math.round(sr * (122 + bitIndex * 22) / 1000), end = Math.round(sr * (122 + (bitIndex + 1) * 22) / 1000);
    const hz = (() => { let e19 = 0, e21 = 0; for (let k = start; k < end; k++) { e19 += buf[k] * Math.sin(2 * Math.PI * 1900 * k / sr); e21 += buf[k] * Math.sin(2 * Math.PI * 2100 * k / sr); } return Math.abs(e19) > Math.abs(e21) ? 2100 : 1900; })();
    let ph = 0;
    for (let k = start; k < end; k++) { out[k] = 0.5 * Math.sin(ph); ph += 2 * Math.PI * hz / sr; }
    return out;
  };
  assert.deepStrictEqual(decodeAll(channel(flip(w, 6 * 2 + 3), sr), sr), [], 'bad checksum rejected');
  assert.deepStrictEqual(decodeAll(channel(flip(w, 1), sr), sr), [], 'broken 0x2A header rejected');
  // Cut the frame before its end marker.
  const cut = w.subarray(0, Math.round(sr * (122 + 4 * 6 * 22) / 1000));
  assert.deepStrictEqual(decodeAll(channel(cut, sr), sr), [], 'truncated frame rejected');
});

test('60 s of band noise decodes nothing', () => {
  for (const sr of [12000, 48000]) {
    const n = new Float32Array(sr * 60);
    const r = lcg(sr);
    for (let i = 0; i < n.length; i++) n[i] = 0.2 * gauss(r);
    assert.deepStrictEqual(decodeAll(n, sr), [], `${sr} Hz`);
  }
});

test('SSTV picture audio (bars, a gradient and wide flat areas) decodes nothing', () => {
  // Flat areas are the worst case: a white field holds the 2300 Hz-ish tone and
  // a light grey one sits near 2100 Hz for a whole line.
  for (const modeKey of ['martin1', 'scottie1', 'robot36', 'pd120']) {
    const mode = MODES[modeKey];
    const w = mode.width, h = mode.height;
    const img = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let v;
      if (y < h / 4) v = 255 * x / w;                    // gradient
      else if (y < h / 2) v = [255, 200, 128, 60, 0, 170, 230, 90][Math.floor(x / (w / 8))]; // bars
      else if (y < 3 * h / 4) v = 223;                   // flat, ~2100 Hz
      else v = 180;                                      // flat, ~1900 Hz
      img[i] = img[i + 1] = img[i + 2] = v; img[i + 3] = 255;
    }
    const audio = encodeImage(img, w, h, modeKey);
    assert.deepStrictEqual(decodeAll(audio, 48000), [], modeKey);
  }
});

test('an ID right after a picture is found (the real order on air)', () => {
  const mode = MODES.robot36;
  const img = new Uint8ClampedArray(mode.width * mode.height * 4).fill(128);
  const pic = encodeImage(img, mode.width, mode.height, 'robot36');
  const id = encodeFskId('JA1ZZZ', 48000);
  const all = new Float32Array(pic.length + id.length + 24000);
  all.set(pic); all.set(id, pic.length);
  assert.deepStrictEqual(decodeAll(all, 48000), ['JA1ZZZ']);
});

test('callsign check', () => {
  for (const ok of ['K3SBP', 'VK3/G4ABC', 'W1AW', 'EA8BB']) assert.ok(isCallsign(ok), ok);
  for (const bad of ['', 'AB', 'ABCDE', '12345', 'K3 SBP', 'K3SBP?']) assert.ok(!isCallsign(bad), bad);
});

test('wiring: the engine runs the decoder on RX audio and main forwards it (source guards)', () => {
  const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
  const eng = R('lib/sstv-engine.js');
  const feed = eng.slice(eng.indexOf('feedAudio(samples) {'), eng.indexOf('feedAudio(samples) {') + 1200);
  assert.ok(/_fskId\.push\(/.test(feed) && /this\.emit\('fskid'/.test(feed), 'engine decodes FSK ID in feedAudio');
  assert.ok(feed.indexOf('_fskId.push(') < feed.indexOf("postMessage("), 'decoded before the buffer is handed to the worker');
  const main = R('main.js');
  assert.ok(/sstvEngine\.on\('fskid'/.test(main));
  assert.ok(/webContents\.send\('sstv-rx-fskid'/.test(main));
  assert.ok(/\[SSTV\] FSK ID: /.test(main));
  assert.ok(/onSstvRxFskid: \(cb\) => ipcRenderer\.on\('sstv-rx-fskid'/.test(R('preload-sstv-popout.js')));
});

console.log(`\nSSTV FSK ID: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
