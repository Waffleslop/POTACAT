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

test('the Activator log runs one save at a time: a second press during a slow save does nothing', async () => {
  const app = read('renderer/app.js');
  const start = app.indexOf('let _activatorLogBusy = false;');
  const end = app.indexOf('async function activatorLogContactNow() {');
  assert.ok(start > 0 && end > start);
  let saves = 0;
  const btn = { disabled: false };
  const ctx = {
    activatorLogBtn: btn,
    activatorLogContactNow: async () => { saves++; await new Promise((r) => setTimeout(r, 150)); },
  };
  vm.createContext(ctx);
  vm.runInContext(app.slice(start, end) + '\nthis.activatorLogContact = activatorLogContact;', ctx);
  const first = ctx.activatorLogContact();
  assert.strictEqual(btn.disabled, true, 'the button is disabled while saving');
  await ctx.activatorLogContact();           // the second press, mid-save
  await ctx.activatorLogContact();           // and a third (Enter)
  await first;
  assert.strictEqual(saves, 1, 'one save, not three');
  assert.strictEqual(btn.disabled, false, 'and the button comes back');
  await ctx.activatorLogContact();
  assert.strictEqual(saves, 2, 'the next contact logs normally');
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
  }
  console.log(`\nActivator log once: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
