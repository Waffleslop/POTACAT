#!/usr/bin/env node
'use strict';
/**
 * DXpeditions in the Contests view (Casey 2026-10-07: "add to the Contest page
 * the DXpeditions that are live and upcoming ... make it visible if they have
 * the DXpedition Spot turned on, or not").
 *
 * lib/dxpedition-contests.js is pure: NG3K date text → a window, feed metadata
 * + spot activity → contest-shaped rows, and the live/on-air status. Source
 * guards keep the main/preload/renderer wiring from drifting.
 *
 * Run: node test/dxpedition-contests-test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseDxpDates, buildDxpeditionEntries, dxpStatus } = require('../lib/dxpedition-contests');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e).split('\n')[0]); }
}
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 31, 12, 0, 0); // 31 Oct 2026

console.log('DXpeditions in the Contests view');

test('NG3K date text (formats copied from the live feed, 2026-10-07)', () => {
  assert.deepStrictEqual(parseDxpDates('Oct 30-Nov 5, 2026 -- Vanuatu -- YJ0SP'), { start: '2026-10-30', end: '2026-11-05' });
  assert.deepStrictEqual(parseDxpDates('Palau: Jan 8-14, 2027 -- T88SM -- QSL via: JA6EGL'), { start: '2027-01-08', end: '2027-01-14' });
  assert.deepStrictEqual(parseDxpDates('May 24-Jun 7, 2027'), { start: '2027-05-24', end: '2027-06-07' });
  assert.deepStrictEqual(parseDxpDates('Oct 9, 2026'), { start: '2026-10-09', end: '2026-10-09' });
  assert.deepStrictEqual(parseDxpDates('Dec 28, 2026-Jan 4, 2027'), { start: '2026-12-28', end: '2027-01-04' });
  assert.deepStrictEqual(parseDxpDates('Dec 28-Jan 4, 2027'), { start: '2026-12-28', end: '2027-01-04' }, 'a range across New Year starts in the prior year');
  assert.strictEqual(parseDxpDates('VE9MY/P & VE9GLF/P – IOTA NA-068 activity'), null, 'DX-World prose is not guessed at');
  assert.strictEqual(parseDxpDates('Feb 30-31, 2027'), null, 'impossible dates are refused');
  assert.strictEqual(parseDxpDates(''), null);
});

const META = {
  YJ0SP: { entity: 'Vanuatu', dates: 'Oct 30-Nov 5, 2026', startDate: '2026-10-30', endDate: '2026-11-05', operators: 'VK2SP', bands: 'HF', modes: 'CW SSB FT8', qsl: 'VK2SP', sources: 'dx-world,ng3k', link: 'https://www.qrz.com/db/YJ0SP' },
  T88SM: { entity: 'Palau', startDate: '2027-01-08', endDate: '2027-01-14', sources: 'ng3k', link: '' },
  OLD1: { entity: 'Gone', startDate: '2026-09-01', endDate: '2026-09-10', sources: 'ng3k' },
  RECENT1: { entity: 'Just ended', startDate: '2026-10-20', endDate: '2026-10-25', sources: 'ng3k' },
  'VE9MY/P': { entity: 'Canada', startDate: '', endDate: '', sources: 'dx-world', link: 'https://www.dx-world.net/ve9my-p/' },
  ZD9W: { entity: '', sources: 'clublog' },
};

function byId(list) { return Object.fromEntries(list.map((e) => [e.dxp.call, e])); }

test('rows: dated, undated and Club Log entries; long-ended ones are dropped', () => {
  const rows = byId(buildDxpeditionEntries(META, {}, NOW));
  assert.ok(rows.YJ0SP && rows.T88SM && rows['VE9MY/P'] && rows.ZD9W && rows.RECENT1);
  assert.ok(!rows.OLD1, 'ended more than two weeks ago: not listed at all');
  const y = rows.YJ0SP;
  assert.strictEqual(y.id, 'dxp:YJ0SP'); assert.strictEqual(y.category, 'dxpedition');
  assert.strictEqual(y.start, '2026-10-30T00:00:00Z'); assert.strictEqual(y.end, '2026-11-05T23:59:59Z');
  assert.strictEqual(Math.round(y.durationHours / 24), 7);
  assert.deepStrictEqual(y.modes, ['CW', 'SSB', 'FT8']);
  assert.strictEqual(y.sponsor, 'DXpedition · Vanuatu');
  assert.strictEqual(rows['VE9MY/P'].whenRule, 'Dates not announced');
  assert.strictEqual(rows.ZD9W.whenRule, 'Uploading logs to Club Log');
});

// The renderer's contest status, reproduced for the test.
function baseStatus(e, now) {
  if (!e.start) return { kind: 'unscheduled', label: e.whenRule };
  const s = new Date(e.start); const t = new Date(e.end);
  if (s <= now && t >= now) return { kind: 'live', label: 'LIVE', start: s, end: t };
  if (t < now) return { kind: 'ended', label: 'ended', start: s, end: t };
  return { kind: 'soon', label: 'in Nd', start: s, end: t };
}

test('status: within dates = running; heard now = on air; Club Log only = active; future = soon', () => {
  const now = new Date(NOW);
  const activity = { 'VE9MY/P': { lastSpottedAt: new Date(NOW - 20 * 60 * 1000).toISOString(), lastBand: '20m', lastMode: 'CW', count24h: 12 } };
  const rows = byId(buildDxpeditionEntries(META, activity, NOW));
  const st = (c) => dxpStatus(rows[c], baseStatus(rows[c], now), NOW);
  assert.strictEqual(st('YJ0SP').kind, 'live'); assert.strictEqual(st('YJ0SP').dxpLabel, 'running');
  assert.strictEqual(st('VE9MY/P').kind, 'live', 'an undated operation being spotted is on the air');
  assert.strictEqual(st('VE9MY/P').dxpLabel, 'on air');
  assert.deepStrictEqual([rows['VE9MY/P'].dxp.heard.band, rows['VE9MY/P'].dxp.heard.count24h], ['20m', 12]);
  assert.strictEqual(st('ZD9W').dxpLabel, 'active');
  assert.strictEqual(st('T88SM').kind, 'soon');
  assert.strictEqual(st('RECENT1').kind, 'ended');
});

test('a spot older than 2 h does not make a row "on air"', () => {
  const activity = { T88SM: { lastSpottedAt: new Date(NOW - 3 * 60 * 60 * 1000).toISOString() } };
  const rows = byId(buildDxpeditionEntries(META, activity, NOW));
  assert.strictEqual(rows.T88SM.dxp.heardNow, false);
  assert.ok(rows.T88SM.dxp.heard, 'but "last spotted" is still shown');
});

test('main: dates on every feed summary, get-dxpeditions, activity fetch, feed links allowed', () => {
  const m = read('main.js');
  assert.ok(/parseDxpDates\(/.test(m) && /startDate: w\.start, endDate: w\.end/.test(m), 'summaries carry the parsed window');
  assert.ok(/if \(rec\.start\) return \{ startDate:/.test(m), 'feed start/end win once the feed fills them');
  assert.ok(/ipcMain\.handle\('get-dxpeditions'/.test(m));
  assert.ok(/api\.potacat\.com\/v1\/dxpeditions\/spots\.json/.test(m));
  assert.ok(/m\.link === url/.test(m), "a link the current feed names may be opened");
  assert.ok(/getDxpeditions: \(\) => ipcRenderer\.invoke\('get-dxpeditions'\)/.test(read('preload.js')));
});

test('renderer: a Sources entry, the spot-flag bar with Turn on, and the shared module loaded', () => {
  const a = read('renderer/app.js');
  assert.ok(/\{ key: 'dxpedition',\s+label: 'DXpeditions' \}/.test(a), 'users can switch DXpeditions on or off in Sources');
  assert.ok(/filter\.dxpedition !== false/.test(a));
  assert.ok(/DXpedition spots are off\./.test(a) && /Turn on DXpedition spots/.test(a), 'says when the spot flag is off');
  assert.ok(/DXpedition spots are on\./.test(a), 'and when it is on');
  assert.ok(/saveSettings\(\{ enableDxe: true/.test(a), 'Turn on saves the setting');
  assert.ok(/not flagged/.test(a) && /is off in Spots › DX Expeditions/.test(a), 'a row whose source is off says so');
  assert.ok(/_addToGeneralWatchlist\(d\.call\)/.test(a), 'a DXpedition can be put on the watchlist');
  assert.ok(/<script src="\.\.\/lib\/dxpedition-contests\.js"><\/script>/.test(read('renderer/index.html')));
});

console.log(`\nDXpeditions in Contests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
