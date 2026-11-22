#!/usr/bin/env node
'use strict';
// Sweep 3c (Casey 2026-11-21): learn the CI-V address from the radio's own
// replies. An Icom ignores frames not addressed to it, so a wrong address was
// a healthy link and a silent radio. Every Icom reply carries the radio's own
// address as its "from" byte (IC-7300 Full Manual rev 12b p.160 (19-2) and
// IC-7100 Full Manual rev 5 p.361 (20-2): FE FE E0 94 FB FD / FE FE E0 88 FB FD).
// Run: node test/icom-civ-address-learn-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { CivCodec } = require('../lib/codecs/civ-codec');
const { getModel } = require('../lib/rig-models');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const hex = (b) => Buffer.from(b).toString('hex');

/** An IC-7300 entry (configured 0x94) talking to a radio whose address is really 0x88. */
function codecFor({ learn = true, model = 'IC-7300' } = {}) {
  const writes = [];
  const codec = new CivCodec(getModel(model), (b) => writes.push(hex(b)), learn ? { learnAddress: true } : {});
  const learned = [];
  codec.on('address-learned', (e) => learned.push(e));
  const freqs = [];
  codec.on('frequency', (hz) => freqs.push(hz));
  return { codec, writes, learned, freqs };
}

console.log('CI-V address learned from the radio (sweep 3c)');

test('the hunt asks for the frequency (03, a read) at every other address, never 00 or E0, never twice', () => {
  const { codec, writes } = codecFor();
  const n = codec.huntAddress([0x94, 0x88, 0x98, 0x88, 0x00, 0xE0, 0x94]);
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(writes, ['fefe88e003fd', 'fefe98e003fd']);
  assert.strictEqual(codec.radioAddress, 0x94, 'the hunt itself changes nothing');
});

test('the radio answering the hunt from 0x88 is adopted at once; later commands go to 0x88', () => {
  const { codec, writes, learned, freqs } = codecFor();
  codec.huntAddress([0x88]);
  codec.onData(Buffer.from('fefee088030040071400fd', 'hex')); // 14.074 MHz from 0x88 to E0
  assert.deepStrictEqual(learned, [{ was: 0x94, now: 0x88, by: 'reply' }]);
  assert.strictEqual(codec.radioAddress, 0x88);
  assert.deepStrictEqual(freqs, [14074000]);
  writes.length = 0;
  codec.getFrequency();
  assert.deepStrictEqual(writes, ['fefe88e003fd']);
});

test('transceive broadcasts (to 00) from another address: learned on the second, not the first', () => {
  const { codec, learned } = codecFor();
  codec.onData(Buffer.from('fefe0088000040071400fd', 'hex'));
  assert.deepStrictEqual(learned, []);
  codec.onData(Buffer.from('fefe0088000050071400fd', 'hex'));
  assert.deepStrictEqual(learned, [{ was: 0x94, now: 0x88, by: 'transceive' }]);
});

test('the configured radio answering ends learning: nothing is ever moved, and no hunt is sent', () => {
  const { codec, writes, learned } = codecFor();
  codec.onData(Buffer.from('fefee094fbfd', 'hex')); // the IC-7300 at 0x94 answers (OK)
  assert.strictEqual(codec.heardFromRadio, true);
  codec.onData(Buffer.from('fefee088030040071400fd', 'hex'));
  codec.onData(Buffer.from('fefe0088000040071400fd', 'hex'));
  codec.onData(Buffer.from('fefe0088000040071400fd', 'hex'));
  assert.deepStrictEqual(learned, []);
  assert.strictEqual(codec.radioAddress, 0x94);
  writes.length = 0;
  assert.strictEqual(codec.huntAddress([0x88]), 0);
  assert.deepStrictEqual(writes, []);
});

test('our own echoed frames (to the radio, from E0) are never taken as the radio', () => {
  const { codec, learned } = codecFor();
  codec.onData(Buffer.from('fefe88e003fd', 'hex'));
  codec.onData(Buffer.from('fefe98e003fd', 'hex'));
  assert.deepStrictEqual(learned, []);
});

test('without learnAddress (a CI-V bus, the network path) nothing is learned and no hunt is sent', () => {
  const { codec, writes, learned } = codecFor({ learn: false });
  assert.strictEqual(codec.huntAddress([0x88]), 0);
  assert.deepStrictEqual(writes, []);
  codec.onData(Buffer.from('fefee088030040071400fd', 'hex'));
  codec.onData(Buffer.from('fefe0088000040071400fd', 'hex'));
  codec.onData(Buffer.from('fefe0088000040071400fd', 'hex'));
  assert.deepStrictEqual(learned, []);
  assert.strictEqual(codec.radioAddress, 0x94);
});

test('main: only the USB serial Icom path learns; it hunts after 5 s of silence and saves what it found', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.strictEqual((main.match(/learnAddress: true/g) || []).length, 1, 'one path only');
  const icomSerial = main.slice(main.indexOf("} else if (target.type === 'icom') {"), main.indexOf("} else if (target.type === 'icom') {") + 1500);
  assert.ok(/learnAddress: true/.test(icomSerial));
  assert.ok(/icomCivAddressLearn\(cat, codec, transport, target\)/.test(icomSerial));
  const fn = main.slice(main.indexOf('function icomCivAddressLearn('), main.indexOf('function icomCivAddressLearn(') + 2600);
  assert.ok(/ct\.civAddress = now/.test(fn), 'saved on the rig');
  assert.ok(/codec\.heardFromRadio\) return/.test(fn), 'no hunt once the radio answered');
  assert.ok(/ICOM_CIV_HUNT_MS/.test(fn));
  assert.ok(/const ICOM_CIV_HUNT_MS = 5000;/.test(main));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
