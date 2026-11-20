'use strict';
// #744 (1.14.6): a 100 W FTDX101D read double on the forward power meter. The
// FTDX101D and FTDX101MP were one model row, 'FTDX101D/MP', at 200 W, and the
// PO meter (RM5) is read as a fraction of the row's rated power (#581).
//
//  - Two rows now: FTDX101D 5-100 W, FTDX101MP 5-200 W. PC is watts on both;
//    only the top differs (FTDX101MP/D CAT reference 2308-L p.18, PDF p.19).
//  - The radio names itself: ID; answers 0681 FTDX101D, 0682 FTDX101MP
//    (same reference, p.14, PDF p.15).
//  - A saved 'FTDX101D/MP' becomes the FTDX101D, once, at load; an MP owner
//    picks FTDX101MP once. Anything that still names the old row reads it as
//    the D.
//
// Run: node test/ftdx101-d-mp-split-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const RigModels = require('../lib/rig-models');
const { RIG_MODELS, getModel, getModelList } = RigModels;
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { applyFullPower } = require('../lib/rig-full-power');
const RigBands = require('../lib/rig-bands');
const Sculan10 = require('../lib/sculan10-protocol');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (err) { failed++; console.log('  FAIL ' + name + '\n       ' + (err.stack || err.message)); }
}

function meterWatts(model, raws) {
  const codec = new KenwoodCodec(model, () => {});
  const watts = [];
  codec.on('powerMeter', (w) => watts.push(w));
  for (const raw of raws) codec.onData(`RM5${raw}000;`);
  return watts;
}

console.log('\n=== two rows ===');

test('FTDX101D is 5-100 W and FTDX101MP is 5-200 W', () => {
  assert.ok(RIG_MODELS.FTDX101D, 'FTDX101D row');
  assert.ok(RIG_MODELS.FTDX101MP, 'FTDX101MP row');
  assert.strictEqual(RIG_MODELS.FTDX101D.maxPower, 100);
  assert.strictEqual(RIG_MODELS.FTDX101MP.maxPower, 200);
  assert.strictEqual(RIG_MODELS.FTDX101D.minPower, 5);
  assert.strictEqual(RIG_MODELS.FTDX101MP.minPower, 5);
});

test('the shared row is gone from the picker; both new rows are under Yaesu', () => {
  assert.strictEqual(RIG_MODELS['FTDX101D/MP'], undefined);
  const yaesu = getModelList().find((b) => b.brand === 'Yaesu').models;
  assert.ok(yaesu.includes('FTDX101D') && yaesu.includes('FTDX101MP'), yaesu.join(', '));
  assert.ok(!yaesu.includes('FTDX101D/MP'));
});

test('the two rows are the same CAT set, but never the same objects', () => {
  const d = RIG_MODELS.FTDX101D, mp = RIG_MODELS.FTDX101MP;
  const strip = (m) => JSON.stringify({ ...m, maxPower: 0 });
  assert.strictEqual(strip(d), strip(mp));
  assert.notStrictEqual(d.caps, mp.caps);
  assert.notStrictEqual(d.cw, mp.cw);
  assert.notStrictEqual(d.filterTables, mp.filterTables);
});

console.log('\n=== power follows the row ===');

test('the power meter reads full scale as 100 W on the D and 200 W on the MP', () => {
  assert.deepStrictEqual(meterWatts(RIG_MODELS.FTDX101D, ['202', '140', '000']), [100, 50, 0]);
  assert.deepStrictEqual(meterWatts(RIG_MODELS.FTDX101MP, ['202', '140', '000']), [200, 100, 0]);
});

test('the slider top (maxPower after Full power (W)) is 100 on the D and 200 on the MP', () => {
  assert.strictEqual(applyFullPower(getModel('FTDX101D'), { model: 'FTDX101D' }).maxPower, 100);
  assert.strictEqual(applyFullPower(getModel('FTDX101MP'), { model: 'FTDX101MP' }).maxPower, 200);
});

test('setting power: PC is watts on both, clamped at the row top (D PC100, MP PC200)', () => {
  const sent = (model, w) => { const out = []; new KenwoodCodec(model, (d) => out.push(String(d))).setTxPower(w); return out; };
  assert.deepStrictEqual(sent(RIG_MODELS.FTDX101D, 100), ['PC100;']);
  assert.deepStrictEqual(sent(RIG_MODELS.FTDX101D, 200), ['PC100;']);
  assert.deepStrictEqual(sent(RIG_MODELS.FTDX101MP, 100), ['PC100;']);
  assert.deepStrictEqual(sent(RIG_MODELS.FTDX101MP, 200), ['PC200;']);
});

test('both rows keep the HF + 6 m band list', () => {
  for (const name of ['FTDX101D', 'FTDX101MP']) {
    const bands = RigBands.nativeBands(name, getModel(name));
    assert.ok(bands && bands.includes('160m') && bands.includes('6m') && !bands.includes('2m'), name + ': ' + bands);
  }
});

test('the SCU-LAN10 covers both, with the firmware it needs', () => {
  for (const name of ['FTDX101D', 'FTDX101MP']) {
    assert.ok(Sculan10.MODELS.includes(name), name);
    assert.ok(Sculan10.FIRMWARE_MIN[name], name);
  }
});

console.log('\n=== saved rigs ===');

test('a saved FTDX101D/MP still resolves, as the 100 W FTDX101D', () => {
  assert.strictEqual(getModel('FTDX101D/MP'), RIG_MODELS.FTDX101D);
  assert.strictEqual(RigModels.currentModelName('FTDX101D/MP'), 'FTDX101D');
  assert.strictEqual(RigModels.currentModelName('FT-710'), 'FT-710');
});

test('load migrates a saved FTDX101D/MP to FTDX101D once, and leaves every other rig alone', () => {
  const s = { rigs: [
    { id: 'a', name: 'Shack', model: 'FTDX101D/MP' },
    { id: 'b', name: 'MP', model: 'FTDX101MP' },
    { id: 'c', name: 'Portable', model: 'IC-705' },
    { id: 'd', name: 'Unpicked' },
  ] };
  const lines = RigModels.migrateRigModelNames(s);
  assert.deepStrictEqual(s.rigs.map((r) => r.model), ['FTDX101D', 'FTDX101MP', 'IC-705', undefined]);
  assert.strictEqual(lines.length, 1);
  assert.ok(/"Shack".*FTDX101D\/MP is now FTDX101D/.test(lines[0]), lines[0]);
  assert.deepStrictEqual(RigModels.migrateRigModelNames(s), [], 'a second load changes nothing');
  assert.deepStrictEqual(RigModels.migrateRigModelNames({}), []);
  assert.deepStrictEqual(RigModels.migrateRigModelNames(null), []);
});

test('main runs the migration at load and saves only when it changed something', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const body = main.slice(main.indexOf('function migrateRigSettings(s)'));
  const at = body.indexOf('migrateRigModelNames(s)');
  assert.ok(at > 0 && at < 3000, 'migrateRigSettings calls migrateRigModelNames');
  assert.ok(/if \(renamedModels\.length\) \{[\s\S]{0,300}saveSettings\(s\)/.test(body), 'saves when a rig was renamed');
});

console.log('\n=== the radio names itself ===');

test('ID; 0681 is the FTDX101D and 0682 the FTDX101MP; both are rows', () => {
  assert.strictEqual(RigModels.modelFromYaesuId('0681'), 'FTDX101D');
  assert.strictEqual(RigModels.modelFromYaesuId('ID0682;'), 'FTDX101MP');
  assert.strictEqual(RigModels.modelFromYaesuId('9999'), null);
  assert.strictEqual(RigModels.modelFromYaesuId(null), null);
  for (const name of Object.values(RigModels.YAESU_RADIO_IDS)) assert.ok(RIG_MODELS[name], name + ' is a row');
});

test('the SCU-LAN10 test names the radio from that table and says when Radio Model differs', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(main.includes('const radio = modelFromYaesuId(result.id);'));
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.ok(/picked !== r\.radio \? ' Radio Model is set to ' \+ picked \+ ': pick ' \+ r\.radio/.test(app));
});

test('no code outside the rename table still names the shared row', () => {
  for (const f of ['main.js', 'renderer/app.js', 'renderer/index.html', 'lib/rig-bands.js', 'lib/sculan10-protocol.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const live = src.split(/\r?\n/).filter((l) => l.includes('FTDX101D/MP') && !/^\s*(\/\/|\*)/.test(l) && !l.includes('#744'));
    assert.deepStrictEqual(live, [], f);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
