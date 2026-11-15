'use strict';
// JTCAT Stations view (#557, part 2): what each station would give you, and
// the park. lib/jtcat-stations.js (marksOf, parkOf, wantedMatch) decides;
// lib/decode-row.js draws the marks; renderer/jtcat-popout.js wires the
// roster, the map overlay's scope and the Wanted filter. The rendered column
// check (Need and Park at 520 and 900 px) is in test/layout-alignment-test.js.
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const S = require('../lib/jtcat-stations');
const DecodeRow = require('../lib/decode-row');
const WorkedRoster = require('../lib/worked-roster');
const HuntedPark = require('../lib/hunted-park');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       ')); }
}

const T0 = 1_800_000_000_000;
const ctx = (now, band, mode) => ({ now, band: band || '20m', mode: mode || 'FT8' });

// A fixture roster, built the way main builds it (WorkedRoster.build over
// worked-QSO entries). Japan: 20m FT8 confirmed. Germany: 20m SSB only.
// Italy: 40m FT8 worked. Texas: 20m FT8 worked. Ohio: 20m FT8 confirmed.
function fixtureRoster() {
  const entity = { JA1XYZ: 'Japan', DL1ABC: 'Germany', I2ABC: 'Italy', W5TX: 'United States', W8OH: 'United States', W1MA: 'United States' };
  const m = new Map([
    ['JA1XYZ', [{ band: '20M', mode: 'FT8', confirmed: true }]],
    ['DL1ABC', [{ band: '20M', mode: 'SSB' }]],
    ['I2ABC', [{ band: '40M', mode: 'FT8' }]],
    ['W5TX', [{ band: '20M', mode: 'FT8', state: 'TX' }]],
    ['W8OH', [{ band: '20M', mode: 'FT8', state: 'OH', confirmed: true }]],
  ]);
  const r = WorkedRoster.build(m, (c) => entity[c] || '');
  return r;
}
const ROSTER = fixtureRoster();
const scope = (s, extra) => Object.assign({ roster: ROSTER, scope: s || 'band-mode', confirmedOnly: false }, extra || {});

function entry(d, band, mode) {
  const st = S.create();
  S.noteDecode(st, d, ctx(T0, band || '20m', mode || 'FT8'));
  return st.byCall[String(d.call).toUpperCase()];
}

// ---------------------------------------------------------------------------
// The fixture roster is what we think it is (guards the fixtures below).
// ---------------------------------------------------------------------------
test('fixture roster: Japan confirmed, Germany phone only, Texas worked, Ohio confirmed', () => {
  const o = { scope: 'band-mode', band: '20m', mode: 'FT8' };
  assert.strictEqual(WorkedRoster.status(ROSTER, 'entity', 'Japan', o), 'confirmed');
  assert.strictEqual(WorkedRoster.status(ROSTER, 'entity', 'Germany', o), 'none');
  assert.strictEqual(WorkedRoster.status(ROSTER, 'state', 'TX', o), 'worked');
  assert.strictEqual(WorkedRoster.status(ROSTER, 'state', 'OH', o), 'confirmed');
});

// ---------------------------------------------------------------------------
// Each mark, from fixture roster data
// ---------------------------------------------------------------------------
test('a new country: not in the roster under the scope', () => {
  const e = entry({ call: 'VK2ABC', text: 'CQ VK2ABC QF56', grid: 'QF56', entity: 'Australia' });
  const m = S.marksOf(e, scope());
  assert.strictEqual(m.entity, 'new');
  assert.strictEqual(m.needed, true);
});

test('worked and confirmed countries are marked for context, not as needed', () => {
  assert.strictEqual(S.marksOf(entry({ call: 'JA1XYZ', text: 'CQ JA1XYZ PM95', entity: 'Japan' }), scope()).entity, 'confirmed');
  const it = S.marksOf(entry({ call: 'I2ABC', text: 'CQ I2ABC JN45', entity: 'Italy' }, '40m'), scope());
  assert.strictEqual(it.entity, 'worked');
  assert.strictEqual(it.needed, false);
});

test('a new state: QRZ knows it and the roster has not got it; worked and confirmed states too', () => {
  const ma = entry({ call: 'W1MA', text: 'CQ W1MA', entity: 'United States', state: { code: 'MA', source: 'qrz' } });
  assert.strictEqual(S.marksOf(ma, scope()).state, 'new');
  const tx = entry({ call: 'W5TX', text: 'CQ W5TX', entity: 'United States', state: { code: 'TX', source: 'qrz' } });
  assert.strictEqual(S.marksOf(tx, scope()).state, 'worked');
  const oh = entry({ call: 'W8OH', text: 'CQ W8OH', entity: 'United States', state: { code: 'OH', source: 'grid+qrz' } });
  assert.strictEqual(S.marksOf(oh, scope()).state, 'confirmed');
});

test('no state mark from a grid guess (the row shows no state, so no mark either)', () => {
  const e = entry({ call: 'K2ABC', text: 'CQ K2ABC FN20', grid: 'FN20', entity: 'United States', wantedState: true, state: { code: 'NJ', certain: true, source: 'grid' } });
  assert.strictEqual(e.state, '');
  assert.strictEqual(S.marksOf(e, scope()).state, '');
});

test('DC counts as Maryland (the WAS rule in the roster)', () => {
  const r = WorkedRoster.build(new Map([['W3MD', [{ band: '20M', mode: 'FT8', state: 'MD' }]]]), () => 'United States');
  const e = entry({ call: 'K3DC', text: 'CQ K3DC', entity: 'United States', state: { code: 'DC', source: 'qrz' } });
  assert.strictEqual(S.marksOf(e, { roster: r, scope: 'band-mode' }).state, 'worked');
});

test('a new grid: the newGrid flag of the decode the grid came from, kept when later messages carry no grid', () => {
  const st = S.create();
  S.noteDecode(st, { call: 'K1ABC', text: 'CQ K1ABC FN42', grid: 'FN42', newGrid: true, entity: 'United States' }, ctx(T0));
  S.noteDecode(st, { call: 'K1ABC', text: 'W2XYZ K1ABC -08', entity: 'United States' }, ctx(T0 + 15000));
  assert.strictEqual(S.marksOf(st.byCall.K1ABC, scope()).grid, true);
  S.noteDecode(st, { call: 'K1ABC', text: 'CQ K1ABC FN43', grid: 'FN43', newGrid: false, entity: 'United States' }, ctx(T0 + 30000));
  assert.strictEqual(S.marksOf(st.byCall.K1ABC, scope()).grid, false, 'a worked grid heard later: no mark');
});

test('a call never worked: the decode\'s newCall (the worked-before check)', () => {
  assert.strictEqual(S.marksOf(entry({ call: 'K1NEW', text: 'CQ K1NEW FN42', newCall: true, entity: 'United States' }), scope()).call, true);
  assert.strictEqual(S.marksOf(entry({ call: 'K1OLD', text: 'CQ K1OLD FN42', newCall: false, entity: 'United States' }), scope()).call, false);
});

test('after a QSO is logged, clearWorkedFlags on the list\'s decodes drops the grid and call marks', () => {
  const st = S.create();
  S.noteDecode(st, { call: 'K1ABC', text: 'CQ K1ABC FN42', grid: 'FN42', newGrid: true, newCall: true, entity: 'United States' }, ctx(T0));
  S.noteDecode(st, { call: 'K1ABC', text: 'K3SBP K1ABC R-08', newCall: true, entity: 'United States' }, ctx(T0 + 15000));
  const n = DecodeRow.clearWorkedFlags(S.decodesOf(st), { call: 'K1ABC', grid: 'FN42', entity: 'United States', band: '20m' });
  assert.ok(n >= 3, 'flags cleared on the latest decode and on the grid\'s decode');
  const m = S.marksOf(st.byCall.K1ABC, scope());
  assert.strictEqual(m.grid, false);
  assert.strictEqual(m.call, false);
});

test('no roster yet: the decode\'s own newDxcc and wantedState stand in', () => {
  const e = entry({ call: 'DL1ABC', text: 'CQ DL1ABC JO62', entity: 'Germany', newDxcc: true });
  assert.strictEqual(S.marksOf(e, { roster: null }).entity, 'new');
  assert.strictEqual(S.marksOf(entry({ call: 'DL2X', text: 'CQ DL2X', entity: 'Germany', newDxcc: false }), {}).entity, '');
  const s = entry({ call: 'W1MA', text: 'CQ W1MA', entity: 'United States', wantedState: true, state: { code: 'MA', source: 'qrz' } });
  assert.strictEqual(S.marksOf(s, null).state, 'new');
});

// ---------------------------------------------------------------------------
// Scope honoured (the map overlay's "Scope: band + mode" setting)
// ---------------------------------------------------------------------------
test('scope: Germany worked on 20m phone is needed on 20m digital (band + mode), not on 20m (band) or any band', () => {
  const e = entry({ call: 'DL1ABC', text: 'CQ DL1ABC JO62', entity: 'Germany' });
  assert.strictEqual(S.marksOf(e, scope('band-mode')).entity, 'new');
  assert.strictEqual(S.marksOf(e, scope('band')).entity, 'worked');
  assert.strictEqual(S.marksOf(e, scope('any')).entity, 'worked');
  assert.strictEqual(S.marksOf(e, scope('mode')).entity, 'new', 'any band, digital: Germany was phone only');
});

test('scope: Italy worked on 40m is needed on 20m under band scopes, worked under any band', () => {
  const e = entry({ call: 'I2ABC', text: 'CQ I2ABC JN45', entity: 'Italy' }, '20m');
  assert.strictEqual(S.marksOf(e, scope('band-mode')).entity, 'new');
  assert.strictEqual(S.marksOf(e, scope('band')).entity, 'new');
  assert.strictEqual(S.marksOf(e, scope('any')).entity, 'worked');
});

test('scope: confirmed only turns a worked, unconfirmed state into a needed one', () => {
  const tx = entry({ call: 'W5TX', text: 'CQ W5TX', entity: 'United States', state: { code: 'TX', source: 'qrz' } });
  assert.strictEqual(S.marksOf(tx, scope('band-mode', { confirmedOnly: true })).state, 'new');
  const oh = entry({ call: 'W8OH', text: 'CQ W8OH', entity: 'United States', state: { code: 'OH', source: 'qrz' } });
  assert.strictEqual(S.marksOf(oh, scope('band-mode', { confirmedOnly: true })).state, 'confirmed');
});

test('the station\'s own band and mode are used (a multi-slice decode on 40m)', () => {
  const e = entry({ call: 'I2ABC', text: 'CQ I2ABC JN45', entity: 'Italy', band: '40m' }, '20m');
  assert.strictEqual(e.band, '40m');
  assert.strictEqual(S.marksOf(e, scope('band-mode')).entity, 'worked');
});

test('the marks agree with the map: the same WorkedRoster.status under the same options', () => {
  const o = { scope: 'band-mode', band: '20m', mode: 'FT8', confirmedOnly: false };
  for (const [call, ent] of [['JA1XYZ', 'Japan'], ['DL1ABC', 'Germany'], ['I2ABC', 'Italy'], ['VK2A', 'Australia']]) {
    const want = WorkedRoster.status(ROSTER, 'entity', ent, o);
    const got = S.marksOf(entry({ call, text: 'CQ ' + call, entity: ent }), scope('band-mode')).entity;
    assert.strictEqual(got, want === 'none' ? 'new' : want, ent);
  }
});

// ---------------------------------------------------------------------------
// The park: from a spot, from a CQ POTA message, else blank
// ---------------------------------------------------------------------------
const nowIso = new Date(Date.now() - 5 * 60000).toISOString().replace(/\.\d+Z$/, '');
const SPOTS = [
  { source: 'pota', callsign: 'KN5YVJ', reference: 'US-1234', frequency: '14074', spotTime: nowIso },
  { source: 'pota', callsign: 'W9ELSE', reference: 'US-5555', frequency: '7074', spotTime: nowIso },
  { source: 'sota', callsign: 'W7SUM', reference: 'W7O/CN-001', frequency: '14074', spotTime: nowIso },
];

test('main\'s spot match: the call and the band (the spot list Hunt reads); another band does not count', () => {
  const hit = HuntedPark.findHuntedRefs(SPOTS, 'KN5YVJ', { band: '20m', sameBandOnly: true });
  assert.ok(hit && hit.primaryRef === 'US-1234' && hit.sig === 'POTA');
  assert.strictEqual(HuntedPark.findHuntedRefs(SPOTS, 'W9ELSE', { band: '20m', sameBandOnly: true }), null, 'spotted on 40m, heard on 20m');
  assert.ok(HuntedPark.findHuntedRefs(SPOTS, 'W9ELSE', { band: '40m', sameBandOnly: true }));
  assert.strictEqual(HuntedPark.findHuntedRefs(SPOTS, 'KN5YVJ', { sameBandOnly: true }), null, 'no band, no match');
  assert.ok(HuntedPark.findHuntedRefs(SPOTS, 'W9ELSE', { freqKhz: 14074 }), 'the logging lookup (no sameBandOnly) is unchanged');
  assert.strictEqual(HuntedPark.findHuntedRefs(SPOTS, 'W7SUM', { band: '20m', sameBandOnly: true }).sig, 'SOTA');
});

test('the park from a spot: the decode\'s spotRef', () => {
  const e = entry({ call: 'KN5YVJ', text: 'CQ POTA KN5YVJ EM20', spotRef: { sig: 'POTA', ref: 'US-1234' } });
  assert.deepStrictEqual(e.park, { sig: 'POTA', ref: 'US-1234', from: 'spot' });
});

test('the park from a CQ POTA message that names one; a CQ POTA without one is blank', () => {
  assert.deepStrictEqual(entry({ call: 'K1ABC', text: 'CQ POTA US-0001' }).park, { sig: 'POTA', ref: 'US-0001', from: 'cq' });
  assert.deepStrictEqual(S.refFromText('CQ VE-0123 VE3ABC'), { sig: 'POTA', ref: 'VE-0123' });
  assert.deepStrictEqual(S.refFromText('CQ KFF-1234'), { sig: 'WWFF', ref: 'KFF-1234' });
  assert.deepStrictEqual(S.refFromText('CQ W7O/CN-001'), { sig: 'SOTA', ref: 'W7O/CN-001' });
  assert.strictEqual(entry({ call: 'K2ABC', text: 'CQ POTA K2ABC FN20' }).park, null);
  assert.strictEqual(S.refFromText('W2XYZ K1ABC US-0001'), null, 'only a CQ names its own park');
  assert.strictEqual(S.refFromText('CQ K1ABC FN42'), null);
});

test('a spot beats a CQ; the park is kept when later messages say nothing', () => {
  const st = S.create();
  S.noteDecode(st, { call: 'K1ABC', text: 'CQ POTA K1ABC FN42', spotRef: { sig: 'POTA', ref: 'US-1234' } }, ctx(T0));
  S.noteDecode(st, { call: 'K1ABC', text: 'CQ US-9999' }, ctx(T0 + 15000));
  assert.strictEqual(st.byCall.K1ABC.park.ref, 'US-1234');
  S.noteDecode(st, { call: 'K1ABC', text: 'W2XYZ K1ABC RR73' }, ctx(T0 + 30000));
  assert.strictEqual(st.byCall.K1ABC.park.ref, 'US-1234');
});

test('main stamps the spot ref at both decode sites, on the band the decode was heard on', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  assert.ok(/function jtcatSpotRefEnrichDecode\(r, call, band\) \{[\s\S]{0,300}HuntedPark\.findHuntedRefs\(lastMergedSpots, call, \{ band, sameBandOnly: true/.test(main));
  assert.strictEqual((main.match(/^\s+jtcatSpotRefEnrichDecode\(r, uc, currentBand\);$/gm) || []).length, 2, 'single and multi-slice');
});

// ---------------------------------------------------------------------------
// The Wanted filter in the Stations view
// ---------------------------------------------------------------------------
test('wantedMatch: off shows all; Wanted any mark; New DXCC a new country; New grid a new grid', () => {
  const none = { entity: 'worked', state: '', grid: false, call: false, needed: false };
  const call = { entity: 'confirmed', state: '', grid: false, call: true, needed: true };
  const dx = { entity: 'new', state: '', grid: false, call: false, needed: true };
  const grid = { entity: 'worked', state: '', grid: true, call: false, needed: true };
  const state = { entity: 'confirmed', state: 'new', grid: false, call: false, needed: true };
  assert.ok(S.wantedMatch(none, ''));
  assert.ok(!S.wantedMatch(none, 'wanted'));
  for (const m of [call, dx, grid, state]) assert.ok(S.wantedMatch(m, 'wanted'));
  assert.ok(S.wantedMatch(dx, 'dxcc') && !S.wantedMatch(grid, 'dxcc') && !S.wantedMatch(call, 'dxcc'));
  assert.ok(S.wantedMatch(grid, 'grid') && !S.wantedMatch(dx, 'grid'));
});

const pop = readSrc(path.join(__dirname, '..', 'renderer', 'jtcat-popout.js'));
const popHtml = readSrc(path.join(__dirname, '..', 'renderer', 'jtcat-popout.html'));
const block = pop.slice(pop.indexOf('// --- Stations view (#557) ---'), pop.indexOf('function renderDecodes(data)'));

test('the pop-out: Wanted limits the list to stations with a needed mark, from the roster under the overlay scope', () => {
  assert.ok(/if \(!JtcatStations\.wantedMatch\(marks, wantedFilter\)\) return false;/.test(block), 'the Wanted rule on the marks');
  assert.ok(/c\.stationMarks = marks;\n\s+return decodeVisible\(c\);/.test(block), 'the other filters, with the station\'s marks');
  assert.ok(/if \(c\.stationMarks\) return JtcatStations\.wantedMatch\(c\.stationMarks, wantedFilter\);/.test(pop), 'Wanted reads the marks for a station');
  assert.ok(/JtcatStations\.marksOf\(all\[a\], mctx\)/.test(block), 'marks for every station');
  assert.ok(/window\.api\.getWorkedRoster\(\)/.test(block) && /window\.api\.onWorkedRoster\(/.test(block), 'the roster');
  assert.ok(/window\.api\.workedOverlayGet\(\)/.test(block) && /window\.api\.onWorkedOverlayState\(stationsTakeOverlay\)/.test(block), 'the map overlay\'s scope');
  assert.ok(/JtcatStations\.decodesOf\(jpStations\)/.test(pop), 'a logged QSO clears the list\'s flags too');
  assert.ok(/DecodeRow\.stationKeyHtml\('jp', scopeText\)/.test(block), 'the key under the list');
});

test('the worked roster loads before the stations module (it reads window.WorkedRoster)', () => {
  const a = popHtml.indexOf('<script src="../lib/worked-roster.js"></script>');
  const b = popHtml.indexOf('<script src="../lib/jtcat-stations.js"></script>');
  assert.ok(a > 0 && b > a);
});

// ---------------------------------------------------------------------------
// The row: marks, worked colours, park, key
// ---------------------------------------------------------------------------
test('the Need cell: the stream\'s letters, each with words in a tooltip', () => {
  const e = { call: 'KL7ABC', grid: 'BP51', entity: 'Alaska', state: 'AK' };
  const html = DecodeRow.stationMarksHtml(e, { entity: 'new', state: 'new', grid: true, call: true }, 'jp', 'on 20m digital');
  const marks = [...html.matchAll(/class="jp-st-mark jp-st-mark-(\w+)" title="([^"]+)">([^<]+)</g)].map(m => [m[1], m[3], m[2]]);
  assert.deepStrictEqual(marks.map(m => m.slice(0, 2)), [['dxcc', 'D'], ['state', 'AK'], ['grid', 'G'], ['call', 'C']]);
  assert.ok(/New country: Alaska is one you still need on 20m digital/.test(marks[0][2]));
  assert.ok(/New state: AK/.test(marks[1][2]) && /grid BP51/.test(marks[2][2]) && /KL7ABC is not in your log/.test(marks[3][2]));
  assert.strictEqual(DecodeRow.stationMarksHtml(e, { entity: 'worked', state: 'confirmed' }, 'jp'), '', 'worked and confirmed are not needed marks');
});

test('country and state cells carry the worked / confirmed class and say so', () => {
  const row = DecodeRow.stationRowInner({ call: 'W8OH', entity: 'United States', state: 'OH', lastHeard: T0 }, T0, 'jp',
    { marks: { entity: 'worked', state: 'confirmed' }, scopeText: 'on 20m digital' });
  assert.ok(/class="jp-st-country jp-st-worked" title="United States: worked on 20m digital, not confirmed yet"/.test(row));
  assert.ok(/class="jp-st-state jp-st-confirmed" title="OH: worked and confirmed on 20m digital"/.test(row));
});

test('the Park cell: the reference, and where it came from in the tooltip', () => {
  const a = DecodeRow.stationRowInner({ call: 'K1ABC', park: { sig: 'POTA', ref: 'US-1234', from: 'spot' } }, T0, 'jp');
  assert.ok(/class="jp-st-park" title="POTA US-1234: spotted there on this band">US-1234</.test(a));
  const b = DecodeRow.stationRowInner({ call: 'K1ABC', park: { sig: 'POTA', ref: 'US-0001', from: 'cq' } }, T0, 'jp');
  assert.ok(/title="POTA US-0001: named in their CQ">US-0001</.test(b));
  assert.ok(/<span class="jp-st-park"><\/span>/.test(DecodeRow.stationRowInner({ call: 'K1ABC' }, T0, 'jp')), 'blank otherwise');
});

test('the header explains Need and Park; the key names every mark and the scope', () => {
  const h = DecodeRow.stationHeaderInner('jp', 'last');
  assert.ok(/class="jp-st-need" title="What this station would give you/.test(h));
  assert.ok(/class="jp-st-park" title="The park or summit/.test(h));
  const k = DecodeRow.stationKeyHtml('jp', 'on 20m digital');
  for (const w of ['new country', 'new state', 'new grid', 'new call', 'worked', 'confirmed', 'on 20m digital, as on the map']) assert.ok(k.includes(w), w);
  assert.ok(!/<script/.test(DecodeRow.stationKeyHtml('jp', '<script>')), 'escaped');
});

test('a row double-click is still the one decode action (no new handler on the Park or Need cell)', () => {
  assert.ok(!/jp-st-(park|need|mark)(?![\w-])/.test(block.replace(/\/\/[^\n]*/g, '')), 'no handler wired to the new cells');
  assert.strictEqual((block.match(/addEventListener\('dblclick'/g) || []).length, 1);
});

// ---------------------------------------------------------------------------
// Colours: theme tokens only
// ---------------------------------------------------------------------------
test('the marks, worked colours, park and key use theme tokens only (no colour written in)', () => {
  const css = [...popHtml.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
  const rules = css.split('\n').filter(l => /\.jp-st-(mark|worked|confirmed|park|need|key)/.test(l));
  assert.ok(rules.length >= 10, 'rules found: ' + rules.length);
  for (const r of rules) {
    assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(r), 'hard-coded colour: ' + r.trim());
    assert.ok(!/yellow|gold/i.test(r), 'never yellow: ' + r.trim());
  }
  const want = {
    'jp-st-mark-dxcc': ['--accent-red', '--on-mark-dxcc'],
    'jp-st-mark-state': ['--source-dxc', '--on-source-dxc'],
    'jp-st-mark-grid': ['--accent-blue', '--on-accent-blue'],
    'jp-st-mark-call': ['--source-sota', '--on-source-sota'],
  };
  for (const [cls, toks] of Object.entries(want)) {
    const r = rules.find(l => l.includes('.' + cls + ' '));
    assert.ok(r, cls);
    for (const t of toks) assert.ok(r.includes('var(' + t + ')'), cls + ' uses ' + t);
  }
  assert.ok(rules.some(l => /\.jp-st-worked/.test(l) && /var\(--accent-blue\)/.test(l)), 'worked: the theme\'s #4fc3f7 role');
  assert.ok(rules.some(l => /\.jp-st-confirmed/.test(l) && /var\(--accent-green\)/.test(l)), 'confirmed: the theme\'s #4ecca3 role');
});

test('the classic Navy theme gives worked #4fc3f7 and confirmed #4ecca3; the on-mark tokens exist', () => {
  const css = readSrc(path.join(__dirname, '..', 'renderer', 'styles.css'));
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  assert.ok(/--accent-blue: #4fc3f7;/.test(root) && /--accent-green: #4ecca3;/.test(root));
  assert.ok(/--on-source-dxc: /.test(root) && /--on-source-sota: /.test(root) && /--on-mark-dxcc: /.test(root));
});

console.log(`\njtcat stations needed: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
