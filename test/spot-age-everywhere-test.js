#!/usr/bin/env node
'use strict';
// #502: every surface that shows spots uses the table's Max Spot Age.
// The VFO window's activator card named spots the table had aged out (it
// looked them up in allSpots, which also holds old spots), and the Spots
// pop-out, ECHOCAT, SmartSDR and TCI each had their own copy of the age rule
// with different per-source windows. All of them now run lib/spot-age.js.
// Run: node test/spot-age-everywhere-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const SpotAge = require('../lib/spot-age');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok ' + name); }
  catch (e) { failed++; console.log('  FAIL: ' + name + '\n      ' + (e.stack || e.message)); }
}
const R = (f) => readSrc(path.join(__dirname, '..', f)).replace(/\r\n/g, '\n');
const main = R('main.js');
const app = R('renderer/app.js');

function body(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found');
  let d = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; }
  return src.slice(start, i + 1);
}

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const ago = (min) => new Date(NOW - min * 60000).toISOString().replace(/\.\d+Z$/, '');
const spot = (call, source, min, freq) => ({ callsign: call, source, spotTime: ago(min), frequency: freq || '14250', band: '20m', mode: 'SSB' });
const FakeDate = class extends Date { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };

console.log('Spot age on every surface (#502)');

test('the surface cap shortens the table window, never lengthens it', () => {
  const o = SpotAge.ageOptsFromSettings({ maxAgeMin: 30, sotaMaxAge: 30 });
  assert.strictEqual(SpotAge.spotAgeLimitSecs({ source: 'wwff' }, Object.assign({}, o, { capMin: 15 })), 900);
  assert.strictEqual(SpotAge.spotAgeLimitSecs({ source: 'wwff' }, Object.assign({}, o, { capMin: 60 })), 1800);
  assert.strictEqual(SpotAge.spotAgeLimitSecs({ source: 'pskr' }, Object.assign({}, o, { capMin: 60 })), 900);
  assert.strictEqual(SpotAge.spotAgeLimitSecs({ source: 'wwff' }, Object.assign({}, o, { capMin: 0 })), 1800, '0 = no extra cap');
  assert.strictEqual(SpotAge.spotAgeLimitSecs({ source: 'sota' }, o), 1800, 'no cap = the table window');
});

// main.js's helper, run with the given settings.
function withinMaxAge(settings) {
  // eslint-disable-next-line no-new-func
  return new Function('settings', 'SpotAge', 'Date', body(main, 'spotsWithinMaxAge') + '\nreturn spotsWithinMaxAge;')(settings, SpotAge, FakeDate);
}

test('ECHOCAT and the Spots pop-out drop the 222-minute spot with a 30-minute limit', () => {
  const f = withinMaxAge({ maxAgeMin: 30 });
  const out = f([spot('VK4OLD', 'wwff', 222), spot('VK4NEW', 'wwff', 3), spot('K1POTA', 'pota', 222), { callsign: 'NET', source: 'net' }]);
  assert.deepStrictEqual(out.map((s) => s.callsign).sort(), ['K1POTA', 'NET', 'VK4NEW']);
});

test('SmartSDR / TCI: the table window per source, with the panadapter cap on top', () => {
  const f = withinMaxAge({ maxAgeMin: 5, sotaMaxAge: 30 });
  // A 20-minute SOTA spot is on the table (30-minute SOTA window), so a 15-minute
  // panadapter cap drops it and a 60-minute one keeps it. It used to be cut at 5.
  assert.deepStrictEqual(f([spot('S20', 'sota', 20)], 60).map((s) => s.callsign), ['S20']);
  assert.deepStrictEqual(f([spot('S20', 'sota', 20)], 15), []);
  // POTA follows the feed, so only the cap applies.
  assert.deepStrictEqual(f([spot('P10', 'pota', 10), spot('P20', 'pota', 20)], 15).map((s) => s.callsign), ['P10']);
});

test('every main-process spot surface goes through the shared rule', () => {
  const merged = body(main, 'sendMergedSpots');
  assert.ok(/remoteServer\.broadcastSpots\(spotsWithinMaxAge\(merged\)\)/.test(merged), 'ECHOCAT');
  assert.ok(/send\('spots-popout-data', spotsWithinMaxAge\(merged\)\)/.test(merged), 'Spots pop-out push');
  assert.ok(/spotsWithinMaxAge\(spotsForPanadapter\(spots\), sdrCapMin\)/.test(body(main, 'pushSpotsToSmartSdr')), 'SmartSDR');
  assert.ok(/spotsWithinMaxAge\(spotsForPanadapter\(spots\), tciCapMin\)/.test(body(main, 'pushSpotsToTci')), 'TCI');
  assert.ok(/spotsWithinMaxAge\(/.test(body(main, 'spotsForScope')), 'Band Scope and bandspread');
  // No surface gets the raw list.
  assert.ok(!/send\('spots-popout-data', merged\)/.test(main), 'Spots pop-out never gets the unaged list');
  assert.ok(!/maxAgeMin != null \? settings\.maxAgeMin : 5\) \* 60000/.test(main), 'no private copy of the age rule left in main');
});

test('a spot that ages out leaves the Spots pop-out with no new spots arriving', () => {
  assert.ok(/spotsPopoutWin[\s\S]*send\('spots-popout-data', spotsWithinMaxAge\(lastMergedSpots/.test(body(main, 'repushPanadapterPopouts')));
});

// The renderer's VFO card helpers, with a fake allSpots.
function cardEnv(spots, extra) {
  const env = Object.assign({
    allSpots: spots, maxAgeMin: 30, sotaMaxAgeMin: 30, dxcMaxAgeMin: 15, potaAgeLimit: false,
    SpotAge, Date: FakeDate, vfoCardSpot: null, lastTunedSpot: null, sent: [],
  }, extra || {});
  env.notifyVfoTunedSpot = (s) => { env.sent.push(s); env.vfoCardSpot = s; };
  const scope = new Proxy(env, {
    has: () => true,
    get: (t, k) => (k === Symbol.unscopables ? undefined : (k in t ? t[k] : globalThis[k])),
    set: (t, k, v) => { t[k] = v; return true; },
  });
  const src = body(app, 'liveSpotAtFreq') + '\n' + body(app, 'refreshVfoCardAge');
  // eslint-disable-next-line no-new-func
  const fns = new Function('scope', 'with (scope) { ' + src + '\nreturn { liveSpotAtFreq, refreshVfoCardAge }; }')(scope);
  return { env, fns };
}

test('the VFO card never picks up an aged-out spot from the dial', () => {
  const { fns } = cardEnv([spot('VK4OLD', 'wwff', 222, '14250'), spot('W1NEW', 'wwff', 3, '14260')]);
  assert.strictEqual(fns.liveSpotAtFreq(14250), null, 'the 222-minute spot is not named');
  assert.strictEqual(fns.liveSpotAtFreq(14260).callsign, 'W1NEW');
});

test('an aged-out card spot leaves on the next spot refresh; a fresh one at the frequency replaces it', () => {
  const old = spot('VK4OLD', 'wwff', 40, '14250');
  let t = cardEnv([old], { vfoCardSpot: old });
  t.fns.refreshVfoCardAge();
  assert.deepStrictEqual(t.env.sent, [null], 'card cleared');
  const fresh = spot('VK4OLD', 'wwff', 2, '14250');
  t = cardEnv([fresh], { vfoCardSpot: old });
  t.fns.refreshVfoCardAge();
  assert.strictEqual(t.env.sent[0], fresh, 'the re-spot takes its place');
});

test('the operator\'s own pick stays on the card, as the table keeps it pinned', () => {
  const old = spot('VK4OLD', 'wwff', 40, '14250');
  const t = cardEnv([], { vfoCardSpot: old, lastTunedSpot: old });
  t.fns.refreshVfoCardAge();
  assert.deepStrictEqual(t.env.sent, []);
});

test('the dial, the VFO window opening and every spot refresh use the live lookup', () => {
  assert.ok(/const onSpot = onPicked \? lastTunedSpot : liveSpotAtFreq\(exactKhz\);/.test(app), 'dial');
  assert.ok(/const onFreq = radioFreqKhzExact != null \? liveSpotAtFreq\(radioFreqKhzExact\) : null;/.test(app), 'VFO window opens');
  assert.ok(/allSpots = spots;\n\s*render\(\);\n\s*refreshVfoCardAge\(\);/.test(app), 'spot refresh');
  assert.ok(!/allSpots\.find\(s => Math\.abs\(parseFloat\(s\.frequency\) - (exactKhz|radioFreqKhzExact)\) < 0\.5\)/.test(app), 'no unaged lookup by frequency left');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
