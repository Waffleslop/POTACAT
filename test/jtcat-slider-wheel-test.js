#!/usr/bin/env node
'use strict';
// K4RVC (first FT8 day, 2026-10-20): "for TX Pwr and Drive trying to drag
// that setting with the mouse is making large changes ... use the scroll
// wheel ... and/or type in a value." The JTCAT pop-out's level sliders are
// 56-80 px wide; jpWheelAndType adds wheel stepping (Shift = 5 steps) over
// the slider or its readout, and click-to-type on the readout, both feeding
// the existing 'input'/'change' handlers so nothing else changes.
// Run: node test/jtcat-slider-wheel-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('JTCAT slider wheel + type');
const pop = R('renderer/jtcat-popout.js');
const fn = pop.slice(pop.indexOf('function jpWheelAndType('), pop.indexOf('function stopPopoutAudio('));

test('applied to RX gain, Drive and TX Pwr (with its choices list)', () => {
  assert.ok(/jpWheelAndType\(jpRxGain, jpRxGainVal\);/.test(fn));
  assert.ok(/jpWheelAndType\(jpTxGain, jpTxGainVal\);/.test(fn));
  assert.ok(/jpWheelAndType\(jpRfRange, jpRfVal, \{ select: jpRfSelect \}\);/.test(fn));
  // Applied after all three controls exist in scope (declared above the helper).
  const decl = (id) => pop.indexOf(`document.getElementById('${id}')`);
  for (const id of ['jp-rx-gain', 'jp-tx-gain', 'jp-rf-power', 'jp-rf-power-select']) assert.ok(decl(id) > 0 && decl(id) < pop.indexOf('function jpWheelAndType('), id + ' declared before use');
});

test('wheel steps by the slider\'s own step, Shift ×5, clamped, and fires the existing handlers', () => {
  assert.ok(/var step = Number\(el\.step\) \|\| 1;/.test(fn));
  assert.ok(/dir \* step \* \(big \? 5 : 1\)/.test(fn));
  assert.ok(/v = Math\.max\(min, Math\.min\(max, v\)\);/.test(fn));
  assert.ok(/el\.dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\);\n\s*el\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\);/.test(fn), 'input + change, so the RF send/paint and the gain sync run unchanged');
  assert.ok(/e\.preventDefault\(\);\n\s*stepBy\(e\.deltaY < 0 \? 1 : -1, e\.shiftKey\);/.test(fn), 'wheel up = more; the page does not scroll');
  assert.ok(/addEventListener\('wheel', onWheel, \{ passive: false \}\)/.test(fn), 'non-passive so preventDefault works');
  assert.ok(/if \(el\.disabled\) return;/.test(fn), 'a read-only power control is not stepped');
  assert.ok(/el\.tagName === 'SELECT'[\s\S]*?el\.selectedIndex = i;/.test(fn), 'fixed power steps are walked option by option');
});

test('click on the readout types a value; Enter commits, Escape restores', () => {
  assert.ok(/box\.type = 'number';/.test(fn) && /box\.min = el\.min; box\.max = el\.max;/.test(fn));
  assert.ok(/k\.key === 'Enter'\) \{ k\.preventDefault\(\); finish\(true\); \}/.test(fn));
  assert.ok(/k\.key === 'Escape'\) \{ k\.preventDefault\(\); finish\(false\); \}/.test(fn));
  assert.ok(/valEl\.textContent = old;/.test(fn), 'cancel restores the readout');
  assert.ok(/Scroll to adjust, click to type a value/.test(fn), 'the readout says so on hover');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
