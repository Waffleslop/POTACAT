'use strict';
// Yaesu CAT audit, FT-891 (2026-11-15): the model row against Yaesu's FT-891
// CAT Operation Reference rev 1909-C. Page numbers are the printed ones. The
// SH width and RG range were fixed the same day (#595, #597) and are tested in
// rig-test.js; this file covers the rest of the row.
//
// Run: node test/yaesu-audit-ft891-test.js

const assert = require('assert');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RIG_MODELS } = require('../lib/rig-models');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (err) { failed++; console.log('  FAIL ' + name + '\n       ' + (err.stack || err.message)); }
}

const MODEL = RIG_MODELS['FT-891'];
function codec() {
  const writes = [];
  const c = new KenwoodCodec(MODEL, (d) => writes.push(String(d)));
  const events = [];
  for (const e of ['agc', 'mode']) c.on(e, (v) => events.push([e, v]));
  return { c, writes, events };
}

console.log('\n=== Yaesu CAT audit: FT-891 (rev 1909-C) ===');

test('preamp p. 14 is IPO or AMP: PA00; and PA01;, never PA02;', () => {
  const { c, writes } = codec();
  assert.strictEqual(MODEL.preampSteps, undefined);
  c.setPreamp(false); c.setPreamp(true); c.setPreamp(2);
  assert.deepStrictEqual(writes, ['PA00;', 'PA01;', 'PA01;']);
});

test('ATT p. 15 stays on/off: RA01; and RA00;', () => {
  const { c, writes } = codec();
  c.setAttenuator(true); c.setAttenuator(false);
  assert.deepStrictEqual(writes, ['RA01;', 'RA00;']);
});

test('AGC p. 10: OFF GT00;, FAST GT01;, MID GT02;, SLOW GT03;, AUTO GT04;', () => {
  const { c, writes } = codec();
  for (const m of ['off', 'fast', 'med', 'slow', 'auto']) c.setAgc(m);
  assert.deepStrictEqual(writes, ['GT00;', 'GT01;', 'GT02;', 'GT03;', 'GT04;']);
});

test('AGC answer p. 10: GT00 reads OFF, GT04 reads AUTO (was swapped)', () => {
  const { c, events } = codec();
  c.onData('GT00;'); c.onData('GT04;');
  assert.deepStrictEqual(events.filter(e => e[0] === 'agc').map(e => e[1]), ['off', 'auto']);
});

test('PROC p. 14: PR01; on and PR00; off, never the PR1;/PR0; reads', () => {
  const { c, writes } = codec();
  c.setCompressor(true); c.setCompressor(false);
  assert.deepStrictEqual(writes, ['PR01;', 'PR00;']);
});

test('CW text with no key port pp. 10-11: KM5<text>; then KY5;, never "KY <text>;"', () => {
  const { c, writes } = codec();
  c.sendCwText('CQ POTA');
  assert.deepStrictEqual(writes, ['KM5CQ POTA;', 'KY5;']);
});

test('the CW Key Port stays the text path the model asks for', () => {
  assert.strictEqual(MODEL.cw.textMethod, 'dtr-key-port');
});

test('mode p. 11: MD09 reads RTTY, MD0C reads DIGU', () => {
  const { c, events } = codec();
  c.onData('MD09;'); c.onData('MD0C;');
  assert.deepStrictEqual(events.filter(e => e[0] === 'mode').map(e => e[1]), ['RTTY', 'DIGU']);
});

test('power p. 14 stays PC005-PC100', () => {
  const { c, writes } = codec();
  c.setTxPower(1); c.setTxPower(100);
  assert.deepStrictEqual(writes, ['PC005;', 'PC100;']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
