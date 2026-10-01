#!/usr/bin/env node
'use strict';
// Hidden and skipped spots, one desktop-owned list for every surface (K8IKO
// 2026-10-01: "If I hide or skip a station on any device, sync that status
// across all POTACAT/ECHOCAT devices"). Wire contract: potacat-app
// docs/desktop-handoffs/spot-hides-sync-contract.md.
// Run: node test/spot-hides-test.js
require('./ws-stub-if-missing');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/spot-hides');
const { RemoteServer } = require('../lib/remote-server');
const P = require('../lib/echocat-protocol');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('Spot hides');

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

// ---- the pure list ----------------------------------------------------------
test('the desktop window\'s legacy shapes normalize; Infinity and null are forever', () => {
  const h = S.normalizeHides({ w1abc: 5000, K2XYZ: { '*': Infinity, '14074': null, 'band:20m': 9000 }, 'bad call!': { '*': 1 } });
  assert.deepStrictEqual(h, { W1ABC: { '*': 5000 }, K2XYZ: { '*': null, '14074': null, 'band:20m': 9000 } });
});

test('a JSON round trip keeps "forever" forever (it used to come back as expired)', () => {
  const stored = JSON.parse(JSON.stringify({ W1ABC: { '*': Infinity } })); // { '*': null }
  const { hides } = S.pruneHides(S.normalizeHides(stored), NOW);
  assert.deepStrictEqual(hides, { W1ABC: { '*': null } });
});

test('prune drops expired keys and empty calls, keeps forever', () => {
  const r = S.pruneHides({ A1A: { '*': NOW - 1 }, B1B: { '*': null, '7030': NOW - 1 }, C1C: { 'band:40m': NOW + 1000 } }, NOW);
  assert.deepStrictEqual(r.hides, { B1B: { '*': null }, C1C: { 'band:40m': NOW + 1000 } });
  assert.ok(r.changed);
});

test('hide merges with the call\'s other keys; a repeat is no change', () => {
  let r = S.applyHide({ W1ABC: { 'band:20m': null } }, 'w1abc', '14074', NOW + 60000);
  assert.deepStrictEqual(r.hides, { W1ABC: { 'band:20m': null, '14074': NOW + 60000 } });
  r = S.applyHide(r.hides, 'W1ABC', '14074', NOW + 60000);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(S.applyHide({}, 'W1ABC', 'nonsense key', null).changed, false);
});

test('unhide without a key drops the call; with a key drops only that scope', () => {
  const h = { W1ABC: { '*': null, 'band:20m': null } };
  assert.deepStrictEqual(S.applyUnhide(h, 'W1ABC').hides, {});
  assert.deepStrictEqual(S.applyUnhide(h, 'W1ABC', 'band:20m').hides, { W1ABC: { '*': null } });
  assert.strictEqual(S.applyUnhide(h, 'K9ZZZ').changed, false);
});

test('the one-time merge of the window\'s old list keeps the longer hide', () => {
  const m = S.mergeHides({ W1ABC: { '*': NOW + 1000 } }, { W1ABC: { '*': null }, K2XYZ: { '7030': NOW + 5 } });
  assert.deepStrictEqual(m, { W1ABC: { '*': null }, K2XYZ: { '7030': NOW + 5 } });
});

test('skips: callsign TAB frequency, verbatim; idempotent both ways', () => {
  assert.strictEqual(S.skipKey('W1ABC', '14074.0'), 'W1ABC\t14074.0');
  let r = S.applySkip([], 'W1ABC', '14074.0', true);
  assert.deepStrictEqual(r.skips, ['W1ABC\t14074.0']);
  assert.strictEqual(S.applySkip(r.skips, 'W1ABC', '14074.0', true).changed, false);
  assert.deepStrictEqual(S.applySkip(r.skips, 'W1ABC', '14074.0', false).skips, []);
  assert.strictEqual(S.applySkip([], 'W1ABC', undefined, true).changed, false);
});

// ---- the two renderers decide "hidden" the same way ------------------------
function webIsHidden() {
  const src = R('renderer/remote.js');
  const body = src.slice(src.indexOf('  function isSpotHiddenByList(call, freq, band) {'), src.indexOf('  function sendSpotHideOp('));
  // eslint-disable-next-line no-new-func
  return new Function('spotHides', body + '; return isSpotHiddenByList;');
}
function desktopIsHidden() {
  const src = R('renderer/app.js');
  const body = src.slice(src.indexOf('function isSpotHidden(callsign, freqStr, band) {'), src.indexOf('// Applied here at once'));
  // eslint-disable-next-line no-new-func
  return new Function('hiddenSpots', body + '; return isSpotHidden;');
}
test('ECHOCAT Web and the desktop window agree on every scope (call, kHz, band, expiry)', () => {
  const now = Date.now();
  const wire = { W1ABC: { '*': null }, K2XYZ: { '14074': now + 60000 }, N3AAA: { 'band:20m': null }, OLD1: { '*': now - 1 } };
  const desk = {};
  for (const [c, e] of Object.entries(wire)) { desk[c] = {}; for (const [k, v] of Object.entries(e)) desk[c][k] = v === null ? Infinity : v; }
  const web = webIsHidden()(wire);
  const dt = desktopIsHidden()(desk);
  const cases = [['W1ABC', '7030.0', '40m'], ['K2XYZ', '14074.2', '20m'], ['K2XYZ', '14080.0', '20m'],
    ['N3AAA', '14285.0', '20m'], ['N3AAA', '7200.0', '40m'], ['OLD1', '7030.0', '40m'], ['NONE', '7030.0', '40m']];
  for (const [c, f, b] of cases) assert.strictEqual(web(c, f, b), dt(c, f, b), `${c} ${f} ${b}`);
  assert.deepStrictEqual(cases.map(([c, f, b]) => web(c, f, b)), [true, true, false, true, false, false, false]);
});

// ---- the server ---------------------------------------------------------------
function fakeServer() {
  const rs = Object.create(RemoteServer.prototype);
  require('events').EventEmitter.call(rs);
  const sent = [];
  rs._sendTo = (_ws, msg) => sent.push(msg);
  return { rs, sent };
}

test('the server advertises spot-hides and registers all four messages', () => {
  assert.ok(/'spot-hides',/.test(R('lib/remote-server.js')), 'capability not in the hello');
  for (const t of ['spot-hides', 'hide-spot', 'unhide-spot', 'skip-spot']) assert.ok(P.MESSAGES ? P.MESSAGES[t] : R('lib/echocat-protocol.js').includes(`'${t}':`), t);
});

test('hide / unhide / skip from a client reach main; a Guest Pass gets the list back instead', () => {
  const { rs, sent } = fakeServer();
  const got = [];
  for (const t of ['hide-spot', 'unhide-spot', 'skip-spot']) rs.on(t, (p) => got.push([t, p]));
  rs._spotHides = { W1ABC: { '*': null } }; rs._spotSkips = [];
  const owner = { _authenticated: true, readyState: 1 };
  rs._client = owner;
  rs._handleMessage(owner, { type: 'hide-spot', call: 'K2XYZ', key: '*', expiresAt: 123 });
  rs._handleMessage(owner, { type: 'unhide-spot', call: 'K2XYZ', key: 'band:20m' });
  rs._handleMessage(owner, { type: 'skip-spot', call: 'K2XYZ', frequency: '7030.0', skipped: true });
  assert.deepStrictEqual(got.map((g) => g[0]), ['hide-spot', 'unhide-spot', 'skip-spot']);
  assert.deepStrictEqual(got[0][1], { call: 'K2XYZ', key: '*', expiresAt: 123 });
  got.length = 0;
  const guest = { _authenticated: true, readyState: 1, _passSession: { code: 'x' } };
  rs._client = guest;
  rs._handleMessage(guest, { type: 'hide-spot', call: 'K2XYZ', key: '*' });
  rs._handleMessage(guest, { type: 'skip-spot', call: 'K2XYZ', frequency: '7030.0', skipped: true });
  assert.strictEqual(got.length, 0, 'a guest changed the owner\'s list');
  assert.strictEqual(sent.filter((m) => m.type === 'spot-hides').length, 2, 'the guest is not given the list back');
});

test('hydrate sends the full list (hides + skips) to a connecting client', () => {
  const src = R('lib/remote-server.js');
  const h = src.slice(src.indexOf('  _hydrateClient(ws) {'), src.indexOf('  _hydrateClient(ws) {') + 900);
  assert.ok(h.includes('this._echoSpotHides(ws);'));
  const { rs, sent } = fakeServer();
  rs._spotHides = { W1ABC: { '*': null } }; rs._spotSkips = ['K2XYZ\t7030.0'];
  rs._echoSpotHides({});
  assert.deepStrictEqual(sent[0], { type: 'spot-hides', hides: { W1ABC: { '*': null } }, skips: ['K2XYZ\t7030.0'] });
});

// ---- main and the desktop window ------------------------------------------------
test('main is the one owner: every surface changes the list through changeSpotHides / changeSpotSkips', () => {
  const main = R('main.js');
  assert.ok(/remoteServer\.on\('hide-spot'[\s\S]{0,160}changeSpotHides/.test(main));
  assert.ok(/remoteServer\.on\('unhide-spot'[\s\S]{0,160}changeSpotHides/.test(main));
  assert.ok(/remoteServer\.on\('skip-spot'[\s\S]{0,120}changeSpotSkips/.test(main));
  assert.ok(/ipcMain\.on\('spot-hide'[\s\S]{0,200}changeSpotHides/.test(main));
  assert.ok(/ipcMain\.on\('spot-skip'[\s\S]{0,120}changeSpotSkips/.test(main));
  assert.ok(/function spotSkipsNow\(\)[\s\S]{0,200}spotSkips = \[\]/.test(main), 'skips do not clear at 0000Z');
});

test('the desktop window no longer keeps its own copy in localStorage', () => {
  const app = R('renderer/app.js');
  assert.ok(!/localStorage\.setItem\(HIDDEN_SPOTS_KEY/.test(app), 'still writes the old localStorage list');
  assert.ok(/localStorage\.removeItem\(HIDDEN_SPOTS_KEY\)/.test(app), 'the old list is never cleared after migrating');
  assert.ok(/window\.api\.skipSpot\(s\.callsign, String\(s\.frequency\), !isSkipped\)/.test(app), 'the Skip button does not reach main');
  const web = R('renderer/remote.js');
  assert.ok(/type: 'skip-spot', call: call, frequency: freq, skipped: skipped/.test(web), 'the web S button does not reach main');
  assert.ok(!/scanSkipped\.has\(s\.frequency\)/.test(web), 'web skips are still keyed by frequency alone');
});

console.log(`\nSpot hides: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
