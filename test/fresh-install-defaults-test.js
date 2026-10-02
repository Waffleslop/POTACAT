// What a brand-new install starts with (Casey 2026-09-25): light mode (with
// charcoal as the dark theme they get if they switch), WSPR as the idle receive mode, and no ECHOCAT Web token. Installs
// that never chose keep what they have (navy, SSTV), so these live in the
// fresh-install settings, not in the read-side fallbacks.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (err.stack || err.message)); }
}
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const main = R('main.js');
const html = R('renderer/index.html');

test('fresh-install settings: light mode, charcoal when they go dark, and WSPR', () => {
  const load = main.slice(main.indexOf('function loadSettings()'), main.indexOf('function loadSettings()') + 1200);
  const fresh = (load.match(/return \{ grid: 'FN20jb'[^\n]*\};/) || [''])[0];
  assert.ok(/lightMode: true/.test(fresh), fresh);
  assert.ok(/darkVariant: 'charcoal'/.test(fresh), fresh);
  assert.ok(/idleRxMode: 'wspr'/.test(fresh), fresh);
  assert.ok(!/remoteRequireToken/.test(fresh), 'a fresh install must not require an ECHOCAT token');
});

test('the first-run welcome screen shows WSPR before any setting is read', () => {
  const sel = html.slice(html.indexOf('<select id="welcome-idle-rx-mode"'), html.indexOf('</select>', html.indexOf('<select id="welcome-idle-rx-mode"')));
  assert.ok(/<option value="wspr" selected>WSPR<\/option>/.test(sel));
});

test('the welcome screen starts on Light (its value is what Continue saves on a first run)', () => {
  assert.ok(/<input type="checkbox" id="welcome-light-mode" checked>/.test(html));
});

test('existing installs keep their look: the read-side fallback is still navy', () => {
  assert.ok(/settings\.darkVariant \|\| 'navy'/.test(main));
});

// Telemetry (Casey 2026-10-01): on for NEW installs, shown as a ticked box on
// the welcome screen; an existing install that never chose stays off.
test('telemetry: on in the fresh-install settings, never forced on an existing install', () => {
  const load = main.slice(main.indexOf('function loadSettings()'), main.indexOf('function loadSettings()') + 1200);
  const fresh = (load.match(/return \{ grid: 'FN20jb'[^\n]*\};/) || [''])[0];
  assert.ok(/enableTelemetry: true/.test(fresh), fresh);
  // Sending stays gated on the setting itself, so unset (an older install) is off.
  assert.ok(/function telemetryAllowed\(\) \{\n  return !!\(settings && settings\.enableTelemetry && !settings\.firstRun\);/.test(main),
    'unset must be off, and nothing may go out while the welcome screen (firstRun) is up');
  assert.ok(/function sendTelemetry\(sessionSeconds\) \{\n  if \(!telemetryAllowed\(\)\) return/.test(main));
  assert.ok(/function trackTelemetryEvent\(endpoint, source\) \{\n  if \(!telemetryAllowed\(\)\) return;/.test(main));
});

test('telemetry: the welcome screen shows the choice, ticked, and saves it', () => {
  assert.ok(/<input type="checkbox" id="welcome-enable-telemetry" checked>/.test(html));
  const app = R('renderer/app.js');
  assert.ok(/if \(telemetryEl\) saveData\.enableTelemetry = telemetryEl\.checked;/.test(app));
  assert.ok(/t\.checked = s\.enableTelemetry === true;/.test(app), 'reopening the welcome screen does not reflect the saved choice');
  assert.ok(/setEnableTelemetry\.checked = s\.enableTelemetry === true;/.test(app), 'the Settings checkbox does not reflect it');
});

console.log(`\nFresh-install defaults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
