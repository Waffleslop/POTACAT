// Transmit (PTT) = "RTS / DTR on the CAT port" for serial CAT and Icom CI-V
// radios (steveo0600 + wadevk1mic, IC-706MKIIG, 2026-11-01: RX and tuning fine,
// no TX in any mode; the 706MKIIG has no CI-V transmit command and their
// interface keys on RTS, as WSJT-X is set up).
// Run: node test/ptt-cat-line-test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');
const { CivCodec } = require('../lib/codecs/civ-codec');
const { RIG_MODELS } = require('../lib/rig-models');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (err) { failed++; console.log('  FAIL ' + name + '\n       ' + (err.stack || err.message)); }
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');

function rig706() {
  const transport = new EventEmitter();
  const pins = [];
  const writes = [];
  transport.connect = () => {}; transport.disconnect = () => {};
  transport.write = (d) => writes.push(Buffer.from(d));
  transport.setPin = (p, cb) => { pins.push(p); if (cb) cb(null); };
  const model = RIG_MODELS['IC-706MKIIG'];
  const codec = new CivCodec(model, (d) => transport.write(d));
  const rig = new RigController(model, transport, codec);
  rig.connected = true;
  return { rig, pins, writes };
}

test('RTS keys and unkeys on the CAT port, and nothing is sent as a CI-V command', () => {
  const { rig, pins, writes } = rig706();
  const ptt = [];
  rig.on('ptt', (on) => ptt.push(on));
  rig.setTransmitLine('rts', true);
  assert.deepStrictEqual(pins, [{ rts: true }]);
  assert.strictEqual(rig._transmitting, true, 'counts as transmitting (no stale-link verdict mid-over)');
  rig.setTransmitLine('rts', false);
  assert.deepStrictEqual(pins[1], { rts: false });
  assert.strictEqual(rig._transmitting, false);
  assert.strictEqual(writes.filter((b) => b.includes(0x1c)).length, 0, 'no 1C 00 TX frame');
});

test('DTR is the other choice, and a disconnected radio is refused', () => {
  const { rig, pins } = rig706();
  rig.setTransmitLine('dtr', true);
  assert.deepStrictEqual(pins, [{ dtr: true }]);
  rig.connected = false;
  let err = null;
  rig.setTransmitLine('dtr', false, (e) => { err = e; });
  assert.ok(err, 'refused');
});

test('main: gatedSetTransmit raises the line for serial and Icom targets, and refuses RTS under RTS/CTS', () => {
  const main = read('main.js');
  const i = main.indexOf('function gatedSetTransmit(');
  const body = main.slice(i, main.indexOf('\nfunction gatedSetTxPower', i));
  assert.ok(/\(t\.type === 'serial' \|\| t\.type === 'icom'\) && \(t\.ptt === 'rts' \|\| t\.ptt === 'dtr'\)/.test(body));
  assert.ok(/cat\.setTransmitLine\(t\.ptt, state,/.test(body));
  assert.ok(/t\.ptt === 'rts' && cat\._transport && cat\._transport\._hardwareHandshake/.test(body), 'flow-control conflict refused');
  assert.ok(body.indexOf('setTransmitLine') < body.indexOf('cat.setTransmit(state)'), 'before the CAT key-down');
});

test('rig editor: both serial radio types offer RTS / DTR and save them as catTarget.ptt', () => {
  const html = read('renderer/index.html');
  for (const id of ['set-serialcat-ptt', 'set-icom-ptt']) {
    const sel = html.slice(html.indexOf(`id="${id}"`), html.indexOf('</select>', html.indexOf(`id="${id}"`)));
    assert.ok(/value="rts">RTS on the CAT port/.test(sel) && /value="dtr">DTR on the CAT port/.test(sel), id);
  }
  const app = read('renderer/app.js');
  assert.ok(/\.\.\.pttChoiceField\('set-serialcat-ptt'\)/.test(app));
  assert.ok(/\.\.\.pttChoiceField\('set-icom-ptt'\)/.test(app));
  assert.ok(/icomPtt\.value = savedPttChoice\(savedTarget\)/.test(app) && /pttSel\.value = savedPttChoice\(savedTarget\)/.test(app), 'loaded back');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
