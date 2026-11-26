// #1073: the launch usage-statistics ping is held while Welcome is open and sent
// once the operator's choice is saved; never when they unticked the box.
'use strict';
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const { createLaunchPing } = require('../lib/launch-ping');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok ' + name); }
  catch (err) { fail++; console.log('  FAIL ' + name + '\n    ' + (err && err.stack || err)); }
}

// The same rule as main.js telemetryAllowed(): on, and Welcome finished.
function rig(settings) {
  const sends = [];
  const lp = createLaunchPing({
    allowed: () => !!(settings.enableTelemetry && !settings.firstRun),
    waiting: () => !!settings.firstRun,
    send: () => sends.push('ping'),
  });
  return { lp, sends };
}

t('an existing install: the launch timer sends once', () => {
  const s = { enableTelemetry: true, firstRun: false };
  const { lp, sends } = rig(s);
  lp.onLaunchTimer(); lp.onLaunchTimer(); lp.onSettingsSaved();
  assert.strictEqual(sends.length, 1);
});

t('an install that never opted in sends nothing, ever', () => {
  const s = { firstRun: false };
  const { lp, sends } = rig(s);
  lp.onLaunchTimer(); lp.onSettingsSaved();
  assert.strictEqual(sends.length, 0);
});

t('new install: nothing while Welcome is open, the ping goes when Get Started saves', () => {
  const s = { enableTelemetry: true, firstRun: true };
  const { lp, sends } = rig(s);
  lp.onLaunchTimer();
  assert.strictEqual(sends.length, 0);
  lp.onSettingsSaved();                       // a save while Welcome is still up
  assert.strictEqual(sends.length, 0);
  s.firstRun = false;                          // Get Started saved the choice
  lp.onSettingsSaved();
  assert.strictEqual(sends.length, 1);
  lp.onSettingsSaved();
  assert.strictEqual(sends.length, 1, 'only once');
});

t('new install, box unticked: nothing is ever sent', () => {
  const s = { enableTelemetry: true, firstRun: true };
  const { lp, sends } = rig(s);
  lp.onLaunchTimer();
  s.firstRun = false; s.enableTelemetry = false;
  lp.onSettingsSaved();
  s.enableTelemetry = true;                    // ticked again later in Settings
  lp.onSettingsSaved();
  assert.strictEqual(sends.length, 0);
});

t('Welcome finished before the 8 s timer: the timer sends, the save does not repeat it', () => {
  const s = { enableTelemetry: true, firstRun: true };
  const { lp, sends } = rig(s);
  s.firstRun = false;
  lp.onLaunchTimer();
  lp.onSettingsSaved();
  assert.strictEqual(sends.length, 1);
});

t('main.js wires the launch ping to the timer and to the settings save', () => {
  const m = readSrc(path.join(__dirname, '..', 'main.js'));
  assert.ok(/setTimeout\(\(\) => launchPing\.onLaunchTimer\(\), 8000\)/.test(m));
  assert.ok(/saveSettings\(settings\);\n\s*launchPing\.onSettingsSaved\(\)/.test(m));
  assert.ok(/waiting: \(\) => !!\(settings && settings\.firstRun\)/.test(m));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
