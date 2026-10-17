#!/usr/bin/env node
'use strict';
// CW text from a device keeps {call} etc. unexpanded (the mobile app never
// expanded them); main.js fills them (N4RDX 2026-10-11).
// Run: node test/cw-remote-expand-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const X = require('../lib/cw-remote-expand');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('text without placeholders is left alone', () => {
  assert.strictEqual(X.hasPlaceholders('CQ CQ DE N4RDX K'), false);
  assert.strictEqual(X.hasPlaceholders('{call} 599'), true);
  assert.strictEqual(X.hasPlaceholders('TU {OP_FIRSTNAME}'), true);
});

test('{call}, {op_firstname} and {state} are filled', () => {
  const r = X.expandRemoteCw('{call} TNX {op_firstname} UR 599 {state} TU', { call: 'k3sbp', opFirstname: 'Casey', state: 'PA' });
  assert.strictEqual(r.text, 'K3SBP TNX Casey UR 599 PA TU');
  assert.strictEqual(r.missingCall, false);
});

test('no name falls back to OM, as on the desktop; empty state leaves no double space', () => {
  assert.strictEqual(X.expandRemoteCw('TNX {op_firstname} {state} 73', { call: 'K3SBP' }).text, 'TNX OM 73');
});

test('a {call} with nothing to fill is removed and reported, never keyed as braces', () => {
  const r = X.expandRemoteCw('{call} 599 TU', {});
  assert.strictEqual(r.text, '599 TU');
  assert.strictEqual(r.missingCall, true);
});

test('main.js expands device CW text before keying it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(src.includes('sendCwTextToRadio(expandRemoteCwText(text), { live: !!live, fromRemote: true });'));
  assert.ok(src.includes('typedCalls.current() || (tuned && tuned.callsign)'));
});

console.log(`\nCW device text expansion: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
