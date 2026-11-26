'use strict';
// FTX-1 preamp readback (hoogskev, after #997): the radio's own PA setting is
// read, so a radio already on AMP2 shows AMP2 when the VFO window opens instead
// of IPO. Bytes from the Yaesu FTX-1 CAT manual rev 2508-C, PA, PDF p.22:
// Read PA P1; Answer PA P1 P2; P1 0 HF/50, 1 VHF, 2 UHF; P2 (P1=0) 0 IPO,
// 1 AMP1, 2 AMP2; (P1=1/2) 0 off, 1 on.
//
// Run: node test/ftx1-preamp-readback-test.js

const assert = require('assert');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RIG_MODELS } = require('../lib/rig-models');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (err) { failed++; console.log('  FAIL ' + name + '\n       ' + (err.stack || err.message)); }
}

function codec(id, hz) {
  const writes = [];
  const c = new KenwoodCodec(RIG_MODELS[id], (d) => writes.push(String(d)));
  c._lastFreqHz = hz || 0;
  const steps = [];
  c.on('preampStep', (s) => steps.push(s));
  return { c, writes, steps };
}

console.log('\n=== FTX-1 preamp readback (PA, rev 2508-C p.22) ===');

for (const id of ['FTX-1 Field', 'FTX-1 Optima']) {
  test(`${id}: on 20 m the poll reads the HF/50 preamp with PA0;`, () => {
    const { c, writes } = codec(id, 14074000);
    c.getPreamp();
    assert.deepStrictEqual(writes, ['PA0;']);
  });

  test(`${id}: on 2 m it reads PA1;, on 70 cm PA2;`, () => {
    const a = codec(id, 144174000); a.c.getPreamp();
    const b = codec(id, 432100000); b.c.getPreamp();
    assert.deepStrictEqual(a.writes.concat(b.writes), ['PA1;', 'PA2;']);
  });

  test(`${id}: PA02; reads AMP2 (step 2), PA01; AMP1, PA00; IPO`, () => {
    const { c, steps } = codec(id, 14074000);
    c.onData('PA02;'); c.onData('PA01;'); c.onData('PA00;');
    assert.deepStrictEqual(steps, [2, 1, 0]);
  });

  test(`${id}: on 2 m PA11; reads on (step 1)`, () => {
    const { c, steps } = codec(id, 144174000);
    c.onData('PA11;');
    assert.deepStrictEqual(steps, [1]);
  });

  test(`${id}: another front end's answer does not move the shown preamp`, () => {
    const { c, steps } = codec(id, 14074000);
    c.onData('PA11;'); c.onData('PA21;');
    assert.deepStrictEqual(steps, []);
  });
}

test('FT-710 (no per-band preamp): no PA read is sent', () => {
  const { c, writes } = codec('FT-710', 14074000);
  c.getPreamp();
  assert.deepStrictEqual(writes, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
