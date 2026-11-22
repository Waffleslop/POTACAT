#!/usr/bin/env node
'use strict';
// #891 (NJ2DX 2026-11-22, IC-9700): the VFO pop-out's 70cm button sent
// 420.000 MHz, the US band edge. The IC-9700 (and most of the world) starts
// 70 cm at 430 MHz, so POTACAT refused it as outside the radio's range. The
// button goes where the main window's 70cm QSY goes, 432 MHz, inside every
// region's 70 cm band and every 70 cm radio's range in lib/rig-models.js.
// Run: node test/vfo-popout-70cm-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vfo = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'vfo-popout.html'), 'utf8');
const { RIG_MODELS } = require('../lib/rig-models');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const m = vfo.match(/\{ label: '70cm', freq: (\d+) \}/);
const khz = m ? Number(m[1]) : NaN;

test('the 70cm button sends 432.000 MHz', () => assert.strictEqual(khz, 432000));
test('the 70cm button is inside every 70 cm radio range POTACAT knows', () => {
  const hz = khz * 1000;
  for (const [name, info] of Object.entries(RIG_MODELS)) {
    const r = (info && info.rxHz) || [];
    const uhf = r.filter(([lo, hi]) => hi >= 420e6 && lo <= 450e6);
    if (!uhf.length) continue;
    assert.ok(uhf.some(([lo, hi]) => hz >= lo && hz <= hi), `${name}: ${khz} kHz is outside its 70 cm range`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
