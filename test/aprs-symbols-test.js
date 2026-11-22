#!/usr/bin/env node
'use strict';
// APRS symbol to icon (lib/aprs-symbols.js): the nine icons the APRS window
// draws, read from the APRS 1.0.1 symbol tables (primary '/', alternate '\'
// and its overlays). Run: node test/aprs-symbols-test.js

const assert = require('assert');
const Y = require('../lib/aprs-symbols');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
function is(table, code, icon, what) { assert.strictEqual(Y.iconFor(table, code), icon, table + code + ' (' + what + ')'); }

console.log('APRS symbols');
test('nine icons', () => {
  assert.deepStrictEqual(Y.ICONS, ['car', 'house', 'digi', 'igate', 'weather', 'hiker', 'boat', 'aircraft', 'other']);
});
test('cars and other road vehicles', () => {
  is('/', '>', 'car', 'car');
  is('/', 'k', 'car', 'truck');
  is('/', 'u', 'car', 'truck, 18 wheeler');
  is('/', 'v', 'car', 'van');
  is('/', 'j', 'car', 'jeep');
  is('/', '<', 'car', 'motorcycle');
  is('/', 'U', 'car', 'bus');
  is('/', 'R', 'car', 'RV');
  is('/', 'a', 'car', 'ambulance');
  is('/', 'f', 'car', 'fire truck');
  is('\\', '>', 'car', 'car with overlay');
  is('\\', 'k', 'car', 'SUV');
  is('E', '>', 'car', 'overlay E on the car');
});
test('house', () => {
  is('/', '-', 'house', 'house QTH (VHF)');
  is('\\', '-', 'house', 'house (HF)');
  is('/', 'y', 'house', 'yagi at QTH');
});
test('digipeaters', () => {
  is('/', '#', 'digi', 'digi');
  is('\\', '#', 'digi', 'digi, alternate');
  is('1', '#', 'digi', 'digi with overlay 1');
  is('W', '#', 'digi', 'WIDEn-N digi overlay');
});
test('iGates and gateways', () => {
  is('/', '&', 'igate', 'HF gateway');
  is('\\', '&', 'igate', 'gateway');
  is('I', '&', 'igate', 'iGate');
  is('R', '&', 'igate', 'receive-only iGate');
});
test('weather', () => {
  is('/', '_', 'weather', 'weather station');
  is('\\', '_', 'weather', 'weather station with digi');
  is('/', 'W', 'weather', 'NWS site');
  is('\\', 't', 'weather', 'tornado');
  is('\\', '@', 'weather', 'hurricane');
});
test('hiker', () => {
  is('/', '[', 'hiker', 'human / person');
  is('\\', '[', 'weather', 'the alternate [ is a wall cloud, not a person');
});
test('boats', () => {
  is('/', 'Y', 'boat', 'yacht');
  is('/', 's', 'boat', 'power boat');
  is('/', 'C', 'boat', 'canoe');
  is('\\', 's', 'boat', 'ship with overlay');
  is('\\', 'C', 'boat', 'coast guard');
});
test('aircraft', () => {
  is('/', "'", 'aircraft', 'small aircraft');
  is('/', '^', 'aircraft', 'large aircraft');
  is('/', 'X', 'aircraft', 'helicopter');
  is('/', 'g', 'aircraft', 'glider');
  is('/', 'O', 'aircraft', 'balloon');
  is('\\', '^', 'aircraft', 'aircraft with overlay');
  is('\\', "'", 'other', 'the alternate quote is a crash site');
});
test('anything else is the fallback', () => {
  is('/', '/', 'other', 'red dot');
  is('/', 'r', 'other', 'repeater');
  is('/', ';', 'other', 'campground');
  is('/', 'h', 'other', 'hospital');
  is('\\', '9', 'other', 'gas station');
  is('/', 'A', 'other', 'aid station');
  assert.strictEqual(Y.iconFor(null, '>'), 'other');
  assert.strictEqual(Y.iconFor('/', null), 'other');
  assert.strictEqual(Y.iconFor('', ''), 'other');
  assert.strictEqual(Y.iconFor('a', '>'), 'other', 'lower-case is not a table or overlay');
  assert.strictEqual(Y.iconFor('//', '>'), 'other');
});
test('only car, boat and aircraft turn to their course', () => {
  assert.deepStrictEqual(Y.ICONS.filter(Y.isHeaded), ['car', 'boat', 'aircraft']);
});
test('every mapped icon is one of the nine', () => {
  for (let c = 33; c < 127; c++) {
    for (const t of ['/', '\\', 'I']) assert.ok(Y.ICONS.includes(Y.iconFor(t, String.fromCharCode(c))));
  }
});
test('dual mode: window.AprsSymbols in a page', () => {
  const fs = require('fs');
  const vm = require('vm');
  const sandbox = {};
  sandbox.self = sandbox;
  vm.runInNewContext(fs.readFileSync(require.resolve('../lib/aprs-symbols'), 'utf8'), sandbox);
  assert.strictEqual(sandbox.AprsSymbols.iconFor('/', '>'), 'car');
});
test('this test is in the list CI runs', () => {
  const fs = require('fs');
  const path = require('path');
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-tests.js'), 'utf8').includes("'test/aprs-symbols-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
