#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// GitHub #700: an operator activated the same park two days running without
// pressing End. On the second launch the activation still looked live, then
// ended 33 s later ("no contacts for 6 hours") on the first 30 s tick: the
// saved activation-clock.json was reloaded, the parks matched, so the clock
// was kept, and it had already run out while POTACAT was closed.
//
// The #147 rule stands (a forgotten activation ends at the UTC day change or
// after 6 h idle). What changes: the saved clock is judged once at launch
// (lib/activation-clock.js atLaunch). One that ran out while POTACAT was
// closed ends the activation before any window or phone shows it as live,
// and the notice is shown when the main window has loaded.
//
// Run:  node test/activation-relaunch-700-test.js

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; return; }
  fail++; failures.push(msg); console.log(`  x ${msg}`);
}
function eq(actual, expected, msg) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(same, same ? msg : `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function section(name) { console.log(`\n=== ${name} ===`); }

const AC = require('../lib/activation-clock');
const at = (iso) => Date.parse(iso);

section('atLaunch: the saved clock judged once at launch');
{
  ok(typeof AC.atLaunch === 'function', 'lib/activation-clock exports atLaunch');
  if (typeof AC.atLaunch === 'function') {
    // The report: day 1 started 14:00 UTC, last contact 16:00, POTACAT closed
    // at 17:00; launched again the next day at 13:00 with the same park.
    const day1 = { startedAt: at('2026-11-15T14:00:00Z'), lastContactAt: at('2026-11-15T16:00:00Z'), refs: 'US-1234' };
    eq(AC.atLaunch(day1, 'US-1234', at('2026-11-16T13:00:00Z')), { action: 'end', reason: 'idle' },
      'the report: same park, the clock ran out while closed (6 h idle first) -> end at launch, not 33 s later');
    const lateDay1 = { startedAt: at('2026-11-15T21:00:00Z'), lastContactAt: at('2026-11-15T23:00:00Z'), refs: 'US-1234' };
    eq(AC.atLaunch(lateDay1, 'US-1234', at('2026-11-16T01:00:00Z')), { action: 'end', reason: 'day' },
      'same park, the UTC day changed while closed -> end at launch');
    // A restart in the middle of an activation keeps it.
    const running = { startedAt: at('2026-11-16T14:00:00Z'), lastContactAt: at('2026-11-16T15:00:00Z'), refs: 'US-1234' };
    eq(AC.atLaunch(running, 'US-1234', at('2026-11-16T15:10:00Z')), { action: 'keep', reason: null },
      'a restart 10 min after the last contact keeps the activation and its clock');
    // A different set of parks, or no saved clock: a new clock.
    eq(AC.atLaunch(day1, 'US-5678', at('2026-11-16T13:00:00Z')), { action: 'start', reason: null },
      'different parks: a new clock (the old one never applies)');
    eq(AC.atLaunch(null, 'US-1234', at('2026-11-16T13:00:00Z')), { action: 'start', reason: null }, 'no saved clock: a new clock');
    eq(AC.atLaunch('junk', 'US-1234', at('2026-11-16T13:00:00Z')), { action: 'start', reason: null }, 'a damaged file: a new clock');
  }
}

section('wiring: main.js judges the saved clock at launch');
{
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const i = main.indexOf('activationClockLoad();');
  ok(i > 0, 'main loads the saved clock at launch');
  const boot = main.slice(i, i + 1200);
  const judge = boot.indexOf('ActivationClock.atLaunch(');
  ok(judge > 0, 'the saved clock is judged with ActivationClock.atLaunch right after it is loaded');
  ok(judge > 0 && judge < boot.indexOf('activationClockFollow(false)'), 'it is judged before activationClockFollow keeps it');
  ok(judge > 0 && judge < boot.indexOf('setInterval(activationClockTick'), 'it is judged before the first tick');
  ok(/autoEndActivation\(/.test(boot.slice(judge)), 'one that ran out ends the activation the way the tick does');
  const dfl = main.slice(main.indexOf("win.webContents.on('did-finish-load'"), main.indexOf("win.webContents.on('did-finish-load'") + 4000);
  ok(/_activationLaunchNotice/.test(dfl), 'the main window gets the launch notice once it has loaded');
}

console.log('\n' + '='.repeat(56));
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('All tests passed.');
