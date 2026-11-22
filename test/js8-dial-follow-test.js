#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// GitHub #714 (k5vab): in JS8, turning the VFO never moved the dial the
// wrong-band TX guard compares against (the follow ran for FT8/FT4/FT2
// only), so after a knob turn every JS8 transmission was refused, and the
// refusal reached only the CAT log. JS8 now follows the knob onto its own
// calling dials under the same rule as FT8 (lib/jtcat-dial-follow.js), and a
// JS8 refusal shows in the JS8 window and on ECHOCAT's js8-send-result.
// Run: node test/js8-dial-follow-test.js
const assert = require('assert');
const path = require('path');
const { decideDialFollow, followsKnob } = require('../lib/jtcat-dial-follow');
const { freqsForMode } = require('../lib/ft8-engine');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const read = (p) => readSrc(path.join(__dirname, '..', p));
const main = read('main.js');

// main.js's JS8 dial table, read from the source (it is the one table main uses).
function js8Dials() {
  const m = main.match(/const JS8_DIAL_KHZ = (\{[\s\S]*?\});/);
  assert.ok(m, 'JS8_DIAL_KHZ in main.js');
  return Function('return ' + m[1])();
}

test('which modes follow the knob: FT8, FT4, FT2 and JS8; not PSK31, JTTY or WSPR', () => {
  assert.strictEqual(typeof followsKnob, 'function', 'lib/jtcat-dial-follow exports followsKnob');
  for (const m of ['FT8', 'FT4', 'FT2', 'JS8', 'js8']) assert.ok(followsKnob(m), m);
  for (const m of ['PSK31', 'JTTY', 'WSPR', '', undefined]) assert.ok(!followsKnob(m), String(m));
});

test('JS8 follows the knob onto another band\'s JS8 dial (40 m -> 20 m)', () => {
  assert.deepStrictEqual(decideDialFollow({ dialHz: 14078000, anchorHz: 7078000, freqs: js8Dials() }), { action: 'follow', band: '20m', dialHz: 14078000 });
});
test('JS8 on an FT8 dial is not a JS8 dial: still refused', () => {
  assert.strictEqual(decideDialFollow({ dialHz: 14074000, anchorHz: 7078000, freqs: js8Dials() }).action, 'refuse');
});
test('JS8 never moves while a message is going out (qsoLive)', () => {
  assert.strictEqual(decideDialFollow({ dialHz: 14078000, anchorHz: 7078000, freqs: js8Dials(), qsoLive: true }).action, 'refuse');
});
test('FT8 is unchanged: FT8 dials follow, a phone frequency is refused', () => {
  assert.strictEqual(decideDialFollow({ dialHz: 7075500, anchorHz: 7074000, freqs: freqsForMode('FT8') }).action, 'none');
  assert.strictEqual(decideDialFollow({ dialHz: 14074000, anchorHz: 7074000, freqs: freqsForMode('FT8') }).band, '20m');
  assert.strictEqual(decideDialFollow({ dialHz: 14250000, anchorHz: 7074000, freqs: freqsForMode('FT8') }).action, 'refuse');
});

test('main: the follow runs for JS8 with the JS8 table, and holds while a JS8 message is in flight', () => {
  const fn = main.slice(main.indexOf('function jtcatDialFollow(hz)'), main.indexOf('function jtcatFollowBand('));
  assert.ok(/if \(!followsKnob\(mode\)\) return;/.test(fn), 'the mode gate is the lib rule');
  assert.ok(!/\^FT\[842\]\$/.test(fn), 'no FT-only gate left in the follow');
  assert.ok(/freqs: js8 \? JS8_DIAL_KHZ : freqsForMode\(mode\)/.test(fn), 'JS8 uses its own dials');
  assert.ok(/qsoLive: jtcatQsoLive\(\) \|\| \(js8 && !!\(ft8Engine\._txActive \|\| ft8Engine\.txQueueLength > 0\)\)/.test(fn), 'a JS8 message in flight counts as busy');
  assert.ok(/if \(js8\) \{ js8FollowBand\(/.test(fn), 'JS8 re-anchors through its own follow');
  const js8f = main.slice(main.indexOf('function js8FollowBand('), main.indexOf('function js8FollowBand(') + 800);
  assert.ok(/_jtcatExpectedDialHz = Math\.round\(dialHz\);/.test(js8f), 'moves the guard anchor');
  assert.ok(/js8RxAssembler = new Js8RxAssembler\(\{\}\);/.test(js8f), 'half a message from the old band is dropped');
});

test('main: the wrong-band guard keeps its 2.5 kHz rule and FT8 refusal, and tells the JS8 surfaces', () => {
  const g0 = main.indexOf('// Wrong-band TX guard (KF0U 2026-07-17)');
  const guard = main.slice(g0, main.indexOf('// The operator\'s licence class, before anything is keyed', g0));
  assert.ok(/Math\.abs\(_currentFreqHz - _jtcatExpectedDialHz\) > 2500\)/.test(guard), '2.5 kHz rule');
  assert.ok(/error: dialMsg, followRadio: true/.test(guard), 'the FT8 refusal is unchanged');
  assert.ok(/if \(ft8Engine\._mode === 'JS8'\) \{/.test(guard), 'a JS8 branch');
  assert.ok(/js8PopoutWin\.webContents\.send\('js8call-send-result', \{ ok: false, error: js8Msg \}\)/.test(guard), 'the JS8 window shows it');
  assert.ok(/remoteServer\.sendJs8SendResult\(\{ ok: false, error: js8Msg \}\)/.test(guard), 'ECHOCAT shows it on the existing js8-send-result');
});

test('the JS8 window already shows a refused send result', () => {
  assert.ok(/onSendResult\(function \(r\) \{\s*if \(r && !r\.ok\) note\(/.test(read('renderer/js8call-popout.js')));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
