#!/usr/bin/env node
'use strict';
// The JTCAT window's QSO steps show the first answer as it really goes out:
// a report with Faster contacts (skip Tx1), not the grid.
// Run: node test/jtcat-skip-tx1-steps-test.js
const assert = require('assert');
const path = require('path');
const vm = require('vm');
const { readSrc } = require('./_src');
const pop = readSrc(path.join(__dirname, '..', 'renderer/jtcat-popout.js'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
function label(skipTx1, q) {
  const i = pop.indexOf('function replyStepLabel(q) {');
  assert.ok(i >= 0, 'replyStepLabel');
  const body = pop.slice(i, pop.indexOf('\n  }\n', i) + 4);
  const ctx = { skipTx1 };
  vm.createContext(ctx);
  vm.runInContext(body + '\nthis.f = replyStepLabel;', ctx);
  return ctx.f({ call: 'SA7BXU', myCall: 'DA2PK', myGrid: 'JO31', ...q });
}

test('while the first answer is sent, the step shows main\'s txMsg (report with skip Tx1)', () => {
  assert.strictEqual(label(true, { phase: 'reply', txMsg: 'SA7BXU DA2PK -21', sentReport: '-21' }), 'SA7BXU DA2PK -21');
});
test('after it, skip Tx1 keeps the report we sent', () => {
  assert.strictEqual(label(true, { phase: 'r+report', sentReport: '-21' }), 'SA7BXU DA2PK -21');
});
test('without skip Tx1 it is the grid, as before', () => {
  assert.strictEqual(label(false, { phase: 'r+report', sentReport: '-21' }), 'SA7BXU DA2PK JO31');
  assert.strictEqual(label(false, { phase: 'reply', txMsg: 'SA7BXU DA2PK JO31' }), 'SA7BXU DA2PK JO31');
});
test('the reply steps use it', () => {
  assert.ok(/\{ key: 'reply',\s+dir: 'tx', label: replyStepLabel \},/.test(pop));
});

console.log(`\nJTCAT skip-Tx1 steps: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
