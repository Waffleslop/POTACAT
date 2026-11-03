#!/usr/bin/env node
'use strict';
// Radio power on/off at the bottom of the VFO window (KQ5O 2026-10-26: an
// FTDX101MP driven from a laptop over a remote shack had no Power On anywhere —
// the main window's Rig button shows only while CAT answers, and a switched-off
// radio does not answer). Casey: "VFO, at the bottom, where someone can scroll to."
// Run: node test/vfo-power-button-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'vfo-popout.html'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('VFO window: radio power');
test('the section exists with both buttons', () => {
  assert.ok(/id="sec-power"/.test(html));
  assert.ok(/id="vfo-power-on"/.test(html) && /id="vfo-power-off"/.test(html));
});
test('it stays below every ordered block', () => {
  assert.ok(/function applyOrder\(\)[\s\S]{0,500}getElementById\('sec-power'\)[\s\S]{0,80}pane\.appendChild\(power\)/.test(html));
});
test('shown from the model caps, never from the CAT link', () => {
  assert.ok(/power: vfoPowerAvailable\(\)/.test(main), 'vfo-radio-state carries power');
  assert.ok(/function vfoPowerAvailable\(\) \{\s*try \{ return !!getRigCapabilities\(detectRigType\(\)\)\.power;/.test(main));
  assert.ok(/s\.power != null\) document\.getElementById\('sec-power'\)\.style\.display = s\.power \? '' : 'none'/.test(html));
});
test('the buttons go through the one dispatcher; Off asks once', () => {
  assert.ok(/rigControl\(\{ action: 'power-on' \}\)/.test(html));
  assert.ok(/Press again to power off/.test(html));
  assert.ok(/rigControl\(\{ action: 'power-off' \}\)/.test(html));
  assert.ok(!/confirm\(/.test(html.slice(html.indexOf('wirePowerButtons'), html.indexOf('wirePowerButtons') + 1500)), 'no browser dialog');
});
test('remote mode forwards rig-control to the shack', () => {
  assert.ok(/ipcMain\.handle\('rig-control'[\s\S]{0,400}isRemoteMode\(\)[\s\S]{0,300}remoteClient\.sendRaw\(\{ type: 'rig-control', data \}\)/.test(main));
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
