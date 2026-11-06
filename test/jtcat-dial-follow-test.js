#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// GitHub #115 (ianturo): turning the radio from 40 m FT8 to 20 m FT8 kept
// decodes flowing while every transmission was refused "wrong band". A dial
// on the mode's published dial now re-anchors JTCAT and its band follows;
// any other dial is still refused, and the refusal offers Follow the radio.
// Run: node test/jtcat-dial-follow-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { decideDialFollow } = require('../lib/jtcat-dial-follow');
const { freqsForMode } = require('../lib/ft8-engine');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const read = (p) => readSrc(path.join(__dirname, '..', p));
const FT8 = freqsForMode('FT8');

test('a dial turned onto 10 m FT8 follows', () => {
  assert.deepStrictEqual(decideDialFollow({ dialHz: 28074500, anchorHz: 7074000, freqs: FT8 }), { action: 'follow', band: '10m', dialHz: 28074500 });
});
test('a phone frequency is refused (the KF0U guard stays)', () => {
  assert.strictEqual(decideDialFollow({ dialHz: 14250000, anchorHz: 7074000, freqs: FT8 }).action, 'refuse');
});
test('a nudge inside the guard is nothing to decide', () => {
  assert.strictEqual(decideDialFollow({ dialHz: 7075500, anchorHz: 7074000, freqs: FT8 }).action, 'none');
});
test('FT4 follows FT4 dials, not FT8 ones', () => {
  assert.strictEqual(decideDialFollow({ dialHz: 14080000, anchorHz: 7047500, freqs: freqsForMode('FT4') }).band, '20m');
  assert.strictEqual(decideDialFollow({ dialHz: 14074000, anchorHz: 7047500, freqs: freqsForMode('FT4') }).action, 'refuse');
});
test('never moves a QSO in progress to another band', () => {
  assert.strictEqual(decideDialFollow({ dialHz: 14074000, anchorHz: 7074000, freqs: FT8, qsoLive: true }).action, 'refuse');
});
test('no session, no anchor: nothing', () => {
  assert.strictEqual(decideDialFollow({ dialHz: 14074000, anchorHz: 0, freqs: FT8 }).action, 'none');
});

test('main: every frequency passes through the follow; the refusal names both bands and offers the button', () => {
  const main = read('main.js');
  const sink = main.slice(main.indexOf('function sendCatFrequency(hz) {'), main.indexOf('function sendCatFrequency(hz) {') + 2500);
  assert.ok(sink.includes('jtcatDialFollow(hz);'), 'in the one frequency sink');
  const fn = main.slice(main.indexOf('function jtcatDialFollow(hz)'), main.indexOf('function jtcatFollowBand('));
  assert.ok(/isRemoteMode\(\)/.test(fn) && /sliceCount > 1/.test(fn) && /qsoLive: jtcatQsoLive\(\)/.test(fn), 'not remote, not multi-slice, not mid-QSO');
  assert.ok(/error: dialMsg, followRadio: true/.test(main), 'the refusal carries followRadio');
  assert.ok(/Press "Follow the radio"/.test(main));
  assert.ok(/ipcMain\.on\('jtcat-follow-radio'/.test(main) && /remoteServer\.on\('jtcat-follow-radio'/.test(main), 'window and ECHOCAT can press it');
});

test('a tune POTACAT makes never follows itself (every tune path updates the anchor after tuneRadio returns)', () => {
  const main = read('main.js');
  assert.ok(/_jtcatTuneEcho = true;\s*try \{ sendCatFrequency\(tuneFreqHz\); \} finally \{ _jtcatTuneEcho = false; \}/.test(main), 'tuneRadio marks its echo');
  const fn = main.slice(main.indexOf('function jtcatDialFollow(hz)'), main.indexOf('function jtcatFollowBand('));
  assert.ok(/if \(_jtcatTuneEcho\) return;/.test(fn), 'and the follow ignores it');
});

test('wire, bridge and window', () => {
  const proto = read('lib/echocat-protocol.js');
  assert.ok(proto.includes("'jtcat-follow-radio': { dir: Dir.C2S") && proto.includes("'jtcat-band-follow': { dir: Dir.S2C"));
  assert.ok(/case 'jtcat-follow-radio':\s*this\.emit\('jtcat-follow-radio'\)/.test(read('lib/remote-server.js')));
  const bridge = read('lib/remote-bridge.js');
  assert.ok(bridge.includes("'jtcat-follow-radio': () => one({ type: 'jtcat-follow-radio' })") && bridge.includes("'jtcat-band-follow': same('jtcat-band-follow')"));
  const pop = read('renderer/jtcat-popout.js');
  assert.ok(/onJtcatBandFollow\(function\(d\) \{[\s\S]*?bandSelectFollowActive\(\)/.test(pop), 'the window marks the band');
  const follow = pop.slice(pop.indexOf('onJtcatBandFollow(function(d)'), pop.indexOf('// Band buttons'));
  assert.ok(!/window\.api\.tune\(/.test(follow), 'and never retunes the radio');
  assert.ok(/data\.followRadio && window\.api\.jtcatFollowRadio/.test(pop), 'the refusal toast has the button');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
