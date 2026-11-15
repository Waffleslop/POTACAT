'use strict';
// Yaesu CAT audit (Casey, 2026-11-15): the FTDX101D/MP row against its CAT
// reference, rev 2308-L. Every byte here is from that manual; none of it has
// been seen on an FTDX101 yet. The FT-710, which shares this CAT generation, does
// each of these on the air (test/rig-test.js, W3MDT 2026-10-22/23).
//
//  - SH P1 P2 P3, P1 0 MAIN, P2 fixed at 0, P3 00-21 from Table 3 (p.21, PDF p.22).
//  - GT0 P2 0 OFF, 1 FAST, 2 MID, 3 SLOW, 4 AUTO (p.13, PDF p.14).
//  - MD0 P2 9 RTTY-U, E PSK, F DATA-FM-N (p.15, PDF p.16).
//  - PC 005-100 on the D, 005-200 on the MP (p.18, PDF p.19).
//
// Run: node test/yaesu-audit-ftdx101-test.js

const assert = require('assert');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RIG_MODELS } = require('../lib/rig-models');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (err) { failed++; console.log('  FAIL ' + name + '\n       ' + (err.stack || err.message)); }
}

function codec(mode) {
  const writes = [];
  const c = new KenwoodCodec(RIG_MODELS['FTDX101D/MP'], (d) => writes.push(String(d)));
  if (mode) c._lastParsedMode = mode;
  return { c, writes };
}

console.log('\n=== FTDX101D/MP against CAT reference 2308-L ===');

test('width is SH00nn (main receiver), never the SH01nn the Yaesu default sends', () => {
  const { c, writes } = codec('USB');
  c.setFilterWidth(2400);
  assert.deepStrictEqual(writes, ['SH0014;']);
});

test('SSB widths index its own Table 3: 300 Hz = 01, 2200 = 12, 2300 = 13, 3200 = 21', () => {
  for (const [hz, want] of [[300, 'SH0001;'], [1200, 'SH0006;'], [2200, 'SH0012;'], [2300, 'SH0013;'], [2400, 'SH0014;'], [2700, 'SH0017;'], [3000, 'SH0020;'], [3200, 'SH0021;'], [4000, 'SH0021;']]) {
    const { c, writes } = codec('USB');
    c.setFilterWidth(hz);
    assert.deepStrictEqual(writes, [want], hz + ' Hz');
  }
});

test('CW, RTTY and DATA widths index the 18-entry CW column: 50 = 01, 500 = 10, 3000 = 18', () => {
  for (const mode of ['CW', 'RTTY', 'DIGU', 'PSK']) {
    for (const [hz, want] of [[50, 'SH0001;'], [500, 'SH0010;'], [1200, 'SH0013;'], [3000, 'SH0018;'], [4000, 'SH0018;']]) {
      const { c, writes } = codec(mode);
      c.setFilterWidth(hz);
      assert.deepStrictEqual(writes, [want], mode + ' ' + hz + ' Hz');
    }
  }
});

test('AGC: OFF is GT00, AUTO is GT04, and the replies read back the same way', () => {
  const sent = {};
  for (const m of ['off', 'fast', 'med', 'slow', 'auto']) {
    const { c, writes } = codec();
    c.setAgc(m);
    sent[m] = writes[0];
  }
  assert.deepStrictEqual(sent, { off: 'GT00;', fast: 'GT01;', med: 'GT02;', slow: 'GT03;', auto: 'GT04;' });
  for (const [reply, want] of [['GT00', 'off'], ['GT01', 'fast'], ['GT03', 'slow'], ['GT04', 'auto']]) {
    const { c } = codec();
    let got = null;
    c.on('agc', (m) => { got = m; });
    c.onData(reply + ';');
    assert.strictEqual(got, want, reply);
  }
});

test('mode replies: MD09 is RTTY, MD0E is PSK, MD0F is FM, MD0C stays DATA-U', () => {
  for (const [reply, want] of [['MD09', 'RTTY'], ['MD0E', 'PSK'], ['MD0F', 'FM'], ['MD0C', 'DIGU'], ['MD02', 'USB']]) {
    const { c } = codec();
    let got = null;
    c.on('mode', (m) => { got = m; });
    c.onData(reply + ';');
    assert.strictEqual(got, want, reply);
  }
});

test('power is clamped to 5-200 W: PC005 at the bottom, never PC004', () => {
  for (const [w, want] of [[1, 'PC005;'], [5, 'PC005;'], [150, 'PC150;'], [250, 'PC200;']]) {
    const { c, writes } = codec();
    c.setTxPower(w);
    assert.deepStrictEqual(writes, [want], w + ' W');
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
