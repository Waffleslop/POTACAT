'use strict';
// Split operation "Fake It" on by default for a new setup, and nobody's
// existing setup changes (Casey 2026-11-23, after N4RLW's IC-7300 / IC-7100
// report: since 1.14.7 a CQ from a minimised window or ECHOCAT can sit
// anywhere in 200-2800 Hz, and the radio's filter cuts the edges).
// Rules: lib/jtcat-fake-it.js seedSetting + engineCanShift. Wiring: main.js.
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const FakeIt = require('../lib/jtcat-fake-it');
const { Ft8Engine } = require('../lib/ft8-engine');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

const ROOT = path.join(__dirname, '..');
const MAIN = readSrc(path.join(ROOT, 'main.js'));
const roundTrip = (s) => JSON.parse(JSON.stringify(s));   // save, then load again

(async () => {
  await test('a fresh install (no settings yet) gets Fake It on', () => {
    const s = { grid: 'FN20jb', catTarget: null, firstRun: true };
    assert.strictEqual(FakeIt.seedSetting(s, { fresh: true }), true);
    assert.strictEqual(s.jtcatFakeIt, true);
    assert.strictEqual(FakeIt.NEW_SETUP_DEFAULT, true);
  });

  await test('existing settings without the key get it off, once, and it stays off after save and reload', () => {
    const s = { myCallsign: 'N0CALL', catTarget: { type: 'serial', path: 'COM3' } };
    assert.strictEqual(FakeIt.seedSetting(s), true, 'written once');
    assert.strictEqual(s.jtcatFakeIt, false);
    let again = roundTrip(s);
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(FakeIt.seedSetting(again), false, `launch ${i + 2}: nothing to write`);
      assert.strictEqual(FakeIt.seedSetting(again, { fresh: true }), false, 'not even on a fresh-path call');
      assert.strictEqual(again.jtcatFakeIt, false);
      again = roundTrip(again);
    }
    const nulled = { jtcatFakeIt: null };
    assert.strictEqual(FakeIt.seedSetting(nulled), true);
    assert.strictEqual(nulled.jtcatFakeIt, false, 'null reads as never set: off');
  });

  await test('an explicit on or off is never overwritten', () => {
    for (const v of [true, false]) {
      for (const fresh of [true, false]) {
        const s = { jtcatFakeIt: v };
        assert.strictEqual(FakeIt.seedSetting(s, { fresh }), false);
        assert.strictEqual(s.jtcatFakeIt, v, `${v} kept (fresh=${fresh})`);
      }
    }
    assert.strictEqual(FakeIt.seedSetting(null), false);
  });

  await test('Fake It shifts on a CAT radio: serial CI-V/Kenwood/Yaesu, Hamlib, flrig, Flex, RS-BA1, SCU-LAN10', () => {
    for (const type of ['serial', 'icom', 'civ-tcp', 'rigctld', 'rigctldnet', 'flrig', 'dxlab-commander', 'tcp', 'icom-network', 'yaesu-lan']) {
      assert.strictEqual(FakeIt.engineCanShift({ enabled: true, catTarget: { type } }), true, type);
    }
    assert.strictEqual(FakeIt.engineCanShift({ enabled: false, catTarget: { type: 'serial' } }), false, 'off is off');
  });

  await test('where Fake It cannot work it falls back to the plain audio offset', () => {
    const cat = { type: 'serial' };
    const cases = {
      'no radio picked yet': { catTarget: null },
      'CAT None chosen': { catTarget: null, catNone: true },
      'a no-CAT (VOX) radio': { catTarget: { type: 'none' } },
      'a TCI rig (Zeus / Thetis)': { catTarget: { type: 'tci' } },
      'the radio in split': { catTarget: cat, split: true },
      'more than one band': { catTarget: cat, multiBand: true },
      'a laptop driving a remote shack': { catTarget: cat, remote: true },
      'a target with no type': { catTarget: {} },
    };
    for (const [why, c] of Object.entries(cases)) {
      assert.strictEqual(FakeIt.engineCanShift({ enabled: true, ...c }), false, why);
    }
    // The fallback is exactly Fake It off: the engine renders at the offset, no dial shift.
    const eng = new Ft8Engine();
    eng._txFreq = 700;
    eng.setFakeIt(FakeIt.engineCanShift({ enabled: true, catTarget: { type: 'tci' } }));
    assert.strictEqual(eng._txShiftNow(), 0, 'TCI: no shift, the tone stays at 700 Hz');
    eng.setFakeIt(FakeIt.engineCanShift({ enabled: true, catTarget: cat }));
    assert.strictEqual(eng._txShiftNow(), -1000, 'CAT: the tone moves to 1700 Hz');
  });

  await test('main.js: a fresh install is seeded on; an existing one is written off once at startup', () => {
    const load = MAIN.slice(MAIN.indexOf('function loadSettingsFromDisk() {'), MAIN.indexOf('// Migration path: legacy settings.json'));
    assert.ok(/if \(!global\) \{[\s\S]*return \{ grid: 'FN20jb'[^\n]*jtcatFakeIt: FakeIt\.NEW_SETUP_DEFAULT \};/.test(load), 'the fresh-install defaults');
    const once = MAIN.indexOf('if (FakeIt.seedSetting(settings)) {');
    assert.ok(once > 0, 'the startup seed');
    assert.ok(/if \(FakeIt\.seedSetting\(settings\)\) \{\s+saveSettings\(settings\);/.test(MAIN.slice(once - 5)), 'written to disk at once');
    assert.ok(once > MAIN.indexOf("console.log('[multi-op] healed missing activeProfile pointer"), 'after the profile is loaded');
    assert.ok(once < MAIN.indexOf('InstallDefaults.applyDefaultsOnce(settings, CLUSTER_PRESETS)'), 'with the other one-time defaults');
    const add = MAIN.slice(MAIN.indexOf('function addProfile(callsign) {'), MAIN.indexOf('function switchProfile(callsign) {'));
    assert.ok(!/jtcatFakeIt/.test(add), 'a new operator on an existing station inherits the station rule (off unless chosen)');
    assert.ok(/function fakeItEnabled\(\) \{ return settings\.jtcatFakeIt === true; \}/.test(MAIN), 'a missing key still reads off');
  });

  await test('main.js: the engine shifts only where engineCanShift says, and follows rig and split changes', () => {
    const sync = MAIN.slice(MAIN.indexOf('function fakeItSyncEngine() {'), MAIN.indexOf('function fakeItIsEcho(hz) {'));
    assert.ok(/ft8Engine\.setFakeIt\(FakeIt\.engineCanShift\(\{/.test(sync), 'the pure gate');
    for (const k of ['enabled: fakeItEnabled()', 'multiBand:', 'remote: isRemoteMode()', 'catTarget: settings.catTarget', 'catNone: !!settings.catNone', 'split: _currentSplit']) {
      assert.ok(sync.includes(k), k);
    }
    const split = MAIN.slice(MAIN.indexOf('function sendCatSplit(on) {'), MAIN.indexOf('function sendCatSplit(on) {') + 400);
    assert.ok(split.includes('fakeItSyncEngine();'), 'split on/off re-arms the engine');
    const conn = MAIN.slice(MAIN.indexOf('async function connectCat() {'), MAIN.indexOf("if (target.type === 'tci') {", MAIN.indexOf('async function connectCat() {')));
    assert.ok((conn.match(/fakeItSyncEngine\(\);/g) || []).length >= 2, 'a rig change re-arms the engine');
  });

  await test('the test runner lists this file', () => {
    const runner = readSrc(path.join(ROOT, 'scripts/run-tests.js'));
    assert.ok(runner.includes("'test/jtcat-fake-it-default-test.js'"));
  });

  console.log(`\njtcat-fake-it-default: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
