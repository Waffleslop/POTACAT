// A log from another program that names the park only as POTA_REF (QLog):
// import fills SIG / SIG_INFO, and the Logbook shows POTA_REF for logs
// imported before that (KC9FOZ, 2026-10-22: imported parks showed blank).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fillSigFromProgramRefs } = require('../lib/adif-normalize');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

check('QLog: POTA_REF alone becomes SIG POTA / SIG_INFO, and POTA_REF stays', () => {
  const r = fillSigFromProgramRefs({ CALL: 'K3SBP', POTA_REF: 'us-1234' });
  assert.deepStrictEqual(r, { CALL: 'K3SBP', POTA_REF: 'us-1234', SIG: 'POTA', SIG_INFO: 'US-1234' });
});
check('the activator side too: MY_POTA_REF fills MY_SIG / MY_SIG_INFO', () => {
  const r = fillSigFromProgramRefs({ CALL: 'W1AW', MY_POTA_REF: 'US-0001' });
  assert.strictEqual(r.MY_SIG, 'POTA');
  assert.strictEqual(r.MY_SIG_INFO, 'US-0001');
});
check('a filled SIG_INFO is never touched, and an unchanged record is the same object', () => {
  const rec = { CALL: 'K3SBP', SIG: 'POTA', SIG_INFO: 'US-1', POTA_REF: 'US-2' };
  assert.strictEqual(fillSigFromProgramRefs(rec), rec);
  const plain = { CALL: 'K3SBP' };
  assert.strictEqual(fillSigFromProgramRefs(plain), plain);
});
check('never moves a record to another program', () => {
  const rec = { CALL: 'K3SBP', SIG: 'WWBOTA', POTA_REF: 'US-1' };
  assert.strictEqual(fillSigFromProgramRefs(rec), rec);
});
check('SOTA_REF and WWFF_REF are read the same way', () => {
  assert.strictEqual(fillSigFromProgramRefs({ SOTA_REF: 'W4C/CM-001' }).SIG, 'SOTA');
  assert.strictEqual(fillSigFromProgramRefs({ WWFF_REF: 'KFF-0001' }).SIG_INFO, 'KFF-0001');
});
check('every import goes through it, and the Logbook falls back to POTA_REF', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const fn = main.slice(main.indexOf('function importQsoRecords('), main.indexOf('function importQsoRecords(') + 700);
  assert.ok(/records = records\.map\(fillSigFromProgramRefs\);[\s\S]*planImport\(existing, records\)/.test(fn));
  const pop = fs.readFileSync(path.join(ROOT, 'renderer/qso-popout.js'), 'utf8');
  assert.ok(/label: 'Park'[^\n]*get: \(q\) => q\.SIG_INFO \|\| q\.POTA_REF \|\| ''/.test(pop));
  assert.ok(/q\.SIG_INFO \|\| q\.POTA_REF, q\.COMMENT/.test(pop), 'search finds it too');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
