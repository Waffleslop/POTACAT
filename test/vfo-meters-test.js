#!/usr/bin/env node
'use strict';
/**
 * VFO view shows only the meters the radio reports (Casey 2026-10-07: "if the
 * radio connected lacks SWR, ALC, Power or S Meter values (because we can't
 * poll it), the VFO should not show these elements. Nothing should.").
 *
 * Runs main.js's own meter-tracking block against stub settings, then guards
 * the wiring: every real meter sender marks its meter, synthetic values never
 * do, the list rides vfo-radio-state, and the VFO window draws only those rows.
 *
 * Run: node test/vfo-meters-test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e).split('\n')[0]); }
}
const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const vfo = fs.readFileSync(path.join(root, 'renderer', 'vfo-popout.html'), 'utf8');

// Lift main's block (METER_KEYS .. vfoMetersAvailable) and run it on stubs.
function load(settings) {
  const a = main.indexOf('const METER_KEYS');
  const b = main.indexOf('function sendCatFwdPower(watts)');
  assert.ok(a > 0 && b > a, 'meter block found');
  const saves = []; const pushes = [];
  const factory = new Function('settings', 'saveSettings', 'sendVfoState', 'setTimeout', 'clearTimeout',
    main.slice(a, b) + '\nreturn { noteMeterSeen, vfoMetersAvailable, _metersSeenSession };');
  const api = factory(settings, () => saves.push(1), () => pushes.push(1), (fn) => { fn(); return 1; }, () => {});
  return { ...api, saves, pushes };
}

console.log('VFO view: only the meters the radio reports');

test('nothing reported, nothing shown; a reading shows that meter only', () => {
  const settings = { activeRigId: 'r1', catTarget: { type: 'serial' }, rigs: [{ id: 'r1', model: 'IC-7300', catTarget: { type: 'serial' } }] };
  const m = load(settings);
  assert.deepStrictEqual(m.vfoMetersAvailable(), { smeter: false, swr: false, alc: false, power: false });
  m.noteMeterSeen('smeter');
  assert.deepStrictEqual(m.vfoMetersAvailable(), { smeter: true, swr: false, alc: false, power: false });
  assert.strictEqual(m.pushes.length, 1, 'the VFO window is told at once');
  m.noteMeterSeen('smeter');
  assert.strictEqual(m.pushes.length, 1, 'only the first reading pushes');
});

test('remembered per rig and connection type, so TX meters show before the first TX', () => {
  const settings = { activeRigId: 'r1', catTarget: { type: 'serial' }, rigs: [{ id: 'r1', model: 'TS-480', catTarget: { type: 'serial' } }] };
  const a = load(settings);
  a.noteMeterSeen('swr'); a.noteMeterSeen('alc');
  assert.deepStrictEqual(settings.rigs[0].metersSeen, { sig: 'serial|TS-480', list: ['swr', 'alc'] });
  assert.ok(a.saves.length >= 1, 'persisted');
  const b = load(settings); // next session, nothing seen yet
  assert.deepStrictEqual(b.vfoMetersAvailable(), { smeter: false, swr: true, alc: true, power: false });
  settings.rigs[0].catTarget = { type: 'rigctld' }; settings.catTarget = { type: 'rigctld' };
  assert.deepStrictEqual(load(settings).vfoMetersAvailable(), { smeter: false, swr: false, alc: false, power: false },
    'a different connection type starts over: rigctld may not answer what serial did');
});

test('a No-CAT (VOX) rig never shows a meter', () => {
  const settings = { activeRigId: 'r1', catTarget: { type: 'none' }, rigs: [{ id: 'r1', model: 'Pebble HF', catTarget: { type: 'none' } }] };
  const m = load(settings);
  m.noteMeterSeen('smeter');
  assert.deepStrictEqual(m.vfoMetersAvailable(), { smeter: false, swr: false, alc: false, power: false });
});

test('main: real readings mark meters; synthetic values never do', () => {
  for (const [fn, key] of [['sendCatSmeter', 'smeter'], ['sendCatSwr', 'swr'], ['sendCatAlc', 'alc']]) {
    const body = main.slice(main.indexOf(`function ${fn}(val) {`), main.indexOf(`function ${fn}(val) {`) + 200);
    assert.ok(body.includes(`noteMeterSeen('${key}')`), fn);
  }
  const fwd = main.slice(main.indexOf('function sendCatFwdPower(watts) {'), main.indexOf('function sendCatPower('));
  assert.ok(/function sendCatFwdPower\(watts\) \{\n?\r?\n?\s*noteMeterSeen\('power'\)/.test(fwd), 'a measured wattmeter reading marks PWR');
  assert.ok(/_fwdPowerHold\.reset\(\); push\(0\);/.test(fwd), 'the 3 s decay to 0 uses push(), not sendCatFwdPower, so it never counts');
  assert.ok(/smartSdr\.on\('swr-ratio', \(swr\) => \{\s*noteMeterSeen\('swr'\)/.test(main), 'Flex true SWR counts');
  assert.ok(/meters: vfoMetersAvailable\(\)/.test(main), 'the list rides vfo-radio-state');
  assert.ok(/async function connectCat\(\) \{[\s\S]{0,300}_metersSeenSession\.clear\(\)/.test(main), 'a new connection starts with nothing seen');
  assert.ok(/SETUP_KEYS = \[[^\]]*'metersSeen'/.test(main), 'a rig-list save from the renderer keeps metersSeen');
});

test('VFO window: rows follow the list; with none the meter block is gone', () => {
  assert.ok(/if \(s && s\.meters\) \{ radioMeters = s\.meters; applyMeterRows\(\); \}/.test(vfo));
  assert.ok(/let radioMeters = null;/.test(vfo), 'nothing is drawn before main says what the radio reports');
  assert.ok(/classList\.toggle\('visible', !!vfoWidgets\.smeter && any\)/.test(vfo), 'the block shows only with at least one row');
  assert.ok(/function applyWidgets\(\) \{[\s\S]{0,400}applyMeterRows\(\);/.test(vfo), 'the widget toggle cannot bring back empty rows');
});

console.log(`\nVFO meters: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
