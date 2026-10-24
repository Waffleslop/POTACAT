'use strict';
// The Winlink waterfall's shared rules: lib/winlink-spectrum.js (band markers,
// the Busy / Clear detector, the wire bins). Run: node test/winlink-spectrum-test.js
const assert = require('assert');
const S = require('../lib/winlink-spectrum');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

function tone(hz, rate, seconds, amp, noise) {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  let seed = 1;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * hz * i / rate) + noise * rnd();
  return out;
}
// A modem-width signal: carriers every 25 Hz across the band (what an ARDOP
// frame looks like on the waterfall). The Busy rule is the 90th percentile of
// the band, so a lone tone is deliberately NOT busy — a carrier is not a modem.
function modem(centerHz, bwHz, rate, seconds, amp, noise) {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const tones = [];
  for (let hz = centerHz - bwHz / 2; hz <= centerHz + bwHz / 2; hz += 25) tones.push(hz);
  for (let i = 0; i < n; i++) {
    let v = noise * rnd();
    for (let t = 0; t < tones.length; t++) v += (amp / tones.length) * Math.sin(2 * Math.PI * tones[t] * i / rate + t);
    out[i] = v;
  }
  return out;
}
function framesOf(pcm, rate) {
  const frames = [];
  const acc = new S.SpectrumAccumulator((m) => frames.push(Float32Array.from(m)));
  acc.push(pcm, rate);
  return frames;
}
// Feed the same frame for `ms` at the shack's cadence (85 ms per frame); returns the last verdict.
function feed(det, frame, from, ms) {
  let v = null;
  for (let t = from; t <= from + ms; t += 85) v = det.update(frame, t);
  return v;
}
const NOISE = framesOf(tone(1500, 24000, 0.4, 0, 0.02), 24000)[1];
const MODEM = framesOf(modem(1500, 500, 24000, 0.4, 0.3, 0.02), 24000)[1];
const CARRIER = framesOf(tone(1500, 24000, 0.4, 0.3, 0.02), 24000)[1];

console.log('winlink-spectrum');
test('a 1500 Hz tone lands in the middle of the span, at 24 kHz and at 48 kHz alike', () => {
  for (const rate of [24000, 48000]) {
    const frames = framesOf(tone(1500, rate, 0.5, 0.3, 0.001), rate);
    assert.ok(frames.length >= 4, `frames at ${rate}`);
    const m = frames[2];
    let peak = 0; for (let b = 1; b < m.length; b++) if (m[b] > m[peak]) peak = b;
    assert.ok(Math.abs(peak - 128) <= 1, `peak bin ${peak} at ${rate} Hz`);
    const wire = S.wireBins(m);
    assert.strictEqual(wire.length, S.WIRE_BINS);
    let wpeak = 0; for (let b = 1; b < wire.length; b++) if (wire[b] > wire[wpeak]) wpeak = b;
    assert.ok(wpeak === 63 || wpeak === 64, 'wire peak ' + wpeak);
    assert.ok(wire[wpeak] > 200 && wire[10] < 90, `scaled ${wire[wpeak]} / ${wire[10]}`);
  }
});

test('busy: a modem in the band says Busy once it has lasted 150 ms, holds 4 s past the last frame, then Clear', () => {
  const band = S.markerBand('ardop', { ardop: 500 });
  const det = new S.BusyDetector(band.lo, band.hi);
  assert.strictEqual(det.update(MODEM, 1000).busy, false, 'one frame is not a signal');
  const v = feed(det, MODEM, 1085, 300);
  assert.strictEqual(v.busy, true, 'sustained');
  assert.ok(v.peakDb >= S.BUSY_DB, 'peak ' + v.peakDb);
  assert.strictEqual(feed(det, NOISE, 1500, 3500).busy, true, 'held through 3.5 s of noise');
  assert.strictEqual(det.update(NOISE, 1500 + 4100).busy, false, 'released after the hold');
  // A tone OUTSIDE the marked band is not Busy for this modem.
  const off = framesOf(modem(2400, 500, 24000, 0.4, 0.3, 0.02), 24000)[1];
  assert.strictEqual(feed(new S.BusyDetector(band.lo, band.hi), off, 1000, 600).busy, false, 'off-band modem');
  // Noise alone, at any level, is Clear (like compared with like).
  for (const lvl of [0.002, 0.02, 0.2]) {
    const noise = framesOf(tone(1500, 24000, 0.6, 0, lvl), 24000);
    const d = new S.BusyDetector(band.lo, band.hi);
    let t = 1000;
    for (const f of noise) { assert.strictEqual(d.update(f, t).busy, false, 'noise ' + lvl); t += 85; }
  }
  // A strong lone carrier in the band (CW, somebody tuning) IS busy; a weak one is not a modem.
  assert.strictEqual(feed(new S.BusyDetector(band.lo, band.hi), CARRIER, 1000, 300).busy, true, 'strong carrier');
  const weak = framesOf(tone(1500, 24000, 0.4, 0.004, 0.02), 24000)[1];
  assert.strictEqual(feed(new S.BusyDetector(band.lo, band.hi), weak, 1000, 600).busy, false, 'weak carrier');
});

test('busy does not blink: a static crash is one frame, and a signal fading through the threshold stays Busy', () => {
  const band = S.markerBand('ardop', { ardop: 500 });
  const det = new S.BusyDetector(band.lo, band.hi);
  // crashes: single hot frames 1 s apart in noise never enter
  let t = 1000, flips = 0, last = false;
  for (let i = 0; i < 60; i++, t += 85) {
    const v = det.update(i % 12 === 0 ? MODEM : NOISE, t);
    if (v.busy !== last) { flips++; last = v.busy; }
  }
  assert.strictEqual(flips, 0, 'crashes flipped the badge ' + flips + ' times');
  // a marginal signal: alternate a frame just over the enter threshold with one just under it → enters once, stays
  const strong = framesOf(modem(1500, 500, 24000, 0.4, 0.3, 0.02), 24000)[1];
  const marginal = framesOf(modem(1500, 500, 24000, 0.4, 0.09, 0.02), 24000)[1]; // ~6 dB: under enter, over stay
  const d2 = new S.BusyDetector(band.lo, band.hi);
  feed(d2, strong, 1000, 300);
  let flips2 = 0, was = true;
  for (let i = 0, tt = 1400; i < 100; i++, tt += 85) {
    const v = d2.update(i % 2 ? strong : marginal, tt);
    if (v.busy !== was) { flips2++; was = v.busy; }
  }
  assert.strictEqual(flips2, 0, 'a fading signal flipped the badge ' + flips2 + ' times');
  assert.strictEqual(d2.busy, true);
});

test('busy: a wide band whose outside is only the receiver filter skirt reads Clear on noise once the floor is tracked', () => {
  const band = S.markerBand('vara', { vara: 2750 }); // outside = 0–125 Hz and 2875–3000 Hz
  // noise inside the receiver passband, nothing in the skirts: the outside bins are far below the band
  const skirt = Float32Array.from(NOISE, (v, b) => (b < 12 || b > 244 ? v - 6 : v)); // 26 dB down outside
  const det = new S.BusyDetector(band.lo, band.hi);
  const v = feed(det, skirt, 1000, S.FLOOR_WARM_MS + 5000);
  assert.strictEqual(v.busy, false, 'noise with deep skirts is Clear');
  // and a modem filling that band, after the floor is tracked on noise, is still Busy
  const wide = framesOf(modem(1500, 2300, 24000, 0.4, 0.4, 0.02), 24000)[1];
  const v2 = feed(det, wide, 1000 + S.FLOOR_WARM_MS + 5100, 400);
  assert.strictEqual(v2.busy, true, 'a wide modem over the tracked floor is Busy');
});

test('marker bands follow the mode and each modem\'s own bandwidth, labelled center', () => {
  assert.deepStrictEqual(S.markerBand('ardop', { ardop: 2000 }), { lo: 500 / 3000, hi: 2500 / 3000, label: 'ARDOP center 1500 Hz, 2000 Hz wide' });
  assert.strictEqual(S.markerBand('ardop', {}).lo, 1250 / 3000);
  assert.strictEqual(S.markerBand('vara', { vara: 2300 }).label, 'VARA HF center 1500 Hz, 2300 Hz wide');
  assert.strictEqual(S.markerBand('vara', { vara: 2750 }).hi, 2875 / 3000);
  assert.strictEqual(S.markerBand('vara', undefined).label, 'VARA HF center 1500 Hz, 2300 Hz wide');
  assert.strictEqual(S.markerBand('mercury', { mercury: 500 }).label, 'Mercury center 1500 Hz, 500 Hz wide');
  assert.strictEqual(S.markerBand('varafm').label, 'VARA FM, the whole audio passband');
  assert.strictEqual(S.markerBand('packet').label, 'Packet tones 1200 / 2200 Hz');
  assert.strictEqual(S.markerBand('telnet', { ardop: 500 }).label, 'ARDOP center 1500 Hz, 500 Hz wide');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
