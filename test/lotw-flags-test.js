#!/usr/bin/env node
'use strict';
// LoTW per-QSO sent-flag stamping. The stderr sample is verbatim from the
// first real K3SBP upload (2026-08-13). Run: node test/lotw-flags-test.js
const assert = require('assert');
const { lotwKey, parseTqslSkips, stampLotwSent } = require('../lib/lotw-flags');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const STDERR_SAMPLE = `TQSL Version 2.8.6 [v2.8.6]
Signing using Callsign K3SBP, DXCC Entity UNITED STATES OF AMERICA

Callsign Certificate does not match QSO details
The Callsign Certificate 'Callsign' has value 'K3SBP' while QSO has 'WB6ACU' on line 8
CALL: CR2T
FREQ: 7.051800
MODE: CW
QSO_DATE: 20260221
TIME_ON: 033800
BAND: 40m
OPERATOR: WB6ACU

Station Location does not match QSO details
The Station Location 'Gridsquare' has value 'FN20JB' while QSO has 'FN20JC' on line 40
CALL: N0AD
FREQ: 14.025000
MODE: CW
QSO_DATE: 20260228
TIME_ON: 164929
BAND: 20m
OPERATOR: K3SBP
MY_GRIDSQUARE: FN20jc
STATION_CALLSIGN: K3SBP

Invalid contact - QSO does not specify a Callsign on line 1594
BAND: 20m
MODE: CW
OPERATOR: K3SBP

Attempting to upload 499 QSOs
Final Status: Success(0)`;

test('parseTqslSkips: reads the KEY: blocks, ignores no-callsign complaints', () => {
  const skips = parseTqslSkips(STDERR_SAMPLE);
  assert.strictEqual(skips.length, 2);
  assert.strictEqual(skips[0].CALL, 'CR2T');
  assert.strictEqual(skips[0].TIME_ON, '033800');
  assert.strictEqual(skips[1].CALL, 'N0AD');
  assert.strictEqual(skips[1].QSO_DATE, '20260228');
  assert.deepStrictEqual(parseTqslSkips(''), []);
});

test('lotwKey: 4- vs 6-digit TIME_ON match; case-insensitive call', () => {
  assert.strictEqual(lotwKey('n0ad', '20260228', '164929'), lotwKey('N0AD', '20260228', '1649'));
  assert.notStrictEqual(lotwKey('N0AD', '20260228', '1649'), lotwKey('N0AD', '20260228', '1650'));
});

test('stampLotwSent: stamps snapshot QSOs, spares skips / new / already-stamped', () => {
  const qsos = [
    { CALL: 'KP2B', QSO_DATE: '20260221', TIME_ON: '030600' },            // sent -> stamp
    { CALL: 'CR2T', QSO_DATE: '20260221', TIME_ON: '033800' },            // tqsl-skipped
    { CALL: 'N0AD', QSO_DATE: '20260228', TIME_ON: '164929' },            // tqsl-skipped
    { CALL: 'W1AW', QSO_DATE: '20260301', TIME_ON: '1200',
      LOTW_QSL_SENT: 'Y', LOTW_QSLSDATE: '20260302' },                     // already stamped
    { CALL: 'K1NEW', QSO_DATE: '20260814', TIME_ON: '235959' },           // logged mid-upload
  ];
  const snapshot = qsos.slice(0, 4); // K1NEW arrived after the snapshot
  const res = stampLotwSent(qsos, snapshot, parseTqslSkips(STDERR_SAMPLE), '20260814');
  assert.strictEqual(res.stamped, 1);
  assert.strictEqual(res.alreadyStamped, 1);
  assert.strictEqual(qsos[0].LOTW_QSL_SENT, 'Y');
  assert.strictEqual(qsos[0].LOTW_QSLSDATE, '20260814');
  assert.strictEqual(qsos[1].LOTW_QSL_SENT, undefined);
  assert.strictEqual(qsos[2].LOTW_QSL_SENT, undefined);
  assert.strictEqual(qsos[3].LOTW_QSLSDATE, '20260302'); // untouched
  assert.strictEqual(qsos[4].LOTW_QSL_SENT, undefined);
});

// GitHub #92: "N skipped (see log)" and no log said why. Each skip carries
// TQSL's headline and its specific line.
test('each skip carries TQSL\'s reason and detail', () => {
  const skips = parseTqslSkips(STDERR_SAMPLE);
  const cr2t = skips.find(s => s.CALL === 'CR2T');
  assert.strictEqual(cr2t.reason, 'Callsign Certificate does not match QSO details');
  assert.ok(/has value 'K3SBP' while QSO has 'WB6ACU'/.test(cr2t.detail));
  const n0ad = skips.find(s => s.CALL === 'N0AD');
  assert.strictEqual(n0ad.reason, 'Station Location does not match QSO details');
  assert.ok(/'Gridsquare' has value 'FN20JB'/.test(n0ad.detail));
  // The TQSL banner above the first block is not mistaken for a reason.
  assert.ok(!/TQSL Version|Signing using/.test(cr2t.reason + cr2t.detail));
});

// K3SBP 2026-10-17: TQSL listed every duplicate as "Previously Signed QSO
// detected on line N"; they were treated as failures, left unmarked, and
// each became its own "reason" because the line number differs.
test('previously signed QSOs are already at LoTW, not skips', () => {
  const { summarizeSkips, isAlreadyAtLotw, stampLotwSent } = require('../lib/lotw-flags');
  const skips = [
    { reason: 'Previously Signed QSO detected on line 6', CALL: 'W1AW', QSO_DATE: '20261001', TIME_ON: '1200' },
    { reason: 'Previously Signed QSO detected on line 8', CALL: 'K1ABC', QSO_DATE: '20261001', TIME_ON: '1210' },
    { reason: 'Invalid MODE (DIGU) on line 10', CALL: 'KM4ACK', QSO_DATE: '20261015', TIME_ON: '2039' },
  ];
  assert.ok(isAlreadyAtLotw(skips[0]));
  const sum = summarizeSkips(skips);
  assert.strictEqual(sum.dupes.length, 2);
  assert.strictEqual(sum.real.length, 1);
  const qsos = skips.map((k) => ({ CALL: k.CALL, QSO_DATE: k.QSO_DATE, TIME_ON: k.TIME_ON }));
  const stats = stampLotwSent(qsos, qsos, sum.real, '20261017');
  assert.strictEqual(stats.stamped, 2, 'the two LoTW already has are stamped');
  assert.strictEqual(qsos[2].LOTW_QSL_SENT, undefined, 'the real skip stays unmarked');
});

test('skips group by reason and detail without line numbers', () => {
  const { summarizeSkips } = require('../lib/lotw-flags');
  const loc = (line, grid) => ({ reason: 'Station Location does not match QSO details', detail: `The Station Location 'Gridsquare' has value 'FN20JB' while QSO has '${grid}' on line ${line}`, CALL: 'X' + line, QSO_DATE: '1' });
  const g = summarizeSkips([loc(40, 'FN20JC'), loc(42, 'FN20JC'), loc(44, 'FN12RK'), { reason: 'Invalid BAND () on line 36', CALL: 'Y', QSO_DATE: '1' }]).groups;
  assert.strictEqual(g.length, 3);
  assert.strictEqual(g[0].n, 2);
  assert.ok(/FN20JC'$/.test(g[0].text), g[0].text);
  assert.ok(!g.some((x) => /on line/.test(x.text)));
});

test('main.js reports grouped real skips and the true total', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(src.includes('const skips = skipSummary.real;'));
  assert.ok(src.includes('r.skippedTotal = skips.length;'));
});

console.log(`\nLoTW flags: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
