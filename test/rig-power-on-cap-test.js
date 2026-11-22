#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// GitHub #485: the FTX-1 can be switched off over CAT but not on (Yaesu FTX-1
// CAT manual rev 2508-C p.23: PS Set has P1=0, POWER OFF, only). Its models say
// caps.powerOn: false; every surface then shows Power Off alone, and main
// refuses a Power On with a log line instead of sending PS1;.
// Run: node test/rig-power-on-cap-test.js
const assert = require('assert');
const path = require('path');
const { RIG_MODELS } = require('../lib/rig-models');
const RigPower = require('../lib/rig-power');
const { RemoteRigState } = require('../lib/remote-rig');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
const app = readSrc(path.join(root, 'renderer', 'app.js'));
const vfo = readSrc(path.join(root, 'renderer', 'vfo-popout.html'));
const remote = readSrc(path.join(root, 'renderer', 'remote.js'));

console.log('Power On capability (#485)');

test('both FTX-1 models: power true, powerOn false', () => {
  for (const name of ['FTX-1 Field', 'FTX-1 Optima']) {
    const caps = RIG_MODELS[name].caps;
    assert.strictEqual(caps.power, true, name + ' power');
    assert.strictEqual(caps.powerOn, false, name + ' powerOn');
    assert.strictEqual(RigPower.powerOnAvailable(caps), false, name);
    assert.ok(RigPower.powerOnRefusal(caps), name + ' refused');
  }
});

test('a typical other radio keeps Power On (powerOn absent)', () => {
  for (const name of ['IC-7300', 'FT-710', 'FTDX10']) {
    const m = RIG_MODELS[name];
    if (!m) continue;
    assert.strictEqual(m.caps.powerOn, undefined, name);
    assert.strictEqual(RigPower.powerOnAvailable(m.caps), !!m.caps.power, name);
    assert.strictEqual(RigPower.powerOnRefusal(m.caps), null, name);
  }
  assert.ok(RIG_MODELS['IC-7300'] && RIG_MODELS['IC-7300'].caps.power, 'IC-7300 is in the table');
  assert.strictEqual(RigPower.powerOnAvailable({ power: true }), true);
  assert.strictEqual(RigPower.powerOnAvailable({ power: false }), false);
  assert.strictEqual(RigPower.powerOnAvailable(null), false);
  assert.strictEqual(RigPower.powerOnRefusal(null), null);
});

test('only the FTX-1 models are off-only', () => {
  const offOnly = Object.keys(RIG_MODELS).filter((k) => RIG_MODELS[k].caps && RIG_MODELS[k].caps.powerOn === false);
  assert.deepStrictEqual(offOnly.sort(), ['FTX-1 Field', 'FTX-1 Optima']);
});

test('a remote shack\'s off-only radio: canPower but not canPowerOn', () => {
  const r = new RemoteRigState();
  r.applyStatus({ type: 'status', capabilities: { power: true, powerOn: false } });
  assert.strictEqual(r.canPower(), true);
  assert.strictEqual(r.canPowerOn(), false);
  r.applyStatus({ type: 'status', capabilities: { power: true, nb: true } });
  assert.strictEqual(r.canPowerOn(), true, 'absent = on and off');
});

test('main refuses Power On before sending, and says so', () => {
  const a = main.indexOf("case 'power-on': {");
  const on = main.slice(a, main.indexOf('\n      case ', a + 10));
  assert.ok(/RigPower\.powerOnRefusal\(onCaps\)/.test(on));
  assert.ok(on.indexOf('powerOnRefusal') < on.indexOf('cat.setPowerState(true)'), 'checked before sending');
  assert.ok(/sendCatLog\('\[Power\] ' \+ onRefused\)/.test(on), 'a log line');
});

test('every surface hides Power On on an off-only radio', () => {
  assert.ok(/powerOn: vfoPowerOnAvailable\(\),/.test(main), 'vfo-radio-state carries powerOn');
  assert.ok(/canPowerOn: remoteRig\.canPowerOn\(\)/.test(main), 'shack info carries canPowerOn');
  assert.ok(/getElementById\('vfo-power-on'\);\s*if \(onBtn\) onBtn\.style\.display = s\.powerOn \? '' : 'none';/.test(vfo), 'VFO pop-out');
  assert.ok(/rigPowerOnBtn\.style\.display = caps\.power && caps\.powerOn !== false/.test(app), 'main window rig popover');
  assert.ok(/if \(info\.canPowerOn !== false\) row\.appendChild\(on\);/.test(app), 'remote CAT popover');
  assert.ok(/offOnly = s\.capabilities\.powerOn === false/.test(remote), 'ECHOCAT Web');
  assert.ok(/getElementById\('rc-power-on'\);\s*if \(rcPowerOn\) rcPowerOn\.classList\.toggle\('hidden', offOnly\)/.test(remote));
  assert.ok(/getElementById\('vf-power-on-btn'\);\s*if \(vfPowerOn\) vfPowerOn\.classList\.toggle\('hidden', offOnly\)/.test(remote));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
