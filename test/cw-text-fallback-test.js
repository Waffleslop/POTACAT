#!/usr/bin/env node
'use strict';
// #383: a Xiegu X5105 through Hamlib answers RPRT -11 to send_morse (`b`).
// POTACAT left it there: nothing keyed, the VFO showed transmit for the
// message, and the CW Key Port was never tried. Now the -11 is named, the
// transmit display drops, `b` is not sent again this session, and main.js
// keys the text on an open CW Key Port or says in one sentence what to set
// up. PTT is never the fallback.
//
// Run: node test/cw-text-fallback-test.js

const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const { readSrc } = require('./_src');
const { cwTextUnavailablePlan } = require('../lib/cw-text-fallback');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { RigController } = require('../lib/rig-controller');

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try { await fn(); passed++; console.log('  ✓ ' + name); }
    catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + (e.stack || e.message)); }
  })());
}

const HAMLIB = { brand: 'Hamlib', protocol: 'rigctld', caps: {}, cw: {} };

function rig(model = HAMLIB) {
  const transport = new EventEmitter();
  transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => {};
  const writes = [];
  const codec = new RigctldCodec(model, (d) => writes.push(String(d)));
  const r = new RigController(model, transport, codec);
  r.connected = true;
  r._lastReadOkMs = Date.now();
  const events = [];
  r.on('cw-text-unavailable', (i) => events.push(i));
  return { rig: r, codec, writes, events, transport };
}

test('plan: an open CW Key Port keys the text', () => {
  const p = cwTextUnavailablePlan({ keyPortPath: 'COM7', keyPortReady: true });
  assert.strictEqual(p.route, 'key-port');
  assert.ok(/COM7/.test(p.message));
});

test('plan: a CW Key Port that is not open is named, nothing keyed', () => {
  const p = cwTextUnavailablePlan({ keyPortPath: 'COM7', keyPortReady: false });
  assert.strictEqual(p.route, 'none');
  assert.ok(/COM7/.test(p.message) && /not open/.test(p.message), p.message);
});

test('plan: no key port says what to set up, with the real setting names', () => {
  const p = cwTextUnavailablePlan({ keyPortPath: '' });
  assert.strictEqual(p.route, 'none');
  assert.ok(/Settings > Station > CW Keyer > WinKeyer Port/.test(p.message), p.message);
  assert.ok(/Settings > ECHOCAT > CW Key Port/.test(p.message), p.message);
  assert.ok(!/PTT/.test(p.message));
});

test('codec: RPRT -11 to `b` is named with the lost text; other replies are not', () => {
  const { codec } = rig();
  const got = [];
  codec.on('cw-text-unavailable', (i) => got.push(i));
  codec.sendCwText('cq pota');
  codec.onData('RPRT -11\n');
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].text, 'CQ POTA');
  codec.sendCwText('TU');
  codec.onData('RPRT 0\n');
  codec.sendCwText('TU');
  codec.onData('RPRT -1\n');
  assert.strictEqual(got.length, 1, 'only -11 to a `b` is the verdict');
});

test('codec: a -11 to another command is not blamed on send_morse', () => {
  const { codec } = rig();
  const got = [];
  codec.on('cw-text-unavailable', (i) => got.push(i));
  codec.getVfoSplit();
  codec.sendCwText('TU');
  codec.onData('RPRT -11\nRPRT 0\n');
  assert.strictEqual(got.length, 0);
});

test('controller: after the -11 the transmit display drops and `b` is never sent again', () => {
  const { rig: r, codec, writes, events } = rig();
  r.sendCwText('CQ POTA');
  return new Promise((resolve, reject) => setTimeout(() => {
    try {
      assert.ok(writes.some((w) => /^b CQ POTA/.test(w)), JSON.stringify(writes));
      assert.strictEqual(r._transmitting, true, 'held for the message');
      assert.ok(writes[0].startsWith('T 0'), 'the generic path clears the buffer first: ' + JSON.stringify(writes));
      codec.onData('RPRT 0\nRPRT -11\n'); // T 0 accepted, b refused
      assert.strictEqual(r.cwTextUnavailable, true);
      assert.strictEqual(r._transmitting, false, 'no transmit shown for CW that is not going out');
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].text, 'CQ POTA');
      writes.length = 0;
      assert.strictEqual(r.sendCwText('TU 73'), false);
      assert.ok(!writes.some((w) => /^b |^T 1/.test(w)), 'no send_morse, no PTT: ' + JSON.stringify(writes));
      assert.strictEqual(events.length, 2);
      assert.strictEqual(events[1].again, true);
      r.disconnect();
      resolve();
    } catch (e) { reject(e); }
  }, 80));
});

test('controller: a ky1 rig through rigctld never keys PTT once CW text is known unavailable', () => {
  const model = { brand: 'Xiegu', protocol: 'rigctld', caps: {}, cw: { text: 'ky1' } };
  const { rig: r, writes } = rig(model);
  r.cwTextUnavailable = true;
  r.sendCwText('CQ');
  assert.ok(!writes.some((w) => /^T 1/.test(w)), JSON.stringify(writes));
  r.disconnect();
});

// Hamlib 4.7 (assets/hamlib/rigctld.exe -m 3089 -u) prints, for the X5105:
// "Can send Morse:\tN". Known at connect, so the first macro never tries `b`.
test('dump_caps "Can send Morse: N": no `b` ever sent, no transmit shown, nothing said until a macro', () => {
  const { rig: r, codec, writes, events } = rig();
  codec.probeCaps();
  codec.onData('Caps dump for model: 3089\nModel name:\tX5105\nCan send Morse:\tN\nCan stop Morse:\tN\nRPRT 0\n');
  assert.strictEqual(r.cwTextUnavailable, true);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].text, '', 'nothing was lost at connect');
  assert.strictEqual(events[0].fromCaps, true);
  writes.length = 0;
  assert.strictEqual(r.sendCwText('CQ'), false);
  assert.ok(!writes.some((w) => /^b |^T /.test(w)), JSON.stringify(writes));
  assert.strictEqual(events[1].again, true);
  r.disconnect();
});

test('dump_caps "Can send Morse: Y": send_morse is used', () => {
  const { rig: r, codec, events } = rig();
  codec.probeCaps();
  codec.onData('Caps dump for model: 3088\nCan send Morse:\tY\nRPRT 0\n');
  assert.ok(!r.cwTextUnavailable);
  assert.strictEqual(events.length, 0);
  r.disconnect();
});

test('main.js: the connect-time verdict alone says nothing', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  assert.ok(/function onCwTextUnavailable\(info\) \{\s*const text = info && info\.text;[\s\S]{0,200}if \(!text && !\(info && info\.again\)\) return;/.test(main));
});

test('controller: a new connection asks again', () => {
  const { rig: r, transport } = rig();
  r.cwTextUnavailable = true;
  transport.emit('connect');
  assert.strictEqual(r.cwTextUnavailable, false);
  r.disconnect();
});

test('main.js: both rigctld links route the verdict to the fallback, and the key port is shared', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  assert.strictEqual((main.match(/cat\.on\('cw-text-unavailable', onCwTextUnavailable\)/g) || []).length, 2);
  const fn = main.slice(main.indexOf('function onCwTextUnavailable('), main.indexOf('function onCwTextUnavailable(') + 2500);
  assert.ok(/cwTextUnavailablePlan\(/.test(fn));
  assert.ok(/keyCwTextOnKeyPort\(text,/.test(fn), 'keys on the same key-port path as macros');
  assert.ok(!/setTransmit|handleRemotePtt|cat\.setPtt/.test(fn), 'never PTT');
  assert.ok(/const keyViaKeyPort = \(\) => keyCwTextOnKeyPort\(expanded, wpm, txtPins, live\);/.test(main));
});

test('the CW keying line help text no longer says a CW Key Port ignores it', () => {
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'index.html'));
  const i = html.indexOf('id="set-cw-key-line"');
  const help = html.slice(i, i + 1500);
  assert.ok(!/dedicated CW-key-port setups/.test(help), 'main.js keys the CW Key Port on this line');
  assert.ok(/CW Key Port/.test(help));
});

Promise.all(pending).then(() => {
  console.log(`\nCW text fallback: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
