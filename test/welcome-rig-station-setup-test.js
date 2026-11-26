#!/usr/bin/env node
'use strict';
// A radio set up from the first run gets its Station Setup steps once, never
// twice, and never on top of the Welcome (#1070 / #1076 / #1078).
//
// A shorter first run, part 2 (2026-11-26): "Where is your radio?" > Here goes
// on to Which radio and the Radio check inside the Welcome. Saving the radio
// there does not open the Station Setup window; the check shows its control
// and hearing steps inline, and once it has, the after-Welcome launch card
// does not offer the checklist again in that sitting. The Settings rig editor
// is unchanged: a radio added there still opens its Station Setup after the
// save (#1076: only a radio added now).
// Run: node test/welcome-rig-station-setup-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const R = (f) => readSrc(path.join(__dirname, '..', f)).replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('First-run radio and Station Setup');
const app = R('renderer/app.js');
const html = R('renderer/index.html');
const radio = R('renderer/first-run-radio.js');
const ss = R('renderer/station-setup.js');
const a = app.indexOf('async function welcomeChooseWhere(');
const choose = app.slice(a, app.indexOf('\n}\n', a));

test('the Welcome has no rig editor of its own', () => {
  assert.ok(!/welcome-rig-editor|welcome-radio-type|welcome-rig-save-btn/.test(html));
  assert.ok(!/welcomeRigIsNew|showWelcomeRigItem/.test(app));
});
test('Here goes on to Which radio inside the Welcome; it no longer opens Settings', () => {
  assert.ok(a > 0, 'welcomeChooseWhere found');
  assert.ok(/if \(r\.action === 'radio-step'\) \{ welcomeShowStep\('radio'\); return; \}/.test(choose));
  assert.ok(!/openSettingsDialog|openRigEditor/.test(choose));
});
test('saving the radio in the first run does not open the Station Setup window', () => {
  assert.ok(!/openStationSetup/.test(radio.replace(/^\s*\/\/.*$/gm, '')));
  assert.ok(!/saveRigEditor/.test(radio), 'the first run saves its own record, not through the editor (which opens Station Setup)');
});
test('the check marks the steps as seen, so the after-Welcome card does not offer them again', () => {
  assert.ok(/window\.stationSetupSeenInline = \(\) => \{ openedThisSession = true; \};/.test(ss));
  const show = radio.slice(radio.indexOf('async function showCheck('));
  assert.ok(/window\.stationSetupSeenInline\(\)/.test(show.slice(0, 900)));
  assert.ok(/if \(launchDone \|\| openedThisSession\) return;/.test(ss), 'launchCheck honours it');
  assert.ok(/if \(launchDone \|\| openedThisSession \|\| afterWelcomeQueued\) return;/.test(ss), 'and so does the after-Welcome queue');
});
test('the Settings rig editor still opens Station Setup for a radio added there, after the save', () => {
  const s = app.slice(app.indexOf('    currentRigs.push(newRig);'));
  assert.ok(/currentRigs\.push\(newRig\);\n\s*_stationSetupOpenAfterSave = newRig\.id;/.test(s), 'only a new radio is marked');
  assert.ok(/Promise\.resolve\(_ssSave\)\.then\(\(\) => window\.openStationSetup\(newId\)\)/.test(s), 'opens after the save');
});

// "Here" run for real (the function itself, with the window's calls stubbed).
async function runChoice(action) {
  const calls = [];
  const deps = {
    window: { FirstRun: { chooseWhere: () => ({ action, state: { step: 'radio', where: 'here' }, patch: {} }) },
      api: { saveSettings: async () => { calls.push('save'); } } },
    welcomeShowRemotePanel: () => calls.push('remote-panel'),
    welcomeShowStep: (step) => calls.push('step:' + step),
    welcomeCloseFlow: () => calls.push('close'),
  };
  const fn = new Function(...Object.keys(deps), 'let _firstRunState = {};\n' + choose + '\n}\nreturn welcomeChooseWhere;')(...Object.values(deps));
  await fn('here');
  return calls;
}
(async () => {
  for (const [action, want] of [['radio-step', ['save', 'step:radio']], ['remote-panel', ['save', 'remote-panel']], ['spots', ['save', 'close']]]) {
    try {
      assert.deepStrictEqual(await runChoice(action), want);
      passed++; console.log('  ok  ' + action + ': ' + want.join(', '));
    } catch (e) { failed++; console.log('  FAIL ' + action + '\n       ' + (e.message || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
