#!/usr/bin/env node
'use strict';
// FT-817/818/857/897 legacy 5-byte binary CAT (KL4XQ FT-818, 2026-10-21:
// those radios were on the text codec, so mode never arrived, tunes did
// nothing and the link was declared down every few minutes).
// Drives the REAL RigController + codec against a fake radio that answers
// the way the FT-817 manual says it does.
// Run: node test/yaesu-legacy-codec-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');
const { YaesuLegacyCodec, encodeFreq, decodeFreq, smeterToWire } = require('../lib/codecs/yaesu-legacy-codec');
const { RIG_MODELS } = require('../lib/rig-models');
const { cwPaddleAvailability } = require('../lib/cw-paddle-availability');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

/** A radio on the other end of the serial line. */
class FakeFT817 {
  constructor() {
    this.hz = 7074000; this.mode = 0x0A; this.tx = false; this.split = false;
    this.rx = []; this.silentFor = 0; this.splitReplies = false;
  }
  hear(buf, reply) {
    for (const b of buf) this.rx.push(b);
    while (this.rx.length >= 5) {
      const cmd = this.rx.splice(0, 5);
      this.cmds = (this.cmds || []).concat([cmd]);
      if (this.silentFor > 0) { this.silentFor--; continue; }
      const out = this.answer(cmd);
      if (!out) continue;
      if (this.splitReplies && out.length > 1) {
        reply(Buffer.from(out.slice(0, 2)));
        setTimeout(() => reply(Buffer.from(out.slice(2))), 5);
      } else reply(Buffer.from(out));
    }
  }
  answer([p1, p2, p3, p4, op]) {
    const bcd = (b) => (b >> 4) * 10 + (b & 0x0F);
    switch (op) {
      case 0x01: this.hz = (bcd(p1) * 1e6 + bcd(p2) * 1e4 + bcd(p3) * 1e2 + bcd(p4)) * 10; return [0x00];
      case 0x03: return [...encodeFreq(this.hz), this.mode];
      case 0x07: this.mode = p1; return [0x00];
      case 0x08: { const was = this.tx; this.tx = true; return [was ? 0xF0 : 0x00]; }
      case 0x88: { const was = this.tx; this.tx = false; return [was ? 0x00 : 0xF0]; }
      case 0x02: this.split = true; return [0x00];
      case 0x82: this.split = false; return [0x00];
      case 0x81: return [0x00];
      case 0xE7: return [0x09];
      case 0xF7: return [this.tx ? 0x0A : 0xFF];
      default: return [0x00];
    }
  }
}

class FakeTransport extends EventEmitter {
  constructor(radio) { super(); this.radio = radio; this.writes = []; }
  connect(target) { this._target = target; setImmediate(() => this.emit('connect')); }
  disconnect() { this.emit('close'); }
  write(buf) {
    this.writes.push(Buffer.from(buf));
    setTimeout(() => this.radio.hear(buf, (r) => this.emit('data', r)), 3);
  }
}

function rig() {
  const radio = new FakeFT817();
  const transport = new FakeTransport(radio);
  const model = Object.assign({}, RIG_MODELS['FT-817/818'], { connectDelay: 10, pollIntervalMs: 200 });
  const codec = new YaesuLegacyCodec(model, (d) => transport.write(d));
  const cat = new RigController(model, transport, codec);
  const seen = { freq: [], mode: [], ptt: [], smeter: [], logs: [] };
  cat.on('frequency', (hz) => seen.freq.push(hz));
  cat.on('mode', (m) => seen.mode.push(m));
  codec.on('ptt', (on) => seen.ptt.push(on));
  cat.on('smeter', (v) => seen.smeter.push(v));
  codec.on('log', (m) => seen.logs.push(m));
  cat.connect({ path: 'FAKE', baudRate: 9600 });
  return { radio, transport, codec, cat, seen };
}

console.log('Yaesu legacy CAT (FT-817/818/857/897)');

test('frequency BCD is 8 digits of 10 Hz, most significant first (manual example: 439.70 MHz)', () => {
  assert.deepStrictEqual(encodeFreq(439700000), [0x43, 0x97, 0x00, 0x00]);
  assert.deepStrictEqual(encodeFreq(14074000), [0x01, 0x40, 0x74, 0x00]);
  assert.deepStrictEqual(encodeFreq(7007500), [0x00, 0x70, 0x07, 0x50]);
  assert.strictEqual(decodeFreq([0x01, 0x40, 0x74, 0x00]), 14074000);
  assert.strictEqual(decodeFreq([0x1A, 0x40, 0x74, 0x00]), null, 'a non-digit nibble is a baud mismatch, not a frequency');
});

test('S-meter 0-15 lands on the wire scale (S9 = 120)', () => {
  assert.strictEqual(smeterToWire(9), 120);
  assert.strictEqual(smeterToWire(0), 0);
  assert.strictEqual(smeterToWire(15), 255);
});

test('connected: polls report frequency and mode, so PTT/HALT are not hidden', async () => {
  const { cat, seen, transport } = rig();
  await sleep(700);
  assert.ok(seen.freq.includes(7074000), 'frequency ' + JSON.stringify(seen.freq));
  assert.ok(seen.mode.includes('DIGU'), 'mode ' + JSON.stringify(seen.mode));
  assert.ok(transport.writes.every((w) => w.length === 5), 'every command is exactly 5 bytes');
  assert.ok(!transport.writes.some((w) => /[A-Z]{2}\d*;/.test(w.toString('latin1'))), 'no text-protocol command reaches the radio');
  cat.disconnect();
});

test('a spot click tunes: mode to DIG for FT8, frequency set, then read back', async () => {
  const { cat, seen, radio } = rig();
  await sleep(400);
  radio.mode = 0x01; // USB
  await sleep(300);
  cat.tune(14074000, 'FT8');
  await sleep(1300);
  assert.strictEqual(radio.hz, 14074000);
  assert.strictEqual(radio.mode, 0x0A);
  assert.ok(seen.freq.includes(14074000), 'readback ' + JSON.stringify(seen.freq.slice(-3)));
  cat.tune(7144000, 'SSB');
  await sleep(1300);
  assert.strictEqual(radio.mode, 0x00, 'SSB below 10 MHz is LSB');
  assert.strictEqual(radio.hz, 7144000);
  cat.tune(7043000, 'CW');
  await sleep(1300);
  assert.strictEqual(radio.mode, 0x02);
  cat.disconnect();
});

test('PTT keys and unkeys the radio, and the TX status read reports it', async () => {
  const { cat, seen, radio } = rig();
  await sleep(400);
  cat.setTransmit(true);
  await sleep(120);
  assert.strictEqual(radio.tx, true, 'keyed');
  await sleep(500);
  assert.ok(seen.ptt.includes(true), 'TX status read back: ' + JSON.stringify(seen.ptt));
  cat.setTransmit(false);
  await sleep(120);
  assert.strictEqual(radio.tx, false, 'unkeyed');
  cat.disconnect();
});

test('PTT goes out ahead of queued polls', () => {
  const writes = [];
  const c = new YaesuLegacyCodec({}, (b) => writes.push(b));
  c.getFrequency();          // in flight
  c.getPtt(); c.getSmeter(); // queued
  c.setTransmit(true);
  c.onData(Buffer.from([...encodeFreq(14074000), 0x0A]));
  assert.strictEqual(writes[1][4], 0x08, 'the key-down is the next command on the wire');
});

test('a reply split across serial chunks is reassembled', async () => {
  const { cat, seen, radio } = rig();
  radio.splitReplies = true;
  await sleep(700);
  assert.ok(seen.freq.includes(7074000), JSON.stringify(seen.freq));
  cat.disconnect();
});

test('a missed reply times out and the link carries on', async () => {
  const { cat, seen, radio } = rig();
  radio.silentFor = 2;
  await sleep(2200);
  assert.ok(seen.freq.includes(7074000), 'recovered: ' + JSON.stringify(seen.freq));
  cat.disconnect();
});

test('controls the radio does not have say so once and never throw', () => {
  const logs = [];
  const c = new YaesuLegacyCodec({}, () => {});
  c.on('log', (m) => logs.push(m));
  c.setFilterWidth(2400); c.setFilterWidth(500); c.setNb(true); c.setTxPower(5); c.setVfo('B');
  assert.strictEqual(logs.filter((l) => /setFilterWidth/.test(l)).length, 1);
  assert.strictEqual(c.getAtuStartSequence(), null);
  assert.strictEqual(typeof c.getPowerMeter, 'undefined', 'no getter the controller would poll for nothing');
});

test('custom CAT buttons take 5 hex bytes, opcode last', () => {
  const writes = [];
  const c = new YaesuLegacyCodec({}, (b) => writes.push(b));
  c.sendRaw('00 00 00 00 81');
  assert.deepStrictEqual([...writes[0]], [0, 0, 0, 0, 0x81]);
  c.sendRaw('FA;');
  assert.strictEqual(writes.length, 1, 'a text command is refused, not sent');
});

test('the models and the wiring use this codec (source guards)', () => {
  for (const m of ['FT-817/818', 'FT-857', 'FT-897']) {
    assert.strictEqual(RIG_MODELS[m].protocol, 'yaesu-legacy', m);
    assert.strictEqual(RIG_MODELS[m].serialStopBits, 2, m + ' wants 2 stop bits');
  }
  const main = R('main.js');
  assert.ok(/model\.protocol === 'yaesu-legacy'\n\s+\? new YaesuLegacyCodec/.test(main), 'the serial branch builds this codec');
  assert.ok(/stopBits: model\.serialStopBits/.test(main), 'stop bits reach the port');
  assert.ok(/stopBits === 2 \? 2 : 1/.test(R('lib/transport.js')), 'the transport honours them');
  assert.deepStrictEqual(cwPaddleAvailability({ paddleKey: false, protocol: 'yaesu-legacy' }).available, false,
    'no per-element CW over this CAT: the paddle must not dead-key PTT');
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
