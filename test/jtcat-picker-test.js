#!/usr/bin/env node
'use strict';
// The JTCAT window for older eyes (Casey 2026-11-02): one band-and-mode button
// and picker, buttons that are the actions, a Call button on CQ rows.
// Run: node test/jtcat-picker-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'jtcat-popout.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'jtcat-popout.js'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('the band and mode selects stay in the DOM as the sources of truth', () => {
  for (const id of ['jp-band', 'jp-mode', 'jp-auto-cq', 'jp-enable-tx']) assert.ok(html.includes('id="' + id + '"'), id);
  assert.ok(/class="jp-src-selects" hidden/.test(html));
  assert.ok(/id="jp-enable-tx" class="jp-btn" hidden/.test(html));
});
test('picker: taps only pick; Switch drives the selects; hidden bands stay out', () => {
  assert.ok(/if \(bo\.hidden && band !== curBand\) return;/.test(js), 'rig-bands filter');
  const apply = js.slice(js.indexOf('function pkApply('), js.indexOf('function pkApply(') + 700);
  assert.ok(/modeSelect\.dispatchEvent\(new Event\('change'\)\)/.test(apply) && /selectBand\(opt, true\)/.test(apply));
  const render = js.slice(js.indexOf('function pkRender('), js.indexOf('function pkOpen('));
  assert.ok(!/selectBand|window\.api\.tune/.test(render), 'a tap must not retune');
});
test('the button follows paths that assign the mode with no change event', () => {
  assert.ok(/Object\.defineProperty\(modeSelect, 'value'/.test(js));
});
test('controls: the buttons are the actions', () => {
  for (const id of ['jp-cq', 'jp-hunt-btn', 'jp-hunt-target', 'jp-halt-tx', 'jp-tune', 'jp-atu', 'jp-full-auto-cq', 'jp-cq-preview']) assert.ok(html.includes('id="' + id + '"'), id);
  assert.ok(html.includes('>Logbook</button>'));
  assert.ok(html.includes('whichever half is free'));
  assert.ok(js.includes("'<option value=\"\">everyone</option>'"));
});
test('a CQ row has a Call button that takes the double-click path', () => {
  assert.ok(/if \(c\.isCq\) \{\s*var callBtn/.test(js));
  assert.ok(/e\.stopPropagation\(\); onDecodeRowClick\(decode\)/.test(js));
});
test('every QSO step is outlined', () => {
  assert.ok(/\.jp-qso-step \{[^}]*border: 1px solid var\(--border-primary\)/.test(html));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
