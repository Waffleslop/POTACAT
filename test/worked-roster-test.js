#!/usr/bin/env node
'use strict';
// Worked roster (lib/worked-roster.js): states + DXCC entities worked and
// confirmed by band and mode, the data under the Worked All States view and
// the map overlays (docs/worked-states-countries-plan.md). Plus the wiring
// guards that keep main.js, lib/adif.js and the renderer on the one roster.
// Run: node test/worked-roster-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WR = require('../lib/worked-roster');
const { parseWorkedQsos } = require('../lib/adif');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const ENTITY = { K1ABC: 'United States', KL7AA: 'Alaska', KH6ZZ: 'Hawaii', VE3XYZ: 'Canada', VK2ABC: 'Australia', JA1XYZ: 'Japan', XE1ABC: 'Mexico' };
const entityOf = (c) => ENTITY[c] || '';
const e = (over) => ({ date: '20260601', ref: '', myRef: '', band: '20M', mode: 'FT8', ...over });

test('award family: voice is phone, CW is cw, everything else digital', () => {
  assert.strictEqual(WR.awardFamily('SSB'), 'phone');
  assert.strictEqual(WR.awardFamily('usb'), 'phone');
  assert.strictEqual(WR.awardFamily('FM'), 'phone');
  assert.strictEqual(WR.awardFamily('CW'), 'cw');
  for (const m of ['FT8', 'FT4', 'FT2', 'RTTY', 'PSK31', 'JS8', 'JTTY', 'MFSK', 'OLIVIA', 'SSTV']) assert.strictEqual(WR.awardFamily(m), 'digital', m);
  assert.strictEqual(WR.awardFamily(''), '');
});

test('state keys: US states on US/Alaska/Hawaii calls, DC counts as MD, provinces on Canada, nothing on anyone else', () => {
  assert.deepStrictEqual(WR.stateKeys('United States', 'nj'), ['NJ']);
  assert.deepStrictEqual(WR.stateKeys('Alaska', 'AK'), ['AK']);
  assert.deepStrictEqual(WR.stateKeys('Hawaii', 'HI'), ['HI']);
  assert.deepStrictEqual(WR.stateKeys('United States', 'DC'), ['DC', 'MD']);
  assert.deepStrictEqual(WR.stateKeys('United States', 'ON'), [], 'a province on a US call is a typo, not Ontario');
  assert.deepStrictEqual(WR.stateKeys('Canada', 'ON'), ['ON']);
  assert.deepStrictEqual(WR.stateKeys('Canada', 'PQ'), ['QC'], 'old province spelling');
  assert.deepStrictEqual(WR.stateKeys('Australia', 'NSW'), [], 'Australia is not tracked: NT/WA/SA collide with US and Canadian codes');
  assert.deepStrictEqual(WR.stateKeys('Mexico', 'JAL'), []);
  assert.deepStrictEqual(WR.stateKeys('Japan', 'NJ'), []);
  assert.deepStrictEqual(WR.stateKeys('United States', ''), []);
});

test('the US and Canadian code sets never collide (bare codes are safe roster keys)', () => {
  const us = new Set(WR.US_STATES.map((s) => s.code));
  const ca = new Set(WR.CA_PROVINCES.map((s) => s.code));
  for (const c of ca) assert.ok(!us.has(c), 'CA/US collision ' + c);
  assert.strictEqual(WR.US_STATES.length, 50);
  assert.strictEqual(WR.CA_PROVINCES.length, 13);
  assert.strictEqual(new Set([...us, ...ca]).size, 63);
});

test('build: worked vs confirmed, by band, family and exact mode', () => {
  const entries = [
    ['K1ABC', [e({ state: 'NJ', band: '20M', mode: 'FT8' }), e({ state: 'NJ', band: '40M', mode: 'SSB', confirmed: true })]],
    ['VE3XYZ', [e({ state: 'ON', band: '20M', mode: 'CW' })]],
    ['JA1XYZ', [e({ band: '15M', mode: 'FT4', confirmed: true })]],
  ];
  const r = WR.build(entries, entityOf);
  // any scope
  assert.strictEqual(WR.status(r, 'state', 'NJ', { scope: 'any' }), 'confirmed');
  assert.strictEqual(WR.status(r, 'state', 'PA', { scope: 'any' }), 'none');
  assert.strictEqual(WR.status(r, 'state', 'ON', { scope: 'any' }), 'worked');
  // band
  assert.strictEqual(WR.status(r, 'state', 'NJ', { scope: 'band', band: '20m' }), 'worked');
  assert.strictEqual(WR.status(r, 'state', 'NJ', { scope: 'band', band: '40M' }), 'confirmed', 'band case-insensitive');
  assert.strictEqual(WR.status(r, 'state', 'NJ', { scope: 'band', band: '80m' }), 'none');
  // band + family: FT4 counts for digital on 20m because FT8 was worked there
  assert.strictEqual(WR.status(r, 'state', 'NJ', { scope: 'band-mode', band: '20m', mode: 'FT4' }), 'worked');
  assert.strictEqual(WR.status(r, 'state', 'NJ', { scope: 'band-mode', band: '20m', mode: 'SSB' }), 'none');
  assert.strictEqual(WR.status(r, 'state', 'NJ', { scope: 'band-mode', band: '40m', mode: 'USB' }), 'confirmed');
  // band + exact: FT4 on 20m is still wanted
  assert.strictEqual(WR.status(r, 'state', 'NJ', { scope: 'band-exact', band: '20m', mode: 'FT4' }), 'none');
  assert.strictEqual(WR.status(r, 'state', 'NJ', { scope: 'band-exact', band: '20m', mode: 'FT8' }), 'worked');
  // mode (any band, family)
  assert.strictEqual(WR.status(r, 'state', 'NJ', { scope: 'mode', mode: 'FT2' }), 'worked');
  assert.strictEqual(WR.status(r, 'state', 'NJ', { scope: 'mode', mode: 'CW' }), 'none');
  // entities
  assert.strictEqual(WR.status(r, 'entity', 'Japan', { scope: 'band', band: '15m' }), 'confirmed');
  assert.strictEqual(WR.status(r, 'entity', 'Japan', { scope: 'band', band: '20m' }), 'none');
  assert.strictEqual(WR.status(r, 'entity', 'United States', { scope: 'any' }), 'confirmed');
  assert.strictEqual(WR.status(r, 'entity', 'Canada', { scope: 'band-mode', band: '20m', mode: 'CW' }), 'worked');
  // confirmedOnly turns worked into wanted
  assert.strictEqual(WR.status(r, 'state', 'ON', { scope: 'any', confirmedOnly: true }), 'none');
  assert.ok(WR.isWanted(r, 'state', 'ON', { scope: 'any', confirmedOnly: true }));
  assert.ok(!WR.isWanted(r, 'state', 'ON', { scope: 'any' }));
});

test('build accepts a Map and the renderer\'s array alike; a QSO with no STATE counts for the entity only', () => {
  const m = new Map([['K1ABC', [e({ band: '20M', mode: 'FT8' })]]]);
  const r1 = WR.build(m, entityOf);
  const r2 = WR.build([...m.entries()], entityOf);
  assert.deepStrictEqual(r1, r2);
  assert.strictEqual(WR.status(r1, 'entity', 'United States', { scope: 'any' }), 'worked');
  assert.deepStrictEqual(Object.keys(r1.states), [], 'no state is ever guessed');
});

test('a band-scoped question with no band falls back to the wider answer, never throws', () => {
  const r = WR.build([['K1ABC', [e({ state: 'TX' })]]], entityOf);
  assert.strictEqual(WR.status(r, 'state', 'TX', { scope: 'band', band: '' }), 'worked');
  assert.strictEqual(WR.status(r, 'state', 'TX', { scope: 'band-mode', band: '', mode: '' }), 'worked');
  assert.strictEqual(WR.status(null, 'state', 'TX', {}), 'none');
  assert.strictEqual(WR.status(r, 'state', 'TX', { scope: 'bogus' }), 'worked');
});

test('addEntry after build == build with the entry (the live-add path)', () => {
  const base = [['K1ABC', [e({ state: 'NJ' })]]];
  const a = WR.build(base, entityOf);
  WR.addEntry(a, 'KL7AA', e({ state: 'AK', band: '40M', mode: 'CW', confirmed: true }), 'Alaska');
  const b = WR.build([...base, ['KL7AA', [e({ state: 'AK', band: '40M', mode: 'CW', confirmed: true })]]], entityOf);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(WR.status(a, 'state', 'AK', { scope: 'band-mode', band: '40m', mode: 'CW' }), 'confirmed');
  assert.strictEqual(WR.status(a, 'entity', 'Alaska', { scope: 'any' }), 'confirmed');
});

test('counts and matrix for the WAS view', () => {
  const r = WR.build([
    ['K1ABC', [e({ state: 'NJ', confirmed: true }), e({ state: 'DC', band: '40M', mode: 'CW' })]],
  ], entityOf);
  const keys = WR.US_STATES.map((s) => s.code);
  assert.deepStrictEqual(WR.counts(r, 'state', keys, { scope: 'any' }), { worked: 2, confirmed: 1, total: 50 });
  assert.deepStrictEqual(WR.counts(r, 'state', keys, { scope: 'any', confirmedOnly: true }), { worked: 1, confirmed: 1, total: 50 });
  const rows = WR.matrix(r, 'state', WR.US_STATES, { scope: 'band-mode', mode: 'FT8' });
  const nj = rows.find((x) => x.code === 'NJ');
  const md = rows.find((x) => x.code === 'MD');
  assert.strictEqual(nj.cells['20m'], 'confirmed');
  assert.strictEqual(nj.overall, 'confirmed');
  assert.strictEqual(md.cells['40m'], 'none', 'DC was CW, the matrix is on digital');
  assert.strictEqual(md.overall, 'none');
  const anyRows = WR.matrix(r, 'state', WR.US_STATES, { scope: 'band' });
  assert.strictEqual(anyRows.find((x) => x.code === 'MD').cells['40m'], 'worked', 'DC counts as Maryland');
  assert.strictEqual(anyRows.find((x) => x.code === 'MD').overall, 'worked');
  assert.strictEqual(rows.length, 50);
});

test('parseWorkedQsos carries STATE and the DXCC tracker\'s confirmation rule, only when present', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'was-'));
  const file = path.join(dir, 'log.adi');
  fs.writeFileSync(file,
    'POTACAT<EOH>' +
    '<CALL:5>K1ABC<QSO_DATE:8>20260601<BAND:3>20M<MODE:3>FT8<STATE:2>nj<LOTW_QSL_RCVD:1>Y<EOR>' +
    '<CALL:5>K1ABC<QSO_DATE:8>20260602<BAND:3>40M<MODE:3>USB<EOR>' +
    '<CALL:5>K2DEF<QSO_DATE:8>20260603<BAND:3>20M<MODE:3>SSB<QSL_RCVD:1>Y<POTA_REF:7>US-1234<EOR>');
  const m = parseWorkedQsos(file);
  const [a, b] = m.get('K1ABC');
  assert.strictEqual(a.state, 'NJ');
  assert.strictEqual(a.confirmed, true);
  assert.ok(!('state' in b) && !('confirmed' in b), 'absent fields stay absent (payload size)');
  const [c] = m.get('K2DEF');
  assert.strictEqual(c.confirmed, true);
  assert.strictEqual(c.ref, 'US-1234', 'POTA_REF import counts as the park (KC9FOZ)');
  assert.strictEqual(c.mode, 'SSB');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('wiring: main.js builds the roster from workedQsos, adds live, serves and pushes it', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(main.includes("require('./lib/worked-roster')"));
  assert.ok(/workedRoster = WorkedRoster\.build\(workedQsos, rosterEntityOf\)/.test(main));
  assert.strictEqual((main.match(/^\s+workedRosterAdd\(call, entry\);/gm) || []).length, 2, 'both live-add sites (log save + WSJT-X bridge)');
  assert.ok(/if \(qsoData\.state\) entry\.state = /.test(main), 'a saved QSO\'s state reaches the entry');
  assert.ok(main.includes("ipcMain.handle('worked-roster-get'"));
  assert.ok(main.includes("ipcMain.handle('was-backfill-states'"));
  assert.ok(/webContents\.send\('worked-roster', workedRoster\)/.test(main));
  // the backfill is a log EDIT through qso-log with the cloud sink, never a raw rewrite
  // The handler body is the named function (the map legend's sync button shares it).
  const bf = main.slice(main.indexOf('async function wasBackfillStates('), main.indexOf('async function wasBackfillStates(') + 6000);
  assert.ok(/mutateLog\(logPath,[\s\S]*\{ sink: qsoLogSink \}\)/.test(bf));
  assert.ok(!/rewriteAdifFile|appendRawQso/.test(bf));
  assert.ok(/stateKeys\(ent, state\)\.length/.test(bf), 'a state QRZ lists that is not one for that entity is never written');
});

test('wiring: renderer loads the roster module and the view, preload exposes the channels', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.ok(html.includes('<script src="../lib/worked-roster.js"></script>'));
  assert.ok(html.includes('<script src="was-view.js"></script>'));
  assert.ok(html.includes('id="was-view"') && html.includes('id="view-was-btn"') && html.includes('id="was-backfill-btn"'));
  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  for (const k of ['onWorkedRoster', 'getWorkedRoster', 'wasBackfillStates']) assert.ok(pre.includes(k + ':'), k);
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.ok(app.includes("view === 'was'") && app.includes("currentView === 'was'"));
  assert.ok(app.includes("viewState.lastView === 'was'"), 'the view is restored at launch like the others');
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
  assert.ok(css.includes('.was-worked') && css.includes('#4fc3f7'), 'worked = POTACAT blue');
  assert.ok(css.includes('.was-confirmed') && css.includes('#4ecca3'), 'confirmed = POTA green');
  assert.ok(!/was-[a-z-]*\{[^}]*#f(fd|ff)?[0-9a-f]*00/i.test(css), 'no GridTracker yellow');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
