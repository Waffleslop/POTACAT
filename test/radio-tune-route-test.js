#!/usr/bin/env node
'use strict';
// The one "is the radio reachable for tuning" decision (lib/radio-tune-route.js),
// in tuneRadio's order: TCI, WSJT-X + SmartSDR API, Flex Direct, CAT. Found on a
// FLEX-8600M on 2026-11-18: Flex Direct up, APRS refused because it asked
// `cat && cat.connected` and the 5002 shim was dead without SmartSDR.
// Run: node test/radio-tune-route-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = require('../lib/radio-tune-route');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const NONE = { tciTarget: false, tciLinked: false, wsjtxMode: false, smartSdrConnected: false, smartSdrCanTune: false, smartSdrSelf: false, catConnected: false, catTargetType: '' };
const route = (o) => R.tuneRoute({ ...NONE, ...o });

console.log('Radio tune route');

test('Flex Direct, no SmartSDR (the 8600M on 2026-11-18): the dead 5002 shim does not matter', () => {
  const s = { smartSdrConnected: true, smartSdrCanTune: true, smartSdrSelf: true, catConnected: false, catTargetType: 'tcp' };
  assert.strictEqual(route(s), 'flex-direct');
  assert.strictEqual(R.canTune({ ...NONE, ...s }), true);
});

test('Flex Direct beside a live SmartSDR shim (multiFlex self): our own slice, not the shim', () => {
  assert.strictEqual(route({ smartSdrConnected: true, smartSdrCanTune: true, smartSdrSelf: true, catConnected: true, catTargetType: 'tcp' }), 'flex-direct');
});

test('Flex API bound to SmartSDR with the shim up: CAT (the shim tunes SmartSDR\'s slice)', () => {
  assert.strictEqual(route({ smartSdrConnected: true, smartSdrCanTune: true, smartSdrSelf: false, catConnected: true, catTargetType: 'tcp' }), 'cat');
});

test('Flex API bound, shim down: the API tunes', () => {
  assert.strictEqual(route({ smartSdrConnected: true, smartSdrCanTune: true, smartSdrSelf: false, catConnected: false }), 'flex-direct');
});

test('SmartSDR API up but no slice to tune yet, no CAT: not reachable', () => {
  assert.strictEqual(route({ smartSdrConnected: true, smartSdrCanTune: false, catConnected: false }), '');
});

test('serial CAT, rigctld, Icom Network, CI-V over TCP: CAT when its link is up', () => {
  for (const t of ['serial', 'rigctld', 'icom-network', 'civ-tcp']) {
    assert.strictEqual(route({ catConnected: true, catTargetType: t }), 'cat', t);
    assert.strictEqual(route({ catConnected: false, catTargetType: t }), '', t + ' down');
  }
});

test('TCI (Zeus / Thetis): its own link decides, never a stale CAT or Flex flag', () => {
  assert.strictEqual(route({ tciTarget: true, tciLinked: true, catTargetType: 'tci' }), 'tci');
  assert.strictEqual(route({ tciTarget: true, tciLinked: false, catTargetType: 'tci' }), '');
  assert.strictEqual(route({ tciTarget: true, tciLinked: false, catConnected: true, smartSdrCanTune: true, smartSdrSelf: true }), '');
});

test('WSJT-X mode with CAT closed: only a Flex on the API (tcp target) can be tuned', () => {
  assert.strictEqual(route({ wsjtxMode: true, smartSdrConnected: true, catTargetType: 'tcp' }), 'flex-wsjtx');
  assert.strictEqual(route({ wsjtxMode: true, smartSdrConnected: false, catTargetType: 'tcp' }), '');
  assert.strictEqual(route({ wsjtxMode: true, catTargetType: 'serial' }), '');
  assert.strictEqual(route({ wsjtxMode: true, catConnected: true, catTargetType: 'serial' }), 'cat');
});

test('nothing connected: not reachable', () => {
  assert.strictEqual(route({}), '');
  assert.strictEqual(R.canTune(null), false);
});

test('a mode on its own goes over CAT only (never the shim on a Flex route)', () => {
  assert.strictEqual(R.modeOverCat('cat'), true);
  for (const r of ['flex-direct', 'flex-wsjtx', 'tci', '']) assert.strictEqual(R.modeOverCat(r), false, r);
});

test('the place before: Flex Direct saves the slice frequency and mode as read', () => {
  // 8600M before state on 2026-11-18: slice 0 at 7.171000 MHz LSB.
  assert.deepStrictEqual(R.placeBefore({ route: 'flex-direct', freqHz: 7171000, mode: 'LSB', catDataForm: 'DIGL' }), { freqHz: 7171000, mode: 'LSB' });
  assert.deepStrictEqual(R.placeBefore({ route: 'flex-direct', freqHz: 14074000, mode: 'DIGU' }), { freqHz: 14074000, mode: 'DIGU' });
});

test('the place before: an Icom on CAT in USB + DATA is saved as its data form', () => {
  assert.deepStrictEqual(R.placeBefore({ route: 'cat', freqHz: 14074000, mode: 'USB', catDataForm: 'DIGU' }), { freqHz: 14074000, mode: 'DIGU' });
  assert.deepStrictEqual(R.placeBefore({ route: 'cat', freqHz: 7171000, mode: 'LSB', catDataForm: '' }), { freqHz: 7171000, mode: 'LSB' });
  assert.deepStrictEqual(R.placeBefore({ route: 'tci', freqHz: 7171000.4, mode: 'LSB', catDataForm: 'DIGL' }), { freqHz: 7171000, mode: 'LSB' });
  assert.deepStrictEqual(R.placeBefore({ route: 'cat', freqHz: 0, mode: '' }), { freqHz: 0, mode: '' });
});

// ── tuneRadio still checks the routes in the order the lib mirrors ────────
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const fnBody = (name) => {
  const i = main.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' not found');
  const open = main.indexOf(') {', i) + 2; // past a destructured parameter's braces
  let depth = 0;
  for (let k = open; k < main.length; k++) {
    if (main[k] === '{') depth++;
    else if (main[k] === '}' && --depth === 0) return main.slice(open, k + 1);
  }
  return '';
};

test('tuneRadio: TCI, then WSJT-X + API, then Flex Direct, then the CAT refusal (the lib\'s order)', () => {
  const b = fnBody('tuneRadio');
  const tci = b.indexOf('if (tciRigTarget()) { tciRigTune(');
  const wsjtx = b.indexOf('if (settings.enableWsjtx && (!cat || !cat.connected))');
  const flex = b.indexOf("if (smartSdr && smartSdr.canTune && (smartSdr.mode === 'self' || !cat || !cat.connected))");
  const refuse = b.indexOf('if (!cat || !cat.connected) {', flex);
  assert.ok(tci > 0 && wsjtx > tci && flex > wsjtx && refuse > flex, `order tci=${tci} wsjtx=${wsjtx} flex=${flex} refuse=${refuse}`);
});

test('main.js reads the route through radioTuneRoute(), from tuneRadio\'s own inputs', () => {
  const b = fnBody('radioTuneRoute');
  assert.ok(/RadioTuneRoute\.tuneRoute\(/.test(b));
  for (const k of ['tciRigTarget()', 'tciRigLinked()', 'settings.enableWsjtx', 'smartSdr.canTune', "smartSdr.mode === 'self'", 'cat.connected']) {
    assert.ok(b.indexOf(k) >= 0, k);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
