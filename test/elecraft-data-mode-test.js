#!/usr/bin/env node
'use strict';
/**
 * Elecraft K3/K3S/KX2/KX3 DATA mode. Elecraft's Programmer's Reference
 * (rev G5, p. 11 and 16): DATA is MD6; (MD9; = DATA-REV), and DT picks the
 * data sub-mode only once the radio is in DATA; DT0 = DATA A, the setting for
 * FT8/WSPR. POTACAT sent MD2;DT1; (USB, then AFSK A, ignored outside DATA),
 * which left these radios in plain USB. Found by the website session's check
 * of the manuals, 2026-11-01.
 *
 * Run: node test/elecraft-data-mode-test.js
 */
const assert = require('assert');
const { RIG_MODELS } = require('../lib/rig-models');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

function sent(model, mode, hz = 14074000) {
  const out = [];
  const c = new KenwoodCodec(RIG_MODELS[model], (d) => out.push(d));
  c.setMode(mode, hz);
  return out.join('');
}
function parsed(model, md) {
  const c = new KenwoodCodec(RIG_MODELS[model], () => {});
  let got = null;
  c.on('mode', (m) => { got = m; });
  c.onData(`MD${md};`);
  return got;
}

for (const model of ['K3/K3S', 'KX2/KX3']) {
  test(`${model}: FT8, FT4, FT2 and DIGU are MD6 then DT0`, () => {
    for (const m of ['FT8', 'FT4', 'FT2', 'DIGU', 'PKTUSB']) assert.strictEqual(sent(model, m), 'MD6;DT0;', m);
  });
  test(`${model}: DIGL is DATA-REV, MD9 then DT0`, () => {
    assert.strictEqual(sent(model, 'DIGL', 7074000), 'MD9;DT0;');
  });
  test(`${model}: voice modes send no DT at all`, () => {
    assert.strictEqual(sent(model, 'USB'), 'MD2;');
    assert.strictEqual(sent(model, 'LSB', 7200000), 'MD1;');
    assert.strictEqual(sent(model, 'SSB', 14250000), 'MD2;');
    assert.strictEqual(sent(model, 'AM'), 'MD5;');
  });
  test(`${model}: never the old MD2;DT1;`, () => {
    for (const m of ['FT8', 'DIGU']) assert.ok(!/DT1;/.test(sent(model, m)) && !/^MD2;/.test(sent(model, m)), m);
  });
  test(`${model}: MD6 reads back as data mode (DIGU), MD9 as DIGL`, () => {
    assert.strictEqual(parsed(model, 6), 'DIGU');
    assert.strictEqual(parsed(model, 9), 'DIGL');
  });
}

test('the K4 and a Kenwood TS-590 are unchanged', () => {
  assert.strictEqual(sent('K4/K4D', 'FT8'), 'DT0;MD6;');
  assert.strictEqual(sent('TS-590S/SG', 'FT8'), 'MD2;DA1;');
  assert.strictEqual(sent('TS-590S/SG', 'USB'), 'DA0;MD2;');
});

console.log(`\nElecraft data mode: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
