#!/usr/bin/env node
'use strict';
// The level control on the radio audio a soundcard modem hears
// (lib/modem-rx-level.js) + the session guards built the same day (K3SBP
// VARA HF on a Flex, 2026-10-23). Run: node test/modem-rx-level-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RxLeveler, TxLeveler } = require('../lib/modem-rx-level');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const tone = (peak, n = 480) => Float32Array.from({ length: n }, (_, i) => peak * Math.sin(i / 7));
const maxAbs = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

test('a normal level passes through untouched at unity', () => {
  const l = new RxLeveler();
  const a = tone(0.3);
  const copy = Float32Array.from(a);
  l.process(a, 1000);
  assert.deepStrictEqual(Array.from(a), Array.from(copy));
  assert.strictEqual(l.gain, 1);
  assert.strictEqual(l.trims, 0);
  assert.deepStrictEqual(l.levels(), { inDb: -10, outDb: -10, trimDb: 0, hot: false });
});

test('a hot chunk is trimmed to the target at once, and stays trimmed', () => {
  const l = new RxLeveler();
  const a = tone(0.95);
  l.process(a, 1000);
  assert.ok(Math.abs(maxAbs(a) - 0.3) < 0.01, 'first hot chunk already at the target: ' + maxAbs(a));
  assert.strictEqual(l.trims, 1);
  assert.ok(l.gainDb < -9 && l.gainDb > -11, 'about -10 dB: ' + l.gainDb);
  assert.strictEqual(l.levels().hot, true, 'the raw input was on the red line');
  const b = tone(0.95);
  l.process(b, 1100);
  assert.ok(Math.abs(maxAbs(b) - 0.3) < 0.01);
  assert.strictEqual(l.trims, 1, 'no second cut for the same level');
});

test('a quiet band creeps back up slowly and never past maxGain', () => {
  const l = new RxLeveler({ maxGain: 4 });
  l.process(tone(0.95), 0); // trimmed to ~0.316
  let t = 100;
  for (let i = 0; i < 20; i++, t += 100) l.process(tone(0.01), t); // 2 s quiet: inside the hold, no change
  assert.ok(l.gain < 0.33, 'held during floorHoldMs: ' + l.gain);
  for (let i = 0; i < 600; i++, t += 100) l.process(tone(0.01), t); // another 60 s quiet
  assert.ok(l.gain > 0.33, 'released: ' + l.gain);
  assert.ok(l.gain <= 4, 'capped: ' + l.gain);
  // release is slow: well under full gain after the first few seconds
  const l2 = new RxLeveler();
  l2.process(tone(0.95), 0);
  let t2 = 100;
  for (let i = 0; i < 70; i++, t2 += 100) l2.process(tone(0.01), t2); // 7 s: 4 s hold + 3 s release
  assert.ok(l2.gain < 0.5, 'about 12% per second: ' + l2.gain);
});

test('a hot chunk after a creep-up is cut again', () => {
  const l = new RxLeveler();
  let t = 0;
  for (let i = 0; i < 100; i++, t += 100) l.process(tone(0.02), t);
  assert.ok(l.gain > 1, 'crept up on a quiet band: ' + l.gain);
  const a = tone(0.9);
  l.process(a, t);
  assert.ok(maxAbs(a) <= 0.31, 'cut at once: ' + maxAbs(a));
  assert.strictEqual(l.trims, 1);
});

test('levels() reads dBFS and silence is -90', () => {
  const l = new RxLeveler();
  l.process(new Float32Array(480), 0);
  assert.deepStrictEqual(l.levels(), { inDb: -90, outDb: -90, trimDb: 0, hot: false });
  l.process(tone(0.1), 1000);
  assert.strictEqual(l.levels().inDb, -20);
});

test('TX: a modem playing at -7 dBFS is raised toward full scale over a second or two, never past +18 dB', () => {
  const l = new TxLeveler();
  let t = 0;
  const first = tone(0.45); l.process(first, t);
  assert.strictEqual(l.gain, 1, 'the very first chunk goes out as played');
  for (let i = 0; i < 40; i++) { t += 20; l.process(tone(0.45), t); } // 0.8 s of audio
  assert.ok(l.gainDb > 3 && l.gainDb < 6.1, 'rising at ~6 dB/s: ' + l.gainDb);
  for (let i = 0; i < 100; i++) { t += 20; l.process(tone(0.45), t); }
  assert.ok(Math.abs(l.gain * 0.45 - 0.8) < 0.02, 'settled with peaks at the target: ' + (l.gain * 0.45));
  assert.strictEqual(l.cuts, 0);
  const q = new TxLeveler();
  let t2 = 0;
  for (let i = 0; i < 400; i++) { t2 += 20; q.process(tone(0.02), t2); } // very quiet, 8 s
  assert.ok(q.gain === 1, 'silence is never raised: ' + q.gain);
  for (let i = 0; i < 400; i++) { t2 += 20; q.process(tone(0.06), t2); }
  assert.ok(Math.abs(q.gain - 8) < 0.01, 'capped at maxGain: ' + q.gain);
});

test('TX: a peak that would clip cuts the gain at once; a seeded gain is applied from the first chunk', () => {
  const l = new TxLeveler({ gain: 2 });
  const a = tone(0.3);
  l.process(a, 0);
  assert.ok(Math.abs(maxAbs(a) - 0.6) < 0.01, 'seeded gain applied at once: ' + maxAbs(a));
  const b = tone(0.7);
  l.process(b, 20);
  assert.ok(maxAbs(b) <= 0.81, 'cut before it clipped: ' + maxAbs(b));
  assert.strictEqual(l.cuts, 1);
  assert.ok(Math.abs(l.gain - 0.8 / 0.7) < 0.01);
  const u = new TxLeveler({ gain: 1 });
  const c = tone(1.0);
  u.process(c, 0);
  assert.ok(maxAbs(c) <= 1.0 && u.gain === 1, 'never below unity: a hot modem is left alone');
  assert.deepStrictEqual(u.levels(), { inDb: 0, outDb: 0, boostDb: 0 });
});

test('wiring: the session chain is tokened, VARA launches once, Pat is asked before a new call, the cable feed is levelled', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(main.includes('const seq = ++_winlinkSessionSeq;'));
  assert.ok((main.match(/if \(!live\(\)\) throw cancelled\(\);/g) || []).length >= 5, 'a liveness check after every await');
  assert.ok(/if \(e && e\.cancelled\) \{ winlinkLog\(`attempt #\$\{seq\} ended after it was stopped/.test(main), 'a cancelled chain never ends a later session');
  assert.ok(/const launched = _varaLaunch\[kind\];/.test(main) && /_varaLaunch\[kind\] = \{ child, at: Date\.now\(\) \};/.test(main), 'single-flight VARA launch');
  assert.ok(/const busy = await winlinkPatStillBusy\(\);/.test(main), 'a new radio session asks Pat first');
  assert.ok(/_cableRxLeveler\.process\(/.test(main), 'the cable feed goes through the leveler');
  assert.ok(/_cableRxLeveler = null; \/\/ the next session starts at unity/.test(main));
  assert.ok(/winlinkStartSessionMeter\(\)/.test(main) && /setSession\(\{ audio: winlinkAudioLevels\(\) \}\)/.test(main));
  assert.ok(/telling Pat to hang up/.test(main), 'a stray PTT after Stop re-sends the disconnect');
  assert.ok(/function winlinkDispatchTx\(mono24k\) \{\r?\n  mono24k = winlinkLevelModemTx\(mono24k\);/.test(main), 'every modem transmit route goes through the TX leveler');
  assert.ok(/winlinkRememberModemTxGain\(\);/.test(main) && /'winlinkModemTxGain',/.test(main), 'the learned gain is kept per modem, machine-scoped');
  assert.ok(/boostDb/.test(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'winlink-popout.js'), 'utf8')), 'the Mail window shows the boost');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'winlink-popout.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'winlink-popout.js'), 'utf8');
  assert.ok(html.includes('id="wl-audio"') && js.includes("$('wl-audio')") && js.includes('au.toModemDb'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
