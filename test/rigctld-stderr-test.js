#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// lib/rigctld-stderr.js — what rigctld's stderr means to an operator.
//
// K5AWJ's Test Connection (FT-710 over rigctld, 2026-09-22) raced the dying
// live rigctld for COM3 and rigctld printed, in order: "serial port COM3 is
// already open", "Access denied", and finally "COM3 No such file or
// directory". The last line was what he saw. His COM port existed and his
// radio link was fine.
//
// Run:  node test/rigctld-stderr-test.js

const assert = require('assert');
const { explainRigctldFailure } = require('../lib/rigctld-stderr');

let pass = 0; let fail = 0; const failures = [];
function check(msg, fn) {
  try { fn(); pass++; } catch (err) { fail++; failures.push(msg); console.log(`  ✗ ${msg}\n      ${err.message}`); }
}

const K5AWJ = [
  "rig_set_conf: rig_pathname='COM3'",
  'rig.c(1050):rig_open entered',
  'serial_open: serial port COM3 is already open',
  'rig.c(1284):rig_open returning2(-22) Access denied',
  'Access denied',
  ' COM3 No such file or directory ',
  'Backend version: 20241118.7, Status: Stable',
].join('\n');

check('the port-in-use story wins over the misleading last line', () => {
  const s = explainRigctldFailure(K5AWJ, 'COM3 No such file or directory');
  assert.ok(/COM3 is in use/.test(s), s);
  assert.ok(/previous rig link/.test(s), 'must mention the release race');
  assert.ok(!/does not exist/.test(s));
});

check('a genuinely missing port is named as missing', () => {
  const s = explainRigctldFailure("rig_set_conf: rig_pathname='COM9'\nserial_open: Unable to open COM9 - No such file or directory", 'x');
  assert.ok(/COM9 does not exist/.test(s), s);
});

check('a silent radio points at baud rate and power', () => {
  const s = explainRigctldFailure("rig_pathname='COM3'\nread_string: Timed out", 'x');
  assert.ok(/did not answer/.test(s) && /baud/.test(s), s);
});

check('nothing recognised → the fallback, else the last non-empty line', () => {
  assert.strictEqual(explainRigctldFailure('something odd', 'fallback text'), 'fallback text');
  assert.strictEqual(explainRigctldFailure('line one\nline two\n\n', ''), 'line two');
});

console.log('\n' + '='.repeat(52));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
console.log('All tests passed.');
