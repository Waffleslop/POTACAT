// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// #1128 (M5DZH): the TS-2000 answered "?" (command error) to every S-meter
// poll, once a second, because it was sent a bare SM; . Its meter query takes
// P1 (0 = main receiver), as Hamlib kenwood.c sends for the TS-2000 (SM0),
// and the reply is SM + P1 + four digits on the Kenwood 0-30 scale, S9 = 15.

const assert = require('assert');
const { RIG_MODELS } = require('../lib/rig-models');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ok  ' + name); }

test('TS-2000 asks the main receiver S-meter with SM0;', () => {
  const out = [];
  const c = new KenwoodCodec(RIG_MODELS['TS-2000'], (d) => out.push(String(d)));
  c.getSmeter();
  assert.deepStrictEqual(out, ['SM0;']);
  assert.ok(!out.includes('SM;'), 'never the bare SM; the radio rejects');
});

test('TS-2000 S-meter reply SM00015; is S9 on the wire scale', () => {
  const c = new KenwoodCodec(RIG_MODELS['TS-2000'], () => {});
  let s = null;
  c.on('smeter', (v) => { s = v; });
  c.getSmeter();
  c.onData('SM00015;');
  assert.strictEqual(s, 120);
  c.getSmeter();
  c.onData('SM00000;');
  assert.strictEqual(s, 0);
});

console.log(`ts2000-smeter-test: ${passed} passed`);
