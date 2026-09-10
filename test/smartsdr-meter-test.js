#!/usr/bin/env node
'use strict';
// Flex TX-bridge forward-power meter: the value is raw/128 like the other
// bridge meters, but its UNIT is dBm — the meter list on an 8600 v4.2.20
// declares `FWDPWR unit=dBm low=0.0 hi=53.0` (53 dBm = 200 W, the radio's
// ceiling). From the day the meter shipped POTACAT emitted that number as
// watts, so every wattmeter downstream (VFO popout, web client, mobile) showed
// dBm with a W after it: 100 W read "50 W", 20 W read "43 W", 1 W read "30 W".
// Plausible enough that nobody questioned it (K3SBP 2026-09-10).
// Run: node test/smartsdr-meter-test.js
const assert = require('assert');
const { SmartSdrClient, fwdMeterToWatts } = require('../lib/smartsdr');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, want ${b}±${tol}`);

// A VITA-49 meter packet the way _parseMeterPacket wants it: header byte
// 0x38, stream id 0x700 at [4..7], packet class 0x8002 at [14..15], then
// (id u16, value i16) pairs from byte 28.
function meterPacket(entries) {
  const buf = Buffer.alloc(28 + entries.length * 4);
  buf[0] = 0x38;
  buf.writeUInt32BE(0x00000700, 4);
  buf.writeUInt16BE(0x8002, 14);
  entries.forEach(([id, raw], i) => {
    buf.writeUInt16BE(id, 28 + i * 4);
    buf.writeInt16BE(raw, 28 + i * 4 + 2);
  });
  return buf;
}

// The 8600's own meter list, trimmed to the three meters POTACAT binds.
const METER_LIST = 'R5|0|8.src=TX-#8.num=1#8.nam=FWDPWR#8.low=0.0#8.hi=53.0#8.desc=RF Power Forward#8.unit=dBm#8.fps=20#'
  + '10.src=TX-#10.num=1#10.nam=SWR#10.low=1.0#10.hi=999.0#10.desc=RF SWR#10.unit=SWR#10.fps=20#'
  + '14.src=SLC#14.num=0#14.nam=LEVEL#14.low=-150.0#14.hi=20.0#14.desc=Signal strength#14.unit=dBm#14.fps=20#';

function client() {
  const c = new SmartSdrClient();
  c._meterIds = {}; c._smeterMeterId = null; c._swrMeterId = null; c._fwdMeterId = null; c._fwdMeterUnit = '';
  c._parseStatusMessage(METER_LIST);
  return c;
}

test('fwdMeterToWatts: dBm → W (the unit the Flex bridge actually declares)', () => {
  near(fwdMeterToWatts(50, 'dBm'), 100, 0.01, '50 dBm');
  near(fwdMeterToWatts(43, 'dBm'), 20, 0.05, '43 dBm');
  near(fwdMeterToWatts(30, 'dBm'), 1, 0.001, '30 dBm');
  near(fwdMeterToWatts(53, 'dBm'), 200, 0.5, '53 dBm (meter hi = the 8600 ceiling)');
  near(fwdMeterToWatts(0, 'dBm'), 0.001, 0.0001, '0 dBm = 1 mW (idle bridge), rounds to 0 W downstream');
});

test('fwdMeterToWatts: a meter that declares watts passes through', () => {
  assert.strictEqual(fwdMeterToWatts(75, 'W'), 75);
  assert.strictEqual(fwdMeterToWatts(75, 'Watts'), 75);
  assert.strictEqual(fwdMeterToWatts(75, ' w '), 75);
});

test('fwdMeterToWatts: an unknown/missing unit is treated as dBm, never as watts', () => {
  // The bug was "dBm shown as W" and it looked plausible for years; if the
  // unit ever goes missing, erring toward dBm reproduces a reading the
  // operator can compare against the radio's own display.
  near(fwdMeterToWatts(50, ''), 100, 0.01, 'blank unit');
  near(fwdMeterToWatts(50, undefined), 100, 0.01, 'undefined unit');
});

test('meter list: the FWDPWR meter is bound WITH its declared unit', () => {
  const c = client();
  assert.strictEqual(c._fwdMeterId, 8, 'FWDPWR id');
  assert.strictEqual(c._fwdMeterUnit, 'dBm', 'FWDPWR unit captured from the meter list');
  assert.strictEqual(c._swrMeterId, 10, 'SWR id');
  assert.strictEqual(c._smeterMeterId, 14, 'S-meter id');
});

test('meter packet: a 50 dBm frame emits 100 W, not "50 W"', () => {
  const c = client();
  const got = [];
  c.on('fwd-power', (w) => got.push(w));
  c._parseMeterPacket(meterPacket([[8, Math.round(50 * 128)]]));
  assert.strictEqual(got.length, 1, 'one fwd-power emit');
  near(got[0], 100, 0.05, '50 dBm frame');
  c._parseMeterPacket(meterPacket([[8, Math.round(43 * 128)]]));
  near(got[1], 20, 0.1, '43 dBm frame');
});

test('meter packet: SWR is a true ratio (raw/128) and unaffected', () => {
  const c = client();
  const got = [];
  c.on('swr-ratio', (r) => got.push(r));
  c._parseMeterPacket(meterPacket([[10, Math.round(1.5 * 128)], [8, Math.round(50 * 128)]]));
  assert.deepStrictEqual(got.map(r => Math.round(r * 100) / 100), [1.5]);
});

test('meter packet: a bridge that declares watts is passed through', () => {
  const c = new SmartSdrClient();
  c._meterIds = {}; c._smeterMeterId = null; c._swrMeterId = null; c._fwdMeterId = null; c._fwdMeterUnit = '';
  c._parseStatusMessage('R5|0|8.src=TX-#8.num=1#8.nam=FWDPWR#8.low=0.0#8.hi=200.0#8.desc=RF Power Forward#8.unit=W#8.fps=20#');
  assert.strictEqual(c._fwdMeterUnit, 'W');
  const got = [];
  c.on('fwd-power', (w) => got.push(w));
  c._parseMeterPacket(meterPacket([[8, Math.round(75 * 128)]]));
  near(got[0], 75, 0.01, 'watts meter');
});

console.log(`\nSmartSDR meters: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
