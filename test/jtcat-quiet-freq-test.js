#!/usr/bin/env node
'use strict';
// The quiet TX frequency for a CQ (lib/jtcat-quiet-freq.js).
//
// The waterfall loops measured it in their draw loops, which Chromium pauses
// while the window is hidden, so an unattended shack sent every phone CQ at
// 1500 Hz (ECHOCAT_TO_DESKTOP_HANDOFF_2026-11-16). Main now measures the engine
// audio with the same rule. These pin: the rule is the one the renderers used,
// main's FFT finds a real gap, the tracker prefers a live window and falls back
// to main, and every CQ path reads the tracker.
// Run: node test/jtcat-quiet-freq-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const Q = require('../lib/jtcat-quiet-freq');
const { computeSpectrumBins } = require('../lib/spectrum-fft');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

// The loop as it stood in renderer/app.js jtcatWaterfallLoop and
// renderer/jtcat-popout.js popoutWaterfallLoop before it moved to the lib.
function rendererRule(freqData, nyquist) {
  var binHz = nyquist / freqData.length;
  var windowBins = Math.round(50 / binHz);
  var startBin = Math.round(200 / binHz);
  var endBin = Math.round(2800 / binHz);
  var bestEnergy = Infinity;
  var bestBin = Math.round(1500 / binHz);
  for (var b = startBin; b <= endBin - windowBins; b++) {
    var energy = 0;
    for (var j = 0; j < windowBins; j++) energy += freqData[b + j];
    if (energy < bestEnergy) { bestEnergy = energy; bestBin = b + Math.floor(windowBins / 2); }
  }
  var quietHz = Math.round(bestBin * binHz / 10) * 10;
  return Math.max(200, Math.min(2800, quietHz));
}

function lcg(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

// #1032 narrowed the range to 500..2400 Hz (test/jtcat-auto-tone-passband-test.js).
// Where the old rule's pick was already well inside that range, nothing moved.
test('pickQuietFreq is the renderer rule wherever that rule picked inside 500..2400 Hz', () => {
  const rnd = lcg(671);
  let compared = 0;
  // AnalyserNode fftSize 2048 -> 1024 bins at the context's rate.
  for (const rate of [12000, 44100, 48000, 96000]) {
    for (let n = 0; n < 200; n++) {
      const bins = new Uint8Array(1024);
      for (let i = 0; i < bins.length; i++) bins[i] = Math.floor(rnd() * 256);
      const old = rendererRule(bins, rate / 2);
      if (old < Q.AUTO_LOW_HZ + 20 || old > Q.AUTO_HIGH_HZ - 20) continue;
      compared++;
      assert.strictEqual(Q.pickQuietFreq(bins, (rate / 2) / bins.length), old, 'rate ' + rate + ' case ' + n);
    }
  }
  assert.ok(compared > 300, 'compared ' + compared + ' cases');
});

test('flat spectrum keeps the first window inside the range; empty input is 1500', () => {
  const flat = new Uint8Array(512).fill(100);
  assert.strictEqual(Q.pickQuietFreq(flat, 3000 / 512), 500, 'the first window inside the range (was 220 Hz before #1032)');
  assert.strictEqual(Q.pickQuietFreq(null, 5), 1500);
  assert.strictEqual(Q.pickQuietFreq([], 5), 1500);
});

test('main\'s FFT of engine audio finds the gap in a busy band', () => {
  // 12 kHz, FT8-like carriers every 60 Hz from 150 to 2850 Hz, none within
  // 90 Hz of 1730 Hz, plus a little noise.
  const rate = 12000, n = 12000;
  const buf = new Float32Array(n);
  const rnd = lcg(7);
  const tones = [];
  for (let f = 150; f <= 2850; f += 60) if (Math.abs(f - 1730) > 90) tones.push(f);
  for (let i = 0; i < n; i++) {
    let v = (rnd() - 0.5) * 1e-4;
    for (const f of tones) v += 0.01 * Math.sin(2 * Math.PI * f * i / rate);
    buf[i] = v;
  }
  const bins = computeSpectrumBins(buf, 0, 512);
  const hz = Q.pickQuietFreq(bins, 3000 / 512);
  const below = Math.max(...tones.filter(f => f < 1730)), above = Math.min(...tones.filter(f => f > 1730));
  assert.ok(hz >= below + 25 && hz <= above - 25, 'picked ' + hz + ' Hz, the gap is ' + below + ' to ' + above + ' Hz');
  assert.strictEqual(hz % 10, 0, 'snapped to 10 Hz');
});

test('tracker: a live window wins, main covers a paused window, nothing is 1500', () => {
  const t = Q.createQuietFreqTracker();
  assert.deepStrictEqual(t.current(1000), { hz: 1500, source: 'default', ageMs: null });
  assert.match(Q.describePick(t.current(1000)), /^1500 Hz \(default 1500, no measurement yet\)$/);
  t.report('main', 1730, 1000);
  assert.deepStrictEqual(t.current(4000), { hz: 1730, source: 'main', ageMs: 3000 });
  assert.match(Q.describePick(t.current(4000)), /^1730 Hz \(quiet, measured 3 s ago from the shack audio\)$/);
  t.report('window', 900, 5000);
  t.report('main', 2100, 5200); // a fresh window still wins
  assert.strictEqual(t.windowFresh(6000), true);
  assert.deepStrictEqual(t.current(6000), { hz: 900, source: 'window', ageMs: 1000 });
  // The window goes quiet (minimised): main takes over once it is newer.
  t.report('main', 2200, 9000);
  assert.strictEqual(t.windowFresh(9000), false);
  assert.deepStrictEqual(t.current(9000), { hz: 2200, source: 'main', ageMs: 0 });
  assert.match(Q.describePick({ hz: 900, source: 'window', ageMs: 2400 }), /measured 2 s ago from the waterfall/);
  t.report('window', NaN, 9100); // junk is ignored
  assert.strictEqual(t.current(9100).hz, 2200);
});

const ROOT = path.join(__dirname, '..');
test('every CQ path reads the tracker and logs the pick', () => {
  const main = readSrc(path.join(ROOT, 'main.js'));
  assert.ok(!/setTxFreq\(jtcatQuietFreq\)/.test(main), 'a CQ path still reads the old window-only value');
  assert.strictEqual((main.match(/ft8Engine\.setTxFreq\(quietPick\.hz\)/g) || []).length, 3, 'Full Auto CQ, the phone CQ and the desktop CQ');
  assert.strictEqual((main.match(/describePick\(quietPick\)/g) || []).length, 3, 'each CQ log line names the pick and its age');
  assert.ok(/jtcatQuietTracker\.report\('window', hz/.test(main), 'the window report feeds the tracker');
  assert.ok(/jtcatQuietTracker\.report\('main', JtcatQuietFreq\.pickQuietFreq\(/.test(main), 'main measures the engine audio');
});

test('both waterfalls use the shared rule and load it', () => {
  for (const [js, html] of [['renderer/app.js', 'renderer/index.html'], ['renderer/jtcat-popout.js', 'renderer/jtcat-popout.html']]) {
    const src = readSrc(path.join(ROOT, js));
    assert.ok(src.includes('window.JtcatQuietFreq.pickQuietFreq(freqData, nyquist / freqData.length)'), js + ' must call the shared rule');
    const page = readSrc(path.join(ROOT, html));
    const lib = page.indexOf('<script src="../lib/jtcat-quiet-freq.js"></script>');
    const own = page.indexOf('<script src="' + path.basename(js) + '"></script>');
    assert.ok(lib > 0 && own > lib, html + ' must load lib/jtcat-quiet-freq.js before ' + path.basename(js));
  }
});

console.log(`\nJTCAT quiet freq: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
