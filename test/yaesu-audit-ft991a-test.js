'use strict';
// Yaesu CAT audit, FT-991/991A (2026-11-15): the model row against Yaesu's
// FT-991A CAT Operation Reference rev 1711-D. Page numbers are the printed
// ones. Every byte here is what the manual defines; the one deliberate
// departure (PR, see below) is named in the model row.
//
// Run: node test/yaesu-audit-ft991a-test.js

const assert = require('assert');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RIG_MODELS } = require('../lib/rig-models');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (err) { failed++; console.log('  FAIL ' + name + '\n       ' + (err.stack || err.message)); }
}

const MODEL = RIG_MODELS['FT-991/991A'];
function codec() {
  const writes = [];
  const c = new KenwoodCodec(MODEL, (d) => writes.push(String(d)));
  const events = [];
  for (const e of ['agc', 'mode']) c.on(e, (v) => events.push([e, v]));
  return { c, writes, events };
}

console.log('\n=== Yaesu CAT audit: FT-991/991A (rev 1711-D) ===');

test('SSB width chart p. 16: 2200/2300/2400 Hz are SH012;/SH013;/SH014;', () => {
  const { c, writes } = codec();
  c._lastParsedMode = 'USB';
  c.setFilterWidth(2200); c.setFilterWidth(2300); c.setFilterWidth(2400);
  c.setFilterWidth(1950); c.setFilterWidth(3200);
  assert.deepStrictEqual(writes, ['SH012;', 'SH013;', 'SH014;', 'SH010;', 'SH021;']);
});

test('CW width chart p. 16 is unchanged: 500 Hz SH010;, 2400 Hz SH016;', () => {
  const { c, writes } = codec();
  c._lastParsedMode = 'CW';
  c.setFilterWidth(500); c.setFilterWidth(2400);
  assert.deepStrictEqual(writes, ['SH010;', 'SH016;']);
});

test('AGC p. 10: OFF GT00;, FAST GT01;, MID GT02;, SLOW GT03;, AUTO GT04;', () => {
  const { c, writes } = codec();
  for (const m of ['off', 'fast', 'med', 'slow', 'auto']) c.setAgc(m);
  assert.deepStrictEqual(writes, ['GT00;', 'GT01;', 'GT02;', 'GT03;', 'GT04;']);
});

test('AGC answer p. 10: GT00 reads OFF, GT04 reads AUTO (was swapped)', () => {
  const { c, events } = codec();
  c.onData('GT00;'); c.onData('GT04;'); c.onData('GT03;');
  assert.deepStrictEqual(events.filter(e => e[0] === 'agc').map(e => e[1]), ['off', 'auto', 'slow']);
});

test('ATT p. 15 is on/off: RA01; and RA00;, never RA02;/RA03;', () => {
  const { c, writes } = codec();
  assert.strictEqual(MODEL.attSteps, undefined);
  c.setAttenuator(true); c.setAttenuator(12); c.setAttenuator(18); c.setAttenuator(false);
  assert.deepStrictEqual(writes, ['RA01;', 'RA01;', 'RA01;', 'RA00;']);
});

test('preamp p. 14 keeps IPO / AMP1 / AMP2: PA00; PA01; PA02;', () => {
  const { c, writes } = codec();
  c.setPreamp(0); c.setPreamp(1); c.setPreamp(2);
  assert.deepStrictEqual(writes, ['PA00;', 'PA01;', 'PA02;']);
});

test('PROC p. 14: PR01; on and PR00; off, never the PR1;/PR0; reads', () => {
  const { c, writes } = codec();
  c.setCompressor(true); c.setCompressor(false);
  assert.deepStrictEqual(writes, ['PR01;', 'PR00;']);
});

test('power p. 14 is PC005-PC100: 2 W is sent as PC005;', () => {
  const { c, writes } = codec();
  c.setTxPower(2); c.setTxPower(100);
  assert.deepStrictEqual(writes, ['PC005;', 'PC100;']);
});

test('CW text pp. 10-11: KM5<text>; then KY5;, never "KY0 <text>;"', () => {
  const { c, writes } = codec();
  c.sendCwText('CQ POTA K3SBP');
  assert.deepStrictEqual(writes, ['KM5CQ POTA K3SBP;', 'KY5;']);
});

test('CW text longer than one memory goes 50 characters at a time', () => {
  const { c, writes } = codec();
  const text = 'A'.repeat(60);
  c.sendCwText(text);
  assert.deepStrictEqual(writes, ['KM5' + 'A'.repeat(50) + ';', 'KY5;', 'KM5' + 'A'.repeat(10) + ';', 'KY5;']);
});

test('no KY stop is defined on this radio: Stop sends nothing extra', () => {
  const { c, writes } = codec();
  assert.strictEqual(c.stopCwPlayback(), false);
  assert.deepStrictEqual(writes, []);
});

test('mode p. 11: MD09 (RTTY-USB) reads RTTY, MD0C reads DIGU, MD08 DIGL', () => {
  const { c, events } = codec();
  c.onData('MD09;'); c.onData('MD0C;'); c.onData('MD08;');
  assert.deepStrictEqual(events.filter(e => e[0] === 'mode').map(e => e[1]), ['RTTY', 'DIGU', 'DIGL']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
