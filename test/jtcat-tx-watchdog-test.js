#!/usr/bin/env node
'use strict';
// The FT8/FT4/FT2 transmit watchdog (lloyd KO4L 2026-10-25: "POTACAT will not
// cease transmissions after x number of connection attempts"). WSJT-X stops
// after a few minutes of transmitting with no progress; POTACAT now does too,
// at six minutes, on the attended-operator clock: the operator's own actions
// and real QSO progress pet it, automatic re-calls never do.
// Runs the real jtcatTxWatchdogTripped() from main.js against a fake clock.
// Run: node test/jtcat-tx-watchdog-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function extract(header) {
  const i = MAIN.indexOf(header);
  assert.ok(i >= 0, 'missing ' + header);
  const open = MAIN.indexOf(') {', i) + 2;
  let d = 0;
  for (let k = open; k < MAIN.length; k++) {
    if (MAIN[k] === '{') d++;
    else if (MAIN[k] === '}') { d--; if (d === 0) return MAIN.slice(i, k + 1); }
  }
  throw new Error('unbalanced');
}
const MS = Number(/const JTCAT_TX_WATCHDOG_MS = (\d+) \* 60 \* 1000;/.exec(MAIN)[1]) * 60000;

function harness() {
  const ctx = {
    now: 1_000_000_000,
    settings: { ultracat: false },
    jtcatFullAutoCq: false, jtcatAutoCqMode: 'off',
    jtcatFullAutoCqLastActivity: 0, _jtcatTxWatchArmedAt: 0,
    JTCAT_TX_WATCHDOG_MS: MS,
  };
  ctx.Date = { now: () => ctx.now };
  vm.createContext(ctx);
  vm.runInContext(extract('function jtcatTxWatchdogTripped(') + '\n' + extract('function jtcatNoteOperatorAtRadio('), ctx);
  return ctx;
}
const min = 60000;

test('six minutes, the WSJT-X figure', () => { assert.strictEqual(MS, 6 * min); });

test('a CQ the operator pressed transmits until six minutes pass with no answer', () => {
  const c = harness();
  vm.runInContext('jtcatNoteOperatorAtRadio()', c);
  c.now += 5 * min;
  assert.strictEqual(vm.runInContext("jtcatTxWatchdogTripped('FT8')", c), false);
  c.now += 1.5 * min;
  assert.strictEqual(vm.runInContext("jtcatTxWatchdogTripped('FT8')", c), true);
});

test('QSO progress or another operator action restarts the six minutes', () => {
  const c = harness();
  vm.runInContext('jtcatNoteOperatorAtRadio()', c);
  c.now += 5 * min;
  c.jtcatFullAutoCqLastActivity = c.now; // what the decode paths do when a QSO advances
  c.now += 5 * min;
  assert.strictEqual(vm.runInContext("jtcatTxWatchdogTripped('FT4')", c), false);
});

test('a first key-down with no operator stamp arms the clock instead of tripping', () => {
  const c = harness();
  assert.strictEqual(vm.runInContext("jtcatTxWatchdogTripped('FT8')", c), false);
  c.now += 7 * min;
  assert.strictEqual(vm.runInContext("jtcatTxWatchdogTripped('FT8')", c), true);
});

test('keyboard modes and WSPR are not watched', () => {
  const c = harness();
  vm.runInContext('jtcatNoteOperatorAtRadio()', c);
  c.now += 60 * min;
  for (const m of ['JTTY', 'PSK31', 'JS8', 'WSPR'])
    assert.strictEqual(vm.runInContext(`jtcatTxWatchdogTripped('${m}')`, c), false, m);
  assert.strictEqual(vm.runInContext("jtcatTxWatchdogTripped('FT2')", c), true);
});

test("ULTRACAT's Run and Hunt keep their own rules; plain Hunt is watched", () => {
  const c = harness();
  vm.runInContext('jtcatNoteOperatorAtRadio()', c);
  c.now += 10 * min;
  c.jtcatAutoCqMode = 'all';
  assert.strictEqual(vm.runInContext("jtcatTxWatchdogTripped('FT8')", c), true, 'Hunt without ULTRACAT');
  c.settings.ultracat = true;
  assert.strictEqual(vm.runInContext("jtcatTxWatchdogTripped('FT8')", c), false, 'Hunt with ULTRACAT');
  c.jtcatAutoCqMode = 'off';
  assert.strictEqual(vm.runInContext("jtcatTxWatchdogTripped('FT8')", c), true, 'ULTRACAT with neither running');
});

test('both key-downs refuse and stop when it trips', () => {
  assert.ok(/if \(jtcatTxWatchdogTripped\(ft8Engine && ft8Engine\._mode\)\) \{[\s\S]{0,160}jtcatTxWatchdogStop\(\);\s*return;/.test(MAIN), 'single slice');
  assert.ok(/if \(jtcatTxWatchdogTripped\(engine\._mode\)\) \{[\s\S]{0,160}jtcatTxWatchdogStop\(\);\s*return;/.test(MAIN), 'multi-slice');
});

test('the stop uses the one halt and tells every surface why', () => {
  const body = extract('function jtcatTxWatchdogStop(');
  assert.ok(/jtcatHaltTxNow\('TX watchdog'\)/.test(body));
  assert.ok(/send\('app-notice'/.test(body) && /jtcat-qso-state', \{ phase: 'error'/.test(body) && /broadcastJtcatQsoState\(\{ phase: 'error'/.test(body));
});

test('turning TX on counts as the operator, desktop and phone', () => {
  assert.ok(/ipcMain\.on\('jtcat-enable-tx', \(_e, enabled\) => \{\s*if \(enabled\) jtcatNoteOperatorAtRadio\(\);/.test(MAIN));
  assert.ok(/remoteServer\.on\('jtcat-enable-tx', \(\{ enabled \}\) => \{\s*if \(enabled\) jtcatNoteOperatorAtRadio\(\);/.test(MAIN));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
