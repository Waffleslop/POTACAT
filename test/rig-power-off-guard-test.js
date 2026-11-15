#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// GitHub #293: a radio POTACAT cannot switch back on is not offered Power Off
// unless the operator allows it for that rig. Most radios carry CAT on their
// own USB, so once off the port is gone (IC-7100 over USB, FT-710, FTDX10).
// Only the SCU-LAN10 keeps a link that wakes the radio (SCU-LAN10 Operation
// Manual rev 2311-D, p. 17). The rule lives in lib/rig-power.js; main refuses
// a Power Off from every surface, and every client hides the button.
// Run: node test/rig-power-off-guard-test.js
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
const html = readSrc(path.join(root, 'renderer', 'index.html'));
const vfo = readSrc(path.join(root, 'renderer', 'vfo-popout.html'));
const remote = readSrc(path.join(root, 'renderer', 'remote.js'));

console.log('Power Off guard (#293)');

test('over USB or serial, no radio is offered Power Off by default', () => {
  for (const name of ['IC-7100', 'IC-7300', 'IC-7610', 'FT-710', 'FTDX10', 'FT-891', 'TS-590S/SG', 'K3/K3S']) {
    const m = RIG_MODELS[name];
    assert.ok(m && m.caps.power, name + ' is a power-capable model');
    for (const link of ['serial', 'icom', 'civ-tcp', 'icom-network', 'rigctld', 'tcp', undefined]) {
      assert.strictEqual(RigPower.canWakeAfterOff(m.caps, link), false, name + ' ' + link);
      assert.strictEqual(RigPower.powerOffAvailable(m.caps, { linkType: link }), false, name + ' ' + link);
    }
  }
});

test('a radio on an SCU-LAN10 keeps Power Off', () => {
  for (const name of ['FT-710', 'FTDX10', 'FTDX101D/MP']) {
    const caps = RIG_MODELS[name].caps;
    assert.strictEqual(RigPower.canWakeAfterOff(caps, 'yaesu-lan'), true, name);
    assert.strictEqual(RigPower.powerOffAvailable(caps, { linkType: 'yaesu-lan' }), true, name);
  }
});

test('the operator can allow it for one rig', () => {
  const caps = RIG_MODELS['IC-7100'].caps;
  assert.strictEqual(RigPower.powerOffAvailable(caps, { linkType: 'serial', allowOffNoWake: true }), true);
  assert.strictEqual(RigPower.powerOffAvailable(caps, { linkType: 'serial', allowOffNoWake: false }), false);
});

test('the FTX-1 (no CAT power-on at all) is not offered Power Off, even on a LAN link', () => {
  for (const name of ['FTX-1 Field', 'FTX-1 Optima']) {
    const caps = RIG_MODELS[name].caps;
    assert.strictEqual(RigPower.canWakeAfterOff(caps, 'yaesu-lan'), false, name);
    assert.strictEqual(RigPower.powerOffAvailable(caps, { linkType: 'serial' }), false, name);
    assert.strictEqual(RigPower.powerOffAvailable(caps, { linkType: 'serial', allowOffNoWake: true }), true, name + ' allowed');
  }
});

test('a radio with no CAT power is never offered Power Off', () => {
  assert.strictEqual(RigPower.powerOffAvailable({ power: false }, { allowOffNoWake: true }), false);
  assert.strictEqual(RigPower.powerOffAvailable(null, { allowOffNoWake: true }), false);
  assert.strictEqual(RigPower.canWakeAfterOff(null, 'yaesu-lan'), false);
});

test('powerOffRefusal: offAllowed false refuses every source, the shack window too', () => {
  for (const source of ['desktop', 'echocat', 'remote', undefined]) {
    assert.strictEqual(RigPower.powerOffRefusal({ source, transmitting: false, offAllowed: false }), RigPower.POWER_OFF_NO_WAKE, String(source));
  }
  // Allowed (or an older caller): the #152 transmit rule only.
  assert.strictEqual(RigPower.powerOffRefusal({ source: 'desktop', transmitting: true, offAllowed: true }), null);
  assert.strictEqual(RigPower.powerOffRefusal({ source: 'echocat', transmitting: true, offAllowed: true }), RigPower.POWER_OFF_WHILE_TX);
  assert.strictEqual(RigPower.powerOffRefusal({ source: 'echocat', transmitting: false }), null);
  assert.ok(/Allow Power Off for a radio POTACAT cannot turn back on/.test(RigPower.POWER_OFF_NO_WAKE));
});

test('RemoteRigState.canPowerOff follows the shack capability', () => {
  const r = new RemoteRigState();
  r.applyStatus({ capabilities: { power: true } });
  assert.strictEqual(r.canPowerOff(), true, 'absent = offered (older shack)');
  r.applyStatus({ capabilities: { power: true, powerOff: false } });
  assert.strictEqual(r.canPowerOff(), false);
  r.applyStatus({ capabilities: { power: false } });
  assert.strictEqual(r.canPowerOff(), false);
});

test('main: caps.powerOff set from the rule, and power-off refused from every surface', () => {
  assert.ok(/caps\.powerOff = RigPower\.powerOffAvailable\(caps,/.test(main), 'getRigCapabilities sets powerOff');
  assert.ok(/allowOffNoWake: !!\(activeRig && activeRig\.allowPowerOffNoWake\)/.test(main), 'the rig setting feeds it');
  const i = main.indexOf("case 'power-off': {");
  assert.ok(i > 0);
  const body = main.slice(i, i + 1500);
  assert.ok(/offAllowed:/.test(body), 'the refusal gets offAllowed');
  assert.ok(body.indexOf('powerOffRefusal') < body.indexOf('setPowerState(false)'), 'refused before anything is sent');
  assert.ok(/powerOff: vfoPowerOffAvailable\(\)/.test(main), 'the VFO window is told');
  assert.ok(/canPowerOff: remoteRig\.canPowerOff\(\)/.test(main), 'the remote CAT popover is told');
});

test('every surface hides Power Off on powerOff false', () => {
  assert.ok(/rigPowerOffBtn\.style\.display = caps\.power && caps\.powerOff !== false/.test(app), 'main window rig popover');
  assert.ok(/if \(info\.canPowerOff !== false\) row\.appendChild\(off\)/.test(app), 'remote CAT popover');
  assert.ok(/s\.powerOff != null[\s\S]{0,200}vfo-power-off/.test(vfo), 'VFO pop-out');
  assert.ok(/const noOff = s\.capabilities\.powerOff === false/.test(remote), 'ECHOCAT Web');
  assert.ok(/rc-power-off'\);\s*\n\s*if \(rcPowerOff\) rcPowerOff\.classList\.toggle\('hidden', noOff\)/.test(remote), 'ECHOCAT Web rc-power-off');
  assert.ok(/vf-power-off-btn'\);\s*\n\s*if \(vfPowerOff\) vfPowerOff\.classList\.toggle\('hidden', noOff\)/.test(remote), 'ECHOCAT Web vf-power-off-btn');
});

test('the rig editor has the setting and saves it', () => {
  assert.ok(/id="set-allow-power-off"/.test(html));
  assert.ok(/Allow Power Off for a radio POTACAT cannot turn back on/.test(html));
  assert.ok(/rig\.allowPowerOffNoWake = true/.test(app), 'edit saves');
  assert.ok(/allowPowerOffNoWake: true/.test(app), 'add saves');
  assert.ok(/allowPowerOffEl\.checked = !!rig\.allowPowerOffNoWake/.test(app), 'edit restores');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
