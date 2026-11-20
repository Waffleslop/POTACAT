#!/usr/bin/env node
'use strict';
// APRS extra 1: the activation in the beacon comment ("POTA US-1234 14.062 CW"),
// off by default. The text always fits the 43-character APRS comment, and the
// internet and radio beacons both carry it. Pure; no network, no radio.
// Run: node test/aprs-activation-test.js

const assert = require('assert');
const A = require('../lib/aprs-activation');
const B = require('../lib/aprs-beacon');
const R = require('../lib/aprs-rf-beacon');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const pota = (ref) => ({ sig: 'POTA', ref });

test('one park: "POTA US-1234 14.062 CW"', () => {
  assert.strictEqual(A.activationText({ refs: [pota('US-1234')], hz: 14062000, mode: 'CW' }), 'POTA US-1234 14.062 CW');
});

test('the mode in spot words: USB and LSB are SSB, CW-R is CW, a data mode is DATA', () => {
  assert.strictEqual(A.modeWord('USB'), 'SSB');
  assert.strictEqual(A.modeWord('LSB'), 'SSB');
  assert.strictEqual(A.modeWord('CW-R'), 'CW');
  assert.strictEqual(A.modeWord('FM'), 'FM');
  for (const m of ['DIGU', 'DIGL', 'PKTUSB', 'DATA-USB', 'USB-D', 'USB-D1', 'PKT']) assert.strictEqual(A.modeWord(m), 'DATA', m);
  assert.strictEqual(A.modeWord('ft8'), 'FT8');
  assert.strictEqual(A.modeWord(''), '');
});

test('the frequency in MHz, as a spot gives it: 14.062, 7.0305, 146.520', () => {
  assert.strictEqual(A.freqWord(14062000), '14.062');
  assert.strictEqual(A.freqWord(7030500), '7.0305');
  assert.strictEqual(A.freqWord(146520000), '146.520');
  assert.strictEqual(A.freqWord(0), '');
});

test('two parks share one program word; a SOTA cross ref gets its own', () => {
  assert.strictEqual(A.activationText({ refs: [pota('US-1234'), pota('US-5678')], hz: 14062000, mode: 'CW' }), 'POTA US-1234,US-5678 14.062 CW');
  assert.strictEqual(A.activationText({ refs: [pota('US-1234'), { sig: 'SOTA', ref: 'W7W/LC-001' }], hz: 14285000, mode: 'USB' }), 'POTA US-1234 SOTA W7W/LC-001 14.285 SSB');
});

test('no frequency or mode known: the refs alone', () => {
  assert.strictEqual(A.activationText({ refs: [pota('US-1234')], hz: 0, mode: '' }), 'POTA US-1234');
});

test('no refs: no text', () => {
  assert.strictEqual(A.activationText({ refs: [], hz: 14062000, mode: 'CW' }), '');
  assert.strictEqual(A.activationText(null), '');
});

test('a big n-fer always fits 43: the refs that do not fit become "+N", frequency and mode stay', () => {
  const refs = ['US-1234', 'US-5678', 'US-9012', 'US-3456', 'US-7890', 'US-11234'].map(pota);
  const t = A.activationText({ refs, hz: 14062000, mode: 'CW' });
  assert.ok(t.length <= B.MAX_COMMENT, t + ' is ' + t.length);
  assert.ok(/^POTA US-1234,US-5678/.test(t), t);
  assert.ok(/\+\d 14\.062 CW$/.test(t), t);
});

test('every mixture of refs, frequency and mode fits 43', () => {
  const pool = [pota('US-1234'), pota('CA-10234'), { sig: 'SOTA', ref: 'W7W/LC-001' }, { sig: 'WWFF', ref: 'KFF-1234' }, pota('GB-0123'), { sig: 'SOTA', ref: 'VK3/VC-001' }];
  for (let n = 1; n <= pool.length; n++) {
    for (const hz of [0, 7030500, 14062000, 146520000, 1296100000]) {
      const t = A.activationText({ refs: pool.slice(0, n), hz, mode: 'DATA-USB' });
      assert.ok(t.length > 0 && t.length <= B.MAX_COMMENT, JSON.stringify(t));
      assert.ok(/^POTA US-1234/.test(t), t);
    }
  }
});

test('the beacon comment: off by default, the typed comment goes as it is', () => {
  assert.strictEqual(B.beaconSettings({}).activation, false);
  const c = A.beaconComment({ comment: 'POTACAT', on: false, activation: { refs: [pota('US-1234')], hz: 14062000, mode: 'CW' } });
  assert.deepStrictEqual(c, { comment: 'POTACAT', added: false, text: 'POTA US-1234 14.062 CW', running: true });
});

test('the beacon comment: on with no activation running, the typed comment goes as it is', () => {
  assert.deepStrictEqual(A.beaconComment({ comment: 'POTACAT', on: true, activation: null }), { comment: 'POTACAT', added: false, text: '', running: false });
});

test('the beacon comment: on during an activation, the activation first, then the typed comment if it fits whole', () => {
  const act = { refs: [pota('US-1234')], hz: 14062000, mode: 'CW' };
  assert.strictEqual(A.beaconComment({ comment: 'POTACAT', on: true, activation: act }).comment, 'POTA US-1234 14.062 CW POTACAT');
  // 22 + 1 + 21 = 44: the typed comment does not fit, so it is left off (never cut mid-word).
  const r = A.beaconComment({ comment: 'Listening on 2 m, 73!', on: true, activation: act });
  assert.strictEqual(r.comment, 'POTA US-1234 14.062 CW');
  assert.strictEqual(r.added, true);
});

test('the setting: "activation" in a patch saves aprsBeaconActivation as a boolean', () => {
  assert.deepStrictEqual(B.settingsPatch({ activation: true }), { aprsBeaconActivation: true });
  assert.deepStrictEqual(B.settingsPatch({ activation: 'yes' }), { aprsBeaconActivation: false });
  assert.strictEqual(B.beaconSettings({ aprsBeaconActivation: true }).activation, true);
});

test('both beacons carry it: the internet packet and the radio packet end with the same comment', () => {
  const comment = A.beaconComment({ comment: 'POTACAT', on: true, activation: { refs: [pota('US-1234')], hz: 14062000, mode: 'CW' } }).comment;
  const is = B.buildBeacon({ settingsCall: 'K3ABC', lat: 40.5, lon: -75.05, symbol: 'portable', comment, approx: true });
  const rf = R.buildRfBeacon({ settingsCall: 'K3ABC', band: '30m', lat: 40.5, lon: -75.05, symbol: 'portable', comment, approx: true });
  assert.ok(is.packet.endsWith(';POTA US-1234 14.062 CW POTACAT'), is.packet);
  assert.ok(rf.packet.endsWith(';POTA US-1234 14.062 CW POTACAT'), rf.packet);
});

test('the frequency of the activation: the dial, or JTCAT\'s mode while it runs', () => {
  assert.deepStrictEqual(A.activationFrequency({ dialHz: 14062000, radioMode: 'CW' }), { hz: 14062000, mode: 'CW' });
  assert.deepStrictEqual(A.activationFrequency({ dialHz: 14074000, radioMode: 'DIGU', jtcatMode: 'FT8' }), { hz: 14074000, mode: 'FT8' });
});

test('while APRS listening holds the dial, the activation\'s frequency is the place the radio goes back to, never the APRS frequency', () => {
  assert.deepStrictEqual(A.activationFrequency({ dialHz: 10147600, radioMode: 'USB', listening: true, returnTo: { freqHz: 14062000, mode: 'CW' } }), { hz: 14062000, mode: 'CW' });
  assert.deepStrictEqual(A.activationFrequency({ dialHz: 144390000, radioMode: 'FM', listening: true, returnTo: null }), { hz: 0, mode: '' });
  // JTCAT does not run while APRS listens (one audio user), so its mode is not used then.
  assert.deepStrictEqual(A.activationFrequency({ dialHz: 10147600, radioMode: 'USB', listening: true, jtcatMode: 'FT8', returnTo: { freqHz: 14074000, mode: 'DIGU' } }), { hz: 14074000, mode: 'DIGU' });
});

// Wiring (source text; CRLF and LF both pass).
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const fnBody = (src, name) => {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  return src.slice(i, src.indexOf('\n}\n', i));
};
const main = read('main.js');

test('wiring: the internet beacon and the radio beacon both take the comment from aprsBeaconComment', () => {
  const is = fnBody(main, 'aprsBeaconSend');
  const rf = fnBody(main, 'aprsRfPlan'); // the radio packet is built in aprsRfPlan since the one-click beacon (2026-11-19)
  for (const [name, body] of [['aprsBeaconSend', is], ['aprsRfPlan', rf]]) {
    assert.ok(/comment: aprsBeaconComment\(st\)\.comment/.test(body), name + ' uses aprsBeaconComment');
    assert.ok(!/comment: st\.comment/.test(body), name + ' no longer sends the typed comment alone');
  }
});

test('wiring: the activation comes from the running activation (liveActivationMyRefs) and the listen return marker', () => {
  const body = fnBody(main, 'aprsActivationNow');
  assert.ok(/activationRunning\(\)/.test(body));
  assert.ok(/liveActivationMyRefs\(\)/.test(body));
  assert.ok(/AprsActivation\.activationFrequency\(/.test(body));
  assert.ok(/settings\.aprsListenReturn/.test(body));
  assert.ok(/aprsListen\.on/.test(body));
});

test('wiring: the window is told the comment before anything is sent (the state carries it)', () => {
  assert.ok(/activation: aprsBeaconComment\(/.test(fnBody(main, 'aprsBeaconState')));
});

test('the window: the checkbox "Add my activation to the beacon comment", and the preview line', () => {
  const html = read('renderer/aprs-popout.html');
  assert.ok(/id="aprs-beacon-activation"/.test(html));
  assert.ok(/Add my activation to the beacon comment/.test(html));
  assert.ok(/id="aprs-beacon-sends"/.test(html));
  const bar = read('renderer/aprs-beacon-bar.js');
  assert.ok(/beaconSet\(\{ activation: /.test(bar));
  assert.ok(/aprs-beacon-sends/.test(bar));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
