#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Pre-release check (1.14.0): a Guest Pass power cap on a rig with Full power
// (W) set. A 5 W Hermes Lite clone behind a 100 W TS-2000 emulation under a
// 25 W pass must transmit, with the cap, the key-down check and the logged
// watts all in real watts; a real 100 W TS-2000 under the same pass must
// still be held to 25 W. Main's own cap functions, the real Kenwood codec,
// lib/rig-full-power.js and the real PassEnforcement key-down check.
// Run: node test/guest-pass-full-power-test.js
const assert = require('assert');
const path = require('path');
const vm = require('vm');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RIG_MODELS } = require('../lib/rig-models');
const { applyFullPower } = require('../lib/rig-full-power');
const { PassEnforcement } = require('../lib/pass-enforcement');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const main = readSrc(path.join(__dirname, '..', 'main.js'));

function shack(rig) {
  const model = applyFullPower(RIG_MODELS['TS-2000'], rig);
  const writes = [];
  const codec = new KenwoodCodec(model, (d) => writes.push(String(d)));
  const logs = [];
  const ctx = {
    Number, String, Date, Math, logs, writes,
    getActiveRigModel: () => model,
    detectRigType: () => 'kenwood',
    smartSdr: null,
    cat: { connected: true, setTxPower: (w) => codec.setTxPower(w) },
    _currentTxPower: 0, _lastPowerReadback: null,
    broadcastRigState: () => {}, sendCatLog: (l) => logs.push(l),
    settings: {}, win: null, setTimeout: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(
    main.slice(main.indexOf('function passPowerState()'), main.indexOf('// Can the connected radio report its RF power at all?'))
    + main.slice(main.indexOf('function setRadioTxPowerRaw('), main.indexOf('// Ask the radio to read its RF power back soon'))
    + main.slice(main.indexOf('function passApplyPowerCap('), main.indexOf('function sendCatSmeter('))
    + '\nthis.cap = passApplyPowerCap; this.state = passPowerState; this.passAskRadioPower = function () {};',
    ctx);
  // The radio's readback reaches main the way sendCatPower records it.
  codec.on('power', (w) => { ctx._currentTxPower = w; ctx._lastPowerReadback = { watts: w, at: Date.now() }; });
  const pe = new PassEnforcement({ revalidateMs: 0, rigPowerReadable: () => true });
  pe._state = 'active';
  pe._expiresAtMs = Date.now() + 3600000;
  pe._pass = { code: 'T1', guest_callsign: 'KF0WWL', privilege_class: 'us_extra', privilege_class_short: 'extra', max_power_w: 25, allowed_modes: [] };
  const keyDown = () => pe.interceptCatCommand({ type: 'tx_enable', freqHz: 14074000, mode: 'DATA', ...ctx.state() });
  return { ctx, codec, writes, logs, keyDown };
}

test('a 5 W rig (Full power 5 W) under a 25 W pass: full drive, 5 W everywhere, and it transmits', () => {
  const s = shack({ fullPowerW: 5 });
  s.ctx.passAskRadioPower = () => {};
  s.ctx.cap(25, 'lease start');
  assert.ok(s.writes.some((w) => w === 'PC100;'), 'full drive on the emulated 100 W scale: ' + s.writes.join(' '));
  assert.strictEqual(s.ctx._currentTxPower, 5, 'never "25 W" on a 5 W radio, even before the readback');
  assert.ok(s.logs.some((l) => /RF power set to 5 W, this radio's full power; the pass allows up to 25 W/.test(l)), s.logs.join('\n'));
  s.codec.onData('PC100;');                       // the radio reports full drive
  assert.strictEqual(s.ctx._lastPowerReadback.watts, 5, 'read back in real watts');
  assert.deepStrictEqual(s.keyDown(), { allowed: true });
});

test('a real 100 W TS-2000 under a 25 W pass is still capped, and over the cap is refused', () => {
  const s = shack({});
  s.ctx.cap(25, 'lease start');
  assert.ok(s.writes.some((w) => w === 'PC025;'), s.writes.join(' '));
  assert.ok(s.logs.some((l) => /RF power set to 25 W — the pass's cap/.test(l)));
  s.codec.onData('PC100;');                       // the owner's knob at 100 W
  const r = s.keyDown();
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.reason, 'over_power');
  s.codec.onData('PC025;');
  assert.deepStrictEqual(s.keyDown(), { allowed: true });
});

console.log(`\nGuest Pass cap with Full power (W): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
