#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// FT-710 band scope, SCU-LAN10 menu item EX030126 (GitHub #113 item 7).
// Pressing Enable reads the setting before writing it:
//   - radio says ON  -> no write, and POTACAT does not turn it off at close;
//   - radio says OFF -> write EX0301261;, and POTACAT turns it back off at close;
//   - no answer      -> no blind write, and nothing to undo at close.
// A setting POTACAT changes, POTACAT puts back; a setting it did not change, it leaves alone.
// Run: node test/sculan10-read-first-test.js
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
const YaesuScope = require('../lib/yaesu-scope');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
function bodyOf(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker);
  assert.ok(i >= 0, 'missing: ' + startMarker);
  const j = src.indexOf(endMarker, i + startMarker.length);
  return src.slice(i, j > i ? j : i + 4000);
}

const plan = (v) => {
  assert.strictEqual(typeof YaesuScope.scuLanEnablePlan, 'function', 'lib/yaesu-scope exports scuLanEnablePlan');
  return YaesuScope.scuLanEnablePlan(v);
};

test('already ON in the radio: no write, no flag, and it says it will be left on at close', () => {
  const p = plan('1');
  assert.strictEqual(p.write, null);
  assert.strictEqual(p.weSet, false);
  assert.ok(/already ON/.test(p.log) && /won't turn it off/.test(p.log), p.log);
});

test('OFF in the radio: write EX0301261;, set the flag, keep the existing log line', () => {
  const p = plan('0');
  assert.strictEqual(p.write, 'EX0301261;');
  assert.strictEqual(p.weSet, true);
  assert.ok(p.log.includes('turning SCU-LAN10 ON in the radio menu (EX0301261;)'), p.log);
  assert.ok(/turns it back off when the scope closes/.test(p.log), p.log);
});

test('no answer: no blind write, no flag, and the log says why', () => {
  for (const v of [null, undefined, '', 'x']) {
    const p = plan(v);
    assert.strictEqual(p.write, null, 'no write for ' + JSON.stringify(v));
    assert.strictEqual(p.weSet, false, 'no flag for ' + JSON.stringify(v));
    assert.ok(/did not answer/.test(p.log) && /not writing/i.test(p.log), p.log);
  }
});

const enable = bodyOf(main, 'function yaesuScopeEnableOnRadio() {', '\n}\n');

test('Enable reads EX030126 through yaesuScopeReadRadio before deciding, with the stale value cleared', () => {
  const clear = enable.indexOf('yaesuScopeState.scuLan = null');
  const read = enable.indexOf('await yaesuScopeReadRadio()');
  const decide = enable.indexOf('YaesuScope.scuLanEnablePlan(yaesuScopeState.scuLan)');
  assert.ok(clear >= 0, 'clears the stale state before reading');
  assert.ok(read > clear, 'awaits a fresh read');
  assert.ok(decide > read, 'decides from the fresh read');
});

test('Enable never sends EX0301261; on its own, and sets the flag only from the plan', () => {
  assert.ok(!/sendRaw\('EX0301261;'\)/.test(enable), 'no unconditional write');
  assert.ok(!/yaesuScopeScuLanWeSet = true/.test(enable), 'flag not hard-set');
  assert.ok(/yaesuScopeScuLanWeSet = plan\.weSet/.test(enable), 'flag from the plan');
  assert.ok(/if \(plan\.write\) cat\.sendRaw\(plan\.write\)/.test(enable), 'write only from the plan');
});

test('the Icom branch is unchanged and still first', () => {
  assert.ok(/^function yaesuScopeEnableOnRadio\(\) \{\n  if \(yaesuScopeState\.source === 'icom' \|\| icomScopeModel\(\)\) \{ icomScopeEnableOnRadio\(\); return; \}/.test(enable));
});

test('a read already in flight is awaited, not skipped', () => {
  const read = bodyOf(main, 'async function yaesuScopeReadRadio() {', '\n}\n');
  assert.ok(/yaesuScopeCatBusy\) return yaesuScopeReadInFlight;/.test(read), 'busy returns the in-flight read');
});

test('the stop path still turns it off only when POTACAT turned it on', () => {
  const stop = bodyOf(main, 'const scuLanOff = () => {', '};');
  assert.ok(/if \(!yaesuScopeScuLanWeSet\) return;/.test(stop));
  assert.ok(stop.includes("cat.sendRaw('EX0301260;')"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
