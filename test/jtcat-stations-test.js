'use strict';
// JTCAT Stations view (#557, part 1): one line per station heard.
// lib/jtcat-stations.js folds the decodes; lib/decode-row.js draws the row;
// renderer/jtcat-popout.js shows it. The rendered column check is in
// test/layout-alignment-test.js (CI).
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const S = require('../lib/jtcat-stations');
const DecodeRow = require('../lib/decode-row');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       ')); }
}

const T0 = 1_800_000_000_000;
const ctx = (now, band, mode) => ({ now, band: band || '20m', mode: mode || 'FT8' });

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------
test('one entry per call; the grid from an earlier CQ is kept when a later message has none', () => {
  const st = S.create();
  S.addDecodes(st, [{ call: 'K1ABC', text: 'CQ K1ABC FN42', grid: 'FN42', entity: 'United States', db: -12, df: 1500, dt: 0.1 }], ctx(T0));
  S.addDecodes(st, [{ call: 'K1ABC', text: 'W2XYZ K1ABC -08', entity: 'United States', db: -7, df: 1510, dt: 0.2 }], ctx(T0 + 15000));
  assert.strictEqual(S.size(st), 1);
  const e = st.byCall.K1ABC;
  assert.strictEqual(e.grid, 'FN42', 'grid kept across messages');
  assert.strictEqual(e.calling, 'W2XYZ', 'calling follows the latest message');
  assert.strictEqual(e.db, -7, 'SNR follows the latest decode');
  assert.strictEqual(e.df, 1510, 'audio frequency follows the latest decode');
  assert.strictEqual(e.firstHeard, T0);
  assert.strictEqual(e.lastHeard, T0 + 15000);
  assert.strictEqual(e.band, '20m');
  assert.strictEqual(e.mode, 'FT8');
});

test('the entry keeps the latest decode object itself (the row click uses it)', () => {
  const st = S.create();
  const d1 = { call: 'K1ABC', text: 'CQ K1ABC FN42', grid: 'FN42', db: -3, df: 900 };
  const d2 = { call: 'K1ABC', text: 'W2XYZ K1ABC RR73', db: -4, df: 905 };
  S.addDecodes(st, [d1], ctx(T0));
  S.addDecodes(st, [d2], ctx(T0 + 15000));
  assert.strictEqual(st.byCall.K1ABC.decode, d2);
});

test('a newer grid replaces the old one; RR73 is never a grid', () => {
  const st = S.create();
  S.noteDecode(st, { call: 'K1ABC', text: 'CQ K1ABC FN42', grid: 'FN42' }, ctx(T0));
  S.noteDecode(st, { call: 'K1ABC', text: 'W2XYZ K1ABC RR73', grid: 'RR73' }, ctx(T0 + 1));
  assert.strictEqual(st.byCall.K1ABC.grid, 'FN42');
  S.noteDecode(st, { call: 'K1ABC', text: 'CQ K1ABC FN43', grid: 'FN43' }, ctx(T0 + 2));
  assert.strictEqual(st.byCall.K1ABC.grid, 'FN43');
});

test('calling: CQ, the CQ modifier, the call being answered, nothing for free text', () => {
  assert.strictEqual(S.callingOf('CQ K1ABC FN42', 'K1ABC'), 'CQ');
  assert.strictEqual(S.callingOf('CQ POTA K1ABC FN42', 'K1ABC'), 'CQ POTA');
  assert.strictEqual(S.callingOf('CQ DX JA1XYZ PM95', 'JA1XYZ'), 'CQ DX');
  assert.strictEqual(S.callingOf('CQ NA K1ABC', 'K1ABC', 'NA'), 'CQ NA', 'main\'s cqTag is used when given');
  assert.strictEqual(S.callingOf('CQ 075 W1ABC FN42', 'W1ABC'), 'CQ', 'a numeric serial is not a modifier');
  assert.strictEqual(S.callingOf('W2XYZ K1ABC -12', 'K1ABC'), 'W2XYZ');
  assert.strictEqual(S.callingOf('<W2XYZ/P> K1ABC R-12', 'K1ABC'), 'W2XYZ/P');
  assert.strictEqual(S.callingOf('<...> K1ABC RR73', 'K1ABC'), '');
  assert.strictEqual(S.callingOf('TNX QSO 73 GL', ''), '');
  assert.strictEqual(S.callingOf('', 'K1ABC'), '');
});

test('state: only when QRZ knows it, never guessed from a grid', () => {
  assert.strictEqual(S.stateOf({ state: { code: 'NJ', certain: true, source: 'grid' } }), '', 'a grid state is a guess');
  assert.strictEqual(S.stateOf({ state: { code: 'NJ/NY/PA', certain: false, source: 'grid' } }), '');
  assert.strictEqual(S.stateOf({ state: { code: 'TX', certain: false, source: 'qrz' } }), 'TX');
  assert.strictEqual(S.stateOf({ state: { code: 'NY', certain: true, source: 'grid+qrz' } }), 'NY');
  assert.strictEqual(S.stateOf({}), '');
  const st = S.create();
  S.noteDecode(st, { call: 'K1ABC', text: 'CQ K1ABC FN20', grid: 'FN20', state: { code: 'NJ', certain: true, source: 'grid' } }, ctx(T0));
  assert.strictEqual(st.byCall.K1ABC.state, '');
  S.noteDecode(st, { call: 'K1ABC', text: 'CQ K1ABC', state: { code: 'TX', source: 'qrz' } }, ctx(T0 + 1));
  S.noteDecode(st, { call: 'K1ABC', text: 'W2XYZ K1ABC 73' }, ctx(T0 + 2));
  assert.strictEqual(st.byCall.K1ABC.state, 'TX', 'a known state is kept across messages');
});

test('country comes from the entity the decode already carries (the decode rows\' lookup)', () => {
  const st = S.create();
  S.noteDecode(st, { call: 'JA1XYZ', text: 'CQ DX JA1XYZ PM95', entity: 'Japan', continent: 'AS' }, ctx(T0));
  assert.strictEqual(st.byCall.JA1XYZ.entity, 'Japan');
  assert.strictEqual(st.byCall.JA1XYZ.continent, 'AS');
});

test('a decode with no sender (our TX, free text) adds nothing', () => {
  const st = S.create();
  assert.strictEqual(S.addDecodes(st, [{ text: 'TNX QSO 73' }, null, { call: '...', text: '... K1ABC' }], ctx(T0)), 0);
  assert.strictEqual(S.size(st), 0);
});

test('multi-slice: a decode\'s own band wins over the window\'s band', () => {
  const st = S.create();
  S.noteDecode(st, { call: 'K1ABC', text: 'CQ K1ABC FN42', band: '40m' }, ctx(T0, '20m'));
  assert.strictEqual(st.byCall.K1ABC.band, '40m');
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------
test('expiry choices are 2, 5 and 10 minutes; anything else is the default 5', () => {
  assert.deepStrictEqual(S.EXPIRY_CHOICES, [2, 5, 10]);
  assert.strictEqual(S.DEFAULT_EXPIRY_MIN, 5);
  assert.strictEqual(S.normalizeExpiryMin('10'), 10);
  assert.strictEqual(S.normalizeExpiryMin(2), 2);
  assert.strictEqual(S.normalizeExpiryMin(3), 5);
  assert.strictEqual(S.normalizeExpiryMin(undefined), 5);
  assert.strictEqual(S.create().expiryMin, 5);
  assert.strictEqual(S.create({ expiryMin: 10 }).expiryMin, 10);
});

test('a station leaves the list when not heard within the expiry; a fresh decode keeps it', () => {
  const st = S.create({ expiryMin: 2 });
  S.addDecodes(st, [{ call: 'K1ABC', text: 'CQ K1ABC FN42' }, { call: 'W2XYZ', text: 'CQ W2XYZ FN20' }], ctx(T0));
  S.addDecodes(st, [{ call: 'W2XYZ', text: 'CQ W2XYZ FN20' }], ctx(T0 + 90000));
  assert.strictEqual(S.list(st, { now: T0 + 119000 }).length, 2, 'both still inside 2 minutes');
  const left = S.list(st, { now: T0 + 120000 });
  assert.deepStrictEqual(left.map(e => e.call), ['W2XYZ'], 'K1ABC went at 2 minutes, W2XYZ was heard again');
  S.setExpiryMin(st, 5);
  assert.strictEqual(S.expire(st, T0 + 90000 + 299000), 0);
  assert.strictEqual(S.expire(st, T0 + 90000 + 300000), 1);
});

// ---------------------------------------------------------------------------
// Clearing
// ---------------------------------------------------------------------------
test('a band change or a mode change empties the list (#517); the same band and mode do not', () => {
  const st = S.create();
  S.addDecodes(st, [{ call: 'K1ABC', text: 'CQ K1ABC FN42' }], ctx(T0, '20m', 'FT8'));
  S.addDecodes(st, [{ call: 'W2XYZ', text: 'CQ W2XYZ FN20' }], ctx(T0 + 15000, '20m', 'FT8'));
  assert.strictEqual(S.size(st), 2);
  assert.strictEqual(S.setContext(st, { band: '20m', mode: 'FT8' }), false);
  S.addDecodes(st, [{ call: 'JA1XYZ', text: 'CQ JA1XYZ PM95' }], ctx(T0 + 30000, '40m', 'FT8'));
  assert.deepStrictEqual(Object.keys(st.byCall), ['JA1XYZ'], 'band change');
  assert.strictEqual(S.setContext(st, { band: '40m', mode: 'FT4' }), true, 'mode change');
  assert.strictEqual(S.size(st), 0);
});

test('clear empties it', () => {
  const st = S.create();
  S.addDecodes(st, [{ call: 'K1ABC', text: 'CQ K1ABC FN42' }], ctx(T0));
  S.clear(st);
  assert.strictEqual(S.size(st), 0);
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------
test('sort: newest first by default, strongest first, or A to Z', () => {
  const st = S.create();
  S.addDecodes(st, [{ call: 'W2XYZ', text: 'CQ W2XYZ FN20', db: -3 }, { call: 'K1ABC', text: 'CQ K1ABC FN42', db: -15 }], ctx(T0));
  S.addDecodes(st, [{ call: 'JA1XYZ', text: 'CQ JA1XYZ PM95', db: -20 }], ctx(T0 + 15000));
  S.addDecodes(st, [{ call: 'N0CALL', text: 'CQ N0CALL EM48' }], ctx(T0 + 30000));
  const now = T0 + 31000;
  assert.deepStrictEqual(S.list(st, { now }).map(e => e.call), ['N0CALL', 'JA1XYZ', 'K1ABC', 'W2XYZ'], 'last heard, ties by call');
  assert.deepStrictEqual(S.list(st, { sort: 'snr', now }).map(e => e.call), ['W2XYZ', 'K1ABC', 'JA1XYZ', 'N0CALL'], 'no SNR sorts last');
  assert.deepStrictEqual(S.list(st, { sort: 'call', now }).map(e => e.call), ['JA1XYZ', 'K1ABC', 'N0CALL', 'W2XYZ']);
  assert.strictEqual(S.normalizeSort('bogus'), 'last');
});

// ---------------------------------------------------------------------------
// Row formatting (lib/decode-row.js)
// ---------------------------------------------------------------------------
test('age reads "12s" under a minute, then whole minutes "3m"', () => {
  assert.strictEqual(DecodeRow.formatAge(0), '0s');
  assert.strictEqual(DecodeRow.formatAge(12400), '12s');
  assert.strictEqual(DecodeRow.formatAge(59999), '59s');
  assert.strictEqual(DecodeRow.formatAge(60000), '1m');
  assert.strictEqual(DecodeRow.formatAge(200000), '3m');
  assert.strictEqual(DecodeRow.formatAge(-5), '0s');
  assert.strictEqual(DecodeRow.formatAge(null), '');
});

test('a station row: ten cells in column order, whole dB and Hz, escaped text', () => {
  const html = DecodeRow.stationRowInner({ call: 'K1ABC', calling: 'CQ POTA', grid: 'FN42', entity: 'Turks & Caicos Islands', state: '', db: -12.6, df: 1499.6, lastHeard: T0 }, T0 + 12000, 'jp');
  const cells = [...html.matchAll(/<span class="jp-st-(\w+)"[^>]*>([^<]*)<\/span>/g)].map(m => [m[1], m[2]]);
  assert.deepStrictEqual(cells, [
    ['call', 'K1ABC'], ['need', ''], ['calling', 'CQ POTA'], ['park', ''], ['grid', 'FN42'], ['country', 'Turks &amp; Caicos Islands'],
    ['state', ''], ['db', '-13'], ['df', '1500'], ['age', '12s'],
  ]);
  assert.deepStrictEqual(DecodeRow.STATION_COLUMNS.map(c => c.label), ['Call', 'Need', 'Calling', 'Park', 'Grid', 'Country', 'State', 'dB', 'Hz', 'Age']);
  assert.ok(!/<script/i.test(DecodeRow.stationRowInner({ call: '<script>' }, T0)), 'escaped');
});

test('the header: same cells, the sortable titles carry data-sort, the current sort is marked', () => {
  const h = DecodeRow.stationHeaderInner('jp', 'snr');
  const keys = [...h.matchAll(/<span class="jp-st-(\w+)/g)].map(m => m[1]);
  assert.deepStrictEqual(keys, DecodeRow.STATION_COLUMNS.map(c => c.key));
  assert.ok(/class="jp-st-db jp-st-sortable jp-st-sorted" data-sort="snr"/.test(h));
  assert.ok(/class="jp-st-call jp-st-sortable" data-sort="call"/.test(h));
  assert.ok(/class="jp-st-age jp-st-sortable" data-sort="last"/.test(h));
  assert.strictEqual((h.match(/data-sort=/g) || []).length, 3, 'Call, dB and Age sort');
});

// ---------------------------------------------------------------------------
// The pop-out (source guards)
// ---------------------------------------------------------------------------
const ROOT = path.join(__dirname, '..');
const pop = readSrc(path.join(ROOT, 'renderer', 'jtcat-popout.js'));
const popHtml = readSrc(path.join(ROOT, 'renderer', 'jtcat-popout.html'));
const block = pop.slice(pop.indexOf('// --- Stations view (#557) ---'), pop.indexOf('function renderDecodes(data)'));

test('the pop-out loads the stations module before its own script', () => {
  const a = popHtml.indexOf('<script src="../lib/jtcat-stations.js"></script>');
  assert.ok(a > 0, 'script tag');
  assert.ok(a < popHtml.indexOf('<script src="jtcat-popout.js"></script>'));
  assert.ok(/id="jp-view-stream"[^>]*>Stream</.test(popHtml) && /id="jp-view-stations"[^>]*>Stations</.test(popHtml), 'the Stream / Stations switch');
  assert.ok(/<div id="jp-stations" class="jp-decode-list jp-stations" hidden><\/div>/.test(popHtml));
  assert.ok(/id="jp-stations-expiry"><option value="2">2 minutes<\/option><option value="5" selected>5 minutes<\/option><option value="10">10 minutes<\/option>/.test(popHtml));
});

test('a row double-click calls the same handler as a decode double-click, with the latest decode', () => {
  assert.ok(block.length > 500, 'stations block found');
  assert.ok(/row\.addEventListener\('dblclick', \(function\(decode\) \{ return function\(\) \{ onDecodeRowClick\(decode\); \}; \}\)\(d\)\);/.test(pop), 'the decode row');
  assert.ok(/addEventListener\('dblclick', function\(ev\) \{\n\s+var e = stationFromEvent\(ev\);\n\s+if \(e\) onDecodeRowClick\(e\.decode\);/.test(block), 'the station row');
  assert.ok(/if \(e\) openRowMenu\(ev, e\.decode\);/.test(block), 'right-click: the same menu');
  // Not a copy: the station code never answers or retunes by itself.
  assert.ok(!/inferReplyStep|jtcatSetTxFreq|jtcatReply|jtcatCall\w*\(/.test(block), 'no reply logic of its own');
  assert.ok(!/isRemoteMode/.test(block), 'no remote branch (the bridge rule)');
});

test('rows come only from DecodeRow; the filters, sort and expiry are wired', () => {
  assert.ok(/DecodeRow\.stationRowInner\(shown\[i\]\.e, now, 'jp', \{ marks: shown\[i\]\.marks, scopeText: scopeText \}\)/.test(block));
  assert.ok(/DecodeRow\.stationHeaderInner\('jp', stationsSort\)/.test(block));
  assert.ok(!/class="jp-st-(call|need|calling|park|grid|country|state|db|df|age)"/.test(block), 'no hand-built cells');
  assert.ok(/return decodeVisible\(c\);/.test(block), 'the stream\'s filters');
  assert.ok(/renderStations\(\); \/\/ the filters apply to the Stations view too/.test(pop), 'a filter change redraws the list');
  assert.ok(/JtcatStations\.addDecodes\(jpStations, results, jpStationsContext\(\)\);/.test(pop), 'each cycle is folded in');
  assert.ok(/saveSettings\(\{ jtcatStationsExpiryMin: n \}\)/.test(block), 'the expiry is a setting');
  assert.ok(/applyStationsExpiry\(s\.jtcatStationsExpiryMin, false\)/.test(pop), 'and is read back at start');
  assert.ok(/localStorage\.setItem\(VIEW_LS_KEY/.test(block), 'the view choice is remembered');
});

test('every place that empties Band Activity empties the list too', () => {
  const clears = (pop.match(/^\s+decodeLog = \[\];$/gm) || []).length;
  assert.ok(clears >= 4, 'found the clear sites (Stop, follow, band, mode hop)');
  const re = /^\s+decodeLog = \[\];\n\s+jpStationsClear\(\);$/gm;
  assert.strictEqual((pop.match(re) || []).length, clears, 'each decodeLog reset is followed by jpStationsClear');
  assert.ok(/getElementById\('jp-clear'\)\.addEventListener\('click', function\(\) \{\n[^\n]*\n\s*jpStationsClear\(\);/.test(pop), 'the Clear button');
  assert.ok(/Multi-slice decoding\.\.\.<\/div>';\n\s*jpStationsClear\(\);/.test(pop), 'multi-slice start');
});

test('main keeps the expiry as a machine (display) setting', () => {
  const main = readSrc(path.join(ROOT, 'main.js'));
  const g = main.slice(main.indexOf('const GLOBAL_KEYS = new Set(['), main.indexOf(']);', main.indexOf('const GLOBAL_KEYS = new Set([')));
  assert.ok(/'jtcatStationsExpiryMin'/.test(g));
});

test('the Stations styles use theme tokens only (no colour written in)', () => {
  const css = [...popHtml.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
  const rules = css.split('\n').filter(l => /\.jp-st-|\.jp-view-switch|#jp-stations/.test(l));
  assert.ok(rules.length >= 10, 'rules found');
  for (const r of rules) {
    assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(r.replace(/#jp-[\w-]+/g, '')), 'hard-coded colour: ' + r.trim());
  }
});

console.log(`\njtcat stations: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
