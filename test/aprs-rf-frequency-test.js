#!/usr/bin/env node
'use strict';
// APRS phase 2: the 2 m APRS frequency by grid square (lib/aprs-rf-frequency.js).
// Every entry cites a published band plan; a country with no verified entry
// gets null (the window says so), never a guess.
// Run: node test/aprs-rf-frequency-test.js

const assert = require('assert');
const path = require('path');
const F = require('../lib/aprs-rf-frequency');
const COUNTRIES = require(path.join(__dirname, '..', 'assets', 'geo', 'countries.json'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const at = (grid) => F.frequencyForGrid(grid, COUNTRIES);
const hz = (grid) => { const r = at(grid); return r ? r.hz : null; };

console.log('APRS 2 m frequency by grid');

test('North America: 144.390 MHz (US, Canada, Mexico)', () => {
  assert.strictEqual(hz('FM29'), 144390000);   // Philadelphia
  assert.strictEqual(hz('CN87'), 144390000);   // Seattle
  assert.strictEqual(hz('BP51'), 144390000);   // Anchorage
  assert.strictEqual(hz('FN25'), 144390000);   // Ottawa
  assert.strictEqual(hz('DO21'), 144390000);   // Calgary
  assert.strictEqual(hz('EK09'), 144390000);   // Mexico City
});

test('IARU Region 1: 144.800 MHz (Europe, Africa, Middle East, Russia)', () => {
  assert.strictEqual(hz('IO91'), 144800000);   // London
  assert.strictEqual(hz('JO62'), 144800000);   // Berlin
  assert.strictEqual(hz('JN18'), 144800000);   // Paris
  assert.strictEqual(hz('KO85'), 144800000);   // Moscow
  assert.strictEqual(hz('KG33'), 144800000);   // Johannesburg
  assert.strictEqual(hz('KM72'), 144800000);   // Tel Aviv
  assert.strictEqual(hz('IN80'), 144800000);   // Madrid
});

test('Australia: 145.175 MHz; New Zealand: 144.575 MHz', () => {
  assert.strictEqual(hz('QF56'), 145175000);   // Sydney
  assert.strictEqual(hz('OF78'), 145175000);   // Perth
  assert.strictEqual(hz('RF73'), 144575000);   // Auckland
  assert.strictEqual(hz('RE78'), 144575000);   // Wellington
});

test('countries with no verified entry give null, never a guess', () => {
  assert.strictEqual(at('PM95'), null);  // Tokyo
  assert.strictEqual(at('GG66'), null);  // Brazil (Sao Paulo area)
  assert.strictEqual(at('FF46'), null);  // Argentina / Chile
  assert.strictEqual(at('FK68'), null);  // Puerto Rico (Caribbean)
  assert.strictEqual(at('OM89'), null);  // China (Beijing)
  assert.strictEqual(at('MK82'), null);  // India
});

test('a grid out at sea (no land nearby) gives null', () => {
  assert.strictEqual(at('HN00'), null);   // mid Atlantic
});

test('a coastal grid whose centre is just offshore takes the nearest country', () => {
  // FN30: Long Island Sound / south shore; the 110 m outline puts its centre offshore or close to it.
  assert.strictEqual(hz('FN30'), 144390000);
});

test('no grid, or nonsense, is null', () => {
  assert.strictEqual(at(''), null);
  assert.strictEqual(at('ZZ'), null);
  assert.strictEqual(at(null), null);
});

test('every entry names its source', () => {
  for (const e of F.ENTRIES) {
    assert.ok(e.hz > 144e6 && e.hz < 146e6, e.id);
    assert.ok(e.source && e.source.length > 20, e.id + ' has no source');
    assert.ok(Array.isArray(e.countries) && e.countries.length, e.id);
  }
});

test('no country is in two entries', () => {
  const seen = new Set();
  for (const e of F.ENTRIES) for (const c of e.countries) { assert.ok(!seen.has(c), c + ' twice'); seen.add(c); }
});

test('the region entries cover what the table claims', () => {
  assert.strictEqual(F.frequencyForCountry('US').hz, 144390000);
  assert.strictEqual(F.frequencyForCountry('GB').hz, 144800000);
  assert.strictEqual(F.frequencyForCountry('ZA').hz, 144800000);
  assert.strictEqual(F.frequencyForCountry('JP'), null);
  assert.strictEqual(F.frequencyForCountry('GL'), null); // Greenland is IARU Region 2, not in the table
});

test('the result carries the MHz text the window shows', () => {
  assert.strictEqual(at('FM29').mhz, '144.390');
  assert.strictEqual(at('IO91').mhz, '144.800');
  assert.strictEqual(at('QF56').mhz, '145.175');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
