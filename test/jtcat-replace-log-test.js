#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
/**
 * Clicking another station abandons the running QSO. It is logged only if it
 * was already complete (their R-report in, our RR73 out). level_death and
 * jgedmond (Discord, 2026-10-31 to 11-01): JTCAT logged the previous station
 * "even though we did not finish a qso at all", every time, including when
 * the click came from GridTracker. The old test was "we hold their report",
 * which on the reply side is true the moment we send R+report.
 *
 * Run: node test/jtcat-replace-log-test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { replaceLogsQso } = require('../lib/jtcat-state-machine');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const q = (o) => Object.assign({ call: 'W1AW', mode: 'reply', phase: 'reply', report: null, sentReport: null }, o);

test('reply side, we sent R+report, no RR73 yet: NOT logged (the reported bug)', () => {
  assert.strictEqual(replaceLogsQso(q({ phase: 'r+report', report: '-10', sentReport: '-12' }), 'K1ABC'), false);
});
test('reply side, only our grid sent: not logged', () => {
  assert.strictEqual(replaceLogsQso(q({ phase: 'reply' }), 'K1ABC'), false);
});
test('CQ side, we sent their report, waiting for R: not logged', () => {
  assert.strictEqual(replaceLogsQso(q({ mode: 'cq', phase: 'cq-report', sentReport: '-05' }), 'K1ABC'), false);
});
test('CQ side, their R-report in and our RR73 out, not yet logged: logged', () => {
  assert.strictEqual(replaceLogsQso(q({ mode: 'cq', phase: 'cq-rr73', report: '-08', sentReport: '-05' }), 'K1ABC'), true);
});
test('an already logged QSO is never logged again', () => {
  assert.strictEqual(replaceLogsQso(q({ mode: 'cq', phase: 'cq-rr73', report: '-08', _logged: true }), 'K1ABC'), false);
});
test('clicking the same station again is not an abandonment', () => {
  assert.strictEqual(replaceLogsQso(q({ mode: 'cq', phase: 'cq-rr73', report: '-08' }), 'w1aw'), false);
});
test('no QSO, or no call: nothing to log', () => {
  assert.strictEqual(replaceLogsQso(null, 'K1ABC'), false);
  assert.strictEqual(replaceLogsQso({ phase: 'cq-rr73' }, 'K1ABC'), false);
});

const MAIN = readSrc(path.join(__dirname, '..', 'main.js'));
test('both reply paths (window and ECHOCAT/phone) use the shared rule', () => {
  assert.ok(/_jtcatStateMachine\.replaceLogsQso\(popoutJtcatQso, data\.call\)/.test(MAIN), 'window path');
  assert.ok(/_jtcatStateMachine\.replaceLogsQso\(remoteJtcatQso, call\)/.test(MAIN), 'ECHOCAT path');
});
test('the old "holds their report = log it" test is gone', () => {
  assert.ok(!/Replacing active QSO with .* — auto-logging/.test(MAIN));
  assert.ok(!/JtcatQso\.report &&\s*\n\s*\w+JtcatQso\.phase !== '73'/.test(MAIN));
});

console.log(`\nJTCAT replace-log: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
