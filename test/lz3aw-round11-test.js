#!/usr/bin/env node
'use strict';
// LZ3AW round 11 (TS-480, ECHOCAT Web), 2026-09-29, on 1.10.27:
//   "SWR is ok now. Unfortunately power meter still is not dynamic, it's
//    looking like it's not in real time." / "S-meter on WEB and POTACAT shows
//    S9+30, when radio transmits." / "The paddle still inserts extra dots."
//   / "Split and VFO switching still are showing with big delay." / "TX audio
//    on the meters bar line on WEB ... shows nothing."
// Run: node test/lz3aw-round11-test.js
require('./ws-stub-if-missing');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RIG_MODELS } = require('../lib/rig-models');
const { RemoteServer } = require('../lib/remote-server');
const { createPeakHold } = require('../lib/meter-peak-hold');

let passed = 0, failed = 0;
const cases = [];
function test(name, fn) { cases.push([name, fn]); }
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const TS480 = RIG_MODELS['TS-480'];
function ts480() {
  const writes = [], watts = [], smeter = [], logs = [];
  const codec = new KenwoodCodec(TS480, (d) => writes.push(String(d)));
  codec.on('powerMeter', (w) => watts.push(w));
  codec.on('smeter', (v) => smeter.push(v));
  codec.on('log', (l) => logs.push(l));
  return { codec, writes, watts, smeter, logs };
}
function ifFrame(vfoB, split, tx) {
  return 'IF' + '00014074000' + '0000' + '+00000' + '0' + '0' + '0' + '00' + (tx ? '1' : '0') + '2' + (vfoB ? '1' : '0') + '0' + (split ? '1' : '0') + '0' + '00' + '0' + ';';
}

console.log('LZ3AW round 11');

test('an S-meter question in flight when TX starts is not read as watts, nor the power bar as S9+30', () => {
  const t = ts480();
  t.codec.getSmeter();        // receive: asks the S-meter
  t.codec.getPowerMeter();    // TX has begun: asks the power bar
  t.codec.onData('SM00009;'); // reply to the S question (S7)
  t.codec.onData('SM00014;'); // reply to the power question (100 W)
  assert.deepStrictEqual(t.watts, [100], `power read as ${JSON.stringify(t.watts)}`);
  assert.strictEqual(t.smeter.length, 1, 'one S reading');
  assert.ok(t.smeter[0] < 120, 'and it is the S7, not the power bar');
});

test('while the radio says it transmits, an SM reply is never shown as the S-meter', () => {
  const t = ts480();
  t.codec.onData(ifFrame(false, false, true)); // IF; P8 = TX
  t.codec.getSmeter();
  t.codec.onData('SM00016;');
  assert.deepStrictEqual(t.smeter, [], 'no S9+30 during TX');
  t.codec.onData('SM00014;');                  // unasked reply while TX = the power bar
  assert.deepStrictEqual(t.watts, [100]);
});

test('key-up voids a power question: its reply (or the S reply in its place) is dropped, not watts', () => {
  const t = ts480();
  t.codec.getPowerMeter();
  t.codec.onData(ifFrame(false, false, true));
  t.codec.onData(ifFrame(false, false, false)); // the radio back in RX
  t.codec.onData('SM00010;');
  assert.deepStrictEqual(t.watts, []);
  t.codec.getSmeter();
  t.codec.onData('SM00009;');
  assert.strictEqual(t.smeter.length, 1, 'the next S question reads normally');
});

test('wattmeter hold: one read period, fast fall (the 1 s hold lagged the radio by seconds)', () => {
  const main = R('main.js');
  assert.ok(/createPeakHold\(\{ holdMs: 350, decayPerSec: 0\.9 \}\)/.test(main));
  const h = createPeakHold({ holdMs: 350, decayPerSec: 0.9 });
  h.sample(100, 0);
  assert.strictEqual(h.sample(0, 300), 100, 'held through a CW gap');
  assert.ok(h.sample(0, 1000) < 25, 'down within a second');
});

test('a VFO/split command logs what the radio reports next, with timings', () => {
  const t = ts480();
  t.codec.setSplit(true);
  t.codec.onData(ifFrame(false, true, false));
  assert.ok(t.logs.some((l) => /^VFO\/split command: want split on/.test(l)), t.logs.join(' | '));
  assert.ok(t.logs.some((l) => /^VFO\/split readback \+\d+ ms: VFO A, split on, RX/.test(l)), t.logs.join(' | '));
});

test('the desktop says which way each ECHOCAT client keys CW', () => {
  const rs = new RemoteServer();
  const logs = [];
  rs.on('log', (l) => logs.push(l));
  rs.setCwKeyerOutput(() => {});
  rs.setCwEnabled(true);
  const old = { readyState: 1, _authenticated: true, send() {}, _clientCapabilities: [] };
  rs._client = old;
  rs._handleMessage(old, { type: 'paddle', contact: 'dit', state: 1 });
  rs._handleMessage(old, { type: 'paddle', contact: 'dit', state: 0 });
  assert.ok(logs.some((l) => /forwards paddle contacts/.test(l)));
  const neu = { readyState: 1, _authenticated: true, send() {}, _clientCapabilities: [] };
  rs._client = neu;
  rs._handleMessage(neu, { type: 'cw-key', at: 0, down: true, ms: 30 });
  assert.ok(logs.some((l) => /keys with its own keyer/.test(l)));
  assert.strictEqual(logs.filter((l) => /\[CW\] This ECHOCAT client/.test(l)).length, 2, 'once per connection');
  rs._destroyCwKeyer();
});

test('an open web page reloads once when it reconnects to an updated desktop', () => {
  const web = R('renderer/remote.js');
  const at = web.indexOf("ws._serverVersion = String(msg.serverVersion || '');");
  const blk = web.slice(at, at + 1400);
  assert.ok(/window\.__echocatPageServerVersion !== ws\._serverVersion/.test(blk));
  assert.ok(/sessionStorage\.getItem\(reloadKey\) === '1'/.test(blk), 'loop guard');
  assert.ok(/if \(!already\) \{ location\.reload\(\); return; \}/.test(blk));
});

test('the web TX audio meter stays hidden until it carries audio', () => {
  assert.ok(/<span class="em-group hidden" id="echo-tx-group">/.test(R('renderer/remote.html')));
  assert.ok(/_txLastPeak > 0\.01 && echoTxGroup && echoTxGroup\.classList\.contains\('hidden'\)\) echoTxGroup\.classList\.remove\('hidden'\)/.test(R('renderer/remote.js')));
});

(async () => {
  for (const [name, fn] of cases) {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (e.stack || e.message)); }
  }
  console.log(`\nLZ3AW round 11: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
