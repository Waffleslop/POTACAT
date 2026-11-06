#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
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

test('rigctld: CW -> FT8 sends 3000, the one width a mode change still sets (FT8 needs ~3 kHz; the FT-991 DATA trap)', () => {
  const { c, writes } = codec(GENERIC_CAPS.rigctld);
  c.setMode('CW', 14030000);
  c.setMode('FT8', 14074000);
  assert.strictEqual(writes[writes.length - 1], 'M PKTUSB 3000\n');
});

test('rigctld: FT8 on another band, and PKTUSB <-> PKTLSB, keep the radio\'s width', () => {
  const { c, writes } = codec(GENERIC_CAPS.rigctld);
  c.setMode('FT8', 14074000);
  c.setMode('FT8', 7074000);
  c.setMode('PKTLSB', 7074000);
  const ms = writes.filter((w) => /^M /.test(w));
  assert.ok(ms.slice(1).every((w) => / -1\n$/.test(w)), ms.join(''));
});

test('rigctld: a configured Digital Filter Width still wins after the 3000', () => {
  const { c, writes } = codec(GENERIC_CAPS.rigctld);
  c.setMode('USB', 14250000);
  c.setMode('FT8', 14074000);
  c.setFilterWidth(2500);
  assert.ok(writes.some((w) => /^M PKTUSB 2500\n$/.test(w)), writes.join(''));
});

test('rigctld: an FTDX10 through Hamlib, any voice or CW mode change, never a width', () => {
  const m = RIG_MODELS.FTDX10 || RIG_MODELS['FTDX-10'] || GENERIC_CAPS.rigctld;
  const { c, writes } = codec({ ...m, brand: 'Hamlib', protocol: 'rigctld', caps: { ...(m.caps || {}), filter: true } });
  for (const [mode, hz] of [['USB', 14250000], ['CW', 14030000], ['LSB', 7200000], ['FT8', 7074000], ['AM', 7290000]]) c.setMode(mode, hz);
  const ms = writes.filter((w) => /^M /.test(w));
  assert.ok(ms.filter((w) => !/^M PKT/.test(w)).every((w) => / -1\n$/.test(w)), ms.join(''));
  assert.ok(ms.includes('M PKTUSB 3000\n'), ms.join(''));
});

test('an explicit width (Filter Width setting / rig preset) still goes out', () => {
  const { c, writes } = codec(GENERIC_CAPS.rigctld);
  c.setMode('CW', 14030000);
  c.setFilterWidth(400);
  assert.ok(writes.some((w) => /^M CW 400\n$/.test(w)), writes.join(''));
});

const main = readSrc(path.join(__dirname, '..', 'main.js'));
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

test('a width from Settings > Filter Width is named in the log when a tune sends it', () => {
  const i = main.indexOf('let filterWidth = 0;');
  const body = main.slice(i, main.indexOf('// FreeDV: auto-start/stop engine', i));
  assert.ok(i > 0);
  assert.ok(/if \(filterWidth > 0\) \{[\s\S]*sendCatLog\(`\[Tune\] \$\{fwName\} width \$\{filterWidth\} Hz from Settings > Filter Width/.test(body), body.slice(-600));
});

console.log(`\nfilter width untouched: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
