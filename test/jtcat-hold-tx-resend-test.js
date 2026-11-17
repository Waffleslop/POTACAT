#!/usr/bin/env node
'use strict';
// #688: an ECHOCAT phone showed Hold TX as off while the shack had it on, so
// every reply went out at the held 1500 Hz and the operator could not see why.
//
// The phone keeps Hold TX in its FT8 screen's state, which starts off and is
// set only by a 'jtcat-hold-tx-state' message. The desktop sent that only at
// connect and when Hold changed, so a screen that mounted later (and started
// FT8) never learned it.
//
// The rule now: the 'jtcat-start' handler sends the current Hold TX state to
// the client, the same message that connect and a change send. Also: the
// engine's log listener is attached before Hold is applied, so "Hold TX Freq:
// ON" reaches the CAT log.
// Run: node test/jtcat-hold-tx-resend-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const MAIN = readSrc(path.join(__dirname, '..', 'main.js'));

// The body of `remoteServer.on('<channel>', ...)`, up to the next top-level
// handler in the same block.
function handlerBody(channel) {
  const start = MAIN.indexOf(`remoteServer.on('${channel}',`);
  assert.ok(start >= 0, `handler for ${channel} not found`);
  const next = MAIN.indexOf('\n  remoteServer.on(', start + 10);
  return MAIN.slice(start, next > 0 ? next : undefined);
}

function fnBody(name) {
  const start = MAIN.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const end = MAIN.indexOf('\n}\n', start);
  return MAIN.slice(start, end);
}

test('jtcat-start sends the current Hold TX state to the client', () => {
  const body = handlerBody('jtcat-start');
  assert.match(body,
    /sendToClient\(\{\s*type:\s*'jtcat-hold-tx-state',\s*enabled:\s*!!settings\.jtcatHoldTxFreq\s*\}\)/,
    "jtcat-start must send { type: 'jtcat-hold-tx-state', enabled: !!settings.jtcatHoldTxFreq }");
});

test('the Hold TX state goes out after the engine is started', () => {
  const body = handlerBody('jtcat-start');
  const startAt = body.indexOf('startJtcat(mode)');
  const holdAt = body.indexOf("'jtcat-hold-tx-state'");
  assert.ok(startAt >= 0 && holdAt > startAt, 'hold state must be sent after startJtcat(mode)');
});

test('no new message type: the existing jtcat-hold-tx-state is reused', () => {
  assert.ok(!/jtcat-hold-tx-sync|jtcat-hold-state'/.test(MAIN));
});

test('startJtcat attaches the engine log listener before applying Hold TX', () => {
  const body = fnBody('startJtcat');
  const logAt = body.indexOf("ft8Engine.on('log',");
  const holdAt = body.indexOf('ft8Engine.setHoldTxFreq(');
  assert.ok(logAt >= 0, 'log listener not found in startJtcat');
  assert.ok(holdAt >= 0, 'setHoldTxFreq not found in startJtcat');
  assert.ok(logAt < holdAt, '"Hold TX Freq: ON" is emitted before anyone listens');
  assert.strictEqual(body.split("ft8Engine.on('log',").length - 1, 1, 'exactly one log listener');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
