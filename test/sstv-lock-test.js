#!/usr/bin/env node
'use strict';
//
// SSTV lock supervision + VIS validation (WB8IMY 2026-09-26).
//
// His report: "the app picks up the wrong mode (such as PD-160) and then
// stays locked in that mode for a while. When another image transmission
// begins, the app seems to be stuck on the incorrect mode and a distorted
// image results." Three decoder faults sat behind it, each reproduced here
// against the pre-fix decoder before it was fixed:
//
//   1. False VIS. Image content passes leader/break/leader all the time (a
//      grey scan is a 1900 Hz tone, every line sync a 1200 Hz break); the bits
//      that followed were decided by E1100 > E1300 with no check that either
//      tone was there, then "corrected" by flipping any data bit that landed
//      on a known code. Content reads as zeros: 0000000 + parity 1 became
//      code 4, Robot 24.
//   2. No exit. A lock ran for the mode's full nominal length whatever the
//      audio did — a wrong PD-160 lock over a Martin 1 image held 158 s.
//   3. Deaf to a new header. VIS detection only ran in IDLE, so the next
//      image's VIS was ignored until the wrong lock ran out.
//
// Plus the pop-out side: the no-VIS auto-start never announced its mode, and
// the RX canvas only knew five modes' sizes, so rows were drawn into the
// previous lock's canvas.
//
// Run: node test/sstv-lock-test.js
//
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SstvDecoder, encodeImage, decideVisBits } = require('../lib/sstv-worker');
const { MODES } = require('../lib/sstv-modes');
const { sstvRxVisLogLine } = require('../lib/sstv-engine');

const SR = 48000;
const CHUNK = 4096;
const VIS_LEN = Math.round(SR * 0.91); // leader 300 + break 10 + leader 300 + start 30 + 8 bits + stop

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + (e && e.message ? e.message : e)); }
}
function section(t) { console.log('\n' + t); }

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
// Photo-like content: large mid-grey and sky areas (1900 Hz — leader-like)
// plus textured regions. The colour-bar test card never exercises this.
function photo(w, h, seed) {
  const rnd = mulberry32(seed);
  const img = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r, g, b;
      if (y < h * 0.4) { r = 120 + y * 0.2; g = 130 + y * 0.2; b = 150; }
      else if (x < w * 0.5) { r = g = b = 128 + (rnd() - 0.5) * 20; }
      else { r = 90 + 60 * Math.sin(x / 9); g = 110 + 40 * Math.cos(y / 7); b = 80 + 30 * rnd(); }
      img[i] = r; img[i + 1] = g; img[i + 2] = b; img[i + 3] = 255;
    }
  }
  return img;
}
function bars(w, h) {
  const img = new Uint8ClampedArray(w * h * 4);
  const cs = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255], [255, 255, 255], [64, 64, 64]];
  for (let y = 0; y < h; y++) {
    const sh = 1 - 0.3 * y / h;
    for (let x = 0; x < w; x++) {
      const [r, g, b] = cs[Math.min(7, Math.floor(x / (w / 8)))];
      const i = (y * w + x) * 4;
      img[i] = r * sh; img[i + 1] = g * sh; img[i + 2] = b * sh; img[i + 3] = 255;
    }
  }
  return img;
}
// Real stations sit at -25..-3 dBFS; 0.3 ≈ -10 dBFS (see the input-level
// note in CLAUDE.md — the decoder at exactly 0 dBFS is a different animal).
const LEVEL = 0.3;
function enc(mode, content, level) {
  const m = MODES[mode];
  const img = content === 'bars' ? bars(m.width, m.height) : photo(m.width, m.height, content || 1);
  const s = encodeImage(img, m.width, m.height, mode);
  const g = level == null ? LEVEL : level;
  for (let i = 0; i < s.length; i++) s[i] *= g;
  return { samples: s, img };
}
function cat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function silence(sec) { return new Float32Array(Math.round(SR * sec)); }
function noise(sec, rms, seed) {
  const r = mulberry32(seed);
  const out = new Float32Array(Math.round(SR * sec));
  for (let i = 0; i < out.length; i++) out[i] = (r() * 2 - 1) * rms * 1.732;
  return out;
}
function tone(freq, ms, amp) {
  const n = Math.round(SR * ms / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * freq * i / SR);
  return out;
}
function gauss(samples, snrDb, seed) {
  const r = mulberry32(seed);
  let p = 0;
  for (const v of samples) p += v * v;
  p /= samples.length;
  const n = Math.sqrt(p / Math.pow(10, snrDb / 10));
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    out[i] = samples[i] + n * Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))) * Math.cos(2 * Math.PI * r());
  }
  return out;
}
function psnr(a, b, w, h) {
  let s = 0;
  for (let i = 0; i < w * h * 4; i += 4) {
    for (let c = 0; c < 3; c++) { const d = a[i + c] - b[i + c]; s += d * d; }
  }
  const mse = s / (w * h * 3);
  return mse === 0 ? 99 : 10 * Math.log10(255 * 255 / mse);
}

// Feed audio in worklet-sized chunks; record every event with its time.
function run(samples, opts) {
  const d = new SstvDecoder();
  const events = [];
  const stopAt = opts && opts.stopAfterSec ? opts.stopAfterSec * SR : Infinity;
  for (let i = 0; i < samples.length && i < stopAt; i += CHUNK) {
    const t = i / SR;
    for (const r of d.processSamples(new Float32Array(samples.subarray(i, Math.min(i + CHUNK, samples.length))))) {
      if (r.type === 'rx-vis' || r.type === 'rx-image' || r.type === 'rx-lock-lost') events.push({ t, ...r });
    }
  }
  return { d, events };
}
const visOf = (ev) => ev.filter((e) => e.type === 'rx-vis');
const lostOf = (ev) => ev.filter((e) => e.type === 'rx-lock-lost');
const imagesOf = (ev) => ev.filter((e) => e.type === 'rx-image');

// ===========================================================================
section('1. VIS bit qualification (decideVisBits)');
// ===========================================================================
const TONE = (bit) => (bit ? { e11: 100, e13: 12, e19: 5 } : { e11: 12, e13: 100, e19: 5 });
const CONTENT = { e11: 3, e13: 4.4, e19: 40 }; // measured shape of image content in a bit window
function evFor(code) {
  const bits = [];
  let p = 0;
  for (let i = 0; i < 7; i++) { const b = (code >> i) & 1; p ^= b; bits.push(b); }
  bits.push(p);
  return bits.map(TONE);
}

check('a clean header decodes to its mode', () => {
  for (const key of Object.keys(MODES)) {
    const v = decideVisBits(evFor(MODES[key].visCode));
    assert.ok(v.ok, key + ': ' + v.reason);
    assert.strictEqual(v.modeKey, key);
  }
});
check('image content in the bit windows is rejected, never a mode', () => {
  const v = decideVisBits(new Array(8).fill(CONTENT));
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /not VIS tones/);
});
check('the Robot 24 false path is closed: zeros from content + a parity tone of 1', () => {
  // The pre-fix reader turned 0000000 / parity 1 into code 4 (Robot 24) by
  // flipping data bit 2 — the second wrong mode in WB8IMY's log.
  const ev = new Array(7).fill(CONTENT).concat([TONE(1)]);
  const v = decideVisBits(ev);
  assert.strictEqual(v.ok, false, 'accepted as ' + v.modeKey);
});
check('parity error with every bit clean is refused, not "corrected" by guessing', () => {
  const ev = evFor(MODES.martin1.visCode);
  ev[7] = TONE(ev[7].e11 > ev[7].e13 ? 0 : 1); // flip the parity tone
  const v = decideVisBits(ev);
  assert.strictEqual(v.ok, false);
  assert.match(v.reason, /parity/);
});
check('one doubtful bit + parity error: that bit is the one corrected', () => {
  const code = MODES.scottie1.visCode; // 60 = 0111100
  const ev = evFor(code);
  // bit 2 (a 1) smeared: fails the contrast test AND reads 0, so parity disagrees
  ev[2] = { e11: 18, e13: 20, e19: 5 };
  const v = decideVisBits(ev);
  assert.ok(v.ok, v.reason);
  assert.strictEqual(v.modeKey, 'scottie1');
  assert.strictEqual(v.corrected, true);
});
check('two doubtful bits are refused', () => {
  const ev = evFor(MODES.pd160.visCode);
  ev[1] = CONTENT; ev[5] = CONTENT;
  assert.strictEqual(decideVisBits(ev).ok, false);
});

// ===========================================================================
section('2. False VIS from non-header audio');
// ===========================================================================
// A leader/break/leader/start-bit front door followed by bits that are not
// VIS tones — voice, noise, or image content behind a sync. Pre-fix this
// fixture locked Robot 24 (content zeros + a 1100 Hz parity window).
function fakeHeader(bitsAudio) {
  return cat(silence(0.3), tone(1900, 300, LEVEL), tone(1200, 10, LEVEL), tone(1900, 300, LEVEL), tone(1200, 30, LEVEL), bitsAudio, silence(2));
}
check('leader + break + leader + start bit, then image-content bits and a 1100 Hz parity: no lock', () => {
  const bitsAudio = cat(tone(1650, 210, LEVEL), tone(1100, 30, LEVEL), tone(1200, 30, LEVEL));
  const { events } = run(fakeHeader(bitsAudio));
  assert.deepStrictEqual(visOf(events).map((e) => e.mode), []);
});
check('the same front door followed by band noise never locks (40 seeds)', () => {
  const hits = [];
  for (let seed = 1; seed <= 40; seed++) {
    const { events } = run(fakeHeader(noise(0.27, LEVEL * 0.6, seed)));
    for (const e of visOf(events)) hits.push(seed + ':' + e.mode);
  }
  assert.deepStrictEqual(hits, []);
});
check('joining images mid-transmission: every lock is the TRUE mode (no false VIS from content)', () => {
  for (const mode of ['scottie1', 'pd120', 'pd90', 'robot36', 'robot72', 'martin1']) {
    const { samples } = enc(mode, 3);
    const body = samples.subarray(VIS_LEN + SR * 3, VIS_LEN + SR * 18);
    const { events } = run(cat(noise(1, 0.005, 1), body));
    const wrong = visOf(events).filter((e) => e.mode !== mode);
    assert.deepStrictEqual(wrong.map((e) => e.mode), [], mode + ' produced a wrong lock');
    // and the join itself is announced with its size (pop-out canvas)
    for (const e of visOf(events)) {
      assert.strictEqual(e.auto, true);
      assert.strictEqual(e.width, MODES[mode].width);
      assert.strictEqual(e.height, MODES[mode].height);
    }
  }
});

// ===========================================================================
section('3. A wrong-mode lock is abandoned within a few line periods');
// ===========================================================================
// The field case: PD-160's VIS followed by a Martin 1 picture. Pre-fix:
// rx-vis pd160 at 1.2 s, then nothing until "Decode discarded" at 159 s.
check('PD-160 header over a Martin 1 image: lock dropped, Martin 1 joined, picture decoded', () => {
  const pd = enc('pd160', 4).samples;
  const m1 = enc('martin1', 2).samples;
  const audio = cat(silence(0.3), pd.subarray(0, VIS_LEN), m1.subarray(VIS_LEN), noise(10, 0.005, 4));
  const { events } = run(audio);
  const v = visOf(events);
  assert.strictEqual(v[0].mode, 'pd160');
  const lost = lostOf(events);
  assert.ok(lost.length >= 1, 'no rx-lock-lost');
  assert.strictEqual(lost[0].mode, 'pd160');
  assert.strictEqual(lost[0].reason, 'no-sync');
  assert.ok(lost[0].t - v[0].t < 6, 'held the wrong lock ' + (lost[0].t - v[0].t).toFixed(1) + ' s');
  const joined = v.find((e) => e.mode === 'martin1');
  assert.ok(joined && joined.auto, 'Martin 1 was not joined from its line sync');
  assert.ok(joined.t - lost[0].t < 3, 'join took ' + (joined.t - lost[0].t).toFixed(1) + ' s');
  const img = imagesOf(events);
  assert.strictEqual(img.length, 1, 'expected one image, got ' + img.length);
  assert.strictEqual(img[0].mode, 'martin1');
  assert.ok(!img[0].weak && img[0].stats.sync >= 80, 'joined image sync=' + img[0].stats.sync + '%' + (img[0].weak ? ' (weak)' : ''));
});
check('Robot 24 header over a PD-120 image: dropped in ≤3.5 s, PD-120 joined', () => {
  const r24 = enc('robot24', 6).samples;
  const pd = enc('pd120', 5).samples;
  const { events } = run(cat(silence(0.3), r24.subarray(0, VIS_LEN), pd.subarray(VIS_LEN, VIS_LEN + SR * 20)));
  const lost = lostOf(events);
  assert.ok(lost.length && lost[0].mode === 'robot24', 'no lock-lost for robot24');
  assert.ok(lost[0].t - visOf(events)[0].t <= 3.5);
  assert.ok(visOf(events).some((e) => e.mode === 'pd120' && e.auto));
});
check('a VIS followed by silence or noise is let go instead of grinding the full image', () => {
  for (const [label, tail] of [['silence', silence(12)], ['noise', noise(12, 0.1, 9)]]) {
    const pd = enc('pd240', 1).samples;
    const { events } = run(cat(silence(0.3), pd.subarray(0, VIS_LEN), tail));
    const lost = lostOf(events);
    assert.ok(lost.length === 1 && lost[0].mode === 'pd240', label + ': ' + JSON.stringify(lost.map((e) => e.detail)));
    assert.ok(lost[0].t < 8, label + ': held ' + lost[0].t.toFixed(1) + ' s');
  }
});

// ===========================================================================
section('4. A new VIS during a lock restarts on the new mode');
// ===========================================================================
check('Martin 1 cut at 20 s, Scottie 1 with its VIS follows: restart on Scottie 1, clean picture', () => {
  const m1 = enc('martin1', 2).samples;
  const s1 = enc('scottie1', 'bars');
  const { events } = run(cat(silence(0.3), m1.subarray(0, SR * 20), s1.samples, silence(2)));
  const v = visOf(events);
  assert.deepStrictEqual(v.map((e) => e.mode), ['martin1', 'scottie1']);
  assert.strictEqual(v[1].midLock, true);
  assert.ok(v[1].t < 22, 'new VIS acted on at ' + v[1].t.toFixed(1) + ' s');
  const lost = lostOf(events);
  assert.ok(lost.length === 1 && lost[0].reason === 'new-vis' && lost[0].mode === 'martin1');
  const img = imagesOf(events);
  assert.strictEqual(img.length, 1);
  assert.strictEqual(img[0].mode, 'scottie1');
  const p = psnr(s1.img, img[0].imageData, MODES.scottie1.width, MODES.scottie1.height);
  assert.ok(p > 30, 'scottie1 after a mid-lock restart: ' + p.toFixed(1) + ' dB');
});
check('the WB8IMY sequence: wrong PD-160 lock, then a real Scottie 1 — Scottie 1 is decoded', () => {
  const pd = enc('pd160', 4).samples;
  const m1 = enc('martin1', 2).samples;
  const s1 = enc('scottie1', 'bars');
  // PD-160 header, 30 s of Martin 1 picture, then the next station's image.
  const audio = cat(silence(0.3), pd.subarray(0, VIS_LEN), m1.subarray(VIS_LEN, VIS_LEN + SR * 30), silence(1), s1.samples, silence(2));
  const { events } = run(audio);
  const img = imagesOf(events).filter((e) => e.mode === 'scottie1');
  assert.strictEqual(img.length, 1, 'Scottie 1 never decoded: ' + events.map((e) => e.type + ':' + (e.mode || '')).join(' '));
  assert.ok(psnr(s1.img, img[0].imageData, 320, 256) > 30);
});
check('a new VIS after most of an image is in: the old picture is emitted, then the new one starts', () => {
  const m2 = enc('martin2', 'bars').samples;          // 58 s
  const r36 = enc('robot36', 'bars').samples;
  const cut = VIS_LEN + Math.round((m2.length - VIS_LEN) * 0.8);
  const { events } = run(cat(silence(0.3), m2.subarray(0, cut), r36, silence(2)));
  const order = events.map((e) => e.type + ':' + e.mode);
  assert.deepStrictEqual(order, ['rx-vis:martin2', 'rx-image:martin2', 'rx-vis:robot36', 'rx-image:robot36']);
});

// ===========================================================================
section('5. Genuine signals are never let go');
// ===========================================================================
// The PSNR matrix (sstv-quality-test.js) is byte-identical with lock
// supervision in place; this adds photo content, low SNR, fading, drift and
// two input levels over the first 15 s of every mode (a lock is confirmed or dropped within max(6 line periods, 3 s) — 5.9 s for PD-240) — the window where a
// lock is confirmed or dropped.
function qsb(s, per, depth) {
  const out = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s[i] * (1 - depth * 0.5 * (1 + Math.sin(2 * Math.PI * i / (SR * per))));
  return out;
}
function driftPpm(s, ppm) {
  const f = 1 + ppm * 1e-6;
  const out = new Float32Array(Math.round(s.length / f));
  for (let i = 0; i < out.length; i++) {
    const x = i * f; const i0 = Math.floor(x); const i1 = Math.min(i0 + 1, s.length - 1); const fr = x - i0;
    out[i] = s[i0] * (1 - fr) + s[i1] * fr;
  }
  return out;
}
check('every mode × {photo, bars 3 dB SNR, QSB, ±2000 ppm, -34 dBFS, 0 dBFS}: no lock ever dropped', () => {
  const bad = [];
  for (const mode of Object.keys(MODES)) {
    const photoAudio = enc(mode, 7).samples.subarray(0, SR * 15);
    const barsAudio = enc(mode, 'bars').samples.subarray(0, SR * 15);
    const cases = {
      photo: photoAudio,
      snr3: gauss(barsAudio, 3, 2),
      qsb: qsb(gauss(barsAudio, 15, 1), 8, 0.8),
      'drift+2000': driftPpm(barsAudio, 2000),
      'drift-2000': driftPpm(barsAudio, -2000),
      quiet: enc(mode, 'bars', 0.02).samples.subarray(0, SR * 15),
      hot: enc(mode, 'bars', 1).samples.subarray(0, SR * 15),
    };
    for (const [label, s] of Object.entries(cases)) {
      const { events } = run(cat(silence(0.3), s));
      const v = visOf(events);
      if (v.length !== 1 || v[0].mode !== mode || lostOf(events).length) {
        bad.push(`${mode}/${label}: ${events.map((e) => e.type + ':' + (e.mode || '') + (e.detail ? ' ' + e.detail : '')).join(' | ')}`);
      }
    }
  }
  assert.deepStrictEqual(bad, []);
});
check('a transmission that stops half-way is closed ~6 s later with its picture, not after the full image time', () => {
  const m1 = enc('martin1', 'bars').samples;
  const cut = VIS_LEN + Math.round((m1.length - VIS_LEN) * 0.6); // ~70 s of 114
  const endT = 0.3 + cut / SR;
  const { events } = run(cat(silence(0.3), m1.subarray(0, cut), noise(15, 0.01, 3)));
  const img = imagesOf(events);
  assert.strictEqual(img.length, 1, events.map((e) => e.type).join(' '));
  assert.ok(img[0].t - endT < 8, 'closed ' + (img[0].t - endT).toFixed(1) + ' s after the audio stopped');
});

// ===========================================================================
section('6. Stop clears the lock; host plumbing');
// ===========================================================================
check('reset() (the worker\'s "stop") leaves no mode, lock or watcher behind', () => {
  const pd = enc('pd160', 4).samples;
  const { d } = run(cat(silence(0.3), pd.subarray(0, VIS_LEN + SR * 2)));
  assert.strictEqual(d.modeKey, 'pd160');
  d.reset();
  assert.strictEqual(d.state, 0);
  assert.strictEqual(d.modeKey, null);
  assert.strictEqual(d.mode, null);
  assert.strictEqual(d.lineNum, 0);
});
check('the VIS log line names the mode and VIS code — never "0xpd160"', () => {
  const line = sstvRxVisLogLine({ mode: 'pd160', modeName: 'PD-160', visCode: 98 });
  assert.ok(!/0x/.test(line), line);
  assert.match(line, /PD-160 \(VIS 98\)/);
  assert.match(sstvRxVisLogLine({ mode: 'martin1', modeName: 'Martin M1', auto: true }), /No VIS heard — joined Martin M1/);
  assert.match(sstvRxVisLogLine({ mode: 'scottie1', modeName: 'Scottie S1', visCode: 60, midLock: true }), /New VIS during a decode: Scottie S1/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(!/VIS detected: \$\{data\.modeName\} \(mode 0x/.test(main), 'main.js still hex-formats the mode key');
  assert.ok(/sendCatLog\(sstvRxVisLogLine\(data\)\)/.test(main));
});
check('main.js: a stopped engine is restarted, and a lost lock clears the decode state', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/if \(sstvEngine\) \{\s*[\s\S]{0,600}?if \(!sstvEngine\.running\) \{\s*sstvEngine\.start\(\);/.test(main), 'startSstv must restart a stopped engine');
  assert.ok(/sstvEngine\.on\('rx-lock-lost'[\s\S]{0,400}?_sstvDecode = null;/.test(main));
  assert.ok(/sstvManager\.on\('rx-lock-lost'/.test(main));
});
check('engine + manager forward rx-lock-lost; engine re-applies the sample rate to a fresh worker', () => {
  const eng = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sstv-engine.js'), 'utf8');
  assert.ok(/case 'rx-lock-lost':[\s\S]{0,300}?this\._decoding = false;[\s\S]{0,300}?this\.emit\('rx-lock-lost'/.test(eng));
  assert.ok(/case 'ready':[\s\S]{0,500}?type: 'set-sample-rate', sampleRate: this\._sampleRate/.test(eng));
  const mgr = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sstv-manager.js'), 'utf8');
  assert.ok(/engine\.on\('rx-lock-lost'/.test(mgr));
});
check('pop-out: canvas sized from the decoder\'s mode, PD row pairs drawn, lock-lost handled', () => {
  const pop = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'sstv-popout.js'), 'utf8');
  assert.ok(/function rxResFor\(data\) \{\s*if \(data && data\.width > 0 && data\.height > 0\)/.test(pop));
  assert.ok(!/const res = MODE_RES\[data\.mode\];/.test(pop), 'rx-vis must not size the canvas from the TX table alone');
  assert.ok(/new ImageData\(rgba, w, rgba\.length \/ \(4 \* w\)\)/.test(pop), 'a PD rx-line is two rows');
  assert.ok(/onSstvRxLockLost/.test(pop));
  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload-sstv-popout.js'), 'utf8');
  assert.ok(/onSstvRxLockLost: \(cb\) => ipcRenderer\.on\('sstv-rx-lock-lost'/.test(pre));
});

console.log('\n' + '='.repeat(60));
console.log(`SSTV lock: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
