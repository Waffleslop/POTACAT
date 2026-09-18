// SSTV input level independence (WB8IMY 2026-09-18).
//
// A strong image arriving at ~-40 dBFS left the decoder in IDLE for the whole
// transmission: every amplitude gate in lib/sstv-worker.js (ENV_THRESHOLD_MIN,
// AFC_MAG_MIN, sync-peak minimums) was ABSOLUTE and tuned for audio near full
// scale, while the auto-ranging waterfall painted the signal as bright as any
// other and the "NO RX AUDIO" badge only fires below -80 dBFS. MMSSTV and
// WSJT-X normalise their input; now so do we. This test pins:
//   1. the same image decodes, line for line, at 0 / -40 / -50 / -60 dBFS;
//   2. digital silence is NOT boosted into a false leader;
//   3. the decode log's IDLE line carries the raw input level ('in=-40dBFS'),
//      so the next low-level report is diagnosable from the paste alone;
//   4. the pop-out shows the level and an amber "RX AUDIO LOW" badge.
// Run: node test/sstv-input-level-test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SstvDecoder, encodeImage } = require('../lib/sstv-worker');
const { MODES } = require('../lib/sstv-modes');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (err.stack || err.message)); }
}
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

const SAMPLE_RATE = 48000;
const CHUNK = 4096;
const KEY = 'robot36';
const mode = MODES[KEY];

// The quality matrix's colour bars (test/sstv-quality-test.js makeTestImage).
function testImage(w, h) {
  const img = new Uint8ClampedArray(w * h * 4);
  const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255], [255, 255, 255], [64, 64, 64]];
  for (let y = 0; y < h; y++) {
    const shade = 1 - 0.3 * (y / h);
    for (let x = 0; x < w; x++) {
      const [r, g, b] = colors[Math.min(7, Math.floor(x / (w / 8)))];
      const i = (y * w + x) * 4;
      img[i] = Math.round(r * shade); img[i + 1] = Math.round(g * shade); img[i + 2] = Math.round(b * shade); img[i + 3] = 255;
    }
  }
  return img;
}
const srcImage = testImage(mode.width, mode.height);
const base = encodeImage(srcImage, mode.width, mode.height, KEY);
function psnrOf(rx) {
  const a = rx.imageData, w = rx.width, h = rx.height;
  let sum = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) { const d = a[i + c] - srcImage[i + c]; sum += d * d; }
  }
  const mse = sum / (w * h * 3);
  return mse === 0 ? 99 : 10 * Math.log10(255 * 255 / mse);
}

// Feed the encoded image at a given linear amplitude with half a second of
// silence either side; report what the decoder did and what it logged.
function decodeAt(amp) {
  const pad = SAMPLE_RATE * 2; // 2 s of silence first: the IDLE diagnostic prints every 10th chunk
  const s = new Float32Array(base.length + pad * 2);
  for (let i = 0; i < base.length; i++) s[i + pad] = base[i] * amp;
  const d = new SstvDecoder();
  const out = { leader: false, lines: 0, idleLines: [], maxInputDb: -999, image: null };
  for (let i = 0; i < s.length; i += CHUNK) {
    for (const r of d.processSamples(new Float32Array(s.subarray(i, Math.min(i + CHUNK, s.length))))) {
      if (r.type === 'rx-image') out.image = r;
      if (r.type !== 'rx-debug') continue;
      if (r.state === 'LEADER') out.leader = true;
      if (r.state === 'IDLE' && /leader=/.test(r.detail || '')) out.idleLines.push(r.detail);
      if (typeof r.inputDb === 'number' && r.inputDb > out.maxInputDb) out.maxInputDb = r.inputDb;
      const l = /line=(\d+)/.exec(r.detail || '');
      if (l) out.lines = Math.max(out.lines, +l[1]);
    }
  }
  return out;
}

console.log('SSTV input level independence\n');

const full = decodeAt(1);
test('full-scale reference decodes the whole image', () => {
  assert.ok(full.leader, 'leader detected');
  assert.ok(full.image, 'image emitted');
  assert.ok(psnrOf(full.image) > 20, 'PSNR=' + psnrOf(full.image).toFixed(1) + ' dB');
});

for (const [amp, db] of [[0.01, -40], [0.003, -50], [0.001, -60]]) {
  test(`the same image at ${db} dBFS decodes to the same picture (was deaf below -30 dBFS)`, () => {
    const r = decodeAt(amp);
    assert.ok(r.leader, 'leader detected at ' + db + ' dBFS');
    assert.ok(r.image, 'image emitted at ' + db + ' dBFS');
    const p = psnrOf(r.image), p0 = psnrOf(full.image);
    assert.ok(Math.abs(p - p0) < 1.0, 'PSNR ' + p.toFixed(2) + ' dB vs full-scale ' + p0.toFixed(2) + ' dB');
  });
}

test('IDLE log line reports the RAW input level, so a low card level is visible in the paste', () => {
  const r = decodeAt(0.01);
  assert.ok(r.idleLines.length > 0, 'saw IDLE lines before the leader');
  const line = r.idleLines[r.idleLines.length - 1];
  assert.ok(/leader=\d+\/\d+ e19=\d+\.\d{3} in=-?\d+dBFS gain=\+\d+dB/.test(line), line);
  // The peak the tracker reports is the leader tone itself: -40 dBFS ± the
  // filter's passband ripple. If this drifts, the number stops meaning what
  // the pop-out and the release notes say it means.
  assert.ok(r.maxInputDb >= -44 && r.maxInputDb <= -36, 'reported in=' + r.maxInputDb + ' dBFS for a -40 dBFS input');
});

test('inputs above -6 dBFS run at gain 1.000 exactly (the PSNR matrix stays byte-identical); quieter ones are lifted to -6 dBFS', () => {
  const tone = (amp) => { const s = new Float32Array(SAMPLE_RATE); for (let i = 0; i < s.length; i++) s[i] = amp * Math.sin(2 * Math.PI * 1900 * i / SAMPLE_RATE); return s; };
  for (const amp of [1, 0.7, 0.5]) {
    const d = new SstvDecoder(); d.processSamples(tone(amp));
    assert.strictEqual(d._inGain, 1, 'gain=' + d._inGain + ' for a ' + Math.round(20 * Math.log10(amp)) + ' dBFS tone');
  }
  const d2 = new SstvDecoder(); d2.processSamples(tone(0.01));
  assert.ok(Math.abs(d2._inGain - 50) < 1, 'gain=' + d2._inGain.toFixed(2) + ' for a -40 dBFS tone (→ -6 dBFS)');
  const d3 = new SstvDecoder(); d3.processSamples(tone(0.1));
  assert.ok(Math.abs(d3._inGain - 5) < 0.1, 'gain=' + d3._inGain.toFixed(2) + ' for a -20 dBFS tone (→ -6 dBFS)');
});

test('a 5 ms static crash 30 dB above the signal does not move the gain', () => {
  const d = new SstvDecoder();
  const s = new Float32Array(SAMPLE_RATE);
  for (let i = 0; i < s.length; i++) s[i] = 0.01 * Math.sin(2 * Math.PI * 1900 * i / SAMPLE_RATE);
  d.processSamples(s.slice(0, SAMPLE_RATE / 2));
  const before = d._inGain;
  const crash = s.slice(SAMPLE_RATE / 2);
  for (let i = 0; i < 240; i++) crash[i] = 0.3 * Math.sin(2 * Math.PI * 1500 * i / SAMPLE_RATE); // 5 ms at -10 dBFS
  d.processSamples(crash);
  assert.ok(Math.abs(d._inGain - before) / before < 0.02, 'gain ' + before.toFixed(1) + ' → ' + d._inGain.toFixed(1));
});

test('digital silence is not boosted into a leader (gain is capped)', () => {
  const d = new SstvDecoder();
  let leader = false, anyIdle = null;
  const zeros = new Float32Array(CHUNK);
  for (let i = 0; i < Math.ceil(SAMPLE_RATE * 12 / CHUNK); i++) {
    for (const r of d.processSamples(new Float32Array(zeros))) {
      if (r.type === 'rx-debug' && r.state !== 'IDLE') leader = true;
      if (r.type === 'rx-debug' && r.state === 'IDLE') anyIdle = r;
    }
  }
  assert.strictEqual(leader, false, 'stayed IDLE through 12 s of silence');
  assert.ok(anyIdle && /gain=\+40dB/.test(anyIdle.detail), 'boost sits at the cap on silence: ' + (anyIdle && anyIdle.detail));
  assert.strictEqual(anyIdle.inputDb, -120);
});

test('worker: only the amplitude consumers see the gain; the phase path runs on the raw sample', () => {
  const w = R('lib/sstv-worker.js');
  const fn = w.slice(w.indexOf('_runDsp(sample) {'), w.indexOf('_isSyncTone('));
  assert.ok(/this\.hilbertBuf\[this\.hilbertIdx\] = sample;/.test(fn), 'Hilbert delay line takes the raw sample');
  assert.ok(/const x = sample \* gain;/.test(fn));
  for (const e of ['env1200', 'env1900', 'env1100', 'env1300']) assert.ok(fn.includes(`this.${e}.process(x)`), e + ' on normalised audio');
  assert.ok(/const mag = rawMag \* gain;/.test(fn));
  assert.ok(/const INPUT_REF_MIN = 0\.005;/.test(w), 'boost cap');
  assert.ok(/if \(this\.state <= STATE_LEADER\) \{\n\s+const floor = INPUT_REF_MAG \* INPUT_REF_MIN;\n\s+this\._inGain = Math\.max\(1, INPUT_TARGET \* INPUT_REF_MAG \/ /.test(fn), 'boost only, to the target, frozen from the VIS start bit on — the sync argmax must see one scale per image');
  assert.ok(/const med = blockMedian\(this\._inBlock\);\n\s+this\._inBlockN = 0;\n\s+const decayed = this\._inPeak \* this\._inDecayBlock;\n\s+this\._inPeak = med > decayed \? med : decayed;/.test(fn), 'block step: the 20 ms median or one block of decay; nothing moves between blocks');
  assert.ok(!/this\._inPeak \*= this\._inDecay;/.test(fn), 'no per-sample decay');
  assert.ok(/const INPUT_REF_MAG = measureFullScaleMag\(1900, 48000\);/.test(w), 'reference measured through the same convolution and the same estimator');
  assert.ok(/const INPUT_TARGET = 0\.5;/.test(w), 'target is -6 dBFS, not full scale (the _envSawLow knife edge)');
});

test('pop-out: RX level readout and an amber RX AUDIO LOW badge at -50 dBFS', () => {
  const js = R('renderer/sstv-popout.js'), html = R('renderer/sstv-popout.html');
  assert.ok(/const RX_LOW_DBFS = -50;/.test(js));
  assert.ok(/if \(peak > _rxLevelPeak\) _rxLevelPeak = peak;/.test(js), 'level tracked where the dead check samples audio');
  assert.ok(/low\.textContent = 'RX AUDIO LOW \(' \+ Math\.round\(holdDb\) \+ ' dBFS\)';/.test(js));
  assert.ok(/id="rx-level"/.test(html) && /id="rx-low-audio"/.test(html));
  assert.ok(/id="rx-low-audio"[^>]*background:rgba\(240,165,0/.test(html), 'amber, not the red of NO RX AUDIO');
});

console.log(`\nSSTV input level: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
