#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// GitHub #239 (VK4KTW, FTDX10 + SCU-LAN10): the Band Scope pop-out drew spot
// markers 222 minutes old while Max Spot Age was 30 minutes. The scope (and
// the bandspread pop-out) got spotsForPanadapter(merged), which filters by
// source only — no age cut at all. The table's age rule now lives in
// lib/spot-age.js and every panadapter pop-out feed runs the same function,
// re-checked on a timer so a spot that ages out leaves the scope even when no
// new spots arrive. Run: node test/scope-spot-age-test.js
const assert = require('assert');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (e.stack || e.message)); }
}
const R = (f) => readSrc(path.join(__dirname, '..', f));
const main = R('main.js');
const app = R('renderer/app.js');

function body(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found');
  let d = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; }
  return src.slice(start, i + 1);
}

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
// Feed style: UTC without the trailing Z (POTA/SOTA/cluster all send this).
const ago = (min) => new Date(NOW - min * 60000).toISOString().replace(/\.\d+Z$/, '');
const spot = (call, source, min) => ({ callsign: call, source, spotTime: ago(min), frequency: '14074', band: '20m', mode: 'FT8' });
const calls = (list) => list.map((s) => s.callsign).sort();

let SpotAge = null;
try { SpotAge = require('../lib/spot-age'); } catch (e) { /* asserted below */ }
const lib = () => { assert.ok(SpotAge, 'lib/spot-age.js loads'); return SpotAge; };

// Runs main.js's scope feed with the given settings, using the real
// spotsForPanadapter / panadapterAllowsSource / spotAgeExempt.
function scopeFeed(settings, merged) {
  const names = ['panadapterAllowsSource', 'spotsForPanadapter', 'spotAgeExempt', 'spotsForScope'];
  const src = names.map((n) => body(main, n)).join('\n');
  // eslint-disable-next-line no-new-func
  const f = new Function('settings', 'SpotAge', 'Date', src + '\nreturn spotsForScope;');
  const FakeDate = class extends Date { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
  // Sync-with-table (the default), every table source on, as tableFeed has.
  const allOn = {};
  for (const s of ['Pota', 'Sota', 'Wwff', 'Llota', 'Wwbota', 'Tiles', 'Gma', 'Parc', 'Cluster', 'CwSpots', 'Rbn', 'Pskr', 'Freedv']) allOn['enable' + s] = true;
  return f(Object.assign(allOn, settings), lib(), FakeDate)(merged);
}

// Runs the desktop table's real getFiltered() over the spots, every source
// on, no other filter set, with the table's age variables loaded the way
// loadPrefs loads them from settings.json.
function tableFeed(settings, spots) {
  const env = {
    allSpots: spots,
    maxAgeMin: parseInt(settings.maxAgeMin, 10) || 5,
    potaAgeLimit: settings.potaAgeLimit === true,
    sotaMaxAgeMin: parseInt(settings.sotaMaxAge, 10) || 30,
    dxcMaxAgeMin: parseInt(settings.dxcMaxAge, 10) || 15,
    getDropdownValues: () => null,
    _eventFocusEvent: () => null,
    lastTunedSpot: null,
    watchlist: [], watchlistMatch: () => false,
    modeMatches: () => true,
    callFilter: [],
    isSpotHidden: () => false,
    SpotAge: SpotAge,
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } },
  };
  // eslint-disable-next-line no-new-func
  env.spotAgeSecs = new Function('Date', body(app, 'spotAgeSecs') + '\nreturn spotAgeSecs;')(env.Date);
  for (const s of ['Pota', 'Sota', 'Wwff', 'Llota', 'Wwbota', 'Tiles', 'Gma', 'Parc', 'Cluster', 'CwSpots', 'Rbn', 'Pskr']) env['enable' + s] = true;
  const scope = new Proxy(env, {
    has: () => true,
    get: (t, k) => (k === Symbol.unscopables ? undefined : (k in t ? t[k] : globalThis[k])),
  });
  // eslint-disable-next-line no-new-func
  const getFiltered = new Function('scope', 'with (scope) { return (' + body(app, 'getFiltered').replace(/^function getFiltered/, 'function') + '); }')(scope);
  return getFiltered();
}

console.log('Scope spot age (#239)');

test('an old spot is dropped and a fresh one kept', () => {
  const opts = lib().ageOptsFromSettings({ maxAgeMin: 30 });
  const out = lib().filterSpotsByAge([spot('VK4OLD', 'wwff', 222), spot('VK4NEW', 'wwff', 3)], opts, NOW);
  assert.deepStrictEqual(calls(out), ['VK4NEW']);
});

test('the limit follows the Max Spot Age setting', () => {
  const s = [spot('A20', 'wwff', 20), spot('A40', 'wwff', 40)];
  assert.deepStrictEqual(calls(lib().filterSpotsByAge(s, lib().ageOptsFromSettings({ maxAgeMin: 30 }), NOW)), ['A20']);
  assert.deepStrictEqual(calls(lib().filterSpotsByAge(s, lib().ageOptsFromSettings({ maxAgeMin: 60 }), NOW)), ['A20', 'A40']);
  assert.deepStrictEqual(calls(lib().filterSpotsByAge(s, lib().ageOptsFromSettings({ maxAgeMin: 10 }), NOW)), []);
  // SOTA and cluster spots keep their own windows, as in the table.
  const o = lib().ageOptsFromSettings({ maxAgeMin: 5, sotaMaxAge: 45, dxcMaxAge: 20 });
  assert.deepStrictEqual(calls(lib().filterSpotsByAge([spot('S40', 'sota', 40), spot('S50', 'sota', 50), spot('D15', 'dxc', 15), spot('D25', 'dxc', 25)], o, NOW)), ['D15', 'S40']);
  // Blank or 0 falls back to the default 5 minutes, like the table.
  assert.strictEqual(lib().ageOptsFromSettings({ maxAgeMin: 0 }).maxAgeMin, 5);
  assert.strictEqual(lib().ageOptsFromSettings({}).maxAgeMin, 5);
});

test('no limit keeps all: POTA follows the feed unless the operator opts in', () => {
  // Max Spot Age itself has no "no limit" value (Settings min 1, 0 means the
  // default); the one unlimited case is POTA with potaAgeLimit off.
  const s = [spot('K1OLD', 'pota', 222), spot('K1NEW', 'pota', 2)];
  assert.deepStrictEqual(calls(lib().filterSpotsByAge(s, lib().ageOptsFromSettings({ maxAgeMin: 30 }), NOW)), ['K1NEW', 'K1OLD']);
  assert.deepStrictEqual(calls(lib().filterSpotsByAge(s, lib().ageOptsFromSettings({ maxAgeMin: 30, potaAgeLimit: true }), NOW)), ['K1NEW']);
  // Net spots are never aged out.
  assert.deepStrictEqual(calls(lib().filterSpotsByAge([{ callsign: 'NET', source: 'net' }], lib().ageOptsFromSettings({}), NOW)), ['NET']);
});

const MIX = [
  spot('VK4OLD', 'wwff', 222), spot('VK4NEW', 'wwff', 3), spot('W1POTA', 'pota', 222),
  spot('W1PL', 'pota', 40), spot('S40', 'sota', 40), spot('S20', 'sota', 20),
  spot('D10', 'dxc', 10), spot('D20', 'dxc', 20), spot('P14', 'pskr', 14), spot('P16', 'pskr', 16),
  spot('R29', 'rbn', 29), spot('R31', 'rbn', 31), { callsign: 'NOTIME', source: 'llota', band: '20m', frequency: '14250' },
];

test('the scope feed drops the 222-minute spot with a 30-minute limit', () => {
  const out = scopeFeed({ maxAgeMin: 30 }, MIX);
  assert.ok(!calls(out).includes('VK4OLD'), 'old spot gone: ' + calls(out));
  assert.ok(calls(out).includes('VK4NEW'));
});

test('the scope feed and the table agree', () => {
  for (const settings of [
    { maxAgeMin: 30 },
    { maxAgeMin: 5 },
    { maxAgeMin: 30, potaAgeLimit: true, sotaMaxAge: 30, dxcMaxAge: 15 },
    { maxAgeMin: 60, sotaMaxAge: 120, dxcMaxAge: 5 },
  ]) {
    assert.deepStrictEqual(calls(scopeFeed(settings, MIX)), calls(tableFeed(settings, MIX)), JSON.stringify(settings));
  }
});

test('the table and every panadapter pop-out feed use the same age function', () => {
  assert.ok(/SpotAge\.spotWithinAge\(/.test(body(app, 'getFiltered')), 'table');
  assert.ok(/<script src="\.\.\/lib\/spot-age\.js"><\/script>/.test(R('renderer/index.html')), 'renderer loads the lib');
  assert.ok(/SpotAge\.filterSpotsByAge\(/.test(body(main, 'spotsForScope')), 'main scope feed');
  const merged = body(main, 'sendMergedSpots');
  assert.ok(/bandspreadPopoutWin\.webContents\.send\('spots', spotsForScope\(merged\)\)/.test(merged), 'bandspread push');
  assert.ok(/scopePopoutWin\.webContents\.send\('spots', spotsForScope\(merged\)\)/.test(merged), 'scope push');
  assert.ok(/scopePopoutWin\.webContents\.send\('spots', spotsForScope\(lastMergedSpots \|\| \[\]\)\)/.test(main), 'scope first paint');
  assert.ok(/const panaSpots = spotsForScope\(lastMergedSpots\);/.test(main), 'bandspread independent-source override');
  assert.ok(!/send\('spots', spotsForPanadapter\(/.test(main), 'no pop-out gets the source-only feed');
});

test('a spot that ages out leaves the scope with no new spots arriving', () => {
  const f = body(main, 'repushPanadapterPopouts');
  assert.ok(/scopePopoutWin[\s\S]*send\('spots', spotsForScope\(lastMergedSpots/.test(f), 'scope re-push');
  assert.ok(/setInterval\(repushPanadapterPopouts, PANADAPTER_AGE_REPUSH_MS\)/.test(main), 'on a timer');
  const ms = Number((main.match(/const PANADAPTER_AGE_REPUSH_MS = (\d+)/) || [])[1]);
  assert.ok(ms > 0 && ms <= 60000, 'at most a minute late: ' + ms);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
