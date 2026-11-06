#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Typing a UHF or 23 cm frequency in kHz in the VFO window (davidcappello,
// IC-9700 over LAN). Bare digits above 300000 were always read as Hz, so
// 432100 tuned 0.4321 MHz and 1296100 tuned 1.2961 MHz, which the radio
// refused, and the Recent button replayed the same wrong frequency. Above
// 300000 a number is still Hz when that is an amateur band (14074000, 30 m's
// 10136000), and kHz when only that reading is one.
// Run: node test/vfo-typed-freq-uhf-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { typedToKhz, parsePastedFreq } = require('../lib/freq-paste');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

test('70 cm and 23 cm typed in kHz tune there', () => {
  assert.strictEqual(typedToKhz('432100'), 432100);
  assert.strictEqual(typedToKhz('1296100'), 1296100);
  assert.strictEqual(typedToKhz('446000'), 446000);
  assert.strictEqual(parsePastedFreq('1296100'), 1296100);
});

test('HF typed in Hz is still Hz', () => {
  assert.strictEqual(typedToKhz('14074000'), 14074);
  assert.strictEqual(typedToKhz('10136000'), 10136, '30 m, not 3 cm');
  assert.strictEqual(typedToKhz('3500000'), 3500, '80 m, not 9 cm');
  assert.strictEqual(typedToKhz('7074000'), 7074);
});

test('short-wave typed in Hz never lands on a microwave band', () => {
  assert.strictEqual(typedToKhz('10000000'), 10000, 'WWV 10 MHz, not 10 GHz');
  assert.strictEqual(typedToKhz('5900000'), 5900, '49 m broadcast, not 5.9 GHz');
  assert.strictEqual(typedToKhz('3400000'), 3400, 'not 3.4 GHz');
  assert.strictEqual(typedToKhz('2300000'), 2300, 'not 2.3 GHz');
  assert.strictEqual(typedToKhz('915000'), 915, 'AM broadcast, not 33 cm');
  assert.strictEqual(parsePastedFreq('10000000'), 10000);
});

test('2 m, 1.25 m, 70 cm and 23 cm typed in kHz go to kHz', () => {
  assert.strictEqual(typedToKhz('432100'), 432100);
  assert.strictEqual(typedToKhz('1296100'), 1296100);
  assert.strictEqual(typedToKhz('223500'), 223500);
});

test('the rest of the keypad rule is unchanged', () => {
  assert.strictEqual(typedToKhz('14074'), 14074);
  assert.strictEqual(typedToKhz('144200'), 144200);
  assert.strictEqual(typedToKhz('7.074'), 7074);
  assert.strictEqual(typedToKhz('1296.1'), 1296100);
  assert.strictEqual(typedToKhz('146'), 146000);
  assert.strictEqual(typedToKhz(''), 0);
  assert.strictEqual(typedToKhz('.'), 0);
});

test('the VFO window types, previews and tunes with that one rule', () => {
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'vfo-popout.html'));
  assert.ok(/function kpTargetKhz\(buf\) \{\n  return window\.FreqPaste \? window\.FreqPaste\.typedToKhz\(buf\) : 0;\n\}/.test(html));
  const go = html.slice(html.indexOf("kpGo.addEventListener('click'"), html.indexOf("kpGo.addEventListener('click'") + 600);
  assert.ok(/const khz = kpTargetKhz\(kpBuffer\);/.test(go), go);
  assert.ok(!/val > 300000/.test(go));
});

console.log(`\nVFO typed UHF: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
