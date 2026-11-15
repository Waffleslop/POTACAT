'use strict';
// #581 (FT-710 on 1.14.5): no power output meter while transmitting, and a
// log line that said "this radio answers no CAT during TX" although the radio
// answered every meter poll the owner sent by hand.
//
//  - POTACAT asked these radios nothing for power: the Kenwood/Yaesu codec
//    only read power from the S-meter reply, and only on a model with a
//    verified SM scale. The FT-710, FTDX10 and FTDX101 have a PO channel of
//    their own, RM5 (Yaesu CAT references: FT-710 rev 2306-C p. 20, FTDX10
//    rev 2308-F p. 21, FTDX101MP/D rev 2308-L p. 21): "RM5;" answers
//    "RM5" + P2P2P2 (0-255) + P3P3P3.
//  - The controller counted a request the codec never sent as one the radio
//    left unanswered, and after 8 such "asks" blamed the radio.
//
// Run: node test/yaesu-po-meter-test.js

const assert = require('assert');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RIG_MODELS } = require('../lib/rig-models');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (err) { failed++; console.log('  FAIL ' + name + '\n       ' + (err.stack || err.message)); }
}

function codecFor(id, over) {
  const model = Object.assign({}, RIG_MODELS[id], over || {});
  const writes = [];
  const codec = new KenwoodCodec(model, (d) => writes.push(String(d)));
  const watts = [];
  const logs = [];
  codec.on('powerMeter', (w) => watts.push(w));
  codec.on('log', (l) => logs.push(l));
  return { codec, writes, watts, logs, model };
}

function rigFor(id) {
  const model = RIG_MODELS[id];
  const transport = new EventEmitter();
  transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => {};
  const writes = [];
  const codec = new KenwoodCodec(model, (d) => writes.push(String(d)));
  const rig = new RigController(model, transport, codec);
  rig.connected = true;
  rig._debug = true; // _log only emits with the CAT log on
  const logs = [];
  rig.on('log', (l) => logs.push(String(l)));
  return { rig, codec, writes, logs };
}

console.log('=== the request ===');

for (const id of ['FT-710', 'FTDX10', 'FTDX101D/MP']) {
  test(`${id}: the power meter asks RM5; (PO), nothing else`, () => {
    const { codec, writes } = codecFor(id);
    assert.strictEqual(codec.getPowerMeter(), true);
    assert.deepStrictEqual(writes, ['RM5;']);
  });
}

test('a model with no power meter command sends nothing and says so (false)', () => {
  const { codec, writes } = codecFor('FT-891');
  assert.strictEqual(codec.getPowerMeter(), false);
  assert.deepStrictEqual(writes, []);
});

test('TS-480 still asks the S-meter for its power bar', () => {
  const { codec, writes } = codecFor('TS-480');
  assert.strictEqual(codec.getPowerMeter(), true);
  assert.strictEqual(writes.length, 1);
  assert.ok(/^SM0?;$/.test(writes[0]), writes[0]);
});

console.log('\n=== the reply ===');

test('FT-710: the owner\'s two measured points read back as measured (048 = 5 W, 202 = 100 W)', () => {
  const { codec, watts } = codecFor('FT-710');
  codec.onData('RM5049000;');
  codec.onData('RM5202000;');
  assert.deepStrictEqual(watts, [5, 100]);
});

test('FT-710: zero and the owner\'s measured points, never above rated power', () => {
  const { codec, watts } = codecFor('FT-710');
  for (const raw of ['000', '066', '100', '140', '171', '255']) codec.onData(`RM5${raw}000;`);
  assert.deepStrictEqual(watts, [0, 10, 25, 50, 75, 100]);
});

test('FTDX101 (left/right meter answer): P2 is the reading, P3 is ignored', () => {
  const { codec, watts } = codecFor('FTDX101D/MP');
  codec.onData('RM5202037;');
  assert.deepStrictEqual(watts, [200], 'a 200 W model: 202 is full scale on the borrowed FT-710 table');
});

test('the table is a fraction of rated power, so a 100 W FTDX101D (fullPowerW) reads 100 W', () => {
  const { codec, watts } = codecFor('FTDX101D/MP', { maxPower: 100 });
  codec.onData('RM5202000;');
  assert.deepStrictEqual(watts, [100]);
});

test('the raw reading is logged once per new value', () => {
  const { codec, logs } = codecFor('FT-710');
  codec.onData('RM5048000;');
  codec.onData('RM5048000;');
  const po = logs.filter((l) => /RM5=/.test(l));
  assert.deepStrictEqual(po, ['power meter raw RM5=48 of 255 -> 5 W (calibrated)']);
});

test('SWR (RM6) and ALC (RM4) are untouched', () => {
  const { codec, watts } = codecFor('FT-710');
  let swr = null, alc = null;
  codec.on('swr', (v) => { swr = v; });
  codec.on('alc', (v) => { alc = v; });
  codec.onData('RM6026000;');
  codec.onData('RM4100000;');
  assert.deepStrictEqual(watts, []);
  assert.ok(swr > 0 && alc === 100, `swr ${swr} alc ${alc}`);
});

console.log('\n=== the log line ===');

test('a model that asks nothing never logs "no meter reply" (the false line in #581)', () => {
  const { rig, logs } = rigFor('FT-891');
  for (let i = 0; i < 40; i++) rig._askPowerMeter();
  assert.ok(!logs.some((l) => /no meter reply/.test(l)), logs.join('\n'));
  assert.ok(!logs.some((l) => /answers no CAT during TX/.test(l)));
});

test('FT-710 answering RM5: no "no meter reply" line, and the watts reach the controller', () => {
  const { rig, codec, logs } = rigFor('FT-710');
  const seen = [];
  rig.on('powerMeter', (w) => seen.push(w));
  for (let i = 0; i < 30; i++) { rig._askPowerMeter(); codec.onData('RM5202000;'); }
  assert.ok(!logs.some((l) => /no meter reply/.test(l)), logs.join('\n'));
  assert.strictEqual(seen[0], 100);
});

test('requests really sent and never answered still say so, without claiming the radio has no CAT in TX', () => {
  const { rig, logs } = rigFor('FT-710');
  for (let i = 0; i < 24; i++) rig._askPowerMeter();
  const line = logs.filter((l) => /no meter reply/.test(l));
  assert.strictEqual(line.length, 1, logs.join('\n'));
  assert.ok(/did not answer \d+ power meter requests/.test(line[0]), line[0]);
  assert.ok(!/answers no CAT/.test(line[0]));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
