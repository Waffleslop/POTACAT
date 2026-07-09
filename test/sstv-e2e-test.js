#!/usr/bin/env node
'use strict';
//
// SSTV end-to-end + real-world-conditions regression suite (2026-07-07).
//
// Exists because the 2026-06 decode outage shipped with ALL SSTV tests green:
// the pure-decoder suites (sstv-test.js, sstv-quality-test.js) never touch the
// worker thread, the SstvEngine wrapper, or realistic signal impairments, so
// a break anywhere in the shipped pipeline — or a front-door gate that rejects
// real off-air signals — is invisible to them.
//
// Two sections:
//   A. LIVE-ENGINE E2E — encode → SstvEngine (real worker thread, transferable
//      buffers, event bridge) → feedAudio in worklet-sized chunks → rx-image.
//      This is the exact object main.js drives. If worker messaging, engine
//      events, or buffer transfer break, THIS fails while the pure suites pass.
//   B. REAL-WORLD FRONT DOOR — off-tune carriers, noise, QSB against the pure
//      decoder. Cells that pass today are locked as ratchets; cells that fail
//      today (documented MMSSTV-parity gaps) are PENDING contracts — flip them
//      to assertions when AFC / VIS tolerance work lands.
//
// Run: node test/sstv-e2e-test.js   (CI-safe; ~2-3 min)
//
const path = require('path');
const { SstvEngine } = require(path.join(__dirname, '..', 'lib', 'sstv-engine'));
const { SstvDecoder, encodeImage } = require(path.join(__dirname, '..', 'lib', 'sstv-worker.js'));

const SR = 48000;
const CHUNK = 4096; // sstv-audio-worklet.js posts 4096-sample buffers

let pass = 0, fail = 0, pending = 0;
function ok(cond, msg, detail) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg + (detail ? ' — ' + detail : '')); }
}
function todo(cond, msg) {
  // PENDING contract: passes silently if it starts working; never fails.
  if (cond) { pass++; console.log('  ✓ (was PENDING) ' + msg); }
  else { pending++; console.log('  ◌ PENDING: ' + msg); }
}
function section(n) { console.log('\n=== ' + n + ' ==='); }

function makeTestImage(w, h) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    rgba[i] = (x * 255 / w) | 0; rgba[i + 1] = (y * 255 / h) | 0;
    rgba[i + 2] = ((x + y) % 64 < 32) ? 220 : 40; rgba[i + 3] = 255;
  }
  return rgba;
}

// --- Impairments -----------------------------------------------------------

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function addNoise(samples, snrDb, seed) {
  const rnd = mulberry32(seed);
  let sig = 0; for (let i = 0; i < samples.length; i++) sig += samples[i] * samples[i];
  sig /= samples.length;
  const nStd = Math.sqrt(sig / Math.pow(10, snrDb / 10));
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const u1 = Math.max(rnd(), 1e-12), u2 = rnd();
    out[i] = samples[i] + nStd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  return out;
}

// SSB-style spectral shift (what an off-tuned RX does to every SSTV tone):
// y[n] = x·cos(w0 n) − Hilbert(x)·sin(w0 n).
function freqShift(samples, df) {
  const N = 129, M = (N - 1) / 2;
  const h = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const k = i - M;
    if (k % 2 !== 0) h[i] = 2 / (Math.PI * k) * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (N - 1)));
  }
  const out = new Float32Array(samples.length);
  const w0 = 2 * Math.PI * df / SR;
  for (let n = 0; n < samples.length; n++) {
    let q = 0;
    for (let i = 0; i < N; i++) {
      const idx = n - i + M;
      if (idx >= 0 && idx < samples.length) q += h[i] * samples[idx];
    }
    out[n] = samples[n] * Math.cos(w0 * n) - q * Math.sin(w0 * n);
  }
  return out;
}

function qsbFade(samples, periodSec, depth) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const g = 1 - depth * 0.5 * (1 + Math.sin(2 * Math.PI * i / (SR * periodSec)));
    out[i] = samples[i] * g;
  }
  return out;
}

// --- Pure-decoder driver (front-door probes) -------------------------------

function decodePure(samples) {
  const dec = new SstvDecoder();
  let vis = null, lines = 0, image = false;
  const consume = (chunk) => {
    for (const r of (dec.processSamples(chunk) || [])) {
      if (r.type === 'rx-vis') vis = r.modeName || r.mode;
      else if (r.type === 'rx-line') lines++;
      else if (r.type === 'rx-image') image = true;
    }
  };
  for (let off = 0; off < samples.length; off += CHUNK) {
    consume(new Float32Array(samples.subarray(off, Math.min(off + CHUNK, samples.length))));
  }
  const silence = new Float32Array(CHUNK);
  for (let i = 0; i < Math.ceil(SR * 6 / CHUNK); i++) consume(new Float32Array(silence));
  return { vis, lines, image };
}

// --- Section A: live engine ------------------------------------------------

function engineRoundTrip(modeKey, w, h, timeoutMs) {
  return new Promise((resolve) => {
    const engine = new SstvEngine();
    const result = { encoded: false, vis: null, image: false, errors: [] };
    let feeder = null;
    const finish = () => {
      if (feeder) clearInterval(feeder);
      engine.stop();
      resolve(result);
    };
    const guard = setTimeout(finish, timeoutMs);

    engine.on('error', (e) => result.errors.push(e.message));
    engine.on('rx-vis', (d) => { result.vis = d.modeName || d.mode; });
    engine.on('rx-image', () => { result.image = true; clearTimeout(guard); finish(); });
    engine.on('encode-complete', (data) => {
      result.encoded = true;
      const lead = new Float32Array(SR); // 1 s silence
      const tail = new Float32Array(SR * 6); // stall-detector tail
      const all = new Float32Array(lead.length + data.samples.length + tail.length);
      all.set(lead, 0); all.set(data.samples, lead.length);
      all.set(tail, lead.length + data.samples.length);
      let off = 0;
      feeder = setInterval(() => {
        for (let k = 0; k < 10 && off < all.length; k++) {
          engine.feedAudio(all.slice(off, Math.min(off + CHUNK, all.length)));
          off += CHUNK;
        }
        if (off >= all.length) { clearInterval(feeder); feeder = null; }
      }, 5);
    });

    engine.start();
    setTimeout(() => engine.encode(makeTestImage(w, h), w, h, modeKey), 1200);
  });
}

// --- Run --------------------------------------------------------------------

(async () => {
  section('A. Live-engine E2E (worker thread + engine bridge + chunked feed)');
  {
    // Martin M2 (58 s) keeps the suite fast; the pure suites already cover
    // every mode's DSP — this section guards the PIPELINE, not the math.
    const r = await engineRoundTrip('martin2', 320, 256, 120000);
    ok(r.encoded, 'engine encode-complete fires (worker encode path)');
    ok(r.vis === 'Martin M2' || /martin/i.test(String(r.vis)), 'engine emits rx-vis through the event bridge', 'got ' + r.vis);
    ok(r.image, 'engine emits rx-image end-to-end (worklet-sized chunked feed)');
    ok(r.errors.length === 0, 'no engine errors during round trip', r.errors.join('; '));
  }
  {
    // Robot 36 exercises the YCbCr path + a second worker lifecycle.
    const r = await engineRoundTrip('robot36', 320, 240, 90000);
    ok(r.image, 'Robot 36 round-trips through the live engine');
  }

  section('B. Real-world front door — locked ratchets (pass today, must stay)');
  const img = makeTestImage(320, 256);
  const clean = encodeImage(img, 320, 256, 'martin2');
  {
    const r = decodePure(clean);
    ok(r.vis && r.image, 'clean signal decodes (control)');
  }
  {
    const r = decodePure(freqShift(clean, 50));
    ok(r.vis && r.image, 'off-tune +50 Hz still decodes');
  }
  {
    const r = decodePure(addNoise(clean, 8, 1));
    ok(r.vis && r.image, 'AWGN 8 dB SNR still decodes (VIS + full image)');
  }
  {
    const r = decodePure(qsbFade(addNoise(clean, 15, 1), 8, 0.8));
    ok(r.vis && r.image, 'deep 8 s QSB + 15 dB noise still decodes');
  }

  section('B2. Real-world front door — AFC + weak-tier ratchets (won 2026-07-07)');
  // The idle-state AFC (sstv-worker.js _afcTrack) retunes the four tone
  // detectors to a stable off-tune carrier within ±300 Hz — a capability
  // MMSSTV never had (its users tune manually against spectrum markers) —
  // and the weak-tier gate keeps borderline decodes visible. These were
  // PENDING MMSSTV-parity contracts; now locked as hard ratchets.
  {
    const r = decodePure(freqShift(clean, 100));
    ok(r.image, 'off-tune +100 Hz decodes (AFC capture)');
  }
  {
    const r = decodePure(freqShift(clean, 200));
    ok(r.image, 'off-tune +200 Hz decodes (AFC capture)');
  }
  {
    const r = decodePure(freqShift(clean, -150));
    ok(r.image, 'off-tune −150 Hz decodes (AFC capture)');
  }
  {
    const r = decodePure(addNoise(clean, 5, 1));
    ok(r.image, 'AWGN 5 dB SNR decodes to completion (weak tier)');
  }

  section('B3. Real-world front door — no-VIS + combined ratchets (won 2026-07-07)');
  {
    // MMSSTV-parity: sync-interval auto-start joins mid-transmission.
    const late = clean.slice(Math.floor(clean.length * 0.2));
    const r = decodePure(late);
    ok(r.image || r.lines > 50, 'joins a transmission already in progress (sync-interval auto-start)');
  }
  {
    const r = decodePure(addNoise(freqShift(clean, 150), 10, 1));
    ok(r.image, 'off-tune +150 Hz at 10 dB SNR decodes (noisy AFC capture)');
  }

  section('C. Redecode-from-buffer (MMSSTV "replay from RX buffer")');
  {
    // Decode normally, then replay from the retained raw buffer.
    const dec = new SstvDecoder();
    let liveImage = false;
    for (let off = 0; off < clean.length; off += CHUNK) {
      for (const r of (dec.processSamples(new Float32Array(clean.subarray(off, Math.min(off + CHUNK, clean.length)))) || [])) {
        if (r.type === 'rx-image') liveImage = true;
      }
    }
    const silence = new Float32Array(CHUNK);
    for (let i = 0; i < Math.ceil(SR * 6 / CHUNK); i++) {
      for (const r of (dec.processSamples(new Float32Array(silence)) || [])) {
        if (r.type === 'rx-image') liveImage = true; // emit can land in the drain
      }
    }
    ok(liveImage, 'live decode completes (setup)');
    const replayed = dec.redecodeBuffer({});
    ok(!!(replayed && replayed.type === 'rx-image'), 'redecodeBuffer replays the retained transmission');
    ok(!!(replayed && replayed.redecode), 'replayed image is flagged redecode');
    const replayedPpm = dec.redecodeBuffer({ slantPpm: 120 });
    ok(!!(replayedPpm && replayedPpm.type === 'rx-image'), 'redecode with a manual slant-ppm override still produces an image');
    // A fresh decoder with no buffered audio must decline gracefully.
    const empty = new SstvDecoder();
    ok(empty.redecodeBuffer({}) === null, 'redecode with no buffered audio returns null');
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${pass} passed, ${fail} failed, ${pending} pending (MMSSTV-parity contracts)`);
  if (fail > 0) { console.log('FAILURES PRESENT'); process.exit(1); }
  console.log('All assertions passed (pending counts not blocking).');
  process.exit(0);
})();
