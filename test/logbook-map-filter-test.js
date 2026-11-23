// The Logbook map shows exactly what the Logbook filter shows (#702).
// One filter (lib/logbook-filter.js) feeds the Logbook list, its map and the
// ECHOCAT Web Logbook; the map re-plots from the rows the list holds,
// debounced, never re-reading the log. Read-only: nothing here writes a QSO.
// Run: node test/logbook-map-filter-test.js
'use strict';
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const LF = require('../lib/logbook-filter');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const root = path.join(__dirname, '..');
const src = (p) => readSrc(path.join(root, p));
function fnBody(s, name) {
  const i = s.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  let depth = 0;
  for (let k = s.indexOf('{', i); k < s.length; k++) {
    if (s[k] === '{') depth++;
    else if (s[k] === '}' && --depth === 0) return s.slice(i, k + 1);
  }
  throw new Error(name + ': unbalanced');
}

// A small log: two stations without a grid are placed from their prefix
// (the window's cty.dat lookup), one is nowhere.
const LOG = [
  { idx: 0, CALL: 'K1ABC', BAND: '20m', MODE: 'FT8', QSO_DATE: '20261101', TIME_ON: '1200', GRIDSQUARE: 'FN42' },
  { idx: 1, CALL: 'LZ1XX', BAND: '40m', MODE: 'CW', QSO_DATE: '20261105', TIME_ON: '0300', SIG_INFO: 'US-1234' },
  { idx: 2, CALL: 'W9XYZ', BAND: '20m', MODE: 'MFSK', SUBMODE: 'FT4', QSO_DATE: '20261110', TIME_ON: '1800', GRIDSQUARE: 'EN52' },
  { idx: 3, CALL: 'DL1AA', BAND: '20m', MODE: 'PSK', SUBMODE: 'PSK31', QSO_DATE: '20261112', TIME_ON: '0900' },
  { idx: 4, CALL: 'K1ABC', BAND: '40m', MODE: 'CW', QSO_DATE: '20261115', TIME_ON: '2200', GRIDSQUARE: 'FN42' },
  { idx: 5, CALL: 'VK2QQ', BAND: '20m', MODE: 'USB', QSO_DATE: '20261116', TIME_ON: '0700', GRIDSQUARE: 'QF56' },
  { idx: 6, CALL: 'ZZ9ZZ', BAND: '20m', MODE: 'FT8', QSO_DATE: '20261117', TIME_ON: '1000' },
];
const CTY = { LZ1XX: { lat: 42.7, lon: 25.5, continent: 'EU' }, DL1AA: { lat: 51, lon: 10, continent: 'EU' },
  K1ABC: { continent: 'NA', lat: 42, lon: -71 }, W9XYZ: { continent: 'NA', lat: 41, lon: -88 }, VK2QQ: { continent: 'OC', lat: -33, lon: 151 } };
const ctx = { continentOf: (c) => (CTY[c] ? CTY[c].continent : '') };
const GRID = { FN42: { lat: 42.5, lon: -71 }, EN52: { lat: 42.5, lon: -89 }, QF56: { lat: -33.5, lon: 151 } };
const locate = (q) => (q.GRIDSQUARE && GRID[q.GRIDSQUARE]) || (CTY[q.CALL] && CTY[q.CALL].lat != null ? CTY[q.CALL] : null);
const plotted = (s) => s.stations.flatMap((st) => st.qsos.map((q) => q.idx)).sort((a, b) => a - b);

console.log('Logbook map follows the filter (#702)');

// --- The map's points equal the filtered rows ---
const FILTERS = [
  {},
  { band: '20m' },
  { mode: 'CW' },
  { mode: 'SSB' },
  { mode: 'FT4' },
  { mode: 'PSK' },
  { region: 'EU' },
  { from: '2026-11-05', to: '2026-11-12' },
  { query: 'us-1234' },
  { band: '20m', mode: 'FT8', from: '2026-11-01' },
  { band: '160m' },
];
for (const f of FILTERS) {
  test('map points = filtered rows for ' + JSON.stringify(f), () => {
    const rows = LF.filterQsos(LOG, f, ctx);
    const s = LF.mapStations(rows, locate);
    const located = rows.filter((q) => locate(q)).map((q) => q.idx).sort((a, b) => a - b);
    assert.deepStrictEqual(plotted(s), located, 'every located row is on the map, nothing else is');
    assert.strictEqual(s.shownContacts + s.unplaced, rows.length, 'every filtered row is either plotted or counted as unplaced');
    for (const st of s.stations) for (const q of st.qsos) assert.ok(rows.includes(q), 'no row outside the filter on the map');
  });
}
test('the filter rules: band, mode family, region, date range, search combine', () => {
  const calls = (f) => LF.filterQsos(LOG, f, ctx).map((q) => q.idx);
  assert.deepStrictEqual(calls({ band: '20M' }), [0, 2, 3, 5, 6], 'band is case-blind');
  assert.deepStrictEqual(calls({ mode: 'SSB' }), [5], 'USB is SSB');
  assert.deepStrictEqual(calls({ mode: 'FT4' }), [2], 'MFSK/FT4 is FT4');
  assert.deepStrictEqual(calls({ mode: 'PSK' }), [3], 'PSK31 is PSK');
  assert.deepStrictEqual(calls({ region: 'EU' }), [1, 3]);
  assert.deepStrictEqual(calls({ from: '2026-11-05', to: '2026-11-12' }), [1, 2, 3]);
  assert.deepStrictEqual(calls({ query: 'k1abc' }), [0, 4]);
  assert.deepStrictEqual(calls({ region: 'EU', band: '20m' }), [3]);
  assert.ok(LF.modeMatches({ MODE: 'DIGI' }, 'DIGI'), 'an option that names a raw MODE');
  assert.ok(!LF.modeMatches({ MODE: 'FT8' }, 'FT4'));
  assert.ok(!LF.isActive({}) && LF.isActive({ query: ' x ' }) && LF.isActive({ region: 'EU' }));
});
test('one station per call; later contacts join it; no-location rows are counted', () => {
  const s = LF.mapStations(LOG, locate);
  assert.strictEqual(s.totalStations, 5);
  const k1 = s.stations.find((st) => st.call === 'K1ABC');
  assert.deepStrictEqual(k1.qsos.map((q) => q.idx), [0, 4]);
  assert.strictEqual(s.unplaced, 1, 'ZZ9ZZ has no grid and no known prefix');
});

// --- A filter change updates the map ---
function fakeTimers() {
  let now = 0, id = 0; const q = new Map();
  return {
    setTimeout: (fn, ms) => { q.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout: (i) => q.delete(i),
    advance(ms) { now += ms; for (const [i, t] of [...q]) if (t.at <= now) { q.delete(i); t.fn(); } },
    pending: () => q.size,
  };
}
test('a filter change re-plots the map from the rows in hand, debounced', () => {
  const timers = fakeTimers();
  let f = {}; let rows = LF.filterQsos(LOG, f, ctx);
  const draws = [];
  const follower = LF.mapFollower({ rows: () => rows, locate, draw: (s) => draws.push(s), visible: () => true, delay: 150, timers });
  follower.refreshNow();
  assert.strictEqual(draws.length, 1);
  assert.strictEqual(draws[0].shownContacts, 6);
  // The operator types in the search box: three quick changes, one redraw.
  for (const qy of ['k', 'k1', 'k1abc']) { f = { query: qy }; rows = LF.filterQsos(LOG, f, ctx); follower.filterChanged(); }
  timers.advance(100);
  assert.strictEqual(draws.length, 1, 'no redraw inside the debounce');
  timers.advance(60);
  assert.strictEqual(draws.length, 2, 'one redraw after the typing stops');
  assert.deepStrictEqual(plotted(draws[1]), [0, 4], 'the map now shows only the searched rows');
  // Then a band filter.
  rows = LF.filterQsos(LOG, { band: '40m' }, ctx); follower.filterChanged(); timers.advance(150);
  assert.deepStrictEqual(plotted(draws[2]), [1, 4]);
});
test('a closed map does not draw', () => {
  const timers = fakeTimers(); let open = false; const draws = [];
  const follower = LF.mapFollower({ rows: () => LOG, locate, draw: (s) => draws.push(s), visible: () => open, timers });
  follower.filterChanged(); timers.advance(500);
  assert.strictEqual(draws.length, 0);
  open = true; follower.refreshNow();
  assert.strictEqual(draws.length, 1);
});

// --- The cap ---
test('more stations than the cap: newest kept, and the map says "Showing N of M"', () => {
  const big = [];
  for (let i = 0; i < 30; i++) big.push({ CALL: 'K' + i + 'AA', QSO_DATE: '202611' + String(i % 28 + 1).padStart(2, '0'), TIME_ON: '1200', GRIDSQUARE: 'FN42' });
  const s = LF.mapStations(big, locate, { cap: 10 });
  assert.ok(s.capped);
  assert.strictEqual(s.shownStations, 10);
  assert.strictEqual(s.totalStations, 30);
  const kept = s.stations.map((st) => st.qsos[0].QSO_DATE).sort();
  const newest = big.map((q) => q.QSO_DATE).sort().slice(-10);
  assert.deepStrictEqual(kept, newest, 'the most recent stations are the ones drawn');
  assert.strictEqual(LF.mapNote(s), 'Showing 10 of 30 stations (most recent first)');
});
test('under the cap the note counts stations and contacts, and names the unplaced', () => {
  const s = LF.mapStations(LOG, locate);
  assert.ok(!s.capped);
  assert.strictEqual(LF.mapNote(s), '5 stations from 6 contacts · 1 contact with no location');
  const one = LF.mapStations([LOG[0]], locate);
  assert.strictEqual(LF.mapNote(one), '1 station from 1 contact');
  assert.strictEqual(LF.mapNote(LF.mapStations([], locate)), 'No contacts match the filter');
  assert.ok(LF.MAP_STATION_CAP >= 1000, 'the cap is for very large logs only');
});

// --- Wiring ---
const html = src('renderer/qso-popout.html');
const js = src('renderer/qso-popout.js');
test('the Logbook loads lib/logbook-filter.js after adif-mode and before its own script', () => {
  const a = html.indexOf('<script src="../lib/adif-mode.js"></script>');
  const b = html.indexOf('<script src="../lib/logbook-filter.js"></script>');
  const c = html.indexOf('<script src="qso-popout.js"></script>');
  assert.ok(a > 0 && b > a && c > b);
  assert.ok(/id="qso-map-note"/.test(html), 'the map has a line that says what it plots');
});
test('the list and the map use the one filter; no second copy of the rules', () => {
  const r = fnBody(js, 'render');
  assert.ok(/filtered = LogbookFilter\.filterQsos\(allQsos, currentFilter\(\), \{ continentOf/.test(r), 'the list filters through the lib');
  assert.ok(!/filtered\.filter\(/.test(r), 'no hand-written filter left in render()');
  assert.ok(!/function qsoModeMatches\(/.test(js), 'the Mode rule lives in the lib');
  assert.ok(/mapFollower\.filterChanged\(\)/.test(r), 'every render tells the map');
  const u = fnBody(js, 'updateMap');
  assert.ok(/LogbookFilter\.mapStations\(|mapFollower\.refreshNow\(\)/.test(u), 'the map plots mapStations of the filtered rows');
  const d = fnBody(js, 'drawMap');
  assert.ok(!/getAllQsos/.test(d) && !/getAllQsos/.test(u), 'the map never re-reads the log');
  assert.ok(/LogbookFilter\.mapNote\(/.test(d), 'the map says what it shows (and the cap)');
  assert.ok(/LogbookFilter\.mapFollower\(\{\s*rows: \(\) => filtered,/.test(js), 'the map follows the rows the list holds');
});
test('every filter control re-renders (and so re-plots)', () => {
  for (const el of ['filterBandEl', 'filterModeEl', 'filterRegionEl', 'filterFromEl', 'filterToEl']) {
    assert.ok(new RegExp(el + "\\.addEventListener\\('change', \\(\\) => \\{[^}]*render\\(\\); \\}\\);").test(js), el);
  }
  assert.ok(/searchInput\.addEventListener\('input', \(\) => \{\s+searchText = searchInput\.value\.trim\(\);\s+render\(\);/.test(js), 'search');
});
test('ECHOCAT Web filters its Logbook through the same lib', () => {
  const web = src('renderer/remote.js');
  assert.ok(/LogbookFilter\.filterQsos\(/.test(fnBody(web, 'lbFilterQsos')), 'web Logbook filter');
  assert.ok(!/function lbModeFamily\(/.test(web), 'no second Mode rule on the web');
  assert.ok(src('renderer/remote.html').includes('<!-- logbook-filter-js -->'));
  const rs = src('lib/remote-server.js');
  assert.ok(rs.includes("['logbook-filter-js', 'logbook-filter.js']"));
  assert.ok(rs.indexOf("['adif-mode-js', 'adif-mode.js']") < rs.indexOf("['logbook-filter-js', 'logbook-filter.js']"), 'adif-mode inlined first');
  const rh = src('renderer/remote.html');
  assert.ok(rh.indexOf('<!-- adif-mode-js -->') < rh.indexOf('<!-- logbook-filter-js -->'), 'adif-mode is defined before the filter loads');
});
test('the lib is read-only', () => {
  const lib = src('lib/logbook-filter.js');
  assert.ok(!/require\('(fs|electron)'\)|mutateLog|updateQso|writeFile/.test(lib));
});

console.log(`\nLogbook map filter: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
