#!/usr/bin/env node
'use strict';
// OH7DSQ (FT-950 + SignaLink, ECHOCAT app, 2026-09): "After I stop
// transmitting, it takes too long for the radio's receive audio to start
// coming through on my phone ... the first words of the responding station
// are cut off." Most of it was on the phone (potacat-app
// __tests__/pttRxResume.test.ts). The desktop part: the setSinkId TX route
// played the phone's stream into the radio's USB audio input ALL the time,
// so the jitter-buffered tail of the operator's speech kept a VOX-keyed
// SignaLink in transmit after release. The DAX path was already gated.
// Run: node test/oh7dsq-rx-after-tx-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

console.log('OH7DSQ RX after TX');

const html = R('renderer/remote-audio.html');

test('the sink route starts gated to the TX state, not open', () => {
  const at = html.indexOf('if (config.daxTxDirect) {');
  const branch = html.slice(at, html.indexOf('_applyTxDrive(); // sink route', at));
  assert.ok(/_txSinkRoute = true;\s*audioEl\.muted = !kiwiTxMuted;/.test(branch), 'sink route: muted unless transmitting');
  assert.ok(!/audioEl\.muted = false;/.test(branch), 'no unconditional unmute left');
  assert.ok(/_txSinkRoute = false;\s*audioEl\.muted = true;/.test(branch), 'the DAX path keeps its own gate');
});

test('the TX-state edge opens and closes the sink route', () => {
  const at = html.indexOf('window.api.onTxState(');
  const fn = html.slice(at, at + 900);
  assert.ok(/if \(_txSinkRoute\) audioEl\.muted = !kiwiTxMuted;/.test(fn));
});

test('the gate follows the PTT press, not CAT success (a VOX-only station still transmits)', () => {
  const main = R('main.js');
  const fn = main.slice(main.indexOf('function handleRemotePtt('), main.indexOf('function _isEffectivelyTransmitting('));
  const failAt = fn.indexOf("PTT FAILED: CAT not connected");
  const setAt = fn.indexOf('_remoteTxState = state;');
  assert.ok(failAt > 0 && setAt > failAt, 'a failed CAT key-up/down still sets the TX state the bridge follows');
  assert.ok(/_remoteTxState = state;\s*_broadcastEffectiveTxState\(\);/.test(fn));
});

console.log(`\nOH7DSQ RX after TX: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
