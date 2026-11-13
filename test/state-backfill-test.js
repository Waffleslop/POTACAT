#!/usr/bin/env node
'use strict';
// #389 (Discord 2026-11-11): the QRZ button said "No states found for the 1
// QSO still without one" and the operator could find no US contact without a
// state. An Australian contact was counted though no VK state is ever written,
// and the answer never said which QSO it was.
// Run: node test/state-backfill-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const SB = require('../lib/state-backfill');
const WorkedRoster = require('../lib/worked-roster');
const { baseCall } = require('../renderer/jtcat-parser');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const read = (f) => readSrc(path.join(__dirname, '..', f));

// A tiny prefix table standing in for cty.dat
function entityOf(call) {
  const c = String(call || '').toUpperCase();
  if (/^VE3\//.test(c) || /^VE/.test(c)) return 'Canada';
  if (/^VK/.test(c)) return 'Australia';
  if (/^KL7/.test(c)) return 'Alaska';
  if (/^[KWN]/.test(c)) return 'United States';
  if (/^G/.test(c)) return 'England';
  return '';
}
const PARKS = { 'US-0001': 'NJ', 'US-0002': '' }; // US-0002 spans two states
const ctx = {
  entityOf,
  tracksEntity: WorkedRoster.tracksEntity,
  stateKeys: WorkedRoster.stateKeys,
  parkStateOf: (rec) => {
    const ref = String(rec.SIG_INFO || rec.POTA_REF || '').toUpperCase();
    return ref ? (PARKS[ref] !== undefined ? PARKS[ref] : '') : null;
  },
  baseCall,
};

test('the reporter\'s case: a VK contact with no state is not counted (the roster never tracks VK states)', () => {
  assert.strictEqual(SB.decide({ CALL: 'VK2ABC', QSO_DATE: '20260501', BAND: '20M' }, ctx, new Map()), null);
  assert.strictEqual(SB.wantsLookup({ CALL: 'VK2ABC' }, ctx), false, 'and no QRZ lookup is spent on it');
  assert.strictEqual(SB.decide({ CALL: 'G4ABC' }, ctx, new Map()), null, 'nor any other DX');
  assert.strictEqual(SB.decide({ CALL: 'W1AW', STATE: 'CT' }, ctx, new Map()), null, 'a QSO with a state is never touched');
});

test('US, Alaska and Canada calls are candidates and take QRZ\'s state', () => {
  const lookups = new Map([['W1AW', { state: 'ct' }], ['VE3XYZ', { state: 'ON' }], ['KL7AB', { state: 'AK' }]]);
  assert.deepStrictEqual(SB.decide({ CALL: 'W1AW' }, ctx, lookups), { state: 'CT', fromPark: false, call: 'W1AW', ent: 'United States' });
  assert.strictEqual(SB.decide({ CALL: 'VE3XYZ' }, ctx, lookups).state, 'ON');
  assert.strictEqual(SB.decide({ CALL: 'KL7AB' }, ctx, lookups).state, 'AK');
  assert.strictEqual(SB.wantsLookup({ CALL: 'W1AW' }, ctx), true);
});

test('a park contact takes the park\'s state, and is left (named) when the park spans states', () => {
  assert.deepStrictEqual(SB.decide({ CALL: 'K1ABC', SIG_INFO: 'US-0001' }, ctx, new Map()), { state: 'NJ', fromPark: true, call: 'K1ABC', ent: 'United States' });
  const d = SB.decide({ CALL: 'K1ABC', SIG_INFO: 'US-0002' }, ctx, new Map());
  assert.strictEqual(d.state, '');
  assert.match(d.reason, /park US-0002 is not in one state/);
  assert.strictEqual(SB.wantsLookup({ CALL: 'K1ABC', SIG_INFO: 'US-0002' }, ctx), false, 'the park decides, QRZ is not asked');
});

test('each QSO left says why: not looked up, not on QRZ, no state on QRZ, a portable call\'s home state', () => {
  const lookups = new Map([['K2NONE', null], ['K2BLANK', { state: '' }], ['K1ABC', { state: 'MA' }]]);
  assert.strictEqual(SB.decide({ CALL: 'K2LATER' }, ctx, lookups).reason, 'not looked up yet');
  assert.strictEqual(SB.decide({ CALL: 'K2NONE' }, ctx, lookups).reason, 'not found on QRZ');
  assert.strictEqual(SB.decide({ CALL: 'K2BLANK' }, ctx, lookups).reason, 'QRZ lists no state');
  // VE3/K1ABC is worked in Canada; QRZ for K1ABC gives a US state: never written
  const d = SB.decide({ CALL: 'VE3/K1ABC' }, ctx, lookups);
  assert.strictEqual(d.state, '');
  assert.strictEqual(d.reason, 'QRZ lists MA, not a Canada province');
});

test('the answer names the QSO: call, date, band and why', () => {
  const rec = { CALL: 've3/k1abc', QSO_DATE: '20260501', BAND: '20M' };
  const line = SB.describe(rec, { ent: 'Canada', reason: 'QRZ lists MA, not a Canada province' });
  assert.strictEqual(line, 'VE3/K1ABC on 2026-05-01, 20m (Canada; QRZ lists MA, not a Canada province)');
  assert.strictEqual(SB.describe({ CALL: 'W1AW' }, { ent: 'United States', reason: 'not found on QRZ' }), 'W1AW (not found on QRZ)');
  assert.strictEqual(
    SB.resultText({ filled: 0, remaining: 1, left: [line] }),
    'No state found for the 1 QSO still without one: VE3/K1ABC on 2026-05-01, 20m (Canada; QRZ lists MA, not a Canada province).');
});

test('more than three left: three are named and the rest counted', () => {
  const left = ['A', 'B', 'C', 'D', 'E'];
  assert.strictEqual(SB.resultText({ filled: 2, remaining: 5, left, more: true }),
    'Filled 2 QSOs, 5 still without a state: A; B; C; and 2 more (press again for more).');
  assert.strictEqual(SB.resultText({ filled: 0, remaining: 0, left: [] }), 'Every QSO already has a state.');
  assert.strictEqual(SB.resultText({ filled: 1, remaining: 0, left: [] }), 'Filled 1 QSO.');
});

test('wiring: main decides every record through lib/state-backfill.js; both buttons show its sentence', () => {
  const main = read('main.js');
  const f = main.slice(main.indexOf('async function wasBackfillStates()'), main.indexOf("ipcMain.handle('was-backfill-states'"));
  assert.ok(!/'Australia'/.test(f), 'Australia is not a candidate');
  assert.ok(/tracksEntity: WorkedRoster\.tracksEntity/.test(f));
  assert.ok(/StateBackfill\.wantsLookup\(rec, backfillCtx\)/.test(f));
  assert.ok(/const d = StateBackfill\.decide\(rec, backfillCtx, lookups\);/.test(f));
  assert.ok(/mutateLog\(logPath,/.test(f), 'still written through lib/qso-log.js');
  assert.ok(/const text = StateBackfill\.resultText\(\{ filled, remaining, left, more \}\);/.test(f));
  assert.ok(/if \(kind === 'qrz'\) \{[\s\S]{0,200}return \{ ok: true, text: r\.text \};/.test(main), 'the map legend\'s QRZ button');
  const app = read('renderer/app.js');
  assert.ok(/wasEls\.backfillStatus\.textContent = r\.text;/.test(app), 'the WAS view\'s button');
  assert.ok(!/No states found for the/.test(app + f), 'the old unnamed sentence is gone');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
