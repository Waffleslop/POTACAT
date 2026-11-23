#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Rotor control only on chosen bands (#356): "I only need it on 20m and up.
// 30 and below are a dipole." Off by default (every band, as before). When on,
// an automatic turn on a band that is not ticked is skipped with one log line.
// Run: node test/rotor-bands-test.js
const assert = require('assert');
const path = require('path');
const RotorBands = require('../lib/rotor-bands');

const R = (f) => readSrc(path.join(__dirname, '..', f));
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const BEAM = ['20m', '17m', '15m', '12m', '10m'];

test('off (the default) turns the rotor on every band, exactly as before', () => {
  for (const s of [{}, { rotorBandsOnly: false, rotorBands: BEAM }, { rotorBands: BEAM }]) {
    for (const band of ['80m', '40m', '30m', '20m', '6m', null, '']) {
      assert.strictEqual(RotorBands.decide(s, band).turn, true, JSON.stringify(s) + ' ' + band);
    }
  }
  assert.strictEqual(RotorBands.isOn({}), false);
});

test('on with the band ticked turns the rotor', () => {
  const s = { rotorBandsOnly: true, rotorBands: BEAM };
  for (const band of BEAM) {
    const d = RotorBands.decide(s, band);
    assert.strictEqual(d.turn, true, band);
    assert.ok(!d.line, 'no log line when it turns');
  }
});

test('on with the band not ticked skips the turn and gives one log line', () => {
  const s = { rotorBandsOnly: true, rotorBands: BEAM };
  for (const band of ['80m', '40m', '30m']) {
    const d = RotorBands.decide(s, band);
    assert.strictEqual(d.turn, false, band);
    assert.ok(typeof d.line === 'string' && d.line.includes(band), 'line names the band: ' + d.line);
    assert.ok(!d.line.includes('\n'), 'one line');
    assert.ok(/Rotor/.test(d.line) && /Settings/.test(d.line), 'says where to change it');
  }
});

test('an unknown band (outside every ham band) is skipped when the setting is on: the safe choice is not to turn', () => {
  const s = { rotorBandsOnly: true, rotorBands: BEAM };
  for (const band of [null, undefined, '', 'bogus']) {
    const d = RotorBands.decide(s, band);
    assert.strictEqual(d.turn, false, String(band));
    assert.ok(d.line && /not a ham band|unknown/i.test(d.line), d.line);
  }
});

test('on with no band ticked does not silently kill the rotor: every band, as when off', () => {
  assert.strictEqual(RotorBands.decide({ rotorBandsOnly: true, rotorBands: [] }, '40m').turn, true);
  assert.strictEqual(RotorBands.decide({ rotorBandsOnly: true }, '40m').turn, true);
  assert.strictEqual(RotorBands.isOn({ rotorBandsOnly: true, rotorBands: [] }), false);
});

test('band names are cleaned: case, spaces, unknown names and duplicates', () => {
  assert.deepStrictEqual(RotorBands.clean([' 20M', '10m', '20m', 'xyz', null, '6m']), ['20m', '10m', '6m']);
  assert.deepStrictEqual(RotorBands.clean('20m'), []);
  assert.strictEqual(RotorBands.decide({ rotorBandsOnly: true, rotorBands: ['20M'] }, '20m').turn, true);
});

test('the tick boxes offer the bands the operator\'s rigs cover, low to high, plus any already ticked', () => {
  assert.deepStrictEqual(RotorBands.choices([['40m', '20m'], ['20m', '6m']], []), ['40m', '20m', '6m']);
  assert.deepStrictEqual(RotorBands.choices([['20m']], ['2m']), ['20m', '2m'], 'a saved tick is never hidden');
  // A rig of unknown model is not restricted (lib/rig-bands.js), so every band is offered.
  assert.deepStrictEqual(RotorBands.choices([['20m'], null], []), RotorBands.ALL_BANDS);
  // No rigs at all: HF and 6 m, the common case, plus saved ticks.
  const none = RotorBands.choices([], []);
  assert.ok(none.includes('160m') && none.includes('10m') && none.includes('6m') && !none.includes('23cm'));
});

// --- wiring -------------------------------------------------------------
const main = R('main.js');

test('wiring: main.js asks RotorBands before every automatic turn in tuneRadio (spots, scan, ECHOCAT)', () => {
  assert.ok(/require\('\.\/lib\/rotor-bands'\)/.test(main), 'main requires lib/rotor-bands');
  const i = main.indexOf('function tuneRadio(');
  assert.ok(i > 0);
  const body = main.slice(i, i + 40000);
  const turn = body.indexOf('sendRotorBearing(Math.round(brng))');
  assert.ok(turn > 0, 'tuneRadio turns the rotor');
  const before = body.slice(Math.max(0, turn - 1500), turn);
  assert.ok(/RotorBands\.decide\(settings,/.test(before), 'the band rule is checked right before the turn');
});

test('wiring: a skipped turn is logged once per band, not on every click', () => {
  assert.ok(/_rotorBandSkipNoted/.test(main), 'remembers the band it already logged');
});

test('wiring: a click on the bearing (rotate-to) is the operator asking, so it still turns on any band', () => {
  const i = main.indexOf("ipcMain.on('rotate-to'");
  assert.ok(i > 0);
  const body = main.slice(i, main.indexOf('});', i));
  assert.ok(!/RotorBands/.test(body), 'explicit click is not filtered');
});

test('wiring: settings defaults are off, and the save path carries the keys', () => {
  assert.ok(/ipcMain\.handle\('rotor-band-choices'/.test(main), 'IPC for the tick-box list');
  const pre = R('preload.js');
  assert.ok(/rotorBandChoices:/.test(pre), 'preload exposes rotorBandChoices');
  const html = R('renderer/index.html');
  assert.ok(html.includes('id="set-rotor-bands-only"'), 'tick box in Settings > Tuning > Antenna');
  assert.ok(html.includes('Turn the rotor only on these bands'), 'the label');
  assert.ok(html.includes('id="rotor-bands-grid"'), 'band grid');
  const app = R('renderer/app.js');
  assert.ok(/rotorBandsOnly:/.test(app) && /rotorBands:/.test(app), 'app.js saves both keys');
  assert.ok(/s\.rotorBandsOnly === true/.test(app), 'a missing key loads as off (the default)');
});

console.log(`\nRotor bands: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
