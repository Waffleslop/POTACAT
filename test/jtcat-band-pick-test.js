#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
/**
 * artificialjumpprotection 11-03: 2 m WSPR tuned the FT8 dial (the JTCAT
 * window's WSPR table had no 2 m, and the old mode's dial stayed on the
 * button). bobve 10-30: after a voice/CW spot stopped the engine, a band or
 * FT8 spot pick moved the radio and "Switching to 17m..." waited for decodes
 * that could never come.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const pop = readSrc(path.join(ROOT, 'renderer/jtcat-popout.js'));
const web = readSrc(path.join(ROOT, 'renderer/remote.js'));
const main = readSrc(path.join(ROOT, 'main.js'));
const wsprBands = require('../lib/wspr/bands');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
function table(src) {
  const at = src.indexOf('WSPR_BAND_FREQS = {');
  const body = src.slice(at + 'WSPR_BAND_FREQS = '.length, src.indexOf('}', at) + 1);
  return Function('return ' + body)();
}
for (const [name, src] of [['JTCAT window', pop], ['ECHOCAT Web', web]]) {
  check(name + ': WSPR dials are exactly lib/wspr/bands.js (2 m included)', () => {
    const t = table(src);
    for (const [band, khz] of Object.entries(t)) {
      assert.ok(Math.abs(wsprBands.dialForBand(band) * 1000 - khz) < 0.01, band);
    }
    assert.strictEqual(t['2m'], 144489.0);
  });
}
check('a band with no dial in this mode keeps no dial from the last mode', () => {
  assert.ok(/btn\.dataset\.freq = table\[band\] \|\| '';/.test(pop));
  assert.ok(/if \(!\(freq > 0\)\) \{ showJtcatErrorToast\('No '/.test(pop));
});
check('selectBand starts a stopped engine before it tunes', () => {
  const fn = pop.slice(pop.indexOf('function selectBand(btn, save) {'), pop.indexOf('function selectBand(btn, save) {') + 1200);
  const start = fn.indexOf('window.api.jtcatStart(modeSelect.value)');
  const tune = fn.indexOf('window.api.tune(freq, modeSelect.value)');
  assert.ok(start > 0 && tune > start, 'start, then tune');
  assert.ok(/if \(engineStopped\) \{\s+window\.api\.jtcatStart/.test(fn));
});
check('a WSPR band from ECHOCAT with no freqKhz tunes the host-side dial', () => {
  const h = main.slice(main.indexOf("remoteServer.on('jtcat-set-band'"), main.indexOf("remoteServer.on('jtcat-set-band'") + 1200);
  assert.ok(/if \(mhz && !freqKhz\) \{\s+tuneRadio\(mhz \* 1000, 'DIGU'\);\s+_jtcatExpectedDialHz = Math\.round\(mhz \* 1e6\);/.test(h));
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
