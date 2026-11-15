'use strict';
// Yaesu CAT audit, FTX-1 Field and Optima (2026-11-15): the model rows against
// Yaesu's FTX-1 CAT manual rev 2508-C (PDF page numbers). Everything the
// owners proved on their radios (KF4YHC, Hitman90210: power, meters, NB/DNR,
// AGC, clarifier, preamp targets, keyer memory) is left as it is; this covers
// the width and the mode readback, which nobody had checked.
//
// Run: node test/yaesu-audit-ftx1-test.js

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
  const modes = [];
  c.on('mode', (m) => modes.push(m));
  return { c, writes, modes };
}

console.log('\n=== Yaesu CAT audit: FTX-1 (rev 2508-C) ===');

for (const id of ['FTX-1 Field', 'FTX-1 Optima']) {
  test(`${id}: SSB width is SH00nn from Table 5 (p. 25): 2400 Hz SH0013;, 3000 Hz SH0020;, 4000 Hz SH0023;`, () => {
    const { c, writes } = codec(id);
    c._lastParsedMode = 'USB';
    c.setFilterWidth(2400); c.setFilterWidth(3000); c.setFilterWidth(4000); c.setFilterWidth(300);
    assert.deepStrictEqual(writes, ['SH0013;', 'SH0020;', 'SH0023;', 'SH0001;']);
  });

  test(`${id}: CW / DATA width from Table 5: 500 Hz SH0010;, 2400 Hz SH0017;`, () => {
    const { c, writes } = codec(id);
    c._lastParsedMode = 'CW';
    c.setFilterWidth(500); c.setFilterWidth(2400);
    c._lastParsedMode = 'DIGU';
    c.setFilterWidth(3000);
    assert.deepStrictEqual(writes, ['SH0010;', 'SH0017;', 'SH0018;']);
  });

  test(`${id}: MD09 reads RTTY, MD0E PSK, MD0F FM (p. 20); MD0C stays DIGU`, () => {
    const { c, modes } = codec(id);
    c.onData('MD09;'); c.onData('MD0E;'); c.onData('MD0F;'); c.onData('MD0C;');
    assert.deepStrictEqual(modes, ['RTTY', 'PSK', 'FM', 'DIGU']);
  });

  test(`${id}: the owner-proven power form is unchanged`, () => {
    const { c, writes } = codec(id);
    c.setTxPower(5);
    assert.deepStrictEqual(writes, [id === 'FTX-1 Field' ? 'PC1005;' : 'PC2005;']);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
