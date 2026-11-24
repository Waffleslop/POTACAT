#!/usr/bin/env node
'use strict';
// #1032: the automatic FT8/FT4/FT2 CQ tone stays inside the radio's DATA-mode
// transmit filter (lib/jtcat-quiet-freq.js AUTO_LOW_HZ..AUTO_HIGH_HZ).
//
// N4RLW's IC-7100 sent every CQ on a 230 Hz tone picked by the quiet-frequency
// rule (then 200-2800 Hz). The IC-7100 passes only 300-2700 Hz in DATA mode, so
// the power dropped and swung. These pin:
//  - no automatic pick is ever below the low bound or above the high bound,
//    from the waterfall windows, from main's own measurement, or the default;
//  - a tone the operator chose (230 Hz) is kept: the bound is never applied to
//    an operator move, and with Hold TX Freq a CQ does not move it;
//  - every automatic path (window open, minimised, phone / ECHOCAT, Run) gets
//    its tone from the one tracker in lib/, so they share the rule.
// Run: node test/jtcat-auto-tone-passband-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const Q = require('../lib/jtcat-quiet-freq');
const { Ft8Engine } = require('../lib/ft8-engine');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
function lcg(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

const LO = Q.AUTO_LOW_HZ, HI = Q.AUTO_HIGH_HZ;

test('the bounds are the evidenced ones: 500..2400 Hz (signal inside 500-2500 Hz)', () => {
  assert.strictEqual(LO, 500);
  assert.strictEqual(HI, 2400);
  // FT4 is the widest of the three on air here (4 tones x 20.833 Hz = 83 Hz
  // above the lowest tone); FT8 is 50 Hz. The top of the signal stays <= 2500.
  assert.ok(HI + 84 <= 2500, 'an FT4 signal at the highest pick ends by 2500 Hz');
  assert.ok(Q.DEFAULT_HZ >= LO && Q.DEFAULT_HZ <= HI, 'the 1500 Hz default is inside');
});

test('a quiet band edge never pulls the pick outside (the N4RLW 230 Hz case)', () => {
  // Busy everywhere except the very bottom (about 200-260 Hz) and the very top.
  for (const binHz of [3000 / 512, 24000 / 1024, 22050 / 1024, 6000 / 1024, 48000 / 1024]) {
    const n = Math.ceil(3000 / binHz) + 2;
    const bins = new Uint8Array(n).fill(200);
    for (let i = 0; i < n; i++) {
      const hz = i * binHz;
      if (hz < 270 || hz > 2600) bins[i] = 0;
    }
    const hz = Q.pickQuietFreq(bins, binHz);
    assert.ok(hz >= LO && hz <= HI, 'binHz ' + binHz.toFixed(2) + ': picked ' + hz + ' Hz');
  }
  // A flat spectrum (no gap anywhere) used to give the first window, 220 Hz.
  const flat = new Uint8Array(512).fill(100);
  const f = Q.pickQuietFreq(flat, 3000 / 512);
  assert.ok(f >= LO && f <= HI, 'flat spectrum picked ' + f + ' Hz');
});

test('random spectra at every capture rate: always inside, snapped to 10 Hz', () => {
  const rnd = lcg(1032);
  for (const rate of [12000, 44100, 48000, 96000]) {
    for (let k = 0; k < 200; k++) {
      const bins = new Uint8Array(1024);
      for (let i = 0; i < bins.length; i++) bins[i] = Math.floor(rnd() * 256);
      // Make the band edges the quietest place half the time.
      if (k % 2) for (let i = 0; i < bins.length; i++) { const hz = i * (rate / 2) / 1024; if (hz < LO - 30 || hz > HI + 30) bins[i] = 0; }
      const hz = Q.pickQuietFreq(bins, (rate / 2) / bins.length);
      assert.ok(hz >= LO && hz <= HI, 'rate ' + rate + ' case ' + k + ': ' + hz + ' Hz');
      assert.strictEqual(hz % 10, 0);
    }
  }
});

test('a real gap inside the range is still found', () => {
  const binHz = 3000 / 512;
  const bins = new Uint8Array(512).fill(200);
  for (let i = 0; i < 512; i++) { const hz = i * binHz; if (hz > 1700 && hz < 1780) bins[i] = 0; }
  const hz = Q.pickQuietFreq(bins, binHz);
  assert.ok(hz > 1700 && hz < 1780, 'picked ' + hz + ' Hz');
});

test('the tracker bounds every automatic report, from the window or main', () => {
  const t = Q.createQuietFreqTracker();
  t.report('window', 230, 1000);
  assert.strictEqual(t.current(1500).hz, LO, 'a window report of 230 Hz becomes ' + LO);
  t.report('main', 2790, 9000);
  assert.strictEqual(t.current(9000).hz, HI, 'a main report of 2790 Hz becomes ' + HI);
  t.report('window', 1730, 10000);
  assert.strictEqual(t.current(10000).hz, 1730, 'a pick inside is unchanged');
  assert.strictEqual(Q.clampAutoTone(230), LO);
  assert.strictEqual(Q.clampAutoTone(2800), HI);
  assert.strictEqual(Q.clampAutoTone(1500), 1500);
});

test('an operator-chosen 230 Hz tone is kept', () => {
  const eng = new Ft8Engine();
  // A click on the waterfall / the TX box: setTxFreq(hz, { operator: true }).
  eng.setTxFreq(230, { operator: true });
  assert.strictEqual(eng._txFreq, 230, 'the operator move is not bounded');
  // With Hold TX Freq on, the CQ paths' automatic setTxFreq(quietPick.hz) is
  // ignored, so the operator's 230 Hz stays through a CQ.
  eng.setHoldTxFreq(true);
  eng.setTxFreq(230, { operator: true });
  const t = Q.createQuietFreqTracker();
  t.report('window', 1730, 1000);
  eng.setTxFreq(t.current(1000).hz); // what every CQ path does
  assert.strictEqual(eng._txFreq, 230, 'a CQ under Hold TX Freq keeps 230 Hz');
});

const ROOT = path.join(__dirname, '..');
test('operator moves never go through the automatic bound', () => {
  const main = readSrc(path.join(ROOT, 'main.js'));
  assert.ok(!/clampAutoTone/.test(main), 'main.js must not clamp anything itself: the bound lives in the tracker');
  // The operator handlers (desktop and phone) pass the value straight through.
  assert.ok(/ipcMain\.on\('jtcat-set-tx-freq', \(_e, hz, operator\) => \{[\s\S]{0,200}eng\.setTxFreq\(hz, operator \? \{ operator: true \} : undefined\)/.test(main));
  assert.ok(/remoteServer\.on\('jtcat-set-tx-freq', \(\{ hz \}\) => \{[\s\S]{0,400}eng\.setTxFreq\(hz, \{ operator: true \}\)/.test(main));
  const eng = readSrc(path.join(ROOT, 'lib', 'ft8-engine.js'));
  assert.ok(!/jtcat-quiet-freq/.test(eng), 'the engine knows nothing of the automatic bound');
});

test('every automatic path shares the one rule', () => {
  const main = readSrc(path.join(ROOT, 'main.js'));
  // The three CQ paths (desktop CQ button, phone / ECHOCAT CQ, Run) read the tracker.
  assert.strictEqual((main.match(/const quietPick = jtcatQuietPick\(\);\s*\n\s*ft8Engine\.setTxFreq\(quietPick\.hz\);/g) || []).length, 3);
  assert.ok(/function jtcatQuietPick\(\) \{ return jtcatQuietTracker\.current\(Date\.now\(\)\); \}/.test(main));
  // Both feeds (window open: the waterfall; minimised: main's FFT) go through the tracker.
  assert.ok(/jtcatQuietTracker\.report\('window', hz, Date\.now\(\)\)/.test(main));
  assert.ok(/jtcatQuietTracker\.report\('main', JtcatQuietFreq\.pickQuietFreq\(/.test(main));
  for (const js of ['renderer/app.js', 'renderer/jtcat-popout.js']) {
    const src = readSrc(path.join(ROOT, js));
    assert.ok(src.includes('window.JtcatQuietFreq.pickQuietFreq(freqData, nyquist / freqData.length)'), js);
  }
  // No surface carries its own copy of the range.
  for (const js of ['main.js', 'renderer/app.js', 'renderer/jtcat-popout.js']) {
    const src = readSrc(path.join(ROOT, js));
    assert.ok(!/Math\.round\(200 \/ binHz\)|Math\.round\(2800 \/ binHz\)/.test(src), js + ' must not hand-roll the quiet-window range');
  }
});

console.log(`\nJTCAT auto tone passband: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
