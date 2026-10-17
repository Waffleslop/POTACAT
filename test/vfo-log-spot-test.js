#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// VFO window LOG button. Run: node test/vfo-log-spot-test.js
//
// The VFO card follows the radio onto any spotted frequency, but LOG used
// only lastTunedSpot (a main-window click, dropped 0.5 kHz away), so the log
// opened blank under a card naming the activator (K3SBP 2026-10-17).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

check('every card update records the spot the card shows', () => {
  const at = app.indexOf('function notifyVfoTunedSpot(spot) {');
  const head = app.slice(at, at + 200);
  assert.ok(head.indexOf('vfoCardSpot = spot || null;') > 0);
  assert.ok(head.indexOf('vfoCardSpot = spot || null;') < head.indexOf('if (!spot)'), 'recorded before the null return');
});

check('LOG prefers the card spot while the radio is near it', () => {
  const at = app.indexOf('window.api.onOpenLogForm(() => {');
  const body = app.slice(at, at + 900);
  assert.ok(/const spot = cardNear \? vfoCardSpot : lastTunedSpot;/.test(body));
  assert.ok(/<= 3\)/.test(body), 'within 3 kHz');
  assert.ok(/routeLogForSpot\(\{\s*\.\.\.spot,/.test(body), 'the chosen spot fills the form');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
