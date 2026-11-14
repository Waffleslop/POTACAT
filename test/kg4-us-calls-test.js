// test/kg4-us-calls-test.js — #342: KG4OLE (Virginia) shown as Guantanamo Bay.
// KG4 + exactly two letters is Guantanamo; a one- or three-letter suffix is US.
'use strict';
const assert = require('assert');
const path = require('path');
const { loadCtyDat, resolveCallsign, resolveOperatingCall, resolveZones } = require('../lib/cty');
const db = loadCtyDat(path.join(__dirname, '..', 'assets', 'cty.dat'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
const name = (c) => (resolveCallsign(c, db) || {}).name;
const op = (c) => ((resolveOperatingCall(c, db) || {}).entity || {}).name;

console.log('KG4 calls:');
t('KG4OLE, KG4ABC, KG4A are United States', () => {
  for (const c of ['KG4OLE', 'KG4ABC', 'KG4A']) assert.strictEqual(name(c), 'United States', c);
});
t('KG4AB is Guantanamo Bay', () => assert.strictEqual(name('KG4AB'), 'Guantanamo Bay'));
t('portable forms follow the same rule', () => {
  assert.strictEqual(op('KG4OLE/P'), 'United States');
  assert.strictEqual(op('KG4OLE/4'), 'United States');
  assert.strictEqual(op('KG4AB/P'), 'Guantanamo Bay');
  assert.strictEqual(op('W1/KG4AB'), 'United States');
});
t('zones follow the entity', () => {
  assert.strictEqual(resolveZones('KG4AB', db).cqZone, 8);
  assert.notStrictEqual(resolveZones('KG4OLE', db).cqZone, 8);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
