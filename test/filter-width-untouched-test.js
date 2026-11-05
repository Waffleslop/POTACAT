#!/usr/bin/env node
'use strict';
// A spot click leaves the filter width alone (jarhd FTDX10 CW forced to
// 500 Hz, k8iko, WF4I #99). Rule: a tune sends a width only when a rig preset
// or the operator's own per-mode Filter Width setting asks for one; a mode
// change by itself never resets the radio's filter.
// Run: node test/filter-width-untouched-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { GENERIC_CAPS, RIG_MODELS } = require('../lib/rig-models');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
function codec(model) {
  const writes = [];
  const c = new RigctldCodec(model, (d) => writes.push(String(d)));
  return { c, writes };
}

test('rigctld: USB -> CW keeps the radio\'s CW width (M CW -1, not M CW 500)', () => {
  const { c, writes } = codec(GENERIC_CAPS.rigctld);
  c.setMode('USB', 14250000);
  c.setMode('CW', 14030000);
  assert.strictEqual(writes[writes.length - 1], 'M CW -1\n');
});

test('rigctld: CW -> FT8 keeps the radio\'s DATA width (no forced 3000)', () => {
  const { c, writes } = codec(GENERIC_CAPS.rigctld);
  c.setMode('CW', 14030000);
  c.setMode('FT8', 14074000);
  assert.strictEqual(writes[writes.length - 1], 'M PKTUSB -1\n');
});

test('rigctld: an FTDX10 through Hamlib, any mode change, never a width', () => {
  const m = RIG_MODELS.FTDX10 || RIG_MODELS['FTDX-10'] || GENERIC_CAPS.rigctld;
  const { c, writes } = codec({ ...m, brand: 'Hamlib', protocol: 'rigctld', caps: { ...(m.caps || {}), filter: true } });
  for (const [mode, hz] of [['USB', 14250000], ['CW', 14030000], ['LSB', 7200000], ['FT8', 7074000], ['AM', 7290000]]) c.setMode(mode, hz);
  const ms = writes.filter((w) => /^M /.test(w));
  assert.ok(ms.every((w) => / -1\n$/.test(w)), ms.join(''));
});

test('an explicit width (Filter Width setting / rig preset) still goes out', () => {
  const { c, writes } = codec(GENERIC_CAPS.rigctld);
  c.setMode('CW', 14030000);
  c.setFilterWidth(400);
  assert.ok(writes.some((w) => /^M CW 400\n$/.test(w)), writes.join(''));
});

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
test('a width set on the rig panel is not saved as the per-mode Filter Width', () => {
  const i = main.indexOf("case 'set-filter-width': {");
  const body = main.slice(i, main.indexOf('break;\n      }', i));
  assert.ok(i > 0);
  assert.ok(!/settings\.(cw|ssb|digital)FilterWidth\s*=/.test(body), body);
});

test('a tune sends the per-mode setting only, and nothing inside the same mode family', () => {
  const i = main.indexOf('function _modeCategory(mm)');
  const body = main.slice(i, i + 2500);
  assert.ok(/if \(sameCategory\) \{[\s\S]*?filterWidth = 0;/.test(body));
  assert.ok(/filterWidth = settings\.cwFilterWidth \|\| 0;/.test(body));
});

console.log(`\nfilter width untouched: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
