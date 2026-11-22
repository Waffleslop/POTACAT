'use strict';
// #718: FreeDV's capture runs the macOS microphone check JTCAT runs (#463):
// it logs the permission and asks once on start (macMicCaptureStart), and a
// silence watch (lib/mac-mic-access.js SilenceWatch) reports a capture that
// delivers only exact zeros for 10 s, so main logs it and shows the notice.
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const M = require('../lib/mac-mic-access');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ok', name); }
const app = readSrc(path.join(__dirname, '..', 'renderer', 'app.js'));
const start = app.slice(app.indexOf('async function startFreedvForMode('), app.indexOf('function stopFreedv('));

t('the 10 s rule is the shared one: SilenceWatch and micVerdict with 10000 ms', () => {
  const w = new M.SilenceWatch(0, 10000);
  assert.strictEqual(w.note(new Int16Array(640), 9999), null);
  assert.strictEqual(w.note(new Int16Array(640), 10000), 'silent');
  assert.strictEqual(w.note(Int16Array.from([0, 3]), 10100), 'sound');
  assert.strictEqual(M.micVerdict({ platform: 'darwin', status: 'granted', silentMs: 9000, minSilentMs: 10000 }).say, false);
  assert.strictEqual(M.micVerdict({ platform: 'darwin', status: 'granted', silentMs: 10000, minSilentMs: 10000 }).reason, 'silence');
});
t('startFreedvForMode asks macOS once and logs it, as JTCAT does', () => {
  assert.ok(start.length > 0, 'startFreedvForMode found');
  assert.ok(/window\.api\.macMicCaptureStart\('freedv'\)/.test(start));
  assert.ok(/new window\.MacMicAccess\.SilenceWatch\(now, FREEDV_MIC_SILENT_MS\)/.test(app));
  assert.ok(/var FREEDV_MIC_SILENT_MS = 10000;/.test(app));
});
t('every captured block feeds the watch, and main hears surface freedv with the 10 s floor', () => {
  assert.ok(/freedvMicNote\(e\.data\)/.test(start));
  assert.ok(/surface: 'freedv'[^}]*minSilentMs: FREEDV_MIC_SILENT_MS/.test(app));
});

console.log(`freedv-mac-mic: ${passed} passed`);
