#!/usr/bin/env node
'use strict';
// NJ2DX 2026-11-21 (macOS Ventura): "Fix it" said it was not supported and
// "Time settings" did nothing. Each OS now gets only the clock buttons it can
// honour, and Time settings opens the Mac's Date & Time page.
// Run: node test/clock-platform-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ntp = require('../lib/ntp');
const StationSetup = require('../lib/station-setup');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

console.log('Clock buttons per OS');

test('only Windows has the automatic fix', () => {
  assert.strictEqual(ntp.clockFixSupported('win32'), true);
  assert.strictEqual(ntp.clockFixSupported('darwin'), false);
  assert.strictEqual(ntp.clockFixSupported('linux'), false);
});

test('Time settings opens a real page on Windows and macOS, none on Linux', () => {
  assert.deepStrictEqual(ntp.timeSettingsTargets('win32'), ['ms-settings:dateandtime']);
  const mac = ntp.timeSettingsTargets('darwin');
  assert.strictEqual(mac[0], 'x-apple.systempreferences:com.apple.Date-Time-Settings.extension');
  assert.ok(mac.includes('x-apple.systempreferences:com.apple.preference.datetime'), 'older macOS fallback');
  assert.deepStrictEqual(ntp.timeSettingsTargets('linux'), []);
});

test('main: one opener tries each page; the clock tells every surface which buttons work', () => {
  const main = read('main.js');
  assert.ok(/ipcMain\.handle\('jtcat-open-time-settings', async \(\) => openTimeSettings\(\)\);/.test(main));
  assert.ok(/for \(const url of timeSettingsTargets\(process\.platform\)\) \{\s*try \{ await shell\.openExternal\(url\); return true; \}/.test(main));
  assert.ok(/canFix: clockFixSupported\(process\.platform\), canOpenSettings: timeSettingsTargets\(process\.platform\)\.length > 0/.test(main));
  assert.ok(/case 'open-time-settings': await openTimeSettings\(\); break;/.test(main));
  for (const f of ['renderer/app.js', 'renderer/jtcat-popout.js', 'renderer/js8call-popout.js']) {
    assert.ok(/d\.canFix === false/.test(read(f)) && /d\.canOpenSettings === false/.test(read(f)), f);
  }
});

test('Station Setup: Fix the clock only on Windows; the Mac gets Time settings and the steps', () => {
  const { resolveSetupNotes } = require('../lib/rig-setup-notes');
  const { RIG_MODELS } = require('../lib/rig-models');
  const clockStep = (platform) => {
    const model = 'IC-7300';
    const notes = resolveSetupNotes({ model, modelInfo: RIG_MODELS[model], radioType: 'serialcat', platform, done: [] });
    const res = StationSetup.evaluateChecklist({
      rig: { id: 'r1', name: model, model, radioType: 'serialcat', audioSource: '', inputDeviceId: 'in', outputDeviceId: 'out', active: true },
      modelInfo: RIG_MODELS[model], platform, notes, prefs: {},
      live: { callsign: 'K3SBP', grid: 'FN20', catConnected: true, freqHz: 14074000, clock: { level: 'bad', offsetMs: 2100 } },
    });
    return res.steps.find(s => s.id === 'clock');
  };
  const acts = (st) => st.actions.map(a => a.id);
  const text = (st) => JSON.stringify(st.instructions);
  assert.deepStrictEqual(acts(clockStep('win32')), ['sync-clock', 'check-clock']);
  const mac = clockStep('darwin');
  assert.deepStrictEqual(acts(mac), ['open-time-settings', 'check-clock']);
  assert.ok(/Set time and date automatically/.test(text(mac)) && !/Windows/.test(text(mac)));
  const lin = clockStep('linux');
  assert.deepStrictEqual(acts(lin), ['check-clock']);
  assert.ok(!/Windows/.test(text(lin)));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
