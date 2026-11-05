#!/usr/bin/env node
'use strict';
// level_death 2026-11-04: an FT8 spot at 7075 should tune 7074.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { snapToDial } = require('../lib/dial-snap');
const { freqsForMode } = require('../lib/ft8-engine');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
check('FT8 7075 -> 7074; 7073.6 -> 7074; 7077.5 stays', () => {
  assert.strictEqual(snapToDial(7075000, 'FT8', freqsForMode), 7074000);
  assert.strictEqual(snapToDial(7073600, 'ft8', freqsForMode), 7074000);
  assert.strictEqual(snapToDial(7077500, 'FT8', freqsForMode), null);
});
check('FT4 uses the FT4 dial (40 m 7047.5), never the FT8 one', () => {
  assert.strictEqual(snapToDial(7048800, 'FT4', freqsForMode), 7047500);
  assert.strictEqual(snapToDial(7075000, 'FT4', freqsForMode), null);
});
check('already on the dial, other modes, nonsense: unchanged', () => {
  assert.strictEqual(snapToDial(7074000, 'FT8', freqsForMode), null);
  assert.strictEqual(snapToDial(7075000, 'CW', freqsForMode), null);
  assert.strictEqual(snapToDial(7075000, 'DIGU', freqsForMode), null, "JTCAT's own QSYs say DIGU");
  assert.strictEqual(snapToDial(NaN, 'FT8', freqsForMode), null);
});
check('adjacent dials never steal each other (17 m FT8 18100 / FT4 18104, 20 m FT4 14080 / FT2 14084)', () => {
  assert.strictEqual(snapToDial(18102500, 'FT8', freqsForMode), 18100000);
  assert.strictEqual(snapToDial(18104500, 'FT4', freqsForMode), 18104000);
  assert.strictEqual(snapToDial(14082000, 'FT4', freqsForMode), 14080000);
  assert.strictEqual(snapToDial(14085000, 'FT2', freqsForMode), 14084000);
});
check('tuneRadio applies it before anything moves, and says so', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const fn = main.slice(main.indexOf('function tuneRadio('), main.indexOf('function tuneRadio(') + 1500);
  assert.ok(/DialSnap\.snapToDial\(freqHz, mode, freqsForMode\)/.test(fn));
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
