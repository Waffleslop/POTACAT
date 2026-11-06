#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// The VFO window's "Type a frequency" box takes a paste (hoogskev
// 2026-10-31). lib/freq-paste.js reads what people copy; the window fills
// type-to-tune with it and Enter tunes, as for typed digits.
// Run: node test/freq-paste-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parsePastedFreq } = require('../lib/freq-paste');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('what people copy', () => {
  const cases = {
    '14.074': 14074, ' 14.074 ': 14074, '14,074': 14074, '14074 kHz': 14074, '14.074 MHz': 14074,
    '14074000 Hz': 14074, '14.074.000': 14074, '14,074.5': 14074.5, '7185': 7185, '7.1855': 7185.5,
    '50.313': 50313, '146520': 146520, '146.52 MHz': 146520,
  };
  for (const [t, khz] of Object.entries(cases)) assert.ok(Math.abs(parsePastedFreq(t) - khz) < 1e-6, `${JSON.stringify(t)} -> ${parsePastedFreq(t)}, want ${khz}`);
});
test('not a frequency', () => {
  for (const t of ['', 'hello', 'K3SBP', '14.074 W', '-7.1', null]) assert.strictEqual(parsePastedFreq(t), 0, JSON.stringify(t));
});
test('the VFO window listens for paste, fills the keypad, and leaves tuning to Enter', () => {
  const vfo = readSrc(path.join(__dirname, '..', 'renderer', 'vfo-popout.html'));
  assert.ok(vfo.includes('<script src="../lib/freq-paste.js"></script>'));
  const h = vfo.slice(vfo.indexOf("document.addEventListener('paste'"), vfo.indexOf("document.addEventListener('paste'") + 900);
  assert.ok(/window\.FreqPaste\.parsePastedFreq\(text\)/.test(h));
  assert.ok(/showPane\('keypad'\);\s*kpBuffer = fmtMhz\(khz\);\s*kpRender\(\);/.test(h));
  assert.ok(!/kpGo\.click\(\)/.test(h), 'a paste never tunes by itself');
  assert.ok(/t !== kpInput && t && \(t\.tagName === 'INPUT'/.test(h), 'other text fields keep their own paste');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
