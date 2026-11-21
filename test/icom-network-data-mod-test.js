#!/usr/bin/env node
'use strict';
// #853: over the network an IC-7610's transmit audio source is set to LAN for
// the session, but POTACAT always set DATA1 MOD. The IC-7610 has one source
// per data mode (Icom IC-7610 CI-V Reference Guide rev 4, 1A 05: DATA1 MOD
// 00 92, DATA2 MOD 00 93, DATA3 MOD 00 94; values 00 MIC ... 05 LAN), and
// POTACAT re-selects whichever DATA number the radio reported (WF4I runs FT8
// on USB-D2), so on D2 or D3 the radio keyed with no audio.
// Run: node test/icom-network-data-mod-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('../lib/icom-network-data-mod');
const { CivCodec } = require('../lib/codecs/civ-codec');
const { getModel } = require('../lib/rig-models');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const ic7610 = M.SPECS.find((s) => s.models.includes('IC-7610'));

console.log('Icom network DATA MOD per DATA number (#853)');

test('the IC-7610 has DATA1/2/3 MOD at 00 92 / 00 93 / 00 94, LAN = 05', () => {
  assert.strictEqual(M.specForDataNumber(ic7610, 1).settingId, 0x0092);
  assert.strictEqual(M.specForDataNumber(ic7610, 2).settingId, 0x0093);
  assert.strictEqual(M.specForDataNumber(ic7610, 3).settingId, 0x0094);
  assert.strictEqual(M.specForDataNumber(ic7610, 2).label, 'DATA2 MOD');
  assert.strictEqual(M.specForDataNumber(ic7610, 2).networkValue, 0x05);
  assert.strictEqual(M.specForDataNumber(ic7610, 2).values[0x05], 'LAN');
});

test('a radio reporting DATA2 gets DATA2 MOD = LAN on the wire: 1A 05 00 93 05', () => {
  const writes = [];
  const codec = new CivCodec(getModel('IC-7610'), (b) => writes.push(Buffer.from(b).toString('hex')));
  codec.setRadioAddress(0x98);
  codec.onData(Buffer.from('fefee0981a060201fd', 'hex')); // 1A 06 reply: DATA2, FIL1
  assert.strictEqual(codec._dataByte, 2);
  const spec = M.specForDataNumber(ic7610, codec._dataByte);
  writes.length = 0;
  codec.setDataMod(spec.settingId, spec.networkValue);
  assert.strictEqual(writes[0], 'fefe98e01a05009305fd', writes[0]);
});

test('unknown or out-of-range DATA number: DATA1, what POTACAT selects first', () => {
  assert.strictEqual(M.specForDataNumber(ic7610, 0).settingId, 0x0092);
  assert.strictEqual(M.specForDataNumber(ic7610, 7).settingId, 0x0092);
  assert.strictEqual(M.specForDataNumber(ic7610, 0).dataNumber, 1);
});

test('radios with one DATA MOD are unchanged', () => {
  for (const s of M.SPECS.filter((x) => !x.perData)) {
    assert.strictEqual(M.specForDataNumber(s, 2), s);
  }
  const ic9700 = M.SPECS.find((s) => s.models.includes('IC-9700'));
  assert.strictEqual(ic9700.settingId, 0x0116);
});

test('main picks the item from the DATA number in use and moves LAN when the operator changes DATA number', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/const ICOM_NETWORK_DATA_MOD_SPECS = IcomNetworkDataMod\.SPECS;/.test(main));
  const prep = main.slice(main.indexOf('async function prepareIcomNetworkDataMod('), main.indexOf('async function restoreIcomNetworkDataMod('));
  assert.ok(/IcomNetworkDataMod\.specForDataNumber\(baseSpec, n\)/.test(prep));
  assert.ok(/await icomNetworkDataNumber\(dataNumberOf\)/.test(prep), 'waits for the radio\'s DATA report');
  assert.ok(/prepareIcomNetworkDataMod\(networkCat, target, model, dataModSession, networkCodec\.radioAddress, icomDataNumberOf\)/.test(main));
  const sw = main.slice(main.indexOf("networkCodec.on('data-mode'"), main.indexOf("networkCodec.on('data-mode'") + 900);
  assert.ok(/restoreIcomNetworkDataMod\(`DATA\$\{data\} selected`\)\.then/.test(sw), 'the old item goes back first');
  assert.ok(/prepareIcomNetworkDataMod\(/.test(sw), 'then the new one gets LAN');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
