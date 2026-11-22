#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
/**
 * VK4KTW (#804): a voice tune (an SSB spot, 7.144 LSB) stops the FT8 engine.
 * An FT8 spot click on the band and mode the JTCAT window already shows then
 * only armed the spot target: spotTargetResync reached selectBand (which
 * restarts a stopped engine) only on a band or mode mismatch, so Band
 * Activity stayed "Stopped" for good. A spot click on a stopped engine must
 * start it, same band or not. Runs the real function from the window source
 * against stubs.
 */
const assert = require('assert');
const path = require('path');
const pop = readSrc(path.join(__dirname, '..', 'renderer/jtcat-popout.js'));

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

function extractFn(src, name) {
  const at = src.indexOf('function ' + name + '(');
  assert.ok(at >= 0, name + ' not found');
  let depth = 0, i = src.indexOf('{', at);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(at, i + 1);
}

function btn(band, freq) {
  const cls = new Set();
  return { dataset: { band, freq: String(freq) }, classList: {
    add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
  } };
}

// Runs spotTargetResync with the window's state stubbed. Returns what it did.
function run({ engineStopped, mode, activeBand, spot }) {
  const btns = [btn('20m', 14074), btn('40m', 7074), btn('17m', 18100)];
  const active = btns.find((b) => b.dataset.band === activeBand);
  active.classList.add('active');
  const calls = { selectBand: [], modeChange: 0 };
  const modeSelect = { value: mode, dispatchEvent: () => { calls.modeChange++; } };
  const document = {
    querySelectorAll: () => btns,
    querySelector: () => btns.find((b) => b.classList.contains('active')) || null,
  };
  function selectBand(b, save) { calls.selectBand.push([b.dataset.band, save]); }
  function Event(t) { this.type = t; }
  const body = extractFn(pop, 'spotTargetResync');
  const f = Function('document', 'modeSelect', 'selectBand', 'Event', 'engineStopped',
    body + '\nreturn spotTargetResync;')(document, modeSelect, selectBand, Event, engineStopped);
  f(spot);
  return calls;
}

check('stopped engine, same band and mode: the spot click restarts it (selectBand)', () => {
  const c = run({ engineStopped: true, mode: 'FT8', activeBand: '40m', spot: { mode: 'FT8', freqKhz: 7074 } });
  assert.deepStrictEqual(c.selectBand, [['40m', true]]);
});
check('running engine, same band and mode: no-op (heard refreshes every cycle)', () => {
  const c = run({ engineStopped: false, mode: 'FT8', activeBand: '40m', spot: { mode: 'FT8', freqKhz: 7074 } });
  assert.deepStrictEqual(c.selectBand, []);
  assert.strictEqual(c.modeChange, 0);
});
check('running engine, other band: selectBand as before', () => {
  const c = run({ engineStopped: false, mode: 'FT8', activeBand: '20m', spot: { mode: 'FT8', freqKhz: 7074 } });
  assert.deepStrictEqual(c.selectBand, [['40m', true]]);
});
check('other mode: goes through the mode select change, not selectBand', () => {
  const c = run({ engineStopped: true, mode: 'FT8', activeBand: '40m', spot: { mode: 'FT4', freqKhz: 7047 } });
  assert.strictEqual(c.modeChange, 1);
  assert.deepStrictEqual(c.selectBand, []);
});
check('JS8 spots are left to the JS8 window', () => {
  const c = run({ engineStopped: true, mode: 'FT8', activeBand: '40m', spot: { mode: 'JS8', freqKhz: 7078 } });
  assert.deepStrictEqual(c.selectBand, []);
  assert.strictEqual(c.modeChange, 0);
});
check('selectBand still starts a stopped engine before tuning', () => {
  const fn = extractFn(pop, 'selectBand');
  assert.ok(/if \(engineStopped\) \{\s+window\.api\.jtcatStart\(modeSelect\.value\);\s+setEngineStopped\(false\);/.test(fn));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
