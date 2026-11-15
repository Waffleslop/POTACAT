'use strict';
// Yaesu CAT audit (Casey, 2026-11-15): CW break-in delay, SD.
//
// The FT-710, FTDX10 and FTDX101 take SD P1 P1, two digits, an index:
// 00 = 30 ms, 01 = 50, 02 = 100, 03 = 150, 04 = 200, 05 = 250, then
// 06-33 = 300-3000 ms in 100 ms steps (FT-710 CAT reference 2306-C p.20,
// FTDX10 2308-F p.21, FTDX101MP/D 2308-L p.21). POTACAT sent four digits
// one step off (300 ms went out as SD0007;) and read SD06; (300 ms) back as
// 250 ms, so the stuck-transmit check could come one step early.
// Models without sdFormat keep the old bytes.
//
// Run: node test/yaesu-sd-break-in-delay-test.js

const assert = require('assert');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RIG_MODELS } = require('../lib/rig-models');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (err) { failed++; console.log('  FAIL ' + name + '\n       ' + (err.stack || err.message)); }
}

function codec(id) {
  const writes = [];
  const c = new KenwoodCodec(RIG_MODELS[id], (d) => writes.push(String(d)));
  return { c, writes };
}

console.log('\n=== Yaesu SD (CW break-in delay) ===');

for (const id of ['FT-710', 'FTDX10', 'FTDX101D/MP']) {
  test(`${id}: set sends the two-digit index from the manual`, () => {
    for (const [ms, want] of [[30, 'SD00;'], [50, 'SD01;'], [100, 'SD02;'], [250, 'SD05;'], [300, 'SD06;'], [400, 'SD07;'], [2900, 'SD32;'], [3000, 'SD33;'], [9000, 'SD33;'], [0, 'SD00;']]) {
      const { c, writes } = codec(id);
      c.setBreakInDelay(ms);
      assert.deepStrictEqual(writes, [want], `${ms} ms`);
    }
  });

  test(`${id}: replies read as the manual's milliseconds`, () => {
    for (const [reply, want] of [['SD00', 30], ['SD05', 250], ['SD06', 300], ['SD07', 400], ['SD33', 3000]]) {
      const { c } = codec(id);
      let got = null;
      c.on('breakInDelay', (ms) => { got = ms; });
      c.onData(reply + ';');
      assert.strictEqual(got, want, reply);
    }
  });
}

test('a Yaesu without sdFormat keeps the old four-digit bytes', () => {
  const { c, writes } = codec('FT-891');
  c.setBreakInDelay(300);
  assert.deepStrictEqual(writes, ['SD0007;']);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
