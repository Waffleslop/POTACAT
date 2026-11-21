#!/usr/bin/env node
'use strict';
// #850 (jgedmond, TS-890S over Serial CAT): an FT8 spot left the radio in USB,
// not USB-D, with "Switch radio to DATA mode (PKTUSB) for FT8 / FT4 (JTCAT)"
// ticked. POTACAT sent MD2; then DA1;. Kenwood's TS-890S PC Control Command
// Reference Guide rev1 (2019-01) has no MD and no DA command: mode, data modes
// included, is OM (p. 51, PDF p. 52): set `OM P1 P2;` (P1 ignored), read
// `OM P1;`, answer `OM P1 P2;`, P2 D = USB-D, C = LSB-D, E = FM-D, F = AM-D.
// The radio took MD2 (USB) and answered the DA1 with `?;` (his log).
// Run: node test/kenwood-ts890-om-test.js

const assert = require('assert');
const { getModel } = require('../lib/rig-models');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

function codecFor(name) {
  const sent = [];
  const c = new KenwoodCodec(getModel(name), (s) => sent.push(s));
  const modes = [];
  c.on('mode', (m) => modes.push(m));
  return { c, sent, modes };
}

console.log('TS-890S mode over OM (#850)');

test('FT8 sets USB-D in one command, OM0D; and no MD or DA', () => {
  const { c, sent } = codecFor('TS-890S');
  c.setMode('FT8', 28074000);
  assert.deepStrictEqual(sent, ['OM0D;']);
});

test('every data mode name maps to the guide\'s data modes; voice modes to their own', () => {
  const want = { DIGU: 'OM0D;', PKTUSB: 'OM0D;', FT4: 'OM0D;', FT2: 'OM0D;', DIGL: 'OM0C;', PKTLSB: 'OM0C;',
    USB: 'OM02;', LSB: 'OM01;', CW: 'OM03;', FM: 'OM04;', AM: 'OM05;', RTTY: 'OM06;' };
  for (const [mode, cmd] of Object.entries(want)) {
    const { c, sent } = codecFor('TS-890S');
    c.setMode(mode, 14074000);
    assert.deepStrictEqual(sent, [cmd], mode);
    assert.ok(!sent.some((s) => /^(MD|DA)/.test(s)), mode + ': no MD or DA');
  }
});

test('SSB picks the sideband by frequency, over OM', () => {
  const { c, sent } = codecFor('TS-890S');
  c.setMode('SSB', 7200000);
  c.setMode('SSB', 14250000);
  assert.deepStrictEqual(sent, ['OM01;', 'OM02;']);
});

test('the mode is read with OM0; and its answer parsed (D = USB-D reads as DIGU)', () => {
  const { c, sent, modes } = codecFor('TS-890S');
  c.getMode();
  assert.deepStrictEqual(sent, ['OM0;']);
  c.onData(Buffer.from('OM0D;OM02;OM0C;OM03;OM07;'));
  assert.deepStrictEqual(modes, ['DIGU', 'USB', 'DIGL', 'CW', 'CW']);
});

test('the data flag is never asked with DA; on this radio', () => {
  const { c, sent } = codecFor('TS-890S');
  c.askDataState();
  assert.ok(!sent.includes('DA;'), sent.join(' '));
});

test('other Kenwoods are unchanged: the TS-590S/SG still sends MD2; then DA1;', () => {
  const { c, sent } = codecFor('TS-590S/SG');
  c.setMode('FT8', 14074000);
  assert.deepStrictEqual(sent, ['MD2;', 'DA1;']);
});

test('an OM reply on a radio that does not read its mode with OM is not taken as a mode', () => {
  const { c, modes } = codecFor('TS-590S/SG');
  c.onData(Buffer.from('OM0D;'));
  assert.deepStrictEqual(modes, []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
