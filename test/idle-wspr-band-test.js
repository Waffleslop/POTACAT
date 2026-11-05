#!/usr/bin/env node
'use strict';
// artificialjumpprotection (IC-7100, no HF antenna, 2026-11-05): idle-RX WSPR
// went to 20 m with 20 m turned off in the rig's bands, and 2 m was not on
// offer though the WSPR table has its dial (144.489).
// Run: node test/idle-wspr-band-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const W = require('../lib/idle-wspr-band');
const wsprBands = require('../lib/wspr/bands');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

test('2 m is an idle WSPR band, with the 144.489 dial', () => {
  assert.ok(W.IDLE_WSPR_BANDS.includes('2m'));
  assert.strictEqual(wsprBands.dialForBand('2m'), 144.489);
  for (const b of W.IDLE_WSPR_BANDS) assert.ok(wsprBands.dialForBand(b), b + ' has a dial');
});

test('a VHF-only radio with 20 m saved listens on 2 m, never 20 m', () => {
  assert.strictEqual(W.pickIdleWsprBand('20m', ['2m', '70cm']), '2m');
});

test('the saved band is kept when the radio has it; an unrestricted radio keeps it too', () => {
  assert.strictEqual(W.pickIdleWsprBand('17m', ['40m', '20m', '17m']), '17m');
  assert.strictEqual(W.pickIdleWsprBand('20m', null), '20m');
  assert.strictEqual(W.pickIdleWsprBand('2m', null), '2m');
});

test('a saved band that is not an idle band, or none at all: the first band the radio has', () => {
  assert.strictEqual(W.pickIdleWsprBand('6m', ['6m', '30m']), '30m');
  assert.strictEqual(W.pickIdleWsprBand(undefined, ['15m', '10m']), '15m');
  assert.strictEqual(W.pickIdleWsprBand('20m', ['6m', '70cm']), null, 'nothing to listen on');
});

test('the WSPR hop skips bands the radio is not used on', () => {
  assert.deepStrictEqual(W.hopBandsForRig(['40m', '20m', '2m'], ['2m', '40m']), ['40m', '2m']);
  assert.deepStrictEqual(W.hopBandsForRig(['40m', '20m'], null), ['40m', '20m']);
});

test('main uses it for the idle start, the settings it hands out and the hop; both dropdowns offer 2 m', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/const band = IdleWsprBand\.pickIdleWsprBand\(saved, activeRigBands\(\)\) \|\| saved;/.test(main));
  assert.ok(/idleWsprBand: IdleWsprBand\.pickIdleWsprBand\(settings\.idleWsprBand, activeRigBands\(\)\)/.test(main));
  assert.ok(/const bands = IdleWsprBand\.hopBandsForRig\(jtcatWsprHopBands, activeRigBands\(\)\);/.test(main));
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const settingsSel = html.slice(html.indexOf('id="set-idle-wspr-band"'), html.indexOf('</select>', html.indexOf('id="set-idle-wspr-band"')));
  const welcomeSel = html.slice(html.indexOf('id="welcome-idle-wspr-band"'), html.indexOf('</select>', html.indexOf('id="welcome-idle-wspr-band"')));
  assert.ok(/value="2m"/.test(settingsSel) && /value="2m"/.test(welcomeSel));
});

console.log(`\nIdle WSPR band: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
