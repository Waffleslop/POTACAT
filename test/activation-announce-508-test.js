#!/usr/bin/env node
'use strict';
// #508: during an activation, a QSO logged from the Log window (Ctrl+L) was
// saved with the park as MY_SIG_INFO but never reached the activation's live
// list or its Export ADIF. Every save is now announced once, by logContact;
// the main window's own forms (which list the contact themselves) are not.
// Run: node test/activation-announce-508-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const A = require('../lib/activation-announce');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const read = (f) => readSrc(path.join(__dirname, '..', f));

const live = [{ sig: 'POTA', ref: 'US-1234' }, { sig: 'POTA', ref: 'US-5678' }, { sig: 'WWFF', ref: 'KFF-0001' }];
const rec = (call, mySig, mySigInfo, extra) => ({ callsign: call, mySig, mySigInfo, band: '20m', mode: 'SSB', ...(extra || {}) });

test('records at the running activation\'s parks are its own; case does not matter', () => {
  const recs = [rec('K1ABC', 'POTA', 'us-1234'), rec('K1ABC', 'POTA', 'US-5678'), rec('K1ABC', 'WWFF', 'KFF-0001')];
  assert.strictEqual(A.activationRecords(recs, live).length, 3);
});

test('no activation running, nothing is announced', () => {
  assert.deepStrictEqual(A.activationRecords([rec('K1ABC', 'POTA', 'US-1234')], []), []);
  assert.deepStrictEqual(A.activationRecords([rec('K1ABC', 'POTA', 'US-1234')], null), []);
});

test('a record with no MY park, or another park, is not this activation\'s', () => {
  const recs = [rec('K1ABC', '', ''), rec('K2XYZ', 'POTA', 'US-9999'), rec('K3SBP', 'SOTA', 'US-1234')];
  assert.deepStrictEqual(A.activationRecords(recs, live), []);
});

test('a 2-fer is one live-list row per callsign, every record in it (as the Log button adds)', () => {
  const recs = [rec('K1ABC', 'POTA', 'US-1234'), rec('K1ABC', 'POTA', 'US-5678'),
    rec('W2DEF', 'POTA', 'US-1234'), rec('W2DEF', 'POTA', 'US-5678')];
  const groups = A.groupByCall(A.activationRecords(recs, live));
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[0].callsign, 'K1ABC');
  assert.strictEqual(groups[0].records.length, 2);
  assert.strictEqual(groups[1].records.length, 2);
});

test('targets: main window forms never (they list it), ECHOCAT the window only, the rest both', () => {
  assert.deepStrictEqual(A.announceTargets({ origin: 'local-manual', listed: true }), { window: false, session: false });
  assert.deepStrictEqual(A.announceTargets({ origin: 'local-manual' }), { window: true, session: true });
  assert.deepStrictEqual(A.announceTargets({ origin: 'ws-log-qso' }), { window: true, session: false });
  assert.deepStrictEqual(A.announceTargets({ origin: 'jtcat-engine' }), { window: true, session: true });
  assert.deepStrictEqual(A.announceTargets({ origin: 'wsjtx-bridge' }), { window: true, session: true });
  assert.deepStrictEqual(A.announceTargets(undefined), { window: true, session: true });
});

// --- the glue in main.js ---
const main = read('main.js');
const fnBody = (name) => {
  const i = main.indexOf(`async function ${name}(`) >= 0 ? main.indexOf(`async function ${name}(`) : main.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} not found`);
  const j = main.indexOf('\n}\n', i);
  return main.slice(i, j);
};

test('logContact announces every save, once, with the caller\'s options', () => {
  const body = fnBody('logContact');
  assert.ok(/announceActivationContact\(written, ActivationAnnounce\.announceTargets\(opts\)\)/.test(body),
    'logContact must announce the written records');
});

test('announceActivationContact is called from logContact only (no per-surface copies to double a row)', () => {
  const calls = main.match(/announceActivationContact\(/g) || [];
  // the definition + the one call in logContact
  assert.strictEqual(calls.length, 2, `found ${calls.length} mentions`);
});

test('the log-contact handler marks saves from the main window as already listed', () => {
  const i = main.indexOf("ipcMain.handle('log-contact'");
  assert.ok(i >= 0);
  const h = main.slice(i, main.indexOf('\n  });', i));
  assert.ok(/e\.sender === win\.webContents/.test(h), 'must tell the main window apart');
  assert.ok(/logContact\(entry, \{ origin: 'local-manual', listed \}\)/.test(h), 'must pass listed');
});

test('the announcement filters on the running activation\'s parks', () => {
  const body = fnBody('announceActivationContact');
  assert.ok(/ActivationAnnounce\.activationRecords\(records, liveActivationMyRefs\(\)\)/.test(body));
  assert.ok(/targets\.session && remoteServer/.test(body), 'the phone session list only when asked');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
