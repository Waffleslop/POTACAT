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

// ── Contest station or DXpedition (Casey 2026-10-07). Wording copied from the
// live feed (DX-World, NG3K), trimmed.
const { classifyOperations } = require('../lib/dxpedition-contests');
const FEED = [
  { call: 'PJ4K', title: 'PJ4K – Bonaire', description: 'Team consisting of K1DG, K9VV and KM3T will be active as PJ4K during the CQWW SSB contest (Oct 24-25). Category: M/2. QSL via KU9C.' },
  { call: '3B8M', title: '3B8M – Mauritius', description: '[INFO] – This year for the CQWW CW contest, KX7M, 4O3A, E70A and YT1CI will be active as 3B8M.' },
  { call: 'FS/K0CD', title: 'FS/K0CD – St Martin', description: 'Philip, K0CD will be active during the CQWW CW contest (November 28-29) from St Martin as FS/K0CD. Entry: SOAB, QRP.' },
  { call: 'EX9A', title: 'Kyryzstan: Sep 26-27, 2026 -- EX9A -- QSL via: EX7CQ', description: 'Sep 26-27, 2026 -- Kyryzstan -- EX9A -- QSL: EX7CQ -- By EX2M EX7CQ EX7DY; QRV for CQWW DX RTTY Contest; M/S, high power' },
  { call: '4A5E', title: 'Mexico: Sep 26-27, 2026 -- 4A5E -- QSL via: LoTW', description: 'Sep 26-27, 2026 -- Mexico -- 4A5E -- By XE1EE; SOAB HP entry in CQWW DX RTTY Contest' },
  { call: 'T32AZ', title: 'T32AZ – Kiritimati, East Kiribati', description: '[REFRESH] – Running the Oceania DX SSB contest and Arizona QSO party look for Ken KH6QJ to again be active from Kiritimati.' },
  { call: 'C56XA', title: 'C56XA – The Gambia', description: 'Alan, G3XAQ will be active from The Gambia as C56XA during November 17 to December 1, 2026. QRV holiday-style on CW & FT8. Participation in the CQWW CW contest (SOSB, 15m LP).' },
  { call: 'OX7AM', title: 'OX7AM – Greenland', description: 'Nadia, OZ7AM will be active from Kangerlussuaq, Greenland as OX7AM during November 23 to December 7, 2026. QRV on CW only. Participation in the CQWW CW contest (SOAB).' },
  { call: '3DA0GY', title: 'eSwatini: Oct 15-Nov 2, 2026 -- 3DA0GY -- QSL via: LoTW', description: 'Oct 15-Nov 2, 2026 -- eSwatini -- 3DA0GY -- By LA9GY fm Piggs Peak; 40-10m; CW SSB; QRV in Worked All Germany SSB and CQWW DX SSB' },
  { call: 'CT9/DF7EE', title: 'CT9/DF7EE & CQ3W – Madeira', description: 'Helmut, DF7EE will again be active from Madeira as CT9/DF7EE during October 20-27, 2026. Participation in the CQ WW SSB contest as CQ3W.' },
  { call: 'N7NU/VP9', title: 'N7NU/VP9 & VP9I – Bermuda', description: 'From September 23-29, 2026, Lee N7NU, Ron WJ7R and Al K7AR will be active from Bermuda as N7NU/VP9. Participation in the CQWW DX RTTY contest as VP9I.' },
  { call: 'VP9I', title: 'Bermuda: Sep 23-29, 2026 -- VP9I -- QSL via: LoTW', description: 'Sep 23-29, 2026 -- Bermuda -- VP9I -- By N7NU WJ7R K7AR; CQWW DX RTTY; QRV Sep 23-29 as N7NU/VP9' },
  { call: 'JW6VM', title: 'JW6VM, JW7XK & JW9DL – Svalbard', description: 'LA6VM, LA7XK & LA9DL will again be active from Svalbard during October 7-12, 2026. Activity as JW5X during the SSB Scandinavian Activity Contest (Oct 10-11).' },
  { call: 'H49A', title: 'Solomon Is: Oct 7-21, 2026 -- H49A', description: 'Oct 7-21, 2026 -- Solomon Is -- H49A -- By a team; 160-6m; CW SSB FT8' },
];

test('contest stations and DXpeditions are told apart (real feed wording)', () => {
  const k = classifyOperations(FEED);
  const kind = (c) => (k.get(c) || {}).kind;
  for (const c of ['PJ4K', '3B8M', 'FS/K0CD', 'EX9A', '4A5E', 'T32AZ']) assert.strictEqual(kind(c), 'contest', c);
  for (const c of ['C56XA', 'OX7AM', '3DA0GY', 'H49A', 'JW6VM']) assert.strictEqual(kind(c), 'dxpedition', c + ' (a DXpedition, contest on the side)');
  assert.strictEqual(k.get('PJ4K').contest, 'CQ WW SSB');
  assert.strictEqual(k.get('C56XA').contest, 'CQ WW CW', 'the DXpedition keeps its contest as a note');
  assert.strictEqual(k.get('H49A').contest, null);
});

test('"contest as CQ3W": the announced call is the DXpedition, the named call is the contest station', () => {
  const k = classifyOperations(FEED);
  assert.strictEqual(k.get('CT9/DF7EE').kind, 'dxpedition');
  assert.deepStrictEqual(k.get('CQ3W'), { kind: 'contest', contest: 'CQ WW SSB', viaCall: 'CT9/DF7EE' }, 'a call named only inside another announcement is added');
  assert.strictEqual(k.get('N7NU/VP9').kind, 'dxpedition');
  assert.strictEqual(k.get('VP9I').kind, 'contest', 'its own NG3K record (a 7-day window) is still the contest call');
  assert.strictEqual(k.get('JW5X').kind, 'contest');
  assert.strictEqual(k.get('JW5X').viaCall, 'JW6VM');
});

test('rows: a contest station is its own Contests category with a clear sponsor line', () => {
  const rows = buildDxpeditionEntries({
    PJ4K: { kind: 'contest', contest: 'CQ WW SSB', entity: 'Bonaire', sources: 'dx-world' },
    CQ3W: { kind: 'contest', contest: 'CQ WW SSB', entity: 'Madeira', viaCall: 'CT9/DF7EE', sources: 'dx-world' },
    C56XA: { kind: 'dxpedition', contest: 'CQ WW CW', entity: 'The Gambia', sources: 'dx-world' },
  }, {}, NOW);
  const r = Object.fromEntries(rows.map((e) => [e.name, e]));
  assert.strictEqual(r.PJ4K.category, 'contest-station');
  assert.strictEqual(r.PJ4K.sponsor, 'Contest station · CQ WW SSB · Bonaire');
  assert.strictEqual(r.CQ3W.sponsor, 'Contest station · CQ WW SSB · Madeira · contest call of CT9/DF7EE');
  assert.strictEqual(r.C56XA.category, 'dxpedition');
  assert.strictEqual(r.C56XA.sponsor, 'DXpedition · The Gambia · also in CQ WW CW');
});

test("a contest station's dates come from its contest in the catalog", () => {
  const { contestWindowFor } = require('../lib/dxpedition-contests');
  const now = Date.UTC(2026, 9, 7);
  const catalog = [
    { id: 'cq-ww-ssb', name: 'CQ WW DX Contest, SSB', start: '2026-10-24T00:00:00Z', end: '2026-10-26T00:00:00Z' },
    { id: 'cq-ww-cw', name: 'CQ WW DX Contest, CW', start: '2026-11-28T00:00:00Z', end: '2026-11-30T00:00:00Z' },
    { id: 'sac-ssb', name: 'Scandinavian Activity Contest, SSB', start: '2026-10-10T12:00:00Z', end: '2026-10-11T12:00:00Z' },
    { id: 'cq-ww-rtty', name: 'CQ WW RTTY DX Contest', start: '2027-09-25T00:00:00Z', end: '2027-09-27T00:00:00Z' },
  ];
  assert.strictEqual(contestWindowFor('CQ WW SSB', catalog, now).id, 'cq-ww-ssb');
  assert.strictEqual(contestWindowFor('CQ WW CW', catalog, now).id, 'cq-ww-cw');
  assert.strictEqual(contestWindowFor('CQ WW DX RTTY', catalog, now), null, "next year's RTTY weekend is not this announcement's");
  const rows = Object.fromEntries(buildDxpeditionEntries({
    PJ4K: { kind: 'contest', contest: 'CQ WW SSB', sources: 'dx-world' },
    JW5X: { kind: 'contest', contest: 'Scandinavian Activity Contest SSB', startDate: '2026-10-07', endDate: '2026-10-12', sources: 'ng3k' },
    K0CD: { kind: 'contest', contest: 'CQ WW CW', aliasOf: 'FS/K0CD', sources: 'dx-world' },
  }, {}, now, catalog).map((e) => [e.name, e]));
  assert.strictEqual(rows.PJ4K.start, '2026-10-24T00:00:00Z');
  assert.strictEqual(rows.PJ4K.whenRule, 'During CQ WW DX Contest, SSB');
  assert.strictEqual(rows.JW5X.start, '2026-10-10T12:00:00Z', 'the contest weekend beats the whole-trip window NG3K lists');
  assert.ok(!rows.K0CD, 'a bare call split from a slash form is not listed as its own operation');
});

test("an operator's home call listed beside the operation is not labelled", () => {
  const { findAliases } = require('../lib/dxpedition-contests');
  const recs = [
    { call: 'FS/K0CD', title: 'FS/K0CD – St Martin', link: 'https://dx-world.net/fs-k0cd/' },
    { call: 'K0CD', title: 'FS/K0CD – St Martin', link: 'https://dx-world.net/fs-k0cd/' },
    { call: 'VE9MY', title: 'x', aliasOf: 'VE9MY/P' },
    { call: 'N7NU/VP9', title: 'N7NU/VP9 & VP9I – Bermuda' },
    { call: 'N7NU', title: 'N7NU/VP9 & VP9I – Bermuda' },
    { call: 'H49A', title: 'Solomon Is' },
    { call: 'W1AW', title: 'another announcement' },
    { call: 'KH6/W1AW', title: 'a different trip' },
  ];
  const a = findAliases(recs);
  assert.strictEqual(a.get('K0CD'), 'FS/K0CD');
  assert.strictEqual(a.get('N7NU'), 'N7NU/VP9');
  assert.strictEqual(a.get('VE9MY'), 'VE9MY/P', 'the feed\'s own aliasOf');
  assert.ok(!a.has('H49A') && !a.has('FS/K0CD'));
  assert.ok(!a.has('W1AW'), 'a home call from a DIFFERENT announcement is its own operation');
  assert.ok(/if \(dxpAliases\.has\(upper\)\) continue;/.test(read('main.js')), 'main skips aliases');
});

test('labels: CONTEST vs DXP on every surface; only DXpeditions are pinned and get the DXP pin', () => {
  const a = read('renderer/app.js');
  assert.ok(/dxp\.textContent = contestStation \? 'CONTEST' : 'DXP';/.test(a), 'spot table badge');
  assert.ok(/>CONTEST<\/span>/.test(a), 'map popup badge');
  assert.ok(/const aExp = isDxpeditionVisible\(a\.callsign\)/.test(a), 'only DXpeditions are pinned to the top');
  assert.ok(/const isExpedition = isDxpeditionVisible\(s\.callsign\);/.test(a), 'the DXpedition map pin is for DXpeditions');
  assert.ok(/classList\.add\('spot-contest-station'\)/.test(a), 'contest station row mark');
  assert.ok(/Contest station: \$\{m\.contest\}/.test(a), 'the note says "Contest station: CQ WW SSB"');
  assert.ok(/\{ key: 'contest-station', label: 'Contest stations \(DX\)' \}/.test(a), 'own Sources entry in Contests');
  assert.ok(/isContestStation: isContestStationVisible\(s\.callsign\)/.test(a));
  assert.ok(/s\.isContestStation[\s\S]{0,200}CONTEST<\/span>/.test(read('renderer/map-popout.js')), 'map pop-out');
  const m = read('main.js');
  assert.ok(/classifyOperations\(potacatResult\.value\)/.test(m), 'main classifies the feed');
  assert.ok(/merged\.add\(call\);/.test(m), 'contest calls named inside another announcement are tracked');
  assert.ok(/\.spot-contest-station \{/.test(read('renderer/styles.css')));
});

console.log(`\nDXpeditions in Contests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
