#!/usr/bin/env node
'use strict';
// K3SBP 2026-11-21 (BUG-K3SBP-20261121-EAFC83, FLEX-8600 on Flex Direct): the
// ECHOCAT band scope was blank on every subscribe after the radio's network
// link dropped at 05:31 and came back at 05:32. The UDP socket survives a
// reconnect (only disconnect() closes it), and _setupMeterUdp() returned early
// when it existed, so the radio's new TCP client was never told
// `client udpport`: the panadapter FFT and the meters had nowhere to go.
// Run: node test/smartsdr-udpport-reconnect-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SmartSdrClient } = require('../lib/smartsdr');

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

function client() {
  const c = new SmartSdrClient();
  const sent = [];
  c._send = (line) => sent.push(line);
  return { c, sent };
}
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); };

console.log('Flex: the UDP port is told to the radio on every connection');

test('first connection: a socket is bound and its port sent with client udpport', async () => {
  const { c, sent } = client();
  try {
    c._setupMeterUdp();
    await until(() => sent.length > 0);
    assert.strictEqual(sent.length, 1);
    assert.ok(/^client udpport \d+$/.test(sent[0]), sent[0]);
  } finally { c._closeMeterUdp(); }
});

test('a reconnect (socket kept) sends the same port again, so pan frames and meters reach it', async () => {
  const { c, sent } = client();
  try {
    c._setupMeterUdp();
    await until(() => sent.length > 0);
    const port = c._meterSock.address().port;
    c._setupMeterUdp(); // what the connect handler does on the new TCP connection after a drop
    assert.deepStrictEqual(sent, [`client udpport ${port}`, `client udpport ${port}`]);
    assert.strictEqual(c._meterSock.address().port, port, 'the same socket: streams keep flowing to it');
  } finally { c._closeMeterUdp(); }
});

test('the connect handler still calls _setupMeterUdp on every connection', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'smartsdr.js'), 'utf8');
  assert.ok(/this\._send\('sub gps all'\);[\s\S]{0,400}this\._setupMeterUdp\(\);/.test(src));
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
