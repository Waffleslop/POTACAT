#!/usr/bin/env node
'use strict';
// #734 (activation review 2026-11-17, fix 7): the phone's own park is kept on
// a QSO that arrives at the UTC day change.
//
// While the desktop still showed an activation running, the log-qso handler
// dropped the phone's mySig/mySigInfo (liveActivationMyRefs() does not ask
// the #147 clock). logContact then found the day had ended, auto-ended the
// activation and saved the QSO with NO MY_SIG_INFO: a lost park credit.
//
// Now the phone's ref rides along as entry.deviceMyRef, and logContact uses
// it when the desktop's activation does not apply at the contact's own time
// (lib/activation-clock.js contactMyRefs). A live desktop activation still
// wins, and the #147 auto-end and the 6-hour clock are unchanged.
// Run: node test/activation-device-ref-00z-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const AC = require('../lib/activation-clock');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const at = (iso) => Date.parse(iso);
const PHONE = { sig: 'POTA', ref: 'US-1234' };
const DESK = [{ sig: 'POTA', ref: 'US-1234' }, { sig: 'POTA', ref: 'US-5678' }];

test('contactMyRefs exists', () => assert.strictEqual(typeof AC.contactMyRefs, 'function'));

test('00:00:30Z: the desktop activation has ended by the day change, the phone\'s park is saved', () => {
  const clock = AC.startClock(at('2026-11-16T22:00:00Z'), 'US-1234,US-5678');
  // What main.js activationRefsAt does: the clock decides at the contact's own time.
  const activationRefsAt = (t) => (AC.decide(clock, t).live ? DESK : []);
  const t = at('2026-11-17T00:00:30Z');
  const r = AC.contactMyRefs({ activationRefsAt: () => activationRefsAt(t), deviceRef: PHONE });
  assert.deepStrictEqual(r, { refs: [PHONE], from: 'device' });
});

test('23:59:50Z: the desktop activation is live, its full set of parks applies (unchanged)', () => {
  const clock = AC.startClock(at('2026-11-16T22:00:00Z'), 'US-1234,US-5678');
  const t = at('2026-11-16T23:59:50Z');
  const r = AC.contactMyRefs({ activationRefsAt: () => (AC.decide(clock, t).live ? DESK : []), deviceRef: PHONE });
  assert.deepStrictEqual(r, { refs: DESK, from: 'activation' });
});

test('6 h idle end: same rule, the phone\'s park is kept', () => {
  const clock = { startedAt: at('2026-11-17T08:00:00Z'), lastContactAt: at('2026-11-17T09:00:00Z') };
  const t = at('2026-11-17T15:30:00Z');
  const r = AC.contactMyRefs({ activationRefsAt: () => (AC.decide(clock, t).live ? DESK : []), deviceRef: PHONE });
  assert.deepStrictEqual(r.refs, [PHONE]);
});

test('an own ref wins; no activation and no device ref is a home contact; activation:false skips the activation', () => {
  assert.deepStrictEqual(AC.contactMyRefs({ ownRef: PHONE, activationRefsAt: () => DESK }), { refs: [PHONE], from: 'own' });
  assert.deepStrictEqual(AC.contactMyRefs({ activationRefsAt: () => [] }), { refs: [], from: 'none' });
  let asked = false;
  assert.deepStrictEqual(AC.contactMyRefs({ skipActivation: true, activationRefsAt: () => { asked = true; return DESK; } }), { refs: [], from: 'none' });
  assert.strictEqual(asked, false, 'activation:false never asks the clock');
});

test('main.js: the phone\'s ref is never dropped while the desktop runs an activation', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  const i = main.indexOf("remoteServer.on('log-qso', async (data) => {");
  const h = main.slice(i, main.indexOf("remoteServer.on('", i + 10));
  assert.ok(/entry\.deviceMyRef = \{ sig: String\(data\.mySig\)\.toUpperCase\(\), ref: data\.mySigInfo \}/.test(h), 'the device ref rides along');
  const lc = main.slice(main.indexOf('async function logContact(entry, opts) {'));
  const body = lc.slice(0, lc.indexOf('\n}\n'));
  assert.ok(/ActivationClock\.contactMyRefs\(\{/.test(body), 'logContact decides through the rule');
  assert.ok(/deviceRef: entry\.deviceMyRef/.test(body));
  assert.ok(/activationRefsAt: \(\) => activationRefsAt\(actAt\)/.test(body), '#147: still through the clock at the contact\'s own time');
  assert.ok(/mine\.from === 'activation'\) activationNoteContact\(actAt\)/.test(body), 'only an activation contact moves the idle clock (unchanged)');
  assert.ok(/delete e\.deviceMyRef/.test(body), 'the helper field never reaches the record');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
