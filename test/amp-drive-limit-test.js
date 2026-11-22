'use strict';
// The per-rig amplifier drive limit (B10 row 10): the module's rules, the radio
// clients that enforce it, and the wiring in main and the rig editor.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const AmpDrive = require('../lib/amp-drive-limit');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
  finally { AmpDrive.setLimitSource(null); }
}

console.log('\n=== amplifier drive limit ===');

test('limitW: absent, zero, negative and junk mean no limit', () => {
  assert.strictEqual(AmpDrive.limitW(null), 0);
  assert.strictEqual(AmpDrive.limitW({}), 0);
  assert.strictEqual(AmpDrive.limitW({ ampDriveLimitW: 0 }), 0);
  assert.strictEqual(AmpDrive.limitW({ ampDriveLimitW: -5 }), 0);
  assert.strictEqual(AmpDrive.limitW({ ampDriveLimitW: 'x' }), 0);
  assert.strictEqual(AmpDrive.limitW({ ampDriveLimitW: 7 }), 7);
  assert.strictEqual(AmpDrive.limitW({ ampDriveLimitW: 7.25 }), 7.3);
  assert.strictEqual(AmpDrive.limitW({ ampDriveLimitW: 99999 }), 2000);
});

test('clampW: above the limit comes down, at or below is untouched, no limit passes', () => {
  assert.strictEqual(AmpDrive.clampW(100, 7), 7);
  assert.strictEqual(AmpDrive.clampW(7, 7), 7);
  assert.strictEqual(AmpDrive.clampW(5, 7), 5);
  assert.strictEqual(AmpDrive.clampW(100, 0), 100);
});

test('flexPctLimit: percent of full power, rounded down, never under 1 %', () => {
  assert.strictEqual(AmpDrive.flexPctLimit(7, 100), 7);
  assert.strictEqual(AmpDrive.flexPctLimit(7.9, 100), 7);
  assert.strictEqual(AmpDrive.flexPctLimit(50, 500), 10); // an Aurora
  assert.strictEqual(AmpDrive.flexPctLimit(0.2, 100), 1);
  assert.strictEqual(AmpDrive.flexPctLimit(0, 100), 0);
  assert.strictEqual(AmpDrive.flexPctLimit(7, 0), 7); // full power unknown: 100 W
});

test('overLimit: half a watt of slack for rounding', () => {
  assert.strictEqual(AmpDrive.overLimit(7.4, 7), false);
  assert.strictEqual(AmpDrive.overLimit(8, 7), true);
  assert.strictEqual(AmpDrive.overLimit(100, 0), false);
});

test('parseField: unticked is none, ticked needs a positive number', () => {
  assert.strictEqual(AmpDrive.parseField(false, '7'), 0);
  assert.strictEqual(AmpDrive.parseField(true, ''), 0);
  assert.strictEqual(AmpDrive.parseField(true, '7'), 7);
});

test('current(): no source, or a source that throws, is no limit', () => {
  assert.strictEqual(AmpDrive.currentLimitW(), 0);
  AmpDrive.setLimitSource(() => { throw new Error('boom'); });
  assert.strictEqual(AmpDrive.currentLimitW(), 0);
});

// ── RigController ───────────────────────────────────────────────────────
function controller(codec) {
  const { RigController } = require('../lib/rig-controller');
  const t = new EventEmitter(); t.connect = () => {}; t.disconnect = () => {}; t.write = () => {};
  const rc = new RigController({ brand: 'Test', protocol: 'kenwood', caps: {}, cw: {} }, t, codec);
  rc.connected = true;
  return rc;
}
function wattsCodec() {
  const sent = [];
  const c = new EventEmitter();
  c.setTxPower = (w) => sent.push(w);
  return { codec: c, sent };
}

test('RigController.setTxPower (a watts codec) stops at the limit', () => {
  AmpDrive.setLimitSource(() => ({ watts: 7, fullW: 100 }));
  const { codec, sent } = wattsCodec();
  const rc = controller(codec);
  rc.setTxPower(100);
  assert.deepStrictEqual(sent, [7]);
});

test('RigController.setTxPower below the limit and with no limit is unchanged', () => {
  const { codec, sent } = wattsCodec();
  const rc = controller(codec);
  rc.setTxPower(50);
  AmpDrive.setLimitSource(() => ({ watts: 7, fullW: 100 }));
  rc._lastPcTime = 0;
  rc.setTxPower(5);
  assert.deepStrictEqual(sent, [50, 5]);
});

test('RigController.setTxPowerWatts stops at the limit', () => {
  AmpDrive.setLimitSource(() => ({ watts: 7, fullW: 100 }));
  const { codec, sent } = wattsCodec();
  const rc = controller(codec);
  rc.setTxPowerWatts(25);
  assert.deepStrictEqual(sent, [7]);
});

test('rigctld: a fraction over the limit goes out as the limit in watts', () => {
  const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
  const writes = [];
  const model = { brand: 'Hamlib', protocol: 'rigctld', caps: {}, cw: {}, maxPower: 100 };
  const codec = new RigctldCodec(model, (d) => writes.push(String(d)));
  assert.strictEqual(Math.round(codec.wattsForFraction(1)), 100);
  AmpDrive.setLimitSource(() => ({ watts: 7, fullW: 100 }));
  const rc = controller(codec);
  rc.setTxPower(1); // "L RFPOWER 1.000" = full power without the limit
  assert.ok(writes.some((w) => /L RFPOWER 0\.070/.test(w)), writes.join(' | '));
  assert.ok(!writes.some((w) => /L RFPOWER 1\.000/.test(w)), writes.join(' | '));
});

// ── SmartSdrClient (Flex) ───────────────────────────────────────────────
test('Flex: rfpower and tunepower stop at the limit as a percent', () => {
  const { SmartSdrClient } = require('../lib/smartsdr');
  const c = new SmartSdrClient();
  const sent = [];
  c._send = (s) => sent.push(s);
  AmpDrive.setLimitSource(() => ({ watts: 7, fullW: 100 }));
  c.setTxPower(100);
  c.setTunePower(50);
  c.setTxPower(5);
  assert.deepStrictEqual(sent, ['transmit set rfpower=7', 'transmit set tunepower=7', 'transmit set rfpower=5']);
});

test('Flex: no limit sends what was asked', () => {
  const { SmartSdrClient } = require('../lib/smartsdr');
  const c = new SmartSdrClient();
  const sent = [];
  c._send = (s) => sent.push(s);
  c.setTxPower(100);
  assert.deepStrictEqual(sent, ['transmit set rfpower=100']);
});

// ── Wiring (source checks) ──────────────────────────────────────────────
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('the legacy CatClient clamps too', () => {
  const s = read('lib/cat.js');
  assert.ok(/watts = AmpDrive\.clampW\(watts, AmpDrive\.currentLimitW\(\)\)/.test(s));
});

test('main: the source, the slider maximum, the raw setter and the readback guard', () => {
  const m = read('main.js');
  assert.ok(/AmpDrive\.setLimitSource\(/.test(m), 'main sets the source');
  assert.ok(/caps\.ampDriveLimitW = ampLimitW/.test(m), 'caps carry the limit');
  assert.ok(/caps\.maxPower = caps\.maxPower != null \? Math\.min\(/.test(m), 'slider max stops at the limit');
  assert.ok(/w = AmpDrive\.clampW\(w, activeAmpDriveLimitW\(\)\)/.test(m), 'setRadioTxPowerRaw clamps');
  assert.ok(/ampDriveReadbackGuard\(watts\);/.test(m), 'readback guard in sendCatPower');
  assert.ok(/AmpDrive\.overLimit\(watts, lim\)/.test(m));
});

test('rig editor: loads, resets and saves ampDriveLimitW', () => {
  const html = read('renderer/index.html');
  assert.ok(/id="set-amp-drive-on"/.test(html) && /id="set-amp-drive-w"/.test(html));
  const app = read('renderer/app.js');
  assert.ok(/if \(rigAmpDriveW > 0\) rig\.ampDriveLimitW = rigAmpDriveW; else delete rig\.ampDriveLimitW;/.test(app), 'edit saves');
  assert.ok(/\.\.\.\(rigAmpDriveW > 0 \? \{ ampDriveLimitW: rigAmpDriveW \} : \{\}\)/.test(app), 'add saves');
  assert.ok(/on\.checked = lim > 0;/.test(app), 'edit restores');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
