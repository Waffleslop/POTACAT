#!/usr/bin/env node
'use strict';
// Review of the merged 1.13.11 chain, log integrity:
//  1. The N3FJP pull mirrored every confirmation field on an N3FJP-imported
//     contact and '' meant delete, so a Y set by "Update from LoTW" or ticked
//     in the Logbook vanished at the next pull. Now additive, with one
//     correction: a paper QSL_RCVD/SENT = Y is cleared when N3FJP names a
//     known service (L, E, Q, B) for that side (the old mis-mapping).
//  2. eQSL and ClubLog confirmations counted as unconfirmed in WAS/DXCC and
//     confirmed-only exports. One rule now: lib/adif.js isConfirmedRecord.
// Run: node test/n3fjp-confirm-keep-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../lib/n3fjp-pull');
const Adif = require('../lib/adif');
const { readSrc } = require('./_src');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const base = { fldCall: 'K1ABC', fldDateStr: '2026/10/25', fldTimeOnStr: '12:00', fldBand: '20', fldMode: 'FT8' };
const N3 = { CALL: 'K1ABC', APP_POTACAT_IMPORTED_FROM: 'N3FJP' };

test('a LoTW confirmation POTACAT set on an N3FJP contact survives a pull where N3FJP has none', () => {
  const have = { ...N3, LOTW_QSL_RCVD: 'Y', LOTW_QSL_SENT: 'Y' };
  assert.strictEqual(P.confirmationPatch(have, P.toAdifRecord(base)), null);
});

test('a paper QSL ticked in the Logbook survives a pull where N3FJP has no letter', () => {
  const have = { ...N3, QSL_RCVD: 'Y', QSL_SENT: 'Y' };
  assert.strictEqual(P.confirmationPatch(have, P.toAdifRecord(base)), null);
});

test('the one correction: a paper Y is cleared when N3FJP names a known service for that side', () => {
  const have = { ...N3, QSL_RCVD: 'Y' };
  const p = P.confirmationPatch(have, P.toAdifRecord({ ...base, fldQSLR: 'Y', fldQSLConfByR: 'L' }));
  assert.deepStrictEqual(p, { QSL_RCVD: '', LOTW_QSL_RCVD: 'Y', APP_N3FJP_QSL_CONF_BY_R: 'L' });
  const unknown = P.confirmationPatch(have, P.toAdifRecord({ ...base, fldQSLR: 'Y', fldQSLConfByR: 'P' }));
  assert.ok(!unknown || !('QSL_RCVD' in unknown), 'an unknown letter may be the card: kept');
  const own = P.confirmationPatch({ CALL: 'K1ABC', QSL_RCVD: 'Y' }, P.toAdifRecord({ ...base, fldQSLR: 'Y', fldQSLConfByR: 'L' }));
  assert.ok(!('QSL_RCVD' in own), 'a POTACAT contact\'s paper card is never touched');
});

test('one confirmed rule: paper, LoTW, eQSL, and N3FJP\'s ClubLog letter', () => {
  const c = Adif.isConfirmedRecord;
  assert.strictEqual(c({ QSL_RCVD: 'Y' }), true);
  assert.strictEqual(c({ LOTW_QSL_RCVD: 'y' }), true);
  assert.strictEqual(c({ EQSL_QSL_RCVD: 'Y' }), true);
  assert.strictEqual(c({ APP_N3FJP_QSL_CONF_BY_R: 'B' }), true);
  assert.strictEqual(c({ APP_N3FJP_QSL_CONF_BY_S: 'B', CLUBLOG_QSO_UPLOAD_STATUS: 'Y' }), false, 'uploaded is not confirmed');
  assert.strictEqual(c({ QSL_SENT: 'Y', LOTW_QSL_SENT: 'Y' }), false);
});

test('the worked roster and the confirmed-only reader count eQSL and ClubLog confirmations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'confirm-'));
  const file = path.join(dir, 'log.adi');
  const rec = (call, extra) => `<CALL:${call.length}>${call}<QSO_DATE:8>20261025<TIME_ON:4>1200<BAND:3>20m<MODE:3>FT8<STATE:2>NJ${extra}<EOR>\n`;
  fs.writeFileSync(file, '<EOH>\n' + rec('K1AAA', '<EQSL_QSL_RCVD:1>Y') + rec('K1BBB', '<APP_N3FJP_QSL_CONF_BY_R:1>B') + rec('K1CCC', ''));
  const worked = Adif.parseWorkedQsos(file);
  const get = (call) => (worked.get ? worked.get(call) : worked[call])[0];
  assert.strictEqual(get('K1AAA').confirmed, true);
  assert.strictEqual(get('K1BBB').confirmed, true);
  assert.ok(!get('K1CCC').confirmed);
  const confirmed = Adif.parseAdifFile(file).map((q) => q.call || q.CALL);
  assert.strictEqual(confirmed.length, 2);
});

test('a pull with no confirmation in it skips the whole-log pass, and could not have changed anything', () => {
  assert.strictEqual(P.mayChangeConfirmations([P.toAdifRecord(base)]), false);
  assert.strictEqual(P.mayChangeConfirmations([P.toAdifRecord({ ...base, fldQSLR: 'Y', fldQSLConfByR: 'L' })]), true);
  // The skip is safe because the patch is additive: with no confirmation
  // field incoming, no existing record of any kind gets a patch.
  const plain = P.toAdifRecord(base);
  for (const have of [{ ...N3, QSL_RCVD: 'Y' }, { ...N3, LOTW_QSL_RCVD: 'Y' }, { CALL: 'K1ABC', QSL_SENT: 'Y' }, { ...N3 }]) {
    assert.strictEqual(P.confirmationPatch(have, plain), null, JSON.stringify(have));
  }
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  assert.ok(/function n3fjpUpdateConfirmations\(records\) \{[\s\S]{0,200}if \(!N3fjpPull\.mayChangeConfirmations\(records\)\) return 0;/.test(main));
});

console.log(`\nN3FJP keeps confirmations; one confirmed rule: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
