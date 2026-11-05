#!/usr/bin/env node
'use strict';
// A radio's real full power (rig.fullPowerW), W5LEE 2026-11-05: a 5 W Hermes
// Lite clone on deskHPSDR, whose network CAT emulates a 100 W TS-2000. The
// TX Pwr slider ran to 100 "W", 7 W sent PC007 = 7 % of 5 W, and QSOs were
// logged at the 100 the radio reported at full drive.
// Run: node test/rig-full-power-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { applyFullPower, fullPowerOf } = require('../lib/rig-full-power');
const { getModel } = require('../lib/rig-models');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

const kenwood = () => getModel(null, 'kenwood');

test('no override: the model is returned as it is (no copy, nothing changed)', () => {
  const m = kenwood();
  assert.strictEqual(applyFullPower(m, {}), m);
  assert.strictEqual(applyFullPower(m, { fullPowerW: '' }), m);
  assert.strictEqual(applyFullPower(m, { fullPowerW: 0 }), m);
  assert.strictEqual(applyFullPower(null, { fullPowerW: 5 }), null);
});

test('a 5 W radio behind a 100 W Kenwood emulation: 5 W sends PC100, PC100 reads back as 5 W', () => {
  const base = kenwood();
  const m = applyFullPower(base, { fullPowerW: 5 });
  assert.notStrictEqual(m, base, 'a copy');
  assert.strictEqual(base.maxPower, 100, 'the shared model is untouched');
  assert.strictEqual(m.maxPower, 5);
  assert.strictEqual(m.powerDecimals, 1);
  assert.strictEqual(m.powerStep, 0.1);
  const writes = [];
  const codec = new KenwoodCodec({ ...m, tune: {} }, (d) => writes.push(String(d)));
  codec.setTxPower(5);
  codec.setTxPower(2.5);
  codec.setTxPower(7); // above full power: clamped
  assert.deepStrictEqual(writes.filter((w) => /^PC/.test(w)), ['PC100;', 'PC050;', 'PC100;']);
  const read = [];
  codec.on('power', (w) => read.push(w));
  codec.onData(Buffer.from('PC100;PC050;PC010;'));
  assert.deepStrictEqual(read, [5, 2.5, 0.5], 'the logged power is the real one');
});

test('the old behaviour, for the record: without the override, 7 W on the slider sent PC007', () => {
  const writes = [];
  const codec = new KenwoodCodec({ ...kenwood(), tune: {} }, (d) => writes.push(String(d)));
  codec.setTxPower(7);
  assert.deepStrictEqual(writes, ['PC007;']);
});

test('an amplifier-sized override keeps whole watts', () => {
  const m = applyFullPower(kenwood(), { fullPowerW: 500 });
  assert.strictEqual(m.maxPower, 500);
  assert.strictEqual(m.powerDecimals, undefined);
  const writes = [];
  new KenwoodCodec({ ...m, tune: {} }, (d) => writes.push(String(d))).setTxPower(250);
  assert.deepStrictEqual(writes, ['PC050;']);
});

test('Icom and Hamlib already scale by maxPower, so only maxPower changes their full scale', () => {
  const ic = applyFullPower(getModel(null, 'icom'), { fullPowerW: 10 });
  assert.strictEqual(ic.maxPower, 10);
  const hl = applyFullPower(getModel(null, 'rigctld'), { fullPowerW: 5 });
  assert.strictEqual(hl.maxPower, 5);
});

test('not applied where POTACAT does not convert the watts: flrig, DXLab Commander, fixed power tables', () => {
  for (const proto of ['flrig', 'commander']) {
    const m = { brand: 'x', protocol: proto, maxPower: 100 };
    assert.strictEqual(applyFullPower(m, { fullPowerW: 5 }), m, proto);
  }
  const table = { protocol: 'kenwood', maxPower: 100, powerChoices: [5, 10, 50, 100] };
  assert.strictEqual(applyFullPower(table, { fullPowerW: 5 }), table);
});

test('nonsense values are ignored', () => {
  for (const v of [-5, 'abc', NaN, 5000]) assert.strictEqual(fullPowerOf({ fullPowerW: v }), 0, String(v));
  assert.strictEqual(fullPowerOf({ fullPowerW: '5' }), 5);
});

test('main uses it for every model it hands out, and the rig editor saves it', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/function getActiveRigModel\(\) \{\n  const activeRig = \(settings\.rigs \|\| \[\]\)\.find\(r => r && r\.id === settings\.activeRigId\);\n  return RigFullPower\.applyFullPower\(_activeRigModelBase\(\), activeRig\);/.test(main), 'one wrapper over every return path');
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.ok(/fullPowerW: readRigFullPowerField\(\)/.test(app), 'saved on the rig');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.ok(/id="set-rig-full-power"/.test(html), 'a field in the rig editor');
});

console.log(`\nRig full power: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
