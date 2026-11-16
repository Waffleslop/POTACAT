#!/usr/bin/env node
'use strict';
// A Yaesu behind rigctld reads its power setting (#656).
//
// The Yaesu raw path (`w` passthrough) skipped every Hamlib level, the power
// setting included, so POTACAT never knew the power of an FTdx-101D on
// rigctld. The Station Setup test transmit needs that number to turn the
// power down to 5 W, so it refused before keying (N7FQT, 1.14.5). The power is
// now read with the radio's own `PC;` through `w`, parsed as the serial codec
// parses it. Every non-Yaesu rigctld rig must still send exactly what it sent.
// Run: node test/rigctld-yaesu-power-read-test.js
const assert = require('assert');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { RIG_MODELS, GENERIC_CAPS } = require('../lib/rig-models');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

function codec(model, opts) {
  const writes = [];
  const c = new RigctldCodec(model, (d) => writes.push(String(d)), opts);
  const feed = (s) => c.onData(Buffer.from(s));
  const powers = [];
  c.on('power', (w) => powers.push(w));
  return { c, writes, feed, powers };
}

test('FTDX101D/MP on rigctld: the power poll is w PC; and PC050; reads 50 W', () => {
  const { c, writes, feed, powers } = codec(RIG_MODELS['FTDX101D/MP']);
  c.getPower();
  assert.deepStrictEqual(writes, ['w PC;\n']);
  let hz = null;
  c.on('frequency', (f) => { hz = f; });
  // rigctld ends a w reply with a NUL and no newline; the next reply follows.
  feed('PC050;\u000014074000\n');
  assert.deepStrictEqual(powers, [50]);
  assert.strictEqual(hz, 14074000);
});

test('FTDX101MP at full power: PC200; reads 200 W', () => {
  const { c, feed, powers } = codec(RIG_MODELS['FTDX101D/MP']);
  c.getPower();
  feed('PC200;\n');
  assert.deepStrictEqual(powers, [200]);
});

test('a second power poll while one is unanswered sends nothing more', () => {
  const { c, writes, feed } = codec(RIG_MODELS['FTDX101D/MP']);
  c.getPower();
  c.getPower();
  assert.deepStrictEqual(writes, ['w PC;\n']);
  feed('PC100;\n');
  c.getPower();
  assert.deepStrictEqual(writes, ['w PC;\n', 'w PC;\n']);
});

test('the Station Setup round trip: set 5 W writes PC005;, the read says 5 W', () => {
  const { c, writes, feed, powers } = codec(RIG_MODELS['FTDX101D/MP']);
  c.setTxPowerWatts(5);
  assert.strictEqual(writes[writes.length - 1], 'w PC005;\n');
  c.getPower();
  feed('PC005;\n');
  assert.deepStrictEqual(powers, [5]);
});

test('FT-710 and FTDX10 read the same way', () => {
  for (const name of ['FT-710', 'FTDX10']) {
    const { c, writes, feed, powers } = codec(RIG_MODELS[name]);
    c.getPower();
    assert.deepStrictEqual(writes, ['w PC;\n'], name);
    feed('PC075;\n');
    assert.deepStrictEqual(powers, [75], name);
  }
});

test('FTX-1 Field strips its head prefix: PC1010; is 10 W, not 1010', () => {
  const { c, feed, powers } = codec(RIG_MODELS['FTX-1 Field']);
  c.getPower();
  feed('PC1010;\n');
  assert.deepStrictEqual(powers, [10]);
});

test('FTX-1 Optima: PC2100; is 100 W', () => {
  const { c, feed, powers } = codec(RIG_MODELS['FTX-1 Optima']);
  c.getPower();
  feed('PC2100;\n');
  assert.deepStrictEqual(powers, [100]);
});

test('FTDX5000: PC is 000-255, so PC255; is 200 W', () => {
  const { c, feed, powers } = codec(RIG_MODELS['FTDX5000']);
  c.getPower();
  feed('PC255;\n');
  assert.deepStrictEqual(powers, [200]);
});

test('FTDX5000: setting 200 W writes PC255;, 100 W writes PC127; as the serial codec rounds it', () => {
  const { c, writes } = codec(RIG_MODELS['FTDX5000']);
  c.setTxPowerWatts(200);
  assert.strictEqual(writes[writes.length - 1], 'w PC255;\n');
  c.setTxPowerWatts(100);
  assert.strictEqual(writes[writes.length - 1], 'w PC127;\n');
});

test('a Yaesu without powerScale still writes plain watts (FTDX101MP 150 W -> PC150;)', () => {
  const { c, writes } = codec(RIG_MODELS['FTDX101D/MP']);
  c.setTxPowerWatts(150);
  assert.strictEqual(writes[writes.length - 1], 'w PC150;\n');
});

test('every Yaesu model reads power with w PC;, never a Hamlib level', () => {
  for (const [name, m] of Object.entries(RIG_MODELS)) {
    if (m.brand !== 'Yaesu') continue;
    const { c, writes } = codec(m);
    c.getPower();
    assert.deepStrictEqual(writes, ['w PC;\n'], name);
  }
});

test('non-Yaesu rigctld rigs are unchanged: Hamlib power level, and a PC line is not power', () => {
  for (const [label, model, opts] of [
    ['Other Rig (Hamlib), dummy', GENERIC_CAPS.rigctld, { hamlibRigId: 1 }],
    ['Other Rig (Hamlib), Elecraft K3', GENERIC_CAPS.rigctld, { hamlibRigId: 2029 }],
  ]) {
    const { c, writes, feed, powers } = codec(model, opts);
    c.getPower();
    assert.deepStrictEqual(writes, ['l RFPOWER\n'], label);
    feed('PC050;\n');
    assert.deepStrictEqual(powers, [], label);
  }
  for (const [name, m] of Object.entries(RIG_MODELS)) {
    if (m.brand === 'Yaesu' || m.brand === 'Kenwood') continue;
    const { c, writes } = codec(m);
    c.getPower();
    assert.ok(!writes.includes('w PC;\n'), name + ' sent ' + JSON.stringify(writes));
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
