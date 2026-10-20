#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// TS-590S/SG "CAT not staying open" (N7UVH, issue #95, 2026-10-05): the
// TS-590 and TS-990 COM/USB ports use RTS/CTS hardware flow control (Hamlib's
// default for those two models is Hardware; TS-480 and TS-890S are None).
// POTACAT opened every serial rig with flow control off and RTS forced low,
// which to those radios means "do not send" — replies stopped and the link
// was declared down while parked on a frequency. Same port under Hamlib was
// fine. Fix: a per-MODEL serialHandshake flag the transport honours.
//
// Run:  node test/ts590-flow-control-test.js

const fs = require('fs');
const path = require('path');
const { RIG_MODELS } = require('../lib/rig-models');

let pass = 0;
let fail = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(msg);
  console.log(`  ✗ ${msg}`);
}
function section(name) { console.log(`\n=== ${name} ===`); }
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

section('Models: Hamlib parity for the serial handshake');
assert(RIG_MODELS['TS-590S/SG'].serialHandshake === 'hardware', 'TS-590S/SG: hardware (rigctld -m 2037 --show-conf: Hardware)');
assert(RIG_MODELS['TS-990S'].serialHandshake === 'hardware', 'TS-990S: hardware (rigctld -m 2039: Hardware)');
assert(RIG_MODELS['TS-480'].serialHandshake === undefined, 'TS-480: unchanged (rigctld -m 2028: None; LZ3AW\'s works today)');
assert(RIG_MODELS['TS-890S'].serialHandshake === undefined, 'TS-890S: unchanged (rigctld -m 2041: None)');
assert(RIG_MODELS['TS-2000'].serialHandshake === undefined, 'TS-2000: unchanged');
const flagged = Object.entries(RIG_MODELS).filter(([, m]) => m.serialHandshake).map(([k]) => k).sort();
assert(JSON.stringify(flagged) === JSON.stringify(['TS-590S/SG', 'TS-990S']), `only the two Kenwoods that need it carry the flag (got ${flagged.join(', ')})`);
for (const [k, m] of Object.entries(RIG_MODELS)) {
  if (m.serialHandshake) assert(m.serialHandshake === 'hardware', `${k}: the only value the transport knows is 'hardware'`);
}

section('Models: the meter query this generation answers');
for (const k of ['TS-590S/SG', 'TS-890S', 'TS-990S', 'TS-480']) {
  assert(RIG_MODELS[k].smQuery === 'SM0;', `${k}: SM0; (SM; without P1 is a command error)`);
}

section('Transport (lib/transport.js SerialTransport — the direct-serial path): the flag reaches the port and RTS stays asserted');
{
  const { SerialTransport } = require('../lib/transport');
  const t = new SerialTransport();
  t._hardwareHandshake = true;
  assert(JSON.stringify(t._guardPins({ dtr: false, rts: false })) === JSON.stringify({ dtr: false, rts: true }), 'hardware: a low-both request keeps RTS asserted');
  assert(JSON.stringify(t._guardPins({ dtr: true, rts: true })) === JSON.stringify({ dtr: true, rts: true }), 'hardware: DTR (the CW key) passes through');
  t._hardwareHandshake = false;
  assert(JSON.stringify(t._guardPins({ dtr: false, rts: false })) === JSON.stringify({ dtr: false, rts: false }), 'no handshake: pins untouched (every other rig)');

  const src = read('lib/transport.js');
  assert(/connect\(\{ path, baudRate, dtrOff, connectDelay, serialHandshake \}\)/.test(src), 'connect() takes serialHandshake');
  assert(/rtscts: hardware,/.test(src), 'rtscts follows the model flag (false for every other rig)');
  assert(/hardware \? \{ dtr: false, rts: true \} : \{ dtr: false, rts: false \}/.test(src), 'dtrOff at open drops only DTR under hardware flow control');
  assert(/this\._port\.set\(this\._guardPins\(this\._lastPinState\)/.test(src), 'setPin (CW keying) goes through the guard');
  assert(/this\._port\.set\(this\._guardPins\(\{ dtr: false, rts: false \}\)\)/.test(src), 'the close-time line reset goes through the guard');
  assert(/port\.set\(this\._guardPins\(this\._lastPinState\)\)/.test(src), 'the reconnect pin restore goes through the guard');
  // main.js hands the model flag to the transport on the Kenwood/Yaesu path.
  const main = read('main.js');
  assert(/const hs = resolveSerialHandshake\(model, target\)/.test(main) && /serialHandshake: hs\.handshake/.test(main), 'main.js resolves the handshake (rig setting, else model) on the direct-serial connect');
  // The legacy CatClient serial opener (lib/cat.js) mirrors the same rule.
  const cat = read('lib/cat.js');
  assert(/rtscts: hardware,/.test(cat) && /this\._serialHandshake === 'hardware' \? \{ dtr: val \} : \{ dtr: val, rts: val \}/.test(cat), 'lib/cat.js CatClient mirrors the rule');
}

section('SP5GB FX4CR (1.11.7): a radio that keys PTT on RTS — the rig setting wins, and a self-key on connect falls back');
{
  const { resolveSerialHandshake } = require('../lib/rig-models');
  const m590 = RIG_MODELS['TS-590S/SG'];
  assert(resolveSerialHandshake(m590, { type: 'serial' }).handshake === 'hardware', 'TS-590 model, no rig setting: hardware (N7UVH)');
  assert(resolveSerialHandshake(m590, { serialHandshake: 'auto' }).source === 'model', "'auto' follows the model");
  assert(resolveSerialHandshake(m590, { serialHandshake: 'none' }).handshake === 'none', 'rig setting "Held low" beats the TS-590 model (FX4CR)');
  assert(resolveSerialHandshake(m590, { serialHandshake: 'none' }).source === 'rig', 'and says the rig decided');
  assert(resolveSerialHandshake(RIG_MODELS['TS-480'], { serialHandshake: 'hardware' }).handshake === 'hardware', 'rig setting can turn flow control on for any model');
  assert(resolveSerialHandshake(RIG_MODELS['TS-480'], {}).handshake === 'none', 'TS-480 default: none');
  assert(resolveSerialHandshake(null, null).handshake === 'none', 'no model, no target: none');
  const main = read('main.js');
  assert(/if \(hs\.source === 'model'\) armSerialHandshakeFallback\(cat, target\)/.test(main), 'the self-key fallback is armed only for a MODEL default, never over the operator\'s choice');
  assert(/r\.catTarget\.path === path\) r\.catTarget\.serialHandshake = 'none'/.test(main), 'the fallback remembers "held low" on every rig on that port (activeRigId can name nothing)');
  assert(/!\('serialHandshake' in out\.catTarget\)/.test(main), 'a stale Settings save keeps the remembered setting');
  const html = read('renderer/index.html');
  assert(/id="set-serialcat-handshake"/.test(html), 'rig editor has the RTS line choice');
  const app = read('renderer/app.js');
  assert(/serialHandshake: \(document\.getElementById\('set-serialcat-handshake'\)/.test(app), 'the editor saves it on the serial target');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
