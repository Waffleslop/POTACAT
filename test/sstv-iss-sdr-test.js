#!/usr/bin/env node
'use strict';
// SSTV from the SDR (Casey 2026-11-11: "tune into the ISS via a SDR and decode
// SSTV"): the receive source, the frequency box (#359), FM above 30 MHz, the
// satellite FM channel with Doppler, the feed gate, and the ISS pass times.
// Run: node test/sstv-iss-sdr-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const R = require('../lib/sstv-rx-source');
const Gate = require('../lib/sstv-feed-gate');
const { Demodulator } = require('../lib/rtltcp-demod');
const Iss = require('../lib/iss-pass');
const sat = require('satellite.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
const html = readSrc(path.join(root, 'renderer', 'sstv-popout.html'));
const js = readSrc(path.join(root, 'renderer', 'sstv-popout.js'));

console.log('SSTV from the SDR, and the ISS');

test('receive source: radio unless set to the SDR; the SDR never transmits', () => {
  assert.strictEqual(R.normalize(undefined), 'radio');
  assert.strictEqual(R.normalize('websdr'), 'radio');
  assert.strictEqual(R.normalize('sdr'), 'sdr');
  assert.strictEqual(R.txRefusal('radio'), null);
  assert.ok(/does not transmit/.test(R.txRefusal('sdr')));
});

test('FM above 30 MHz; LSB below 10 MHz except 60 m; USB above', () => {
  assert.strictEqual(R.freqMode(3730), 'LSB');
  assert.strictEqual(R.freqMode(5357), 'USB');
  assert.strictEqual(R.freqMode(7171), 'LSB');
  assert.strictEqual(R.freqMode(14230), 'USB');
  assert.strictEqual(R.freqMode(28680), 'USB');
  assert.strictEqual(R.freqMode(145800), 'FM', 'the ISS was tuned in USB (#359)');
  assert.strictEqual(R.freqMode(437550), 'FM');
});

test('the frequency box takes kHz or MHz (#359: 437.550 typed into a kHz box)', () => {
  assert.strictEqual(R.parseFreq('145.8'), 145800);
  assert.strictEqual(R.parseFreq('145.800'), 145800);
  assert.strictEqual(R.parseFreq('145800'), 145800);
  assert.strictEqual(R.parseFreq('437.550 MHz'), 437550);
  assert.strictEqual(R.parseFreq('437,550'), 437550, 'a European decimal comma');
  assert.strictEqual(R.parseFreq('14230'), 14230);
  assert.strictEqual(R.parseFreq('14.230'), 14230);
  assert.strictEqual(R.parseFreq('7171 kHz'), 7171);
  assert.strictEqual(R.parseFreq('abc'), null);
  assert.strictEqual(R.parseFreq('0.5'), null, 'below 1 MHz is no SSTV channel');
  assert.strictEqual(R.parseFreq(''), null);
});

test('the SDR\'s tune: satellite FM on an rtl_tcp SDR, narrow FM on a Kiwi, FM on a WebSDR', () => {
  assert.deepStrictEqual(R.sdrTune(145800, 'FM', 'rtl_tcp'), { freqKhz: 145800, mode: 'fmw' });
  assert.deepStrictEqual(R.sdrTune(145800, 'FM', 'kiwisdr'), { freqKhz: 145800, mode: 'nbfm' });
  assert.deepStrictEqual(R.sdrTune(145800, undefined, 'websdr'), { freqKhz: 145800, mode: 'fm' });
  assert.deepStrictEqual(R.sdrTune(7171, undefined, 'rtl_tcp'), { freqKhz: 7171, mode: 'lsb' });
  assert.strictEqual(R.sdrTune(0, 'FM', 'rtl_tcp'), null);
});

test('feed gate: from the SDR, the radio\'s sound card and streams stay out; the SDR feeds only then', () => {
  const base = { engineRunning: true, feedPaused: false, audioSource: 'smartsdr', smartSdrAudioUp: true, lastVitaFeedMs: 0, now: 1e6 };
  assert.deepStrictEqual(Gate.rendererAudioDecision({ ...base, rxSource: 'sdr' }), { accept: false, reason: 'sdr-source' });
  assert.strictEqual(Gate.rendererAudioDecision({ ...base, audioSource: 'usb', rxSource: 'radio' }).accept, true, 'unchanged for the radio');
  assert.deepStrictEqual(Gate.streamAudioDecision({ ...base, path: 'smartsdr', rxSource: 'sdr' }), { accept: false, reason: 'sdr-source' });
  assert.deepStrictEqual(Gate.streamAudioDecision({ ...base, path: 'sdr', rxSource: 'sdr' }), { accept: true, reason: 'sdr' });
  assert.strictEqual(Gate.streamAudioDecision({ ...base, path: 'sdr', rxSource: 'radio' }).accept, false);
  assert.strictEqual(Gate.streamAudioDecision({ ...base, path: 'smartsdr' }).accept, true, 'no rxSource: as before');
});

// A 1900 Hz SSTV tone, FM at 5 kHz deviation, arriving 3.5 kHz off (the ISS's
// Doppler at its worst), as 8-bit IQ the way rtl_tcp sends it.
function fmIq({ rate = 250000, toneHz = 1900, devHz = 5000, offsetHz = 3500, seconds = 0.6 } = {}) {
  const n = Math.round(rate * seconds);
  const iq = new Uint8Array(n * 2);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const inst = offsetHz + devHz * Math.sin(2 * Math.PI * toneHz * i / rate);
    ph += 2 * Math.PI * inst / rate;
    iq[2 * i] = Math.round(127.5 + 100 * Math.cos(ph));
    iq[2 * i + 1] = Math.round(127.5 + 100 * Math.sin(ph));
  }
  return iq;
}
function toneOf(audio, rate) {
  // Zero crossings over the second half (filters settled).
  const a = audio.subarray(audio.length >> 1);
  let z = 0;
  for (let i = 1; i < a.length; i++) if ((a[i - 1] < 0) !== (a[i] < 0)) z++;
  return z / 2 / (a.length / rate);
}

test('satellite FM: a Doppler-shifted ISS tone comes out at its pitch, centred, unclipped', () => {
  const d = new Demodulator({ inputRate: 250000, mode: 'fmw' });
  assert.strictEqual(d.mode, 'fmw');
  const out = d.processU8(fmIq({ offsetHz: 3500 }));
  const hz = toneOf(out.audio, out.sampleRate);
  assert.ok(Math.abs(hz - 1900) < 40, 'tone ' + hz.toFixed(0) + ' Hz');
  const tail = out.audio.subarray(out.audio.length >> 1);
  let peak = 0, mean = 0;
  for (const v of tail) { peak = Math.max(peak, Math.abs(v)); mean += v; }
  mean /= tail.length;
  assert.ok(peak < 0.99, 'never clips: peak ' + peak.toFixed(2));
  assert.ok(Math.abs(mean) < 0.05, 'Doppler taken out (DC ' + mean.toFixed(3) + ')');
});

// The ISS as CelesTrak gave it on 2026-11-11, fixed so the test never needs the internet.
const TLE = {
  name: 'ISS (ZARYA)',
  line1: '1 25544U 98067A   26315.33607970  .00009043  00000+0  17017-3 0  9996',
  line2: '2 25544  51.6323 291.9174 0007325  13.1877 346.9302 15.49313022594565',
};
const OBS = { lat: 40.5, lon: -75.0 };
const FROM = new Date('2026-11-12T00:00:00Z');

test('a CelesTrak answer is read; anything else is not a TLE', () => {
  const t = Iss.parseTle(TLE.name + '\r\n' + TLE.line1 + '\r\n' + TLE.line2 + '\r\n');
  assert.deepStrictEqual(t, TLE);
  assert.strictEqual(Iss.parseTle('<html>error</html>'), null);
});

test('ISS passes: horizon to horizon, a few minutes, about one orbit apart', () => {
  const ps = Iss.nextPasses(TLE, OBS, { from: FROM, hours: 12, max: 6 });
  assert.ok(ps.length >= 3, 'passes in 12 h: ' + ps.length);
  const satrec = sat.twoline2satrec(TLE.line1, TLE.line2);
  for (const p of ps) {
    assert.ok(p.durationS > 60 && p.durationS < 720, 'duration ' + p.durationS);
    assert.ok(Math.abs(Iss.lookAt(satrec, OBS, p.aos).elDeg) < 0.3, 'rises at the horizon');
    assert.ok(Math.abs(Iss.lookAt(satrec, OBS, p.los).elDeg) < 0.3, 'sets at the horizon');
    assert.ok(p.maxElDeg > 0 && p.maxElDeg <= 90);
  }
  // Consecutive passes in one visibility window are one orbit apart:
  // 1440 / 15.4931 rev/day = 92.9 min (from the TLE's mean motion, not SGP4).
  const period = 1440 / 15.49313022;
  const gap = (ps[1].aos - ps[0].aos) / 60000;
  assert.ok(Math.abs(gap - period) < 6, 'gap ' + gap.toFixed(1) + ' min vs period ' + period.toFixed(1));
});

test('the elevation agrees with an independent calculation from the same position', () => {
  // Way one: satellite.js's own look angles. Way two: our own GMST (IAU 1982),
  // WGS-84 observer and topocentric "up", from the SGP4 position alone.
  const satrec = sat.twoline2satrec(TLE.line1, TLE.line2);
  const ps = Iss.nextPasses(TLE, OBS, { from: FROM, hours: 12, max: 2 });
  for (const when of [ps[0].tca, new Date(ps[0].tca.getTime() + 90000)]) {
    const a = Iss.lookAt(satrec, OBS, when).elDeg;
    const pos = sat.propagate(satrec, when).position;  // km, TEME
    const jd = when.getTime() / 86400000 + 2440587.5;
    const T = (jd - 2451545.0) / 36525;
    let g = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - T * T * T / 38710000;
    g = ((g % 360) + 360) % 360 * Math.PI / 180;
    const x = pos.x * Math.cos(g) + pos.y * Math.sin(g);
    const y = -pos.x * Math.sin(g) + pos.y * Math.cos(g);
    const z = pos.z;
    const lat = OBS.lat * Math.PI / 180, lon = OBS.lon * Math.PI / 180;
    const A = 6378.137, f = 1 / 298.257223563, e2 = f * (2 - f);
    const N = A / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    const ox = N * Math.cos(lat) * Math.cos(lon), oy = N * Math.cos(lat) * Math.sin(lon), oz = N * (1 - e2) * Math.sin(lat);
    const rx = x - ox, ry = y - oy, rz = z - oz, r = Math.hypot(rx, ry, rz);
    const up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    const b = Math.asin((rx * up[0] + ry * up[1] + rz * up[2]) / r) * 180 / Math.PI;
    assert.ok(Math.abs(a - b) < 0.5, 'elevation ' + a.toFixed(2) + ' vs ' + b.toFixed(2));
  }
});

test('the pass sentence', () => {
  const p = { aos: new Date('2026-11-12T21:14:00Z'), los: new Date('2026-11-12T21:20:30Z'), maxElDeg: 63.2, durationS: 390 };
  assert.strictEqual(Iss.passLine(p, new Date('2026-11-12T18:00:00Z')), 'Next ISS pass at 21:14 UTC, 7 min, highest 63°');
  assert.strictEqual(Iss.passLine(p, new Date('2026-11-12T21:02:00Z')), 'Next ISS pass in 12 min (21:14 UTC), 7 min, highest 63°');
  assert.strictEqual(Iss.passLine(p, new Date('2026-11-12T21:16:00Z')), 'The ISS is up now: until 21:20 UTC, highest 63°');
});

test('wiring: the SDR feeds SSTV, only SSTV retunes it, and the window offers the choice', () => {
  assert.ok(/if \(sstvRxFromSdr\(\)\) feedSstvFromSdr\(pcmFloat, sampleRate\);/.test(main));
  assert.ok(/kiwiClient\.tune = \(\.\.\.a\) => \(sstvHoldsSdr\(\) && !_sstvTuningSdr \? undefined : rawTune\(\.\.\.a\)\)/.test(main), 'the radio, JTCAT and the phone cannot pull it off the ISS');
  assert.ok(/const sdrRefusal = SstvRxSource\.txRefusal\(settings\.sstvRxSource\);/.test(main), 'transmit refused from the SDR');
  assert.ok(/delete newSettings\.sstvRxSource;/.test(main), 'one writer for the choice');
  assert.ok(/<select id="rx-src"[^>]*><option value="radio">Radio<\/option><option value="sdr" id="rx-src-sdr">SDR<\/option><\/select>/.test(html));
  assert.ok(/<option value="145800" data-mode="FM" data-iss="1">145\.800 ISS \(FM\)<\/option>/.test(html));
  assert.ok(/data-auto="no"/.test(html) && /if \(g\.dataset\.auto === 'no'\) return;/.test(js), 'the ISS is never an automatic tune (#292)');
  assert.ok(/function freqBoxBusy\(\)/.test(js) && /if \(freqBoxBusy\(\)\) return;/.test(js), 'the box is not overwritten while typing (#359)');
  assert.ok(/ISS SSTV runs only during announced ARISS events/.test(js));
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/sstv-iss-sdr-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
