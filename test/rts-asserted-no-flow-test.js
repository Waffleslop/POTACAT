#!/usr/bin/env node
'use strict';
// GitHub #136: an FT-450D behind an LDG YT-1200's PC port got no CAT. The
// tuner passes data straight through but does not drive CTS back to the PC,
// so under RTS/CTS flow control nothing is ever sent; with RTS held low the
// bytes go out but the radio (CAT RTS = ENABLE) will not answer. The path
// needs RTS ASSERTED with flow control OFF, which 1.14.0's "every Yaesu holds
// the lines low" default made unreachable. Fix: a third, opt-in RTS-line
// choice ('asserted'), plus a log line when RTS/CTS is on and CTS is low.
// No real serial port is opened: `serialport` is replaced by a fake.
const Module = require('module');
const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const { readSrc } = require('./_src');

const opened = []; // every fake port created, in order
let ctsLine = false;
class FakeSerialPort extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.path = opts.path;
    this.isOpen = false;
    this.sets = [];
    this.gets = 0;
    opened.push(this);
  }
  open(cb) { this.isOpen = true; this.emit('open'); if (cb) cb(null); }
  set(lines, cb) { this.sets.push(lines); if (cb) cb(null); }
  get(cb) { this.gets++; cb(null, { cts: ctsLine, dsr: false, dcd: false }); }
  write() { return true; }
  close(cb) { this.isOpen = false; if (cb) cb(); }
  static list() { return Promise.resolve([]); }
}
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'serialport') return { SerialPort: FakeSerialPort };
  return origLoad.call(this, request, ...rest);
};

const { SerialTransport } = require('../lib/transport');
const { CatClient } = require('../lib/cat');
const { RIG_MODELS, resolveSerialHandshake } = require('../lib/rig-models');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
function open(opts) {
  const tr = new SerialTransport();
  const logs = [];
  tr.on('log', (m) => logs.push(m));
  tr.on('error', () => {});
  tr.connect(Object.assign({ path: 'COM10', baudRate: 38400 }, opts));
  const port = opened[opened.length - 1];
  tr._target = null; // stop any reconnect timer
  return { tr, port, logs };
}

console.log('RTS asserted, no flow control (#136):');
const ft450 = RIG_MODELS['FT-450D'] || RIG_MODELS['FT-450'] || { brand: 'Yaesu' };
const ts590 = RIG_MODELS['TS-590S/SG'];

t('resolveSerialHandshake: the rig setting "asserted" is honoured, on any model', () => {
  assert.deepStrictEqual(resolveSerialHandshake(ft450, { serialHandshake: 'asserted' }), { handshake: 'asserted', source: 'rig' });
  assert.deepStrictEqual(resolveSerialHandshake(ts590, { serialHandshake: 'asserted' }), { handshake: 'asserted', source: 'rig' });
});
t('resolveSerialHandshake: the three modes, and auto/unknown still follow the model', () => {
  assert.strictEqual(resolveSerialHandshake(ft450, { serialHandshake: 'none' }).handshake, 'none');
  assert.strictEqual(resolveSerialHandshake(ft450, { serialHandshake: 'hardware' }).handshake, 'hardware');
  assert.deepStrictEqual(resolveSerialHandshake(ft450, { serialHandshake: 'auto' }), { handshake: 'none', source: 'model' });
  assert.deepStrictEqual(resolveSerialHandshake(ts590, {}), { handshake: 'hardware', source: 'model' });
  assert.deepStrictEqual(resolveSerialHandshake(ft450, { serialHandshake: 'bogus' }), { handshake: 'none', source: 'model' });
});

t('transport: "asserted" opens with rtscts off and sets DTR low, RTS high (Yaesu dtrOff)', () => {
  const { port, logs } = open({ dtrOff: true, serialHandshake: 'asserted' });
  assert.strictEqual(port.opts.rtscts, false);
  assert.deepStrictEqual(port.sets[0], { dtr: false, rts: true });
  assert.strictEqual(port.gets, 0, 'no CTS check without flow control');
  assert.ok(logs.some(l => /RTS asserted, no flow control/.test(l)), logs.join(' | '));
});
t('transport: "asserted" sets the lines even when dtrOff is off (non-Yaesu)', () => {
  const { port } = open({ dtrOff: false, serialHandshake: 'asserted' });
  assert.strictEqual(port.opts.rtscts, false);
  assert.deepStrictEqual(port.sets[0], { dtr: false, rts: true });
});
t('transport: "asserted" keeps RTS up through setPin and the close reset', () => {
  const { tr, port } = open({ dtrOff: true, serialHandshake: 'asserted' });
  assert.deepStrictEqual(tr._guardPins({ dtr: false, rts: false }), { dtr: false, rts: true });
  tr._target = { path: 'COM10' };
  tr.disconnect();
  assert.deepStrictEqual(port.sets[port.sets.length - 1], { dtr: false, rts: true });
});

t('unchanged: "none" with dtrOff (1.14.0 Yaesu default) holds both lines low', () => {
  const { tr, port } = open({ dtrOff: true, serialHandshake: 'none' });
  assert.strictEqual(port.opts.rtscts, false);
  assert.deepStrictEqual(port.sets, [{ dtr: false, rts: false }]);
  assert.strictEqual(port.gets, 0);
  assert.deepStrictEqual(tr._guardPins({ dtr: false, rts: false }), { dtr: false, rts: false });
});
t('unchanged: "none" without dtrOff touches no line', () => {
  const { port } = open({ dtrOff: false, serialHandshake: 'none' });
  assert.deepStrictEqual(port.sets, []);
});
t('unchanged: "hardware" opens with rtscts on, drops only DTR', () => {
  ctsLine = true;
  const { port, logs } = open({ dtrOff: true, serialHandshake: 'hardware' });
  assert.strictEqual(port.opts.rtscts, true);
  assert.deepStrictEqual(port.sets[0], { dtr: false, rts: true });
  assert.ok(!logs.some(l => /not driving CTS/.test(l)), 'CTS high: no warning');
});

t('diagnostic: RTS/CTS on and CTS low says nothing will be sent', () => {
  ctsLine = false;
  const { port, logs } = open({ dtrOff: true, serialHandshake: 'hardware' });
  assert.strictEqual(port.gets, 1, 'reads the modem lines once at open');
  assert.ok(logs.some(l => /CTS is low/.test(l) && /not driving CTS/.test(l) && /Asserted, no flow control/.test(l)), logs.join(' | '));
});
t('diagnostic: a driver without get() does not break the open', () => {
  const tr = new SerialTransport();
  tr.on('log', () => {}); tr.on('error', () => {});
  const origGet = FakeSerialPort.prototype.get;
  FakeSerialPort.prototype.get = undefined;
  try {
    let connected = false;
    tr.on('connect', () => { connected = true; });
    tr.connect({ path: 'COM11', dtrOff: true, serialHandshake: 'hardware' });
    tr._target = null;
    assert.ok(connected);
  } finally { FakeSerialPort.prototype.get = origGet; }
});

t('CatClient._connectSerial (legacy opener) mirrors "asserted"', () => {
  const c = new CatClient();
  c._log = () => {};
  c._connectSerial({ path: 'COM12', baudRate: 38400, dtrOff: true, serialHandshake: 'asserted' });
  const port = opened[opened.length - 1];
  c._target = null; c.transport = null;
  assert.strictEqual(port.opts.rtscts, false);
  assert.deepStrictEqual(port.sets[0], { dtr: false, rts: true });
});

t('main.js: the live connect and Test connection honour "asserted"', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  assert.ok(/hs\.handshake === 'asserted'/.test(main), 'connect logs the asserted mode');
  assert.ok(/rtsAsserted: hs\.handshake === 'asserted'/.test(main), 'Test connection opens with RTS asserted');
  assert.ok(/t\.ptt === 'rts' && cat\._transport && cat\._transport\._rtsAsserted/.test(main), 'PTT on RTS is refused, not silently held high');
});
t('rig editor offers it, and a saved "asserted" loads back', () => {
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'index.html'));
  assert.ok(/<option value="asserted">Asserted, no flow control<\/option>/.test(html));
  const app = readSrc(path.join(__dirname, '..', 'renderer', 'app.js'));
  assert.ok(/hs === 'none' \|\| hs === 'hardware' \|\| hs === 'asserted' \? hs : 'auto'/.test(app));
});

console.log('\nrts asserted no flow: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
