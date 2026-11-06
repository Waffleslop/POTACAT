#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
/**
 * Which country's park list answers a lookup (OG3E, Discord 2026-11-01:
 * Activator mode "cant find any parks", then even K-TEST failed).
 * POTA's program prefixes are ISO country codes (test/fixtures/
 * pota-programs.json, from https://api.pota.app/programs on 2026-11-01). The
 * old table's OH, DL, F, I, EA, JA, VK ... answered with ZERO parks, and some
 * old codes are now other countries (PA = Panama, SM = San Marino).
 *
 * Run: node test/pota-parks-db-test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('../lib/pota-parks-db');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const PROGRAMS = require('./fixtures/pota-programs.json').programs;
const BY = Object.fromEntries(PROGRAMS.map((p) => [p.prefix, p.name]));

test('every program in the callsign table is a live POTA program', () => {
  const bad = [...new Set(Object.values(P.PREFIX_TO_PROGRAM))].filter((c) => !BY[c]);
  assert.deepStrictEqual(bad, []);
});
test('callsigns land in the right country (names from POTA\'s own list)', () => {
  const cases = {
    OG3E: 'Finland', OH2BH: 'Finland', OH0Z: 'Åland Islands', K3SBP: 'United States of America', KP4ABC: 'Puerto Rico',
    VE3ABC: 'Canada', G4BFG: 'United Kingdom of Great Britain and Northern Ireland', DL1ABC: 'Germany', PA3ABC: 'Netherlands',
    SM5ABC: 'Sweden', LA1ABC: 'Norway', F4ABC: 'France', I2ABC: 'Italy', EA4ABC: 'Spain', JA1ABC: 'Japan', VK2ABC: 'Australia',
    ZL1ABC: 'New Zealand', HB9CCS: 'Switzerland', ON4ABC: 'Belgium', OZ1ABC: 'Denmark', 'W1AW/7': 'United States of America',
  };
  for (const [call, name] of Object.entries(cases)) assert.strictEqual(BY[P.callsignToProgram(call)], name, call);
});
test('none of the old ITU-style codes survives as a value', () => {
  const values = new Set(Object.values(P.PREFIX_TO_PROGRAM));
  for (const old of ['OH', 'DL', 'F', 'I', 'EA', 'PA', 'SM', 'LA', 'JA', 'VK', 'ZL', 'OZ', 'ON', 'HB']) assert.ok(!values.has(old), old);
  assert.notStrictEqual(P.callsignToProgram('PA3ABC'), 'PA', 'PA is Panama now');
  assert.notStrictEqual(P.callsignToProgram('SM5ABC'), 'SM', 'SM is San Marino now');
});
test('a reference names its own program', () => {
  assert.strictEqual(P.programOfRef('FI-0003'), 'FI');
  assert.strictEqual(P.programOfRef(' us-1234 '), 'US');
  assert.strictEqual(P.programOfRef('GB-0001'), 'GB');
  assert.strictEqual(P.programOfRef('hello'), '');
  assert.strictEqual(P.programOfRef(''), '');
});
test('K-TEST and US-TEST are the practice park, not a lookup', () => {
  assert.ok(P.isTestRef('K-TEST') && P.isTestRef('us-test'));
  assert.ok(!P.isTestRef('FI-0003') && !P.isTestRef('TEST'));
});

const MAIN = readSrc(path.join(__dirname, '..', 'main.js'));
test('get-park answers the practice park and loads the reference\'s own country first', () => {
  const at = MAIN.indexOf("ipcMain.handle('get-park'");
  const body = MAIN.slice(at, at + 600);
  assert.ok(/ParksDb\.isTestRef\(ref\)/.test(body) && /name: 'POTA test park'/.test(body));
  assert.ok(/await ensureParksForRef\(ref\);[\s\S]*return parkInfoFor\(ref\);/.test(body));
});
test('another country\'s list loads BESIDE the home list, never replacing it', () => {
  assert.ok(/loadParksDbForProgram\(program, \{ home: false \}\)/.test(MAIN));
  const at = MAIN.indexOf('function parkInfoFor(');
  assert.ok(/parksListForRef\(ref\)/.test(MAIN.slice(at, at + 500)), 'parkInfoFor consults the reference\'s list');
});
test('an empty park list is never cached or trusted', () => {
  assert.ok(/cached\.parks\.length && !isCacheStale/.test(MAIN));
  assert.ok(/if \(!Array\.isArray\(parks\) \|\| !parks\.length\) throw/.test(MAIN));
});
test('search with a foreign prefix searches that country', () => {
  const at = MAIN.indexOf("ipcMain.handle('search-parks'");
  assert.ok(/parksListForRef\(m\[1\] \+ '-0'\)/.test(MAIN.slice(at, at + 600)));
});

console.log(`\nPOTA parks DB: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
