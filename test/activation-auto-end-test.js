#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// GitHub #147: an activation that was never ended pulled 36 later home FT8
// contacts into the park log. Casey's rule (2026-11-07): a forgotten
// activation ends at the UTC day change or after 6 hours with no contacts,
// whichever comes first, with a notice saying so.
//
// lib/activation-clock.js is the rule (pure). The wiring guards hold main.js
// to checking it (a) before a contact is attached to the activation and
// (b) on a periodic tick, and to ending it the way a manual End does.
//
// Run:  node test/activation-auto-end-test.js

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

let AC = null;
try { AC = require('../lib/activation-clock'); } catch (e) { AC = null; }
ok(!!AC, 'lib/activation-clock.js exists');
if (!AC) finish();

const H = 3600 * 1000;
const at = (iso) => Date.parse(iso);

section('the rule table');
{
  // Started 14:00 UTC, last contact 15:00.
  const clock = { startedAt: at('2026-11-07T14:00:00Z'), lastContactAt: at('2026-11-07T15:00:00Z') };
  const cases = [
    // [name, time, live, reason]
    ['neither: 2 h after the last contact, same day', '2026-11-07T17:00:00Z', true, null],
    ['6 h idle: exactly 6 h after the last contact', '2026-11-07T21:00:00Z', false, 'idle'],
    ['just under 6 h idle is still live', '2026-11-07T20:59:59Z', true, null],
  ];
  for (const [name, t, live, reason] of cases) {
    const d = AC.decide(clock, at(t));
    eq(d.live, live, `${name}: live=${live}`);
    eq(d.reason, reason, `${name}: reason=${reason}`);
  }
  // Day change only: last contact 23:00, checked at 00:30 (1.5 h idle).
  const late = { startedAt: at('2026-11-07T20:00:00Z'), lastContactAt: at('2026-11-07T23:00:00Z') };
  let d = AC.decide(late, at('2026-11-08T00:30:00Z'));
  eq([d.live, d.reason], [false, 'day'], 'day change: 1.5 h idle but a new UTC day ends it');
  // Both: started 20:00, never a contact, checked next day 03:00 (7 h idle AND new day).
  const both = { startedAt: at('2026-11-07T20:00:00Z'), lastContactAt: 0 };
  d = AC.decide(both, at('2026-11-08T03:00:00Z'));
  eq(d.live, false, 'both: ended');
  eq(d.reason, 'day', 'both: the day change came first (00:00 before 02:00), so it is the reason');
  // Both, idle first: started 08:00, last contact 09:00, checked next day 01:00.
  const idleFirst = { startedAt: at('2026-11-07T08:00:00Z'), lastContactAt: at('2026-11-07T09:00:00Z') };
  d = AC.decide(idleFirst, at('2026-11-08T01:00:00Z'));
  eq([d.live, d.reason], [false, 'idle'], 'both: 6 h idle came first (15:00 before 00:00), so it is the reason');
  eq(d.endsAt, at('2026-11-07T15:00:00Z'), 'endsAt is the earlier of the two');
  // No contact yet: idle counts from the start.
  const fresh = { startedAt: at('2026-11-07T10:00:00Z'), lastContactAt: 0 };
  eq(AC.decide(fresh, at('2026-11-07T15:59:59Z')).live, true, 'no contact yet: live under 6 h from the start');
  eq(AC.decide(fresh, at('2026-11-07T16:00:00Z')).reason, 'idle', 'no contact yet: 6 h from the start ends it');
}

section('a contact exactly at the day change: its own timestamp decides');
{
  const clock = { startedAt: at('2026-11-07T22:00:00Z'), lastContactAt: at('2026-11-07T23:50:00Z') };
  eq(AC.decide(clock, at('2026-11-07T23:59:59Z')).live, true, '23:59:59 UTC belongs to the activation');
  const d = AC.decide(clock, at('2026-11-08T00:00:01Z'));
  eq([d.live, d.reason], [false, 'day'], '00:00:01 UTC is after the day change: a home contact');
  eq(AC.decide(clock, at('2026-11-08T00:00:00Z')).live, false, '00:00:00.000 is the new day');
}

section('contactTime: the contact\'s own timestamp');
{
  const now = at('2026-11-08T00:00:05Z');
  eq(AC.contactTime({ qsoAt: at('2026-11-07T23:59:59Z') }, now), at('2026-11-07T23:59:59Z'), 'qsoAt (epoch ms) wins');
  eq(AC.contactTime({ qsoDate: '20261107', timeOn: '235959' }, now), at('2026-11-07T23:59:59Z'), 'qsoDate + HHMMSS');
  eq(AC.contactTime({ qsoDate: '20261108', timeOn: '0000' }, now), at('2026-11-08T00:00:00Z'), 'qsoDate + HHMM');
  eq(AC.contactTime({}, now), now, 'nothing given: now');
  eq(AC.contactTime({ qsoAt: 'junk' }, now), now, 'a bad qsoAt: now');
}

section('clock keeping');
{
  const c = AC.startClock(1000, 'US-1234');
  eq(c, { startedAt: 1000, lastContactAt: 0, refs: 'US-1234' }, 'startClock');
  eq(AC.noteContact(c, 5000).lastContactAt, 5000, 'noteContact moves the last contact forward');
  eq(AC.noteContact({ ...c, lastContactAt: 9000 }, 5000).lastContactAt, 9000, 'a late-logged older contact never moves it back');
  eq(AC.decide(null, 1).live, true, 'no clock: nothing to decide (live)');
}

section('the words');
{
  eq(AC.logLine(['US-1234'], 'day'), '[Activation] US-1234 ended automatically: UTC day changed', 'log line, day');
  eq(AC.logLine(['US-1234', 'US-5678'], 'idle'), '[Activation] US-1234, US-5678 ended automatically: no contacts for 6 hours', 'log line, idle, n-fer');
  eq(AC.noticeText(['US-1234'], 'day'),
    'Your activation at US-1234 ended automatically: the UTC day changed. Contacts from now on are logged as home contacts.',
    'notice, day');
  eq(AC.noticeText(['US-1234'], 'idle'),
    'Your activation at US-1234 ended automatically: no contacts for 6 hours. Contacts from now on are logged as home contacts.',
    'notice, idle');
}

section('wiring: main.js');
{
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/require\(['"]\.\/lib\/activation-clock['"]\)/.test(main), 'main requires lib/activation-clock');
  const lc = main.slice(main.indexOf('async function logContact('), main.indexOf('function qrzBackfillLate('));
  ok(lc.length > 0, 'logContact found');
  ok(/ActivationClock\.contactTime\(entry/.test(lc), '(a) logContact takes the contact\'s own timestamp');
  ok(/activationRefsAt\(/.test(lc) && !/:\s*liveActivationMyRefs\(\)\)/.test(lc),
    '(a) logContact attaches the activation only through the rule check (activationRefsAt), never liveActivationMyRefs() directly');
  ok(/activationNoteContact\(/.test(lc), 'a contact attached to the activation moves its idle clock');
  ok(/setInterval\(activationClockTick,/.test(main), '(b) a periodic tick checks the rule with no new contact');
  const end = main.slice(main.indexOf('function autoEndActivation('), main.indexOf('function autoEndActivation(') + 3000);
  ok(/settings\.activationActive = false/.test(end), 'auto-end clears the desktop activation');
  ok(/settings\.appMode = 'hunter'/.test(end), 'auto-end leaves activator mode (the phone\'s End does)');
  ok(/pushActivatorStateToPhone\(\)/.test(end), 'auto-end tells the phone, as a manual End does');
  ok(/resetSessionContacts\(\)/.test(end), 'auto-end resets the device session list, as the phone\'s End does');
  ok(/ActivationClock\.logLine\(/.test(end), 'auto-end logs one plain line');
  ok(/'activation-auto-ended'/.test(end), 'auto-end notifies the desktop');
  ok(/type: 'activation-ended'/.test(end), 'auto-end notifies ECHOCAT');
  ok(!/mutateLog\(/.test(end), 'auto-end never touches contacts already logged');
  const save = main.slice(main.indexOf("ipcMain.handle('save-settings'"), main.indexOf("ipcMain.handle('save-settings'") + 30000);
  ok(/activationClockFollow\(/.test(save), 'a desktop Start/End (save-settings) starts or clears the clock');
  const park = main.slice(main.indexOf("remoteServer.on('set-activator-park'"), main.indexOf("remoteServer.on('set-park-county'"));
  ok(/activationClockFollow\(/.test(park), 'a phone Start/End starts or clears the clock');
}

section('wiring: desktop and ECHOCAT');
{
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  ok(/onActivationAutoEnded/.test(read('preload.js')), 'preload exposes the auto-end event');
  const app = read('renderer/app.js');
  const h = app.slice(app.indexOf('window.api.onActivationAutoEnded'), app.indexOf('window.api.onActivationAutoEnded') + 800);
  ok(h.length > 40, 'the renderer listens for it');
  ok(/stopActivation\(\)/.test(h), 'the renderer ends it the way its End button does');
  ok(/showLogToast\(/.test(h), 'the renderer shows the notice');
  ok(/'activation-ended'/.test(read('lib/echocat-protocol.js')), 'activation-ended is registered in the ECHOCAT protocol');
  ok(/case 'activation-ended'/.test(read('renderer/remote.js')), 'ECHOCAT Web shows the notice');
  ok(/'activation-auto-end'/.test(read('lib/remote-server.js')), 'the shack advertises the capability');
}

finish();
function finish() {
  console.log('\n' + '='.repeat(56));
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('All tests passed.');
}
