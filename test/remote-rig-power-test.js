#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// GitHub #152: rig power on/off from a remote POTACAT (js365k; KW4FM). A laptop
// driving a shack could not switch the radio on: the Rig popover's Power
// buttons hide with CAT, and the shack's `rigPowered` status field was dropped
// on the laptop. Now the CAT chip popover shows "Radio: On / Off / Unknown"
// with Power On / Power Off (Off asks once). Casey's two rules (2026-11-07):
// the shack refuses Power Off while it is transmitting, with a notice; Power On
// is sent and, if the shack's link to the radio is closed, the laptop is told
// the shack can't reach the radio's port.
// Run: node test/remote-rig-power-test.js
const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');
const { RemoteRigState } = require('../lib/remote-rig');
const RigPower = require('../lib/rig-power');
const { RigController } = require('../lib/rig-controller');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
const app = readSrc(path.join(root, 'renderer', 'app.js'));
function caseBody(src, label) {
  const a = src.indexOf(`case '${label}': {`);
  assert.ok(a >= 0, 'found case ' + label);
  return src.slice(a, src.indexOf('\n      case ', a + 10));
}

console.log('Remote rig power (#152)');

test('the laptop keeps the shack\'s rigPowered: true / false / null (unknown)', () => {
  const r = new RemoteRigState();
  assert.strictEqual(r.radioPowered(), null, 'nothing heard = unknown');
  r.applyStatus({ type: 'status', rigPowered: true });
  assert.strictEqual(r.radioPowered(), true);
  r.applyStatus({ type: 'status', rigPowered: false });
  assert.strictEqual(r.radioPowered(), false);
  r.applyStatus({ type: 'status', rigPowered: null });
  assert.strictEqual(r.radioPowered(), null, 'the shack cannot tell');
  r.applyStatus({ type: 'status', rigPowered: 'yes' });
  assert.strictEqual(r.radioPowered(), null, 'anything else is unknown');
});

test('the power capability is the shack radio\'s', () => {
  const r = new RemoteRigState();
  assert.strictEqual(r.canPower(), false, 'no caps yet = greyed');
  r.applyStatus({ type: 'status', capabilities: { power: true } });
  assert.strictEqual(r.canPower(), true);
  r.applyStatus({ type: 'status', capabilities: { power: false, nb: true } });
  assert.strictEqual(r.canPower(), false, 'Flex / flrig');
});

test('rule 1: Power Off from a remote client is refused while the shack transmits', () => {
  const why = RigPower.powerOffRefusal({ source: 'echocat', transmitting: true });
  assert.ok(why && /Power Off not sent/.test(why) && /transmitting/.test(why), why);
  assert.strictEqual(RigPower.powerOffRefusal({ source: 'echocat', transmitting: false }), null);
  assert.strictEqual(RigPower.powerOffRefusal({ source: 'desktop', transmitting: true }), null,
    'the operator at the shack keeps the power button');
});

test('rule 2: Power On reports when the shack cannot reach the radio\'s port', () => {
  const why = RigPower.powerOnReport({ catPresent: false });
  assert.ok(why && /can't reach the radio's port/.test(why), why);
  assert.strictEqual(RigPower.powerOnReport({ catPresent: true, sent: false }), why);
  assert.strictEqual(RigPower.powerOnReport({ catPresent: true, sent: true }), null);
  assert.strictEqual(RigPower.powerOnReport({ catPresent: true, sent: undefined }), null,
    'a CAT client that does not say is taken as sent');
});

test('RigController.setPowerState says whether it sent', () => {
  const transport = new EventEmitter();
  transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => {};
  const codec = new EventEmitter();
  const sent = [];
  codec.setPowerState = (on) => sent.push(on);
  const rig = new RigController({ brand: 'Test', protocol: 'rigctld', caps: {}, cw: {} }, transport, codec);
  rig.on('log', () => {});
  transport.connected = false;
  assert.strictEqual(rig.setPowerState(true), false, 'port closed');
  transport.connected = true;
  transport._target = { host: 'x' };
  assert.strictEqual(rig.setPowerState(true), true);
  assert.deepStrictEqual(sent, [true]);
});

test('the shack applies both rules in the one dispatcher and tells the asker', () => {
  const off = caseBody(main, 'power-off');
  assert.ok(/RigPower\.powerOffRefusal\(\{ source, transmitting: _isEffectivelyTransmitting\(\) \}\)/.test(off), 'rule 1 checked');
  assert.ok(off.indexOf('powerOffRefusal') < off.indexOf('cat.setPowerState(false)'), 'checked before sending');
  assert.ok(/remoteServer\.sendToAsker\(\{ type: 'tune-blocked', reason: /.test(off), 'the asker hears why');
  const on = caseBody(main, 'power-on');
  assert.ok(/sent = cat\.setPowerState\(true\)/.test(on));
  assert.ok(/RigPower\.powerOnReport\(\{ catPresent: !!cat, sent \}\)/.test(on), 'rule 2 checked');
  assert.ok(/remoteServer\.sendToAsker\(\{ type: 'tune-blocked', reason: /.test(on), 'the asker hears why');
  assert.ok(/remoteClient\.on\('tune-blocked', \(\{ reason \}\) => remoteShackRefused\(reason\)\)/.test(main), 'the laptop shows it');
});

test('the laptop passes the radio\'s power and capability to the CAT popover', () => {
  const info = main.slice(main.indexOf('function remoteShackInfoNow() {'), main.indexOf('function pushRemoteShackInfo() {'));
  assert.ok(/radioPowered: remoteRig\.radioPowered\(\)/.test(info));
  assert.ok(/canPower: remoteRig\.canPower\(\)/.test(info));
  const st = main.slice(main.indexOf("remoteClient.on('status', (snap) => {"), main.indexOf("remoteClient.on('message', (msg) => {"));
  assert.ok(/changed\.includes\('rigPowered'\)/.test(st) && /changed\.includes\('capabilities'\)/.test(st), 'a change is pushed');
});

test('the CAT popover in remote mode: Radio line, Power On, Power Off that asks once', () => {
  const r = app.slice(app.indexOf('function renderRemotePowerRow'), app.indexOf('async function openCatPopover'));
  assert.ok(/catPopoverRigs\.appendChild\(renderRemotePowerRow\(info\)\)/.test(r), 'the row is in the shack popover');
  assert.ok(/'Radio: ' \+ /.test(r), 'Radio: line');
  assert.ok(/'On'/.test(r) && /'Off'/.test(r) && /'Unknown'/.test(r));
  assert.ok(/rigControl\(\{ action: 'power-on' \}\)/.test(r));
  assert.ok(/rigControl\(\{ action: 'power-off' \}\)/.test(r));
  assert.ok(/Press again to power off/.test(r), 'two presses, as in the VFO window');
  assert.ok(/\.disabled = !canPower/.test(r), 'greyed without the capability or the link');
  assert.ok(!/confirm\(/.test(r), 'no browser dialog');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
