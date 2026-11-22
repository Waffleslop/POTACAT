// test/profile-switch-guard-test.js — GitHub #344: switching operator wrote
// the old operator into the new profile. The switch moved the profile pointer
// and then waited a second or more for the radio before restarting; any
// settings save in that window wrote the old callsign, log path and Cloud
// sign-in into the new operator's settings file.
'use strict';
const { readSrc } = require('./_src');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SF = require('../lib/settings-file');
const { createSettingsWriteGate, commitProfileSwitch } = require('../lib/profile-switch-guard');

let pass = 0, fail = 0;
const pending = [];
function t(name, fn) {
  pending.push(async () => {
    try { SF._resetForTests(); await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
  });
}

// A settings store laid out exactly as main.js lays it out: a global
// settings.json holding the machine keys and the activeProfile pointer, and
// profiles/<CALL>/settings.json holding the operator keys. Writes go through
// the real lib/settings-file.js behind the gate, as main.js's _writeJsonAtomic.
const GLOBAL_KEYS = new Set(['activeProfile', 'rigs', 'activeRigId', 'windowState']);
function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-switch-'));
  const SETTINGS_PATH = path.join(root, 'settings.json');
  const profilePath = (call) => path.join(root, 'profiles', call, 'settings.json');
  const logs = [];
  const gate = createSettingsWriteGate({ log: (l) => logs.push(l) });
  function writeJson(p, obj) {
    if (!gate.allowWrite(path.basename(p))) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    SF.writeSettingsFile(p, obj);
  }
  function read(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  function saveSettings(s) {
    const g = {}, prof = {};
    for (const [k, v] of Object.entries(s)) (GLOBAL_KEYS.has(k) ? g : prof)[k] = v;
    writeJson(SETTINGS_PATH, g);
    writeJson(profilePath(g.activeProfile), prof);
  }
  function setActiveProfilePointer(call) {
    const g = read(SETTINGS_PATH);
    g.activeProfile = call;
    writeJson(SETTINGS_PATH, g);
  }
  function loadSettings() {
    const g = read(SETTINGS_PATH);
    return Object.assign({}, read(profilePath(g.activeProfile)), g);
  }
  return { root, SETTINGS_PATH, profilePath, gate, logs, writeJson, read, saveSettings, setActiveProfilePointer, loadSettings };
}

// Two operators on one PC, the first one active.
function twoOperators(store) {
  const rigs = [{ id: 'r1', name: 'FT-710', catTarget: { type: 'serial', path: 'COM4', baud: 38400 } }];
  store.writeJson(store.SETTINGS_PATH, { activeProfile: 'K1AAA', rigs, activeRigId: 'r1' });
  store.writeJson(store.profilePath('K1AAA'), {
    myCallsign: 'K1AAA', adifLogPath: '/logs/k1aaa.adi', cloudUser: { callsign: 'K1AAA' }, cloudAccessToken: 'tok-a',
  });
  store.writeJson(store.profilePath('K1BBB'), {
    myCallsign: 'K1BBB', adifLogPath: '/logs/k1bbb.adi',
  });
  return store.loadSettings();
}
const NEW = 'K1BBB';

console.log('profile switch guard (#344):');

t('a save in flight during the switch leaves the new operator untouched', async () => {
  const store = makeStore();
  const settings = twoOperators(store);
  const newBefore = fs.readFileSync(store.profilePath(NEW), 'utf8');

  // A debounced save scheduled just before the switch (a Settings edit, a
  // window move, a Cloud token refresh), firing while the radio is released.
  const inFlight = new Promise((resolve) => setTimeout(() => {
    settings.windowState = { x: 10, y: 20 };
    store.saveSettings(settings);
    resolve();
  }, 5));

  const r = commitProfileSwitch(NEW, {
    settings, saveSettings: store.saveSettings, setActiveProfilePointer: store.setActiveProfilePointer, gate: store.gate,
  });
  assert.strictEqual(r.previous, 'K1AAA');
  assert.strictEqual(settings.activeProfile, NEW);
  await inFlight;
  // Every other save path in the window: an immediate save and a quit handler.
  store.saveSettings(settings);
  store.saveSettings(Object.assign({}, settings, { cloudAccessToken: 'tok-a-refreshed' }));

  assert.strictEqual(fs.readFileSync(store.profilePath(NEW), 'utf8'), newBefore, 'new profile file unchanged');
  const after = store.loadSettings(); // what the restarted POTACAT reads
  assert.strictEqual(after.activeProfile, NEW);
  assert.strictEqual(after.myCallsign, 'K1BBB');
  assert.strictEqual(after.adifLogPath, '/logs/k1bbb.adi');
  assert.strictEqual(after.cloudUser, undefined, 'no Cloud sign-in carried over');
  assert.strictEqual(after.cloudAccessToken, undefined);
  assert.strictEqual(after.rigs.length, 1, 'the rig list survives');
  assert.strictEqual(after.windowState, undefined, 'the late save did not land anywhere');
  assert.ok(store.gate.refusedCount() >= 3, 'each late save was refused');
  assert.strictEqual(store.logs.filter((l) => /refused/.test(l)).length, 1, 'refusal said once in the log');
});

t('the old operator is saved before the pointer moves', () => {
  const store = makeStore();
  const settings = twoOperators(store);
  settings.grid = 'FN20jb'; // an unsaved edit on the old operator
  commitProfileSwitch(NEW, {
    settings, saveSettings: store.saveSettings, setActiveProfilePointer: store.setActiveProfilePointer, gate: store.gate,
  });
  assert.strictEqual(store.read(store.profilePath('K1AAA')).grid, 'FN20jb');
  assert.strictEqual(store.read(store.SETTINGS_PATH).activeProfile, NEW);
});

t('without the gate the same save corrupts the new profile (the bug as it was)', () => {
  const store = makeStore();
  const settings = twoOperators(store);
  store.saveSettings(settings);
  store.setActiveProfilePointer(NEW);
  settings.activeProfile = NEW;
  store.saveSettings(settings); // the save in the window, no gate closed
  const after = store.loadSettings();
  assert.strictEqual(after.myCallsign, 'K1AAA', 'reproduces #344: old callsign in the new profile');
  assert.strictEqual(after.adifLogPath, '/logs/k1aaa.adi');
});

t('a failed save before the switch leaves the gate open and the pointer where it was', () => {
  const store = makeStore();
  const settings = twoOperators(store);
  assert.throws(() => commitProfileSwitch(NEW, {
    settings, saveSettings: () => { throw new Error('disk full'); },
    setActiveProfilePointer: store.setActiveProfilePointer, gate: store.gate,
  }), /disk full/);
  assert.strictEqual(store.gate.isClosed(), false);
  assert.strictEqual(settings.activeProfile, 'K1AAA');
  assert.strictEqual(store.read(store.SETTINGS_PATH).activeProfile, 'K1AAA');
});

t('the gate is open until closed, and closing twice keeps the first switch', () => {
  const logs = [];
  const g = createSettingsWriteGate({ log: (l) => logs.push(l) });
  assert.strictEqual(g.allowWrite('x'), true);
  g.close('A', 'B');
  g.close('B', 'C');
  assert.strictEqual(g.isClosed(), true);
  assert.strictEqual(g.allowWrite('x'), false);
  assert.ok(/A -> B/.test(logs[0]));
  assert.strictEqual(logs.filter((l) => /switching/.test(l)).length, 1);
});

// main.js glue: one writer for settings files, and it asks the gate; the
// switch goes through commitProfileSwitch.
t('main.js: every settings file write passes the gate, and the switch closes it', () => {
  const src = readSrc(path.join(__dirname, '..', 'main.js'));
  const fn = src.slice(src.indexOf('function _writeJsonAtomic('), src.indexOf('function settingsSaveStatusLine('));
  assert.ok(/^function _writeJsonAtomic\(p, obj\) \{\n\s+if \(!_settingsWriteGate\.allowWrite\(/.test(fn), '_writeJsonAtomic asks the gate first');
  assert.ok(!/SettingsFile\.writeSettingsFile\(/.test(src.replace(fn, '')), 'no settings write outside _writeJsonAtomic');
  const sw = src.slice(src.indexOf('function switchProfile('), src.indexOf('let _profileSwitchRelaunchPending'));
  assert.ok(/ProfileSwitchGuard\.commitProfileSwitch\(/.test(sw), 'switchProfile uses commitProfileSwitch');
  assert.ok(/gate: _settingsWriteGate/.test(sw));
  assert.ok(!/setActiveProfilePointer\(call\)/.test(sw), 'the pointer moves only inside commitProfileSwitch');
});

(async () => {
  for (const run of pending) await run();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
