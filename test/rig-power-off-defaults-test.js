#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// GitHub #768 (Casey, 2026-11-19): Power Off is shown by default where
// POTACAT can switch the radio back on, a direct serial port (Yaesu, Kenwood,
// Elecraft, Icom CI-V) or a Yaesu SCU-LAN10, and hidden by default on Hamlib /
// rigctld. Every other connection is not classified and stays hidden, as in
// 1.14.6. The rig's own box (allowPowerOffNoWake, true or false) wins either
// way; only a rig with no stored choice gets the default.
// Run: node test/rig-power-off-defaults-test.js
const assert = require('assert');
const path = require('path');
const { RIG_MODELS } = require('../lib/rig-models');
const RigPower = require('../lib/rig-power');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { CivCodec } = require('../lib/codecs/civ-codec');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
const app = readSrc(path.join(root, 'renderer', 'app.js'));
const html = readSrc(path.join(root, 'renderer', 'index.html'));
const preload = readSrc(path.join(root, 'preload.js'));

// Every catTarget.type the rig editor can save, and what the rule says of it.
const LINKS = {
  serial: 'yes', icom: 'yes', 'yaesu-lan': 'yes',
  rigctld: 'no', rigctldnet: 'no',
  tcp: 'unknown', 'k4-network': 'unknown', 'civ-tcp': 'unknown', 'icom-network': 'unknown',
  tci: 'unknown', flrig: 'unknown', 'dxlab-commander': 'unknown', none: 'unknown',
};
const ON_OFF = { power: true };

console.log('Power Off defaults by connection (#768)');

test('the matrix: each connection, no stored choice', () => {
  for (const [link, wake] of Object.entries(LINKS)) {
    assert.strictEqual(RigPower.wakeAfterOff(ON_OFF, link), wake, link);
    assert.strictEqual(RigPower.powerOffAvailable(ON_OFF, { linkType: link }), wake === 'yes', link + ' default');
    assert.strictEqual(RigPower.powerOffAvailable(ON_OFF, { linkType: link, allowOffNoWake: undefined }), wake === 'yes', link + ' undefined');
  }
  assert.strictEqual(RigPower.wakeAfterOff(ON_OFF, undefined), 'unknown');
  assert.strictEqual(RigPower.wakeAfterOff(ON_OFF, 'something-new'), 'unknown', 'a new link is hidden until classified');
});

test('the matrix: a stored choice wins on every connection, both ways', () => {
  for (const link of Object.keys(LINKS)) {
    assert.strictEqual(RigPower.powerOffAvailable(ON_OFF, { linkType: link, allowOffNoWake: true }), true, link + ' ticked');
    assert.strictEqual(RigPower.powerOffAvailable(ON_OFF, { linkType: link, allowOffNoWake: false }), false, link + ' unticked');
  }
});

test('the FT-710 over USB serial (#768) and an Icom on CI-V serial show Power Off', () => {
  for (const name of ['FT-710', 'FTDX10', 'FT-891', 'TS-590S/SG', 'K3/K3S']) {
    assert.strictEqual(RigPower.powerOffAvailable(RIG_MODELS[name].caps, { linkType: 'serial' }), true, name);
  }
  for (const name of ['IC-7300', 'IC-7100', 'IC-7610']) {
    assert.strictEqual(RigPower.powerOffAvailable(RIG_MODELS[name].caps, { linkType: 'icom' }), true, name);
  }
});

test('Hamlib hides Power Off by default, whatever the model', () => {
  for (const name of ['FT-710', 'IC-7300', 'TS-590S/SG']) {
    for (const link of ['rigctld', 'rigctldnet']) {
      assert.strictEqual(RigPower.powerOffAvailable(RIG_MODELS[name].caps, { linkType: link }), false, name + ' ' + link);
    }
  }
});

test('a model with no CAT power-on is never "can wake", on any link', () => {
  for (const name of ['FTX-1 Field', 'FTX-1 Optima']) {
    for (const link of Object.keys(LINKS)) {
      assert.strictEqual(RigPower.wakeAfterOff(RIG_MODELS[name].caps, link), 'no', name + ' ' + link);
      assert.strictEqual(RigPower.powerOffAvailable(RIG_MODELS[name].caps, { linkType: link }), false, name + ' ' + link);
    }
  }
  assert.strictEqual(RigPower.wakeAfterOff({ power: false }, 'serial'), 'no');
  assert.strictEqual(RigPower.powerOffAvailable({ power: false }, { linkType: 'serial', allowOffNoWake: true }), false);
});

// "Can wake" is only said where the codec really sends a power-on.
test('every power-capable serial model sends a power-on from its codec', () => {
  let kenwood = 0, civ = 0;
  for (const [name, m] of Object.entries(RIG_MODELS)) {
    if (!m.caps || !m.caps.power || m.caps.powerOn === false) continue;
    const out = [];
    if (m.protocol === 'kenwood') {
      const codec = new KenwoodCodec(m, (d) => out.push(String(d)));
      codec.setPowerState(true);
      assert.ok(out.includes('PS1;'), name + ' sends PS1; (got ' + JSON.stringify(out) + ')');
      kenwood++;
    } else if (m.protocol === 'civ') {
      const codec = new CivCodec(m, (d) => out.push(Buffer.from(d)));
      codec.setPowerState(true, { baudRate: 19200 });
      const hex = Buffer.concat(out).toString('hex');
      assert.ok(/fefe[0-9a-f]{2}e01801fd$/.test(hex), name + ' sends CI-V 18 01 (got ' + hex.slice(-24) + ')');
      assert.ok(/^(fe){20,}/.test(hex), name + ' sends the wake-up run of FE first');
      civ++;
    } else {
      // A new protocol with CAT power: classify its link in lib/rig-power.js
      // and prove its power-on here before it is called "can wake".
      assert.fail(name + ': protocol ' + m.protocol + ' has caps.power but no power-on check in this test');
    }
  }
  assert.ok(kenwood >= 10 && civ >= 5, 'models checked: ' + kenwood + ' Kenwood-style, ' + civ + ' CI-V');
});

test('no Yaesu is sent EX040101 by a power command', () => {
  const out = [];
  const codec = new KenwoodCodec(RIG_MODELS['FT-710'], (d) => out.push(String(d)));
  codec.setPowerState(true); codec.setPowerState(false);
  assert.ok(!out.some((l) => /EX040101/.test(l)), JSON.stringify(out));
});

test('the editor line says when POTACAT can turn the radio back on', () => {
  const info = (caps, linkType) => RigPower.powerOffEditorInfo({ caps, linkType });
  assert.deepStrictEqual(info(RIG_MODELS['FT-710'].caps, 'serial'), {
    applies: true, wake: 'yes', defaultOn: true,
    note: 'POTACAT can turn this radio back on over its serial connection.',
  });
  assert.strictEqual(info(RIG_MODELS['IC-7300'].caps, 'icom').note, 'POTACAT can turn this radio back on over its CI-V serial connection.');
  assert.strictEqual(info(RIG_MODELS['FT-710'].caps, 'yaesu-lan').note, 'POTACAT can turn this radio back on through the SCU-LAN10.');
  for (const link of ['rigctld', 'rigctldnet']) {
    const r = info(undefined, link);
    assert.strictEqual(r.defaultOn, false, link);
    assert.strictEqual(r.note, "POTACAT cannot turn this radio back on through Hamlib. You will need the radio's own power button.", link);
  }
  const ftx = info(RIG_MODELS['FTX-1 Field'].caps, 'serial');
  assert.strictEqual(ftx.defaultOn, false);
  assert.strictEqual(ftx.note, "This radio can be turned off from POTACAT but not back on. You will need the radio's own power button.");
  for (const link of ['tcp', 'k4-network', 'civ-tcp', 'icom-network', 'tci', 'dxlab-commander']) {
    const r = info(undefined, link);
    assert.strictEqual(r.defaultOn, false, link);
    assert.strictEqual(r.wake, 'unknown', link);
    assert.ok(/^POTACAT does not know if it can turn this radio back on over this connection\./.test(r.note), link);
  }
  const flex = info(RIG_MODELS['FLEX-6400/6400M'].caps, 'tcp');
  assert.strictEqual(flex.applies, false);
  assert.ok(/no power command/.test(flex.note));
  // No model picked: the generic rig for the link, CAT power on and off.
  assert.strictEqual(info(undefined, 'serial').defaultOn, true);
  assert.strictEqual(info(null, 'icom').defaultOn, true);
});

test('no line is a "can" on a link the rule does not call "yes"', () => {
  for (const [link, wake] of Object.entries(LINKS)) {
    const r = RigPower.powerOffEditorInfo({ caps: ON_OFF, linkType: link });
    assert.strictEqual(/^POTACAT can turn this radio back on/.test(r.note), wake === 'yes', link);
    assert.strictEqual(r.defaultOn, wake === 'yes', link);
    assert.ok(!/[^\x00-\x7F]/.test(r.note), link + ': plain text only');
  }
});

test('main: the stored choice reaches the rule untouched (true, false or none)', () => {
  assert.ok(/caps\.powerOff = RigPower\.powerOffAvailable\(caps, \{\s*linkType: settings\.catTarget && settings\.catTarget\.type,\s*allowOffNoWake: activeRig \? activeRig\.allowPowerOffNoWake : undefined,/.test(main));
  assert.ok(!/allowOffNoWake: !!/.test(main), 'never forced to a boolean: that would turn "no choice" into "unticked"');
  assert.ok(/ipcMain\.handle\('get-rig-power-off-info'[\s\S]{0,300}RigPower\.powerOffEditorInfo\(/.test(main), 'the editor asks the rule');
  assert.ok(/getRigPowerOffInfo: \(q\) => ipcRenderer\.invoke\('get-rig-power-off-info', q\)/.test(preload));
});

test('the rig editor: the box follows the rule until the operator chooses, and only a choice is stored', () => {
  assert.ok(/id="set-allow-power-off"> Show Power Off for this radio<\/label>/.test(html), 'the label');
  assert.strictEqual(RigPower.POWER_OFF_BOX_LABEL, 'Show Power Off for this radio');
  assert.ok(/id="power-off-wake-note"/.test(html), 'the line that changes with the rig');
  assert.ok(!/Allow Power Off for a radio POTACAT cannot turn back on/.test(html + app + main), 'the 1.14.6 label is gone');
  assert.ok(/window\.api\.getRigPowerOffInfo\(\{ model: rigSetupModelName\(\), linkType: \(buildCatTargetFromForm\(\) \|\| \{\}\)\.type \}\)/.test(app), 'asked for the rig in the form');
  assert.ok(/box\.checked = !box\.disabled && \(typeof rigPowerOffChoice === 'boolean' \? rigPowerOffChoice : !!\(r && r\.defaultOn\)\)/.test(app), 'stored choice first, else the default');
  assert.ok(/box\.addEventListener\('change', \(\) => \{ rigPowerOffChoice = box\.checked; \}\)/.test(app), 'a click is a choice');
  assert.ok(/rigPowerOffChoice = editing && typeof editing\.allowPowerOffNoWake === 'boolean' \? editing\.allowPowerOffNoWake : undefined/.test(app), 'opening the editor loads the stored choice, or none');
  assert.ok(/if \(rigPowerOffStored !== undefined\) rig\.allowPowerOffNoWake = rigPowerOffStored; else delete rig\.allowPowerOffNoWake;/.test(app), 'edit saves a choice only');
  // A new rig: the record is built by lib/rig-record.js (shared with the first run).
  assert.ok(/allowPowerOffNoWake: rigPowerOffStored,/.test(app), 'add passes it on');
  assert.ok(/\.\.\.\(v\.allowPowerOffNoWake !== undefined \? \{ allowPowerOffNoWake: v\.allowPowerOffNoWake \} : \{\}\)/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'rig-record.js'), 'utf8')), 'add saves a choice only');
  assert.ok(/async function refreshRigSetupNotes\(\) \{\s*refreshPacketModeNote\(\);\s*refreshPowerOffNote\(\);/.test(app), 'refreshed with the model and connection');
});

test('the refusal names the box by its label', () => {
  assert.ok(RigPower.POWER_OFF_NO_WAKE.includes("'" + RigPower.POWER_OFF_BOX_LABEL + "'"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
