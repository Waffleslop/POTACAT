// Contest participation history (lib/contest-history.js) — the ECHOCAT
// per-contest, per-year log scan. Spec: potacat-app docs/desktop-asks/
// contest-participation-history.md. Run: node test/contest-history-test.js
'use strict';

const assert = require('assert');
const { buildContestHistory, yearWindow, foldMode, buildModeMatcher, buildBandMatcher } = require('../lib/contest-history');
const catalog = require('../data/contests.json').contests;

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
function qso(date, band, mode) { return { QSO_DATE: date, BAND: band, MODE: mode, CALL: 'TEST' }; }

const cqww = catalog.find(c => c.id === 'cq-ww-ssb');

console.log('yearWindow (real catalog rules, historical years):');
{
  const w2025 = yearWindow(cqww, 2025);
  check(w2025 && w2025.startDay === '20251025' && w2025.endDay === '20251026',
    `CQ WW SSB 2025 = last full Oct weekend → [${w2025 && w2025.startDay}, ${w2025 && w2025.endDay}]`);
  const w2024 = yearWindow(cqww, 2024);
  check(w2024 && w2024.startDay === '20241026' && w2024.endDay === '20241027', 'CQ WW SSB 2024 window');
  check(yearWindow({ whenComputed: 'weekly:Wed:1300z', durationHours: 1 }, 2025) === null, 'weekly rule → null (year-agnostic)');
  check(yearWindow({ whenComputed: 'custom:whenever' }, 2025) === null, 'custom rule → null');
  const range = yearWindow({ whenComputed: 'range:07-01:07-07', durationHours: 168 }, 2025);
  check(range && range.startDay === '20250701' && range.endDay === '20250707', 'range: window (13C shape, 168h inclusive)');
}

console.log('mode folding + matchers:');
{
  check(foldMode('USB') === 'SSB' && foldMode('lsb') === 'SSB' && foldMode('CW-R') === 'CW', 'USB/LSB→SSB, CW-R→CW');
  check(foldMode('FT8') === 'FT8' && foldMode('PSK31') === 'PSK31', 'digital modes stay distinct');
  const ssbOnly = buildModeMatcher(['SSB']);
  check(ssbOnly('SSB') && !ssbOnly('CW') && !ssbOnly('FT8'), 'exact mode list');
  const anyMode = buildModeMatcher(['any']);
  check(anyMode('FT8') && anyMode('SSB'), '"any" = no filter');
  const digi = buildModeMatcher(['DIGITAL']);
  check(digi('FT8') && digi('RTTY') && digi('PSK31') && !digi('SSB') && !digi('CW'), '"DIGITAL" = not phone/CW');
  const psk = buildModeMatcher(['PSK']);
  check(psk('PSK31') && psk('PSK63') && !psk('RTTY'), '"PSK" prefix-matches PSK flavors');
}

console.log('band matchers (catalog token interpretations):');
{
  const hf = buildBandMatcher(['all HF']);
  check(hf('20m') && hf('30m') && hf('160m') && !hf('2m'), '"all HF" includes WARC, excludes VHF');
  const vhf = buildBandMatcher(['VHF']);
  check(vhf('6m') && vhf('2m') && !vhf('70cm') && !vhf('10m'), '"VHF" = 6m–1.25m');
  const plus = buildBandMatcher(['50MHz+']);
  check(plus('6m') && plus('2m') && plus('23cm') && !plus('10m'), '"50MHz+" = 6m and up');
  const mhz = buildBandMatcher(['144MHz', '432MHz']);
  check(mhz('2m') && mhz('70cm') && !mhz('1.25m'), 'MHz aliases map to bands');
  const anyB = buildBandMatcher(['any']);
  check(anyB('13cm') && anyB('160m'), '"any" = no filter');
}

console.log('buildContestHistory end-to-end:');
{
  const qsos = [
    qso('20251025', '20M', 'USB'),   // CQ WW SSB 2025, day 1
    qso('20251026', '40m', 'LSB'),   // day 2
    qso('20251026', '40m', 'SSB'),
    qso('20251026', '17M', 'SSB'),   // WARC during CQ WW → band-filtered out
    qso('20251025', '20m', 'CW'),    // wrong mode → out
    qso('20241026', '15m', 'USB'),   // CQ WW SSB 2024
    qso('20250615', '20m', 'SSB'),   // June VHF weekend, but 20m fails its band filter
  ];
  const h = buildContestHistory(catalog, qsos, { generatedAt: 1751700000000 });
  check(!!h && h.version === 1 && h.generatedAt === 1751700000000, 'blob shape (version, generatedAt)');
  const y25 = h.contests['cq-ww-ssb'] && h.contests['cq-ww-ssb']['2025'];
  check(!!y25 && y25.qsos === 3, `2025 tally = 3 (WARC + CW excluded) → ${y25 && y25.qsos}`);
  check(y25 && y25.bands['20m'] === 1 && y25.bands['40m'] === 2, 'band breakdown lowercased + counted');
  check(y25 && y25.modes.SSB === 3, 'modes folded to SSB');
  check(y25 && y25.firstQso === '20251025' && y25.lastQso === '20251026', 'first/last QSO dates');
  const y24 = h.contests['cq-ww-ssb']['2024'];
  check(!!y24 && y24.qsos === 1, '2024 year entry separate');
  // Zero-match contests omitted entirely
  check(!('arrl-160' in (h.contests || {})), 'contests with no QSOs omitted');
}

console.log('year-spanning window keyed by START year:');
{
  const nye = [{ id: 'nye-test', whenComputed: 'fixed:12-31', durationHours: 48, bands: [], modes: [] }];
  const h = buildContestHistory(nye, [qso('20250101', '80m', 'CW')], { generatedAt: 1 });
  const entry = h && h.contests['nye-test'];
  check(!!entry && !!entry['2024'] && entry['2024'].qsos === 1 && !entry['2025'],
    'Jan 1 QSO lands in the Dec-start year (2024)');
}

console.log('empty / degenerate inputs:');
{
  check(buildContestHistory(catalog, []) === null, 'no QSOs → null');
  check(buildContestHistory([cqww], [qso('20250615', '20m', 'SSB')]) === null, 'no matches → null');
  check(buildContestHistory(catalog, [qso('bad-date', '20m', 'SSB')]) === null, 'malformed dates ignored');
  check(buildContestHistory([], [qso('20251025', '20m', 'SSB')]) === null, 'empty catalog → null');
}

console.log('umbrella windows excluded (> 5 days):');
{
  // cq-dx-marathon is range:01-01:12-31 any/any — without the duration cap
  // it would tally EVERY QSO of every year. yota-month likewise for Dec.
  const h = buildContestHistory(catalog, [qso('20250615', '20m', 'SSB'), qso('20251215', '20m', 'SSB')], { generatedAt: 1 });
  check(h === null || (!h.contests['cq-dx-marathon'] && !h.contests['yota-month']),
    'cq-dx-marathon / yota-month never appear in history');
}

console.log('scan cost sanity (not asserted):');
{
  const synth = [];
  for (let i = 0; i < 20000; i++) {
    const y = 2015 + (i % 11);
    synth.push(qso(`${y}1025`, '20m', 'SSB'));
  }
  const t0 = Date.now();
  buildContestHistory(catalog, synth);
  console.log(`  20k QSOs × ${catalog.length} contests × 11 years: ${Date.now() - t0} ms`);
}

console.log('provenance-first attribution (APP_POTACAT_EVENT, events-roadmap #5):');
{
  // A record stamped at log time with a KNOWN catalog contest id attributes
  // directly — mode/band heuristics are bypassed (the stamp is
  // identity-proven). This CW QSO during CQ WW SSB would normally be
  // mode-filtered out.
  const stamped = { ...qso('20251025', '20m', 'CW'), APP_POTACAT_EVENT: 'cq-ww-ssb' };
  const h = buildContestHistory(catalog, [stamped], { generatedAt: 1 });
  check(!!(h && h.contests['cq-ww-ssb'] && h.contests['cq-ww-ssb']['2025']
    && h.contests['cq-ww-ssb']['2025'].qsos === 1),
    'stamped record attributes despite failing the mode filter');
}
{
  // A stamped record only counts ONCE (provenance path skips heuristics) —
  // no double attribution when the record would also match heuristically.
  const stamped = { ...qso('20251025', '20m', 'SSB'), APP_POTACAT_EVENT: 'cq-ww-ssb' };
  const h = buildContestHistory(catalog, [stamped], { generatedAt: 1 });
  check(h.contests['cq-ww-ssb']['2025'].qsos === 1, 'stamp + heuristic match still counts once');
}
{
  // Unknown stamp id (today's special events — 13col-2026 etc.): falls
  // through to heuristics unchanged. Activates fully under roadmap #1.
  const stamped = { ...qso('20251025', '20m', 'SSB'), APP_POTACAT_EVENT: '13col-2026' };
  const h = buildContestHistory(catalog, [stamped], { generatedAt: 1 });
  check(!!(h && h.contests['cq-ww-ssb'] && h.contests['cq-ww-ssb']['2025']
    && h.contests['cq-ww-ssb']['2025'].qsos === 1),
    'unknown stamp id falls back to heuristic attribution');
}
{
  // Stamp naming a contest whose window does NOT cover the day → heuristics.
  const stamped = { ...qso('20250615', '20m', 'SSB'), APP_POTACAT_EVENT: 'cq-ww-ssb' };
  const h = buildContestHistory(catalog, [stamped], { generatedAt: 1 });
  check(!(h && h.contests && h.contests['cq-ww-ssb']), 'out-of-window stamp does not force attribution');
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, 'contest-history tests failed');
