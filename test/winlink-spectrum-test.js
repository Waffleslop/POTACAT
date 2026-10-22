'use strict';
// The shack-side Winlink waterfall for ECHOCAT devices: lib/winlink-spectrum.js.
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

test('busy: a tone in the ARDOP band says Busy with a 3 s hold; silence says Clear', () => {
  const band = S.markerBand('ardop', 500);
  const st = { until: 0, peakDb: 0 };
  const busyFrames = framesOf(modem(1500, 500, 24000, 0.4, 0.3, 0.02), 24000);
  const v = S.busyVerdict(busyFrames[1], band.lo, band.hi, st, 1000);
  assert.strictEqual(v.busy, true);
  assert.ok(v.peakDb >= S.BUSY_DB, 'peak ' + v.peakDb);
  const quiet = framesOf(tone(1500, 24000, 0.4, 0, 0.02), 24000);
  assert.strictEqual(S.busyVerdict(quiet[1], band.lo, band.hi, st, 1000 + 2000).busy, true, 'held');
  assert.strictEqual(S.busyVerdict(quiet[1], band.lo, band.hi, st, 1000 + 3500).busy, false, 'released');
  // A tone OUTSIDE the marked band is not Busy for this modem.
  const st2 = { until: 0, peakDb: 0 };
  const off = framesOf(modem(2400, 500, 24000, 0.4, 0.3, 0.02), 24000); // band-noise at a real receiver level, not -54 dB
  assert.strictEqual(S.busyVerdict(off[1], band.lo, band.hi, st2, 1000).busy, false);
  // Noise alone, at any level, is Clear (like compared with like).
  for (const lvl of [0.002, 0.02, 0.2]) {
    const noise = framesOf(tone(1500, 24000, 0.4, 0, lvl), 24000);
    for (const f of noise) assert.strictEqual(S.busyVerdict(f, band.lo, band.hi, { until: 0, peakDb: 0 }, 1000).busy, false, 'noise ' + lvl);
  }
  // A strong lone carrier in the band (CW, somebody tuning) IS busy; a weak one is not a modem.
  const strong = framesOf(tone(1500, 24000, 0.4, 0.3, 0.02), 24000);
  assert.strictEqual(S.busyVerdict(strong[1], band.lo, band.hi, { until: 0, peakDb: 0 }, 1000).busy, true, 'strong carrier');
  const weak = framesOf(tone(1500, 24000, 0.4, 0.004, 0.02), 24000);
  assert.strictEqual(S.busyVerdict(weak[1], band.lo, band.hi, { until: 0, peakDb: 0 }, 1000).busy, false, 'weak carrier');
});

test('marker bands follow the mode and the ARDOP bandwidth', () => {
  assert.deepStrictEqual(S.markerBand('ardop', 2000), { lo: 500 / 3000, hi: 2500 / 3000, label: 'ARDOP centre 1500 Hz, 2000 Hz wide' });
  assert.strictEqual(S.markerBand('packet').label, 'packet tones 1200 / 2200 Hz');
  assert.strictEqual(S.markerBand('ardop', undefined).lo, 1250 / 3000);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
