#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// DAX TX stream claim. Run: node test/smartsdr-dax-tx-claim-test.js
//
// Only ONE dax_tx stream on a Flex is the transmit stream (its tx=1 flag).
// SmartSDR's DAX control panel holds it for its own stream, so POTACAT keyed
// SSB with dax=1, its own stream carrying the voice at -29 dBFS, and 0 W out
// (K3SBP 2026-10-17). Verified on the 8600 / v4.2.20: `stream set 0x<id> tx=1`
// moves the flag to that stream and clears every other; a bound client may
// set any stream, so key-up can hand it back.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SmartSdrAudio } = require('../lib/smartsdr-audio');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const DAX_PANEL = 0x84000000;
const OURS = 0x84000001;
const S = (body) => `S615541BF|${body}`;

function newAudio() {
  const a = new SmartSdrAudio();
  a._connected = true;
  a._txStreamId = OURS;
  const sent = [];
  a._send = (cmd) => { sent.push(cmd); return sent.length; };
  a._handleLine(S('stream 0x84000000 type=dax_tx client_handle=0x615541BF tx=1 ip=192.168.10.237'));
  a._handleLine(S('stream 0x04000008 type=dax_rx dax_channel=1 slice=A client_handle=0x73CF0CA5 ip=192.168.10.237'));
  a._handleLine(S('stream 0x84000001 type=dax_tx client_handle=0x73CF0CA5 tx=0 ip=192.168.10.237'));
  return { a, sent };
}

check('status lines record each dax_tx stream flag', () => {
  const { a } = newAudio();
  assert.strictEqual(a.ownTxStreamOn, false);
  assert.strictEqual(a._daxTxFlags.get(DAX_PANEL), true);
  assert.strictEqual(a._daxTxFlags.has(0x04000008), false, 'dax_rx is not tracked');
});

check('key-down claims tx=1 for our stream and names the previous holder', () => {
  const { a, sent } = newAudio();
  assert.strictEqual(a.claimTxStream(), DAX_PANEL);
  assert.deepStrictEqual(sent, ['stream set 0x84000001 tx=1']);
  assert.strictEqual(a.ownTxStreamOn, true);
});

check('key-up hands tx=1 back to the DAX panel stream', () => {
  const { a, sent } = newAudio();
  a.claimTxStream();
  assert.strictEqual(a.returnTxStream(), DAX_PANEL);
  assert.strictEqual(sent[1], 'stream set 0x84000000 tx=1');
  assert.strictEqual(a.returnTxStream(), null, 'handed back once');
});

check('nothing is sent when our stream already transmits', () => {
  const { a, sent } = newAudio();
  a._handleLine(S('stream 0x84000001 type=dax_tx client_handle=0x73CF0CA5 tx=1 ip=192.168.10.237'));
  assert.strictEqual(a.claimTxStream(), false);
  assert.strictEqual(a.returnTxStream(), null);
  assert.deepStrictEqual(sent, []);
});

check('a stream removed mid-transmission is not handed back', () => {
  const { a, sent } = newAudio();
  a.claimTxStream();
  a._handleLine(S('stream 0x84000000 removed'));
  assert.strictEqual(a.returnTxStream(), null);
  assert.strictEqual(sent.length, 1);
});

check('no stream of our own (released for JS8Call) claims nothing', () => {
  const { a, sent } = newAudio();
  a._txStreamId = null;
  assert.strictEqual(a.claimTxStream(), false);
  assert.deepStrictEqual(sent, []);
});

check('the audio connection subscribes to stream status', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'smartsdr-audio.js'), 'utf8');
  assert.ok(src.includes("send('sub audio_stream all')"));
});

check('main claims at key-down and hands back at key-up', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const assertFn = main.slice(main.indexOf('function assertFlexTxDaxForTx()'), main.indexOf('function restoreFlexTxDax()'));
  assert.ok(assertFn.indexOf('claimTxStream()') > 0, 'assert claims');
  assert.ok(assertFn.indexOf('claimTxStream()') < assertFn.indexOf('if (prior === true) return;'), 'claim runs even when dax=1 already');
  const restoreFn = main.slice(main.indexOf('function restoreFlexTxDax()'), main.indexOf('function restoreFlexTxDax()') + 600);
  assert.ok(restoreFn.indexOf('returnTxStream()') < restoreFn.indexOf('if (_flexTxDaxPrior !== false)'), 'hand-back runs before the early return');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
