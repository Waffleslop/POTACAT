#!/usr/bin/env node
'use strict';
/**
 * K4RVC, IC-7300MK2 over the LAN, 2026-10-28: "When I switch/launch into
 * JTCAT, the pwr does switch to 45w, but very quickly goes back to 100w", and
 * "Launch POTACAT, which at first is SSB. So the radio gets set to 100w" with
 * the power he had set by hand. His log: FT8 preset at 15:55:54 (45 W), the
 * SSB preset 3.4 s later from the radio's own mode poll reading "USB", and
 * the SSB preset 4 s after connect at launch.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('../lib/rig-presets');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const presets = [{ id: 'p1', name: 'SSB', txPower: 100 }, { id: 'p2', name: 'FT8', txPower: 45 }];
const byMode = { '*': { ssb: 'p1', digital: 'p2' } };
const base = { band: '20m', presets, byMode, rules: [], rigId: null, transmitting: false, remote: false };

console.log('The rules (lib/rig-presets.js)');
check('an Icom in DATA mode reads back as USB; folded to USB-D it is the digital family', () => {
  assert.strictEqual(P.modeFamily('USB'), 'ssb');
  assert.strictEqual(P.modeFamily('USB-D'), 'digital');
  assert.strictEqual(P.modeFamily('LSB-D'), 'digital');
});
check('his log, replayed: FT8 applies 45 W; the radio echoing USB (data on, folded to USB-D) is the same context, not the SSB preset', () => {
  const d1 = P.decideModePreset({ ...base, mode: 'FT8', prevFamily: 'ssb', prevMatchId: 'p1' });
  assert.strictEqual(d1.reason, 'apply'); assert.strictEqual(d1.apply.id, 'p2');
  const d2 = P.decideModePreset({ ...base, mode: 'USB-D', prevFamily: d1.family, prevMatchId: d1.matchId });
  assert.strictEqual(d2.reason, 'same', JSON.stringify(d2));
  // Unfolded (the old behaviour) the same echo flipped it back: that is the bug.
  const d3 = P.decideModePreset({ ...base, mode: 'USB', prevFamily: d1.family, prevMatchId: d1.matchId });
  assert.strictEqual(d3.reason, 'apply'); assert.strictEqual(d3.apply.id, 'p1');
});
check('launch: the first mode applies nothing, and once its trigger is noted a second poll of the same mode is "same"', () => {
  const first = P.decideModePreset({ ...base, mode: 'USB', prevFamily: null, prevMatchId: null });
  assert.strictEqual(first.reason, 'first');
  assert.strictEqual(first.matchId, null);
  // main.js now notes the trigger's preset after a 'first' (rigPresetOnMode):
  const noted = P.matchTrigger({ band: '20m', family: first.family, rules: [], byMode, rigId: null }).presetId;
  assert.strictEqual(noted, 'p1');
  const again = P.decideModePreset({ ...base, mode: 'USB', prevFamily: first.family, prevMatchId: noted });
  assert.strictEqual(again.reason, 'same');
  // Without the note, the same poll applied the preset: the launch 100 W.
  const unnoted = P.decideModePreset({ ...base, mode: 'USB', prevFamily: first.family, prevMatchId: null });
  assert.strictEqual(unnoted.reason, 'apply');
});

console.log('main.js wiring');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
check('the rules see the mode with the Icom DATA flag folded in (rigPresetModeFor)', () => {
  assert.ok(/function rigPresetModeFor\(mode\)/.test(main));
  assert.ok(/cat\._codec\.dataModeState/.test(main));
  assert.ok(/mode: rigPresetModeFor\(mode\), band: _rigPresetLastBand,/.test(main));
  assert.ok(/RigPresets\.modeFamily\(rigPresetModeFor\(_currentMode\)\) !== 'digital'/.test(main));
});
check('a "first" notes its trigger; the first band learned applies nothing', () => {
  assert.ok(/if \(d\.reason === 'first' && d\.family\) \{[\s\S]{0,400}_rigPresetMatchId = \(m && m\.presetId\) \|\| null;/.test(main));
  assert.ok(/if \(!_rigPresetLastBand && _rigPresetFamily && !_rigPresetPending\) \{[\s\S]{0,400}return;\s+\}\s+rigPresetOnMode\(_currentMode\);/.test(main));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
