#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Transmit-safety review of d7500aac (HIGH): an else-if was hung on the
// voice-hint line, so every forced-DATA key-down (SSTV/Winlink on an Icom,
// Mercury: no voice check) ran cat.tune() after setModeOnly(). tune() re-sent
// the mode at +200 ms, while keyed (the clip 6d88bb7d fixed), and wrote the
// frequency, which takes an IC-705/IC-7100 out of a repeater memory (nj7n's
// case, the reason for noAnchor). This runs main's own block.
// Run: node test/forced-data-no-tune-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const main = readSrc(path.join(__dirname, '..', 'main.js')).replace(/\r\n/g, '\n');

// The key-down's mode block: from "if (cat && cat.connected) {" holding the
// setModeOnly call, to its closing brace.
function block() {
  const at = main.indexOf('if (cat.setModeOnly) cat.setModeOnly(dataMode, _ssbFreqBeforePtt');
  const start = main.lastIndexOf('if (cat && cat.connected) {', at);
  let d = 0, i = main.indexOf('{', start);
  for (let j = i; j < main.length; j++) {
    if (main[j] === '{') d++;
    else if (main[j] === '}' && --d === 0) return main.slice(start, j + 1);
  }
  throw new Error('block not found');
}

function run({ voiceCheck, icom, hasSetModeOnly = true }) {
  const calls = [];
  const cat = { connected: true, tune: (hz, m) => calls.push(['tune', hz, m]) };
  if (hasSetModeOnly) cat.setModeOnly = (m, hz, o) => calls.push(['setModeOnly', m, hz, o.noAnchor]);
  const ctx = { cat, calls, dataMode: 'USB-D', _ssbFreqBeforePtt: 146520000, _icomData: icom, _voiceTxCheck: voiceCheck, _dataSwapSince: 0, Date };
  vm.createContext(ctx);
  vm.runInContext(block(), ctx);
  return { calls, voiceCheck: ctx._voiceTxCheck };
}

test('an Icom in a repeater memory, forced into DATA (SSTV/Winlink, no voice check): mode only, no frequency write', () => {
  const { calls } = run({ voiceCheck: null, icom: true });
  assert.deepStrictEqual(calls, [['setModeOnly', 'USB-D', 146520000, true]], JSON.stringify(calls));
});

test('a voice over still records the DATA mode for its hint, and still never tunes', () => {
  const vc = { mode: 'USB' };
  const { calls, voiceCheck } = run({ voiceCheck: vc, icom: false });
  assert.deepStrictEqual(calls.map((c) => c[0]), ['setModeOnly']);
  assert.strictEqual(voiceCheck.mode, 'USB-D');
});

test('a codec with no mode-only set falls back to tune, as before d7500aac', () => {
  const { calls } = run({ voiceCheck: null, icom: false, hasSetModeOnly: false });
  assert.deepStrictEqual(calls, [['tune', 146520000, 'USB-D']]);
});

console.log(`\nForced DATA never tunes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
