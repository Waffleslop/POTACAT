'use strict';
// FTDX5000: the PC (power control) value is 000-255, not watts (FTDX5000 CAT
// Operation Reference p. 14). POTACAT read it as watts: full power showed and
// was logged as 254 W, and 200 W on the slider sent PC200, about 157 W
// (nicki3fiy, 2026-11-15).
//
// Run: node test/ftdx5000-power-scale-test.js

const assert = require('assert');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RIG_MODELS } = require('../lib/rig-models');
const { applyFullPower } = require('../lib/rig-full-power');
const { pcPowerConfig, encodePcPower, decodePcPower } = require('../lib/kenwood-pc-power');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (err) { failed++; console.log('  FAIL ' + name + '\n       ' + (err.stack || err.message)); }
}

function codecFor(model) {
  const writes = [];
  const codec = new KenwoodCodec(model, (d) => writes.push(String(d)));
  const power = [];
  codec.on('power', (w) => power.push(w));
  return { codec, writes, power };
}

const M = RIG_MODELS.FTDX5000;

test('reads PC254; as about 200 W, not 254', () => {
  const { codec, power } = codecFor(M);
  codec.onData('PC254;');
  assert.strictEqual(power.length, 1);
  assert.ok(power[0] >= 199 && power[0] <= 200, `got ${power[0]}`);
});

test('reads PC255; as 200 W and PC128; as 100 W, whole watts', () => {
  const { codec, power } = codecFor(M);
  codec.onData('PC255;');
  codec.onData('PC128;');
  assert.deepStrictEqual(power, [200, 100]);
});

test('100 W sends PC127; (half of 255), 200 W sends PC255;', () => {
  const { codec, writes } = codecFor(M);
  codec.setTxPower(100);
  codec.setTxPower(200);
  assert.deepStrictEqual(writes, ['PC127;', 'PC255;']);
});

test('never sends above 255, never below the 5 W floor', () => {
  const { codec, writes } = codecFor(M);
  codec.setTxPower(500);
  codec.setTxPower(0);
  assert.deepStrictEqual(writes, ['PC255;', 'PC006;']);
});

test('the TCP CAT path (kenwood-pc-power) uses the same scale', () => {
  const cfg = pcPowerConfig(M);
  assert.strictEqual(encodePcPower(200, cfg).cmd, 'PC255;');
  assert.strictEqual(encodePcPower(100, cfg).cmd, 'PC127;');
  assert.strictEqual(decodePcPower('254', cfg), 199);
});

test('Full power 200 W leaves the model as it is', () => {
  assert.strictEqual(applyFullPower(M, { fullPowerW: 200 }), M);
});

test('Full power 100 W keeps PC255 as full scale', () => {
  const m = applyFullPower(M, { fullPowerW: 100 });
  const { codec, writes, power } = codecFor(m);
  codec.setTxPower(100);
  codec.onData('PC255;');
  assert.deepStrictEqual(writes, ['PC255;']);
  assert.strictEqual(power[0], 100);
});

test('the FTDX3000 and FT-2000 are unchanged (whole watts)', () => {
  for (const id of ['FTDX3000', 'FT-2000']) {
    const { codec, writes, power } = codecFor(RIG_MODELS[id]);
    codec.setTxPower(50);
    codec.onData('PC050;');
    assert.deepStrictEqual(writes, ['PC050;'], id);
    assert.deepStrictEqual(power, [50], id);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
