// test/operating-entity-test.js — country by prefix (jgedmond, tactical_index
// 2026-10/11): KL7 and KH8 calls logged as United States, and W1AW/KL7 shown
// as CT. Two causes: the log took QRZ's MAILING country (<country>) instead of
// its DXCC entity (<land>), and main.js resolved a portable call by its
// prefix alone (W1AW/KL7 -> United States -> QRZ's CT).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadCtyDat, resolveCallsign, resolveOperatingCall } = require('../lib/cty');
const db = loadCtyDat(path.join(__dirname, '..', 'assets', 'cty.dat'));
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const qrzSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'qrz.js'), 'utf8');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
// main.js's resolveCallsign, rebuilt from its source the way main defines it.
const src = main.slice(main.indexOf('function resolveCallsign(call, db) {'), main.indexOf('\n}\n', main.indexOf('function resolveCallsign(call, db) {')) + 2);
const mainResolve = new Function('resolveOperatingCall', 'resolveCallsignByPrefix', src + '; return resolveCallsign;')(resolveOperatingCall, resolveCallsign);

console.log('operating entity:');
t('main.js resolves where a station operates: W1AW/KL7 is Alaska, KH8/W1AW American Samoa', () => {
  assert.strictEqual(mainResolve('W1AW/KL7', db).name, 'Alaska');
  assert.strictEqual(mainResolve('KH8/W1AW', db).name, 'American Samoa');
  assert.strictEqual(mainResolve('6W/IK2HKT', db).name, 'Senegal');
});
t('a plain call resolves exactly as before', () => {
  for (const c of ['W1AW', 'KL7RA', 'KH8B', 'K3SBP', 'W1AW/4', 'K3SBP/P']) {
    assert.strictEqual((mainResolve(c, db) || {}).name, (resolveOperatingCall(c, db).entity || {}).name, c);
  }
  assert.strictEqual(mainResolve('KL7RA', db).name, resolveCallsign('KL7RA', db).name);
});
t('every lookup in main.js goes through it (the module function is imported under another name)', () => {
  assert.ok(main.includes("resolveCallsign: resolveCallsignByPrefix, resolveOperatingCall"));
});
t('QRZ: the DXCC entity (<land>) is read and logged ahead of the mailing country', () => {
  assert.ok(qrzSrc.includes("land: extractTag(xml, 'land') || '',"));
  assert.ok(main.includes("country: q.land || q.country || '',"));
});
console.log('\noperating entity: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
