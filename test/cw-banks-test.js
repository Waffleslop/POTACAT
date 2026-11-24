#!/usr/bin/env node
'use strict';
// #741 CW macro banks (lib/cw-banks.js): the N1MM-positional layout, the
// migration from settings.cwMacros, and the variables.
// Run: node test/cw-banks-test.js
const assert = require('assert');
const B = require('../lib/cw-banks');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('ESM keys sit where N1MM puts them: F1 CQ, F2 EXCH, F3 TU, F4 MYCALL, F5 CALL, F8 AGN (+ F7 P2P)', () => {
  assert.deepStrictEqual(Object.assign({}, B.ROLE_SLOT), { CQ: 0, EXCH: 1, TU: 2, MYCALL: 3, CALL: 4, P2P: 6, AGN: 7 });
  for (const bank of ['run', 'sp']) {
    const d = B.defaultsFor(bank);
    assert.strictEqual(d.length, 12);
    assert.ok(/^CQ /.test(B.slotText(d, 'CQ')), bank + ' F1 CQ');
    assert.strictEqual(B.slotText(d, 'EXCH'), '5NN {MYSTATE}', bank + ' F2: 5NN + state (Casey 2026-11-19)');
    assert.ok(/\{PARK\}/.test(B.slotText(d, 'P2P')), bank + ' F7: P2P adds the park');
    assert.strictEqual(B.slotText(d, 'MYCALL'), '{MYCALL}');
    assert.strictEqual(B.slotText(d, 'CALL'), '{CALL}');
    assert.strictEqual(B.slotText(d, 'AGN'), 'AGN?');
    assert.ok(B.esmReady(d), bank + ' defaults are ESM-ready');
  }
  assert.ok(Object.isFrozen(B.RUN_DEFAULTS) && Object.isFrozen(B.RUN_DEFAULTS[0]));
  const d = B.defaultsFor('run'); d[0].text = 'X';
  assert.notStrictEqual(B.RUN_DEFAULTS[0].text, 'X', 'defaultsFor hands out a copy');
});

test('migration: existing cwMacros become BOTH banks unchanged on first load', () => {
  const mine = [{ label: 'CQ', text: 'CQ DE {MYCALL}' }, { label: '599', text: '{call} 599' }];
  const r = B.banksFromSettings({ cwMacros: mine });
  assert.strictEqual(r.migrated, true);
  assert.deepStrictEqual(r.sp, mine);
  assert.deepStrictEqual(r.run, mine);
  assert.notStrictEqual(r.run, r.sp, 'two copies, not one array');
  r.run[0].text = 'changed';
  assert.strictEqual(r.sp[0].text, 'CQ DE {MYCALL}');
});

test('migration: no saved macros = the set POTACAT shipped, in both banks (nothing new keys)', () => {
  const r = B.banksFromSettings({});
  assert.deepStrictEqual(r.sp, B.LEGACY_DEFAULTS.map((m) => ({ label: m.label, text: m.text })));
  assert.deepStrictEqual(r.run, r.sp);
  assert.strictEqual(B.esmReady(r.run), false, 'the old set never drives ESM');
});

test('a saved Run bank is kept, and cwMacros stays the Hunter bank', () => {
  const run = B.defaultsFor('run');
  const sp = [{ label: 'A', text: 'B' }];
  const r = B.banksFromSettings({ cwMacros: sp, cwMacrosRun: run });
  assert.strictEqual(r.migrated, false);
  assert.deepStrictEqual(r.run, run);
  assert.deepStrictEqual(r.sp, sp);
  assert.deepStrictEqual(B.banksFromSettings({ cwMacros: sp, cwMacrosRun: [] }).run, [], 'an emptied Run bank stays empty');
});

test('rows are cleaned: max 25, strings only', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ label: 'L' + i, text: 'T' + i, extra: 1 }));
  const r = B.banksFromSettings({ cwMacros: [null, { label: 5 }, ...many], cwMacrosRun: many });
  assert.strictEqual(r.sp.length, 25);
  assert.deepStrictEqual(r.sp[0], { label: '', text: '' });
  assert.deepStrictEqual(r.sp[1], { label: '5', text: '' });
  assert.deepStrictEqual(Object.keys(r.run[0]), ['label', 'text']);
});

test('esmReady: F4 my call and F5 their call, CQ/EXCH/TU present', () => {
  const d = B.defaultsFor('run');
  assert.ok(B.esmReady(d));
  const noTu = B.defaultsFor('run'); noTu[2].text = ' ';
  assert.ok(!B.esmReady(noTu));
  const lowercase = B.defaultsFor('sp'); lowercase[4].text = '{call}'; lowercase[3].text = '{mycallsign}';
  assert.ok(B.esmReady(lowercase));
  assert.ok(!B.esmReady(null));
});

test('variables: {PARK} {MYSTATE} {RST} {NR} {MYGRID} {CALL} filled', () => {
  const r = B.expandVars('{call} {CALL} UR {RST} {MYSTATE} {PARK} NR {NR} {MYGRID} {op_firstname} {state}', {
    call: 'w1aw', myState: 'pa', park: 'us-1234,us-5678', rst: '579', nr: 7, myGrid: 'fn20', opFirstname: 'Hiram', state: 'ct',
  });
  assert.strictEqual(r.text, 'W1AW W1AW UR 57N PA US-1234,US-5678 NR 7 FN20 Hiram CT');
  assert.deepStrictEqual(r.unknown, []);
  assert.strictEqual(B.expandVars('{RST}', {}).text, '5NN', 'no report typed = 599 cut');
});

test('variables main fills ({MYCALL} {mycallsign} {greeting}) pass through untouched', () => {
  const r = B.expandVars('{greeting} DE {MYCALL} {mycallsign}', {});
  assert.strictEqual(r.text, '{greeting} DE {MYCALL} {mycallsign}');
});

test('unknown {x} is never keyed as braces: dropped and reported', () => {
  const r = B.expandVars('TU {FOO} 73 {bar baz} {MYCALL}', {});
  assert.strictEqual(r.text, 'TU 73 {MYCALL}');
  assert.deepStrictEqual(r.unknown, ['{FOO}', '{bar baz}']);
  assert.strictEqual(B.expandVars('TU {CALL 73 } {PARK', { park: 'US-1' }).text, 'TU PARK', 'stray braces dropped too');
  assert.deepStrictEqual(B.unknownVars('{CALL} {PARK} {x} {greeting}'), ['{x}']);
});

console.log(`\nCW macro banks: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
