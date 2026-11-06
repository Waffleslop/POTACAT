#!/usr/bin/env node
'use strict';
// .eddiejames (#pota-activations, 2026-11-05): over a 150-QSO activation the
// Activator Log button "just sat there"; pressed again, three contacts saved
// at once, as duplicates. logContact waited for QRZ before saving, and the
// button had no in-flight guard.
// Run: node test/activator-log-once-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { withTimeout } = require('../lib/with-timeout');

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('withTimeout: a fast answer comes through; a slow one gives the fallback at the deadline; a failure never rejects', async () => {
  assert.strictEqual(await withTimeout(Promise.resolve('qrz'), 200), 'qrz');
  let reported = 0;
  const t0 = Date.now();
  const slow = new Promise((r) => setTimeout(() => r('late'), 1000));
  assert.strictEqual(await withTimeout(slow, 100, { onTimeout: () => reported++ }), null);
  assert.ok(Date.now() - t0 < 600, 'did not wait for the slow one');
  assert.strictEqual(reported, 1);
  assert.strictEqual(await withTimeout(Promise.reject(new Error('x')), 100, { fallback: 'fb' }), 'fb');
});

test('logContact caps the QRZ wait, so a slow QRZ never holds up the save', () => {
  const main = read('main.js');
  const m = main.match(/const QRZ_LOG_WAIT_MS = (\d+);/);
  assert.ok(m && Number(m[1]) <= 3000, 'a cap of 3 s or less');
  const lc = main.slice(main.indexOf('async function logContact(entry, opts) {'), main.indexOf('const myRefs = entry.mySig'));
  assert.ok(/await withTimeout\(qrzStationInfo\(c\), QRZ_LOG_WAIT_MS,/.test(lc));
  assert.ok(!/infos\.set\(c, await qrzStationInfo\(c\)\)/.test(lc), 'no uncapped wait left');
});

// The press-time queue (review of the 1.13.11 chain): the guard used to DROP
// a press made during a save, and the save then emptied the box, so a contact
// typed meanwhile was lost. Now each press is read at press time and saved in
// order; only a repeat of the SAME contact is not queued twice.
function loadQueue(app, entries, saved) {
  const start = app.indexOf('let _activatorLogBusy = false;');
  const end = app.indexOf('function activatorReadEntry() {');
  assert.ok(start > 0 && end > start);
  const ctx = {
    console, toasts: [],
    showLogToast: (m) => ctx.toasts.push(m),
    activatorReadEntry: () => entries.shift() || null,
    activatorLogContactNow: async (s) => { saved.push(s.rawCallsign); await new Promise((r) => setTimeout(r, 120)); },
  };
  vm.createContext(ctx);
  vm.runInContext(app.slice(start, end) + '\nthis.activatorLogContact = activatorLogContact;', ctx);
  return ctx;
}
const entry = (call) => ({ key: call + '|SSB|20m|', rawCallsign: call, callsigns: [call] });

test('the Activator log saves one contact per press: repeat presses of the same contact save it once', async () => {
  const saved = [];
  const ctx = loadQueue(read('renderer/app.js'), [entry('K1ABC'), entry('K1ABC'), entry('K1ABC'), entry('W2DEF')], saved);
  const first = ctx.activatorLogContact();
  await ctx.activatorLogContact();           // the second press, mid-save
  await ctx.activatorLogContact();           // and a third (Enter)
  await first;
  assert.deepStrictEqual(saved, ['K1ABC'], 'one save, not three');
  await ctx.activatorLogContact();
  assert.deepStrictEqual(saved, ['K1ABC', 'W2DEF'], 'the next contact logs normally');
});

test('a contact typed and logged during a slow save is saved after it, in order, and never lost', async () => {
  const saved = [];
  const ctx = loadQueue(read('renderer/app.js'), [entry('K1ABC'), entry('W2DEF'), entry('N3GHI')], saved);
  const first = ctx.activatorLogContact();
  await ctx.activatorLogContact();           // W2DEF pressed while K1ABC saves
  await ctx.activatorLogContact();           // and N3GHI
  await first;
  assert.deepStrictEqual(saved, ['K1ABC', 'W2DEF', 'N3GHI']);
  assert.strictEqual(ctx.toasts.length, 2, 'each queued contact says it will be logged next');
});

test('the save empties the entry row only when it still holds that contact\'s call', () => {
  const app = read('renderer/app.js');
  const save = app.slice(app.indexOf('async function activatorLogContactNow(s) {'), app.indexOf('function clearActivatorEntry() {'));
  assert.ok(/if \(activatorCallsignInput\.value\.trim\(\)\.toUpperCase\(\) === rawCallsign\) clearActivatorEntry\(\);/.test(save));
  assert.ok(!/\n  clearActivatorEntry\(\);\n/.test(save), 'no unconditional clear');
  const readFn = app.slice(app.indexOf('function activatorReadEntry() {'), app.indexOf('async function activatorLogContactNow(s) {'));
  assert.ok(/const timeOn = /.test(readFn) && /hunted: hunterParkRefs\.slice\(\)/.test(readFn), 'time and parks are taken at press time');
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
  }
  console.log(`\nActivator log once: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
