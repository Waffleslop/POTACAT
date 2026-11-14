#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
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
  const src = readSrc(path.join(__dirname, '..', 'main.js'));
  assert.ok(src.includes('sendCwTextToRadio(expandRemoteCwText(text), { live: !!live, fromRemote: true });'));
  assert.ok(src.includes('typedCalls.current() || (tuned && tuned.callsign)'));
});

// ── #524: the name follows the call being sent ─────────────────────────────
// Two spots on one frequency: the operator tuned Michael's spot, then worked
// Joe (typed or selected). {call} said JOE and {op_firstname} said Michael.
const JOE_AND_MICHAEL = { K1JOE: { name: 'Joe', state: 'PA' }, W8MIKE: { name: 'Michael', state: 'OH' } };
const baseCall = (c) => String(c || '').toUpperCase().split('/').sort((a, b) => b.length - a.length)[0];

test('#524: expandForCall takes name and state from the same callsign as {call}', () => {
  assert.strictEqual(X.expandForCall('{call} TNX {op_firstname} {state} TU', 'k1joe', JOE_AND_MICHAEL, baseCall).text, 'K1JOE TNX Joe PA TU');
  assert.strictEqual(X.expandForCall('{call} TNX {op_firstname}', 'K1JOE/P', JOE_AND_MICHAEL, baseCall).text, 'K1JOE/P TNX Joe');
});

test('#524: a call with no looked-up name gets OM, never another station\'s name', () => {
  assert.strictEqual(X.expandForCall('{call} TNX {op_firstname} {state} TU', 'N0NEW', JOE_AND_MICHAEL, baseCall).text, 'N0NEW TNX OM TU');
  assert.strictEqual(X.expandForCall('TNX {op_firstname}', '', JOE_AND_MICHAEL, baseCall).text, 'TNX OM');
  assert.strictEqual(X.expandForCall('TNX {op_firstname}', 'constructor', {}, baseCall).text, 'TNX OM');
});

// Run ECHOCAT Web's own sendCwText, cut from renderer/remote.js, with the
// tuned spot (Michael) differing from the call being worked (Joe).
const vm = require('vm');
const REMOTE_JS = readSrc(path.join(__dirname, '..', 'renderer', 'remote.js'));
function runWebSendCwText(text, ctxOver) {
  const start = REMOTE_JS.indexOf('  function sendCwText(text) {');
  assert.ok(start >= 0, 'remote.js has sendCwText');
  const end = REMOTE_JS.indexOf('\n  }\n', start);
  const src = REMOTE_JS.slice(start, end + 4);
  const sent = [];
  const ctx = Object.assign({
    ws: { readyState: 1, send: (s) => sent.push(JSON.parse(s)) },
    WebSocket: { OPEN: 1 },
    macroCallsign: () => 'K1JOE',
    tunedCallsign: 'W8MIKE', tunedOpName: 'Michael', tunedState: 'OH',
    qrzOpByCall: JOE_AND_MICHAEL,
    CwRemoteExpand: X,
    JtcatParser: { baseCall },
    requestQrzOp: () => {},
    playCwTextSidetone: () => {},
  }, ctxOver || {});
  vm.createContext(ctx);
  vm.runInContext(src + '\nsendCwText(' + JSON.stringify(text) + ');', ctx);
  return sent.filter((m) => m.type === 'cw-text').map((m) => m.text);
}

test('#524: ECHOCAT Web keys the worked call\'s name, not the tuned spot\'s', () => {
  assert.deepStrictEqual(runWebSendCwText('{call} TNX {op_firstname} {state} 73'), ['K1JOE TNX Joe PA 73']);
});

test('#524: ECHOCAT Web with no name for the worked call sends OM and asks for it', () => {
  const asked = [];
  const out = runWebSendCwText('{call} TNX {op_firstname}', { macroCallsign: () => 'N0NEW', requestQrzOp: (c) => asked.push(c) });
  assert.deepStrictEqual(out, ['N0NEW TNX OM']);
  assert.deepStrictEqual(asked, ['N0NEW']);
});

test('#524: the web page carries lib/cw-remote-expand.js inlined by the server', () => {
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'remote.html'));
  const server = readSrc(path.join(__dirname, '..', 'lib', 'remote-server.js'));
  assert.ok(html.includes('<!-- cw-remote-expand-js -->'));
  assert.ok(server.includes("['cw-remote-expand-js', 'cw-remote-expand.js']"));
  assert.ok(/qrzOpByCall\[qrzKey\] = \{ name: msg\.nickname \|\| msg\.fname/.test(REMOTE_JS), 'every qrz-result is cached by callsign');
});

test('#524: device text (the phone) looks the name up for the call main fills in', () => {
  const src = readSrc(path.join(__dirname, '..', 'main.js'));
  const fn = src.slice(src.indexOf('function expandRemoteCwText(text) {'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.ok(body.includes('qrz._cache.get(JtcatParser.baseCall(call))'));
  assert.ok(body.includes('CwRemoteExpand.expandRemoteCw(text, {\n    call,'));
});

console.log(`\nCW device text expansion: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
