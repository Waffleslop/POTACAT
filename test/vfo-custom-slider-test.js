#!/usr/bin/env node
'use strict';
// The VFO pop-out's custom CAT sliders (renderer/vfo-popout.html).
//
// Every vfo-radio-state carries settings.customCatButtons, several times a
// second, and the window rebuilt all custom controls on each one. A rebuilt
// slider started at its minimum, so a slider being dragged jumped back to 0
// under the pointer: it could not be turned down, and only the odd value
// slipped through between two rebuilds (DA2PK, AF gain AG0{v3}; on an FT-710,
// 2026-11-14). Now the controls are rebuilt only when a slot changed, and a
// rebuilt slider starts at the value it last sent.
// Run: node test/vfo-custom-slider-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const VFO = readSrc(path.join(__dirname, '..', 'renderer', 'vfo-popout.html'));

function fnSource(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.notStrictEqual(start, -1, name + ' not found');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(name + ' unbalanced');
}

// The three functions in a sandbox: a fake document holding one slider
// element per key, and a build counter in place of buildCustomCatBtns.
function harness() {
  const env = { builds: 0, active: null, sliders: [] };
  const document = {
    get activeElement() { return env.active; },
    querySelectorAll: () => env.sliders,
  };
  const make = new Function('document', 'env', `
    let customCatButtons = [];
    const customSliderLast = {};
    let customCatSlotsSig = null;
    function buildCustomCatBtns() { env.builds++; }
    ${fnSource(VFO, 'customCatSlotsSignature')}
    ${fnSource(VFO, 'customSliderStartValue')}
    ${fnSource(VFO, 'applyCustomCatSlots')}
    return { applyCustomCatSlots, customSliderStartValue, customSliderLast };
  `);
  return Object.assign(env, make(document, env));
}

function slider(key, value) {
  const r = { value: String(value) };
  const v = { textContent: String(value) };
  return { _key: key, range: r, querySelector: (q) => (q.includes('range') ? r : v) };
}

const AF = { name: 'AF', type: 'slider', command: 'AG0{v3};', min: 0, max: 255 };

test('the same slot list again does not rebuild the controls', () => {
  const h = harness();
  h.applyCustomCatSlots([AF]);
  for (let i = 0; i < 20; i++) h.applyCustomCatSlots([Object.assign({}, AF)]);
  assert.strictEqual(h.builds, 1);
});

test('a changed slot rebuilds them', () => {
  const h = harness();
  h.applyCustomCatSlots([AF]);
  h.applyCustomCatSlots([Object.assign({}, AF, { max: 100 })]);
  h.applyCustomCatSlots([AF, { name: 'SQL', type: 'slider', command: 'SQ0{v3};' }]);
  assert.strictEqual(h.builds, 3);
});

test('a value the main window saved is shown in place, without a rebuild', () => {
  const h = harness();
  const s = slider('AF|AG0{v3};', 0);
  h.sliders.push(s);
  h.applyCustomCatSlots([AF]);
  h.applyCustomCatSlots([Object.assign({}, AF, { value: 120 })]);
  assert.strictEqual(h.builds, 1);
  assert.strictEqual(s.range.value, 120);
  assert.strictEqual(h.customSliderLast['AF|AG0{v3};'], 120);
});

test('...but never on the slider being dragged here', () => {
  const h = harness();
  const s = slider('AF|AG0{v3};', 40);
  h.sliders.push(s);
  h.active = s.range;
  h.applyCustomCatSlots([AF]);
  h.applyCustomCatSlots([Object.assign({}, AF, { value: 120 })]);
  assert.strictEqual(s.range.value, '40');
});

test('a rebuilt slider starts at what this window sent, then the saved value, then the minimum', () => {
  const h = harness();
  assert.strictEqual(h.customSliderStartValue(AF, 35, 0), 35);
  assert.strictEqual(h.customSliderStartValue(Object.assign({}, AF, { value: 80 }), undefined, 0), 80);
  assert.strictEqual(h.customSliderStartValue(AF, undefined, 10), 10);
});

test('wiring: the status handler goes through applyCustomCatSlots; a drag records its value', () => {
  assert.ok(/if \(s\.customCatButtons\) applyCustomCatSlots\(s\.customCatButtons\);/.test(VFO));
  assert.ok(!/if \(s\.customCatButtons\) \{\s*customCatButtons = s\.customCatButtons;\s*buildCustomCatBtns\(\);/.test(VFO), 'no rebuild per status');
  assert.ok(/range\.value = customSliderStartValue\(b, customSliderLast\[b\.name \+ '\|' \+ b\.command\], lo\);/.test(VFO));
  assert.ok(/const key = b\.name \+ '\|' \+ b\.command;\s*customSliderLast\[key\] = \+range\.value;/.test(VFO));
});

console.log(`\nVFO custom sliders: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
