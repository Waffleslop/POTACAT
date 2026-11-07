'use strict';
const { readSrc } = require('./_src');
// GitHub #191: a hunter contact with an activator spotted on BOTH POTA and
// SOTA never reached SOTAdata. The Log QSO window picks POTA as the primary
// program (sig=POTA, sigInfo=park) and the summit rides along in `sotaRef`;
// the upload gate in main.js only fired on sig === 'SOTA', silently.
// lib/sota.js sotaChaseSummits(q) is now the one definition of which summits
// a saved record chases. Run: node test/sota-chase-test.js
const assert = require('assert');
const path = require('path');
const { sotaChaseSummits } = require('../lib/sota');
const { expandContact } = require('../lib/qso-expand');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

const ROOT = path.join(__dirname, '..');

test('a POTA-primary record carrying sotaRef chases that summit (#191)', () => {
  assert.deepStrictEqual(
    sotaChaseSummits({ sig: 'POTA', sigInfo: 'US-1234', sotaRef: 'W2/GC-001' }),
    ['W2/GC-001']);
});

test('sotaRef is split, trimmed, upper-cased and de-duplicated', () => {
  assert.deepStrictEqual(
    sotaChaseSummits({ sig: 'POTA', sigInfo: 'US-1234', sotaRef: ' w2/gc-001, W2/GC-002 ,w2/gc-001' }),
    ['W2/GC-001', 'W2/GC-002']);
});

test('the second record of a two-park contact (skipLogbookForward) chases nothing: one QSO, one chase', () => {
  assert.deepStrictEqual(
    sotaChaseSummits({ sig: 'POTA', sigInfo: 'US-5678', sotaRef: 'W2/GC-001', skipLogbookForward: true }),
    []);
});

test('a sig=SOTA record chases its sigInfo, skipLogbookForward or not (unchanged behaviour)', () => {
  assert.deepStrictEqual(sotaChaseSummits({ sig: 'SOTA', sigInfo: 'W2/GC-001' }), ['W2/GC-001']);
  assert.deepStrictEqual(
    sotaChaseSummits({ sig: 'SOTA', sigInfo: 'w2/gc-001', skipLogbookForward: true }),
    ['W2/GC-001']);
});

test('a plain POTA record, or no record, chases nothing', () => {
  assert.deepStrictEqual(sotaChaseSummits({ sig: 'POTA', sigInfo: 'US-1234' }), []);
  assert.deepStrictEqual(sotaChaseSummits({ sig: 'POTA', sigInfo: 'US-1234', sotaRef: '' }), []);
  assert.deepStrictEqual(sotaChaseSummits({ sig: 'SOTA', sigInfo: '' }), []);
  assert.deepStrictEqual(sotaChaseSummits({}), []);
  assert.deepStrictEqual(sotaChaseSummits(null), []);
});

test('end to end: a hunter logs an activator at two parks and a summit -> exactly one chase', () => {
  // The Log QSO window's shape for a POTA+SOTA spot: POTA primary, both
  // parks in sigInfo, the summit in sotaRef (renderer/app.js Save).
  const entry = {
    callsign: 'N2ETH', frequency: '14285', mode: 'SSB', band: '20m',
    sig: 'POTA', sigInfo: 'US-1234,US-5678', potaRef: 'US-1234', sotaRef: 'W2/GC-001',
  };
  const records = expandContact(entry, { now: Date.UTC(2026, 10, 7, 15, 0) });
  assert.strictEqual(records.length, 2, 'one record per park');
  assert.ok(records.every((r) => r.sotaRef === 'W2/GC-001'), 'the summit rides on every POTA record (ADIF SOTA_REF)');
  const chased = records.flatMap((r) => sotaChaseSummits(r));
  assert.deepStrictEqual(chased, ['W2/GC-001'], 'uploaded once, from the forwarded record only');
});

test('main.js: the sig === SOTA gate is gone; the upload loops over sotaChaseSummits', () => {
  const src = readSrc(path.join(ROOT, 'main.js'));
  assert.ok(!src.includes("qsoData.sig === 'SOTA' && qsoData.sigInfo"),
    'the old gate skipped every POTA-primary record that carried a summit');
  assert.ok(src.includes('sotaChaseSummits(qsoData)'), 'saveQsoRecord asks lib/sota.js which summits to chase');
  assert.ok(/require\('\.\/lib\/sota'\)/.test(src) && /sotaChaseSummits[^\n]*require\('\.\/lib\/sota'\)/.test(src),
    'sotaChaseSummits comes from lib/sota.js');
});

test('lib/sota.js: uploadChase takes the summit code; sigInfo stays the fallback', () => {
  const src = readSrc(path.join(ROOT, 'lib', 'sota.js'));
  assert.ok(/async uploadChase\(qso, summit\)/.test(src), 'uploadChase(qso, summit)');
  assert.ok(src.includes('summit || qso.sigInfo'), 'a sig=SOTA record still uploads with no summit argument');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
