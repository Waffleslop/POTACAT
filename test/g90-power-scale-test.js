#!/usr/bin/env node
'use strict';
// GitHub #989: Xiegu G90 through rigctld set 20 W and the radio made 4 W.
// Hamlib answered `\power2mW 1.0` with 100000 mW (and the codec floors the
// scale at 100 W), so 20 W went out as `L RFPOWER 0.200`; the G90's own full
// scale is 20 W, so the radio made 0.2 x 20 W. The G90 model entry now carries
// `hamlibFullScaleW: 20`, which the rigctld codec uses as full scale. No
// other model sets it, so every other radio's bytes are unchanged (the KX3 and
// generic cases below were captured on master before the fix).
// Run: node test/g90-power-scale-test.js
const assert = require('assert');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { getModel, RIG_MODELS } = require('../lib/rig-models');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

function make(model) {
  const writes = [];
  const logs = [];
  const codec = new RigctldCodec(model, (d) => writes.push(String(d)));
  codec.on('log', (m) => logs.push(m));
  return { codec, writes, logs };
}
// Hamlib's extended \power2mW reply, then its RPRT 0.
function hamlibAnswers(codec, mW) {
  codec._pending.push({ kind: 'power2mw', ts: Date.now() });
  codec._parseLine('power2mW: 1.0');
  codec._parseLine(`Power mW: ${mW}`);
  codec._parseLine('RPRT 0');
}
const powerWrites = (writes) => writes.filter((w) => /RFPOWER/.test(w));

const G90 = () => getModel('G90');

test('G90 model carries hamlibFullScaleW 20; no other model sets it', () => {
  assert.strictEqual(RIG_MODELS['G90'].hamlibFullScaleW, 20);
  const others = Object.keys(RIG_MODELS).filter((k) => k !== 'G90' && RIG_MODELS[k].hamlibFullScaleW != null);
  assert.deepStrictEqual(others, []);
});

test('G90: Hamlib says 100 W, 20 W still sends RFPOWER 1.000', () => {
  const { codec, writes } = make(G90());
  hamlibAnswers(codec, 100000);
  codec.setTxPowerWatts(20);
  assert.deepStrictEqual(powerWrites(writes), ['L RFPOWER 1.000\n']);
});

test('G90: 10 W is 0.500 and 1 W is 0.050', () => {
  const { codec, writes } = make(G90());
  hamlibAnswers(codec, 100000);
  codec.setTxPowerWatts(10);
  codec.setTxPowerWatts(1);
  assert.deepStrictEqual(powerWrites(writes), ['L RFPOWER 0.500\n', 'L RFPOWER 0.050\n']);
});

test('G90: same before Hamlib has answered, and after its RPRT -1', () => {
  const a = make(G90());
  a.codec.setTxPowerWatts(20);
  assert.deepStrictEqual(powerWrites(a.writes), ['L RFPOWER 1.000\n']);
  const b = make(G90());
  b.codec._pending.push({ kind: 'power2mw', ts: Date.now() });
  b.codec._parseLine('RPRT -1');
  b.codec.setTxPowerWatts(10);
  assert.deepStrictEqual(powerWrites(b.writes), ['L RFPOWER 0.500\n']);
});

test('G90: readout scale agrees with the write scale (20 W, not 100 W)', () => {
  const { codec } = make(G90());
  hamlibAnswers(codec, 100000);
  assert.strictEqual(codec.powerFullScaleW(), 20);
  assert.strictEqual(Math.round(codec.wattsForFraction(1)), 20);
});

test('G90: no probe is sent (the scale is fixed)', () => {
  const { codec, writes } = make(G90());
  codec.probePowerScale(14074000);
  assert.deepStrictEqual(writes.filter((w) => /power2mW/.test(w)), []);
});

// Captured on master before the fix.
test('KX3 with Hamlib 110 W: unchanged bytes', () => {
  const { codec, writes } = make({ brand: 'Elecraft', protocol: 'rigctld', caps: {}, cw: {}, maxPower: 15 });
  hamlibAnswers(codec, 110000);
  codec.setTxPowerWatts(10);
  codec.setTxPowerWatts(110);
  codec.setTxPower(0.5);
  assert.deepStrictEqual(powerWrites(writes), ['L RFPOWER 0.091\n', 'L RFPOWER 1.000\n', 'L RFPOWER 0.500\n']);
});

test('generic rigctld rig: unchanged bytes, before and after Hamlib answers', () => {
  const m = { brand: 'Hamlib', protocol: 'rigctld', caps: {}, cw: {}, maxPower: 100 };
  const a = make(m);
  a.codec.setTxPowerWatts(20);
  hamlibAnswers(a.codec, 50000);
  a.codec.setTxPowerWatts(20);
  assert.deepStrictEqual(powerWrites(a.writes), ['L RFPOWER 0.200\n', 'L RFPOWER 0.400\n']);
  const b = make({ ...m, maxPower: 20 });
  b.codec.setTxPowerWatts(20);
  assert.deepStrictEqual(powerWrites(b.writes), ['L RFPOWER 0.200\n']);
});

test('log line states the full scale actually used', () => {
  const g = make({ brand: 'Hamlib', protocol: 'rigctld', caps: {}, cw: {}, maxPower: 20 });
  g.codec._pending.push({ kind: 'power2mw', ts: Date.now() });
  g.codec._parseLine('RPRT -1');
  const line = g.logs.find((l) => /cannot convert power/.test(l));
  assert.ok(line, g.logs.join(' | '));
  assert.ok(/watts use a 100 W full scale/.test(line), line);
  assert.ok(!/model maximum/.test(line), line);
  const k = make(G90());
  k.codec._pending.push({ kind: 'power2mw', ts: Date.now() });
  k.codec._parseLine('RPRT -1');
  assert.ok(/watts use a 20 W full scale/.test(k.logs.find((l) => /cannot convert power/.test(l))));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
