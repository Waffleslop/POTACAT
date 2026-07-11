#!/usr/bin/env node
'use strict';
//
// Unified Events/Contests registry — Phase A tests (events-roadmap #1).
// Pins the alias resolution that kills the dual-13-Colonies problem and the
// catalog merge semantics the Phase B view convergence will build on.
// Run: node test/event-registry-test.js
//
const assert = require('assert');
const R = require('../lib/event-registry');
const { buildContestHistory } = require('../lib/contest-history');
const catalog = require('../data/contests.json').contests;

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}

const EV13 = { id: '13colonies-2026', name: '13 Colonies 2026', board: 'checklist' };
const EV_CUSTOM = { id: 'club-sprint-2026', name: 'Club Sprint', board: 'counter', contestId: 'cq-ww-ssb' };
const EV_UNKNOWN = { id: 'mystery-2026', name: 'Mystery', board: 'checklist' };

console.log('alias resolution:');
check(R.baseEventId('13colonies-2026') === '13colonies', 'year suffix strips');
check(R.baseEventId('13-colonies') === '13-colonies', 'non-year ids untouched');
check(R.contestIdForEvent(EV13) === '13-colonies', 'builtin alias: 13colonies-2026 -> 13-colonies');
check(R.contestIdForEvent({ id: '13colonies-2027' }) === '13-colonies', 'future years resolve via base id');
check(R.contestIdForEvent(EV_CUSTOM) === 'cq-ww-ssb', 'server-side contestId field wins');
check(R.contestIdForEvent(EV_UNKNOWN) === null, 'unknown event -> null');

console.log('buildEventAliasMap:');
{
  const m = R.buildEventAliasMap([EV13, EV_CUSTOM, EV_UNKNOWN], catalog);
  check(m.get('13colonies-2026') === '13-colonies', 'map carries the 13C pair');
  check(m.get('club-sprint-2026') === 'cq-ww-ssb', 'map honors explicit contestId');
  check(!m.has('mystery-2026'), 'unresolvable events omitted');
  const m2 = R.buildEventAliasMap([EV_CUSTOM], [{ id: 'something-else' }]);
  check(!m2.has('club-sprint-2026'), 'alias to a contest NOT in the catalog is dropped');
}

console.log('kinds + unifiedCatalog:');
{
  check(R.kindForEvent(EV13) === 'special-event', 'checklist board -> special-event');
  check(R.kindForEvent({ board: 'regions' }) === 'award-window', 'regions board -> award-window');
  check(R.kindForEvent({ board: 'counter' }) === 'contest-window', 'counter board -> contest-window');
  check(R.kindForContest(catalog.find(c => c.id === '13-colonies')) === 'special-event',
    'contests category special-event maps through');
  check(R.kindForContest(catalog.find(c => c.id === 'cq-ww-ssb')) === 'contest', 'plain contest kind');

  const u = R.unifiedCatalog(catalog, [EV13]);
  const thirteenContest = u.find(e => e.id === '13-colonies' && e.source === 'contests');
  check(thirteenContest && thirteenContest.supersededBy === '13colonies-2026',
    'contests-side 13 Colonies marked superseded by the live event (dual-13C collapse)');
  const cqww = u.find(e => e.id === 'cq-ww-ssb');
  check(cqww && !cqww.supersededBy, 'un-aliased contests are not superseded');
  check(u.filter(e => e.source === 'events').length === 1, 'events ride the unified list');
}

console.log('contest-history: event-stamped QSOs attribute via alias (uncapped windows):');
{
  // 13-colonies is a 159 h umbrella window — EXCLUDED from heuristic
  // attribution by MAX_WINDOW_HOURS, so this only works via the provenance
  // path + alias map. The exact payoff of Phase A.
  const stamped = { CALL: 'K2A', QSO_DATE: '20260704', BAND: '20m', MODE: 'FT8',
    APP_POTACAT_EVENT: '13colonies-2026' };
  const aliases = R.buildEventAliasMap([EV13], catalog);
  const h = buildContestHistory(catalog, [stamped], { generatedAt: 1, eventAliases: aliases });
  check(!!(h && h.contests['13-colonies'] && h.contests['13-colonies']['2026']
    && h.contests['13-colonies']['2026'].qsos === 1),
    'stamp "13colonies-2026" attributes to the "13-colonies" contest history');
  // Without the alias map the same record attributes nothing (umbrella cap).
  const h2 = buildContestHistory(catalog, [stamped], { generatedAt: 1 });
  check(!(h2 && h2.contests && h2.contests['13-colonies']),
    'without aliases the umbrella-capped contest stays heuristic-free (no false path)');
  // Unstamped QSO during the window: still NOT heuristically attributed
  // (the umbrella cap protects against random-July-QSO false positives).
  const plain = { CALL: 'W1AW', QSO_DATE: '20260704', BAND: '20m', MODE: 'FT8' };
  const h3 = buildContestHistory(catalog, [plain], { generatedAt: 1, eventAliases: aliases });
  check(!(h3 && h3.contests && h3.contests['13-colonies']),
    'unstamped mid-window QSOs still never attribute to umbrella contests');
}

console.log('adifContestIdForEvent (curated ADIF vocabulary only):');
{
  check(R.adifContestIdForEvent(EV_CUSTOM, catalog) === 'CQ-WW-SSB',
    'event aliased to cq-ww-ssb yields the real ADIF CONTEST_ID');
  check(R.adifContestIdForEvent(EV13, catalog) === null,
    '13 Colonies yields NO CONTEST_ID (not in the ADIF vocabulary — never invented)');
  check(R.adifContestIdForEvent(EV_UNKNOWN, catalog) === null, 'unaliased event -> null');
  const fd = catalog.find(c => c.id === 'arrl-field-day');
  check(fd && fd.adifContestId === 'ARRL-FIELD-DAY',
    'curated field-day entry matches the value JTCAT FD mode already writes');
}

console.log('synthesizeContestEntry (Phase B — server-pushed contest rows):');
{
  const WRTC = {
    id: 'wrtc-2026', name: 'WRTC 2026', board: 'checklist',
    url: 'https://www.wrtc2026.org', badge: 'WRTC',
    schedule: [{ region: 'ALL', start: '2026-07-11T12:00:00Z', end: '2026-07-12T12:00:00Z' }],
    tracking: { type: 'checklist', total: 50, items: [] },
  };
  const s = R.synthesizeContestEntry(WRTC, catalog);
  check(!!s, 'un-aliased scheduled event synthesizes a contest row');
  check(s.id === 'wrtc-2026' && s.source === 'events', 'id + source carried');
  check(s.category === 'special-event', 'checklist board defaults to special-event category');
  check(s.start === '2026-07-11T12:00:00.000Z' && s.end === '2026-07-12T12:00:00.000Z',
    'explicit start/end from schedule');
  check(s.durationHours === 24, 'duration derived from the schedule span');
  check(Array.isArray(s.explicitWindows) && s.explicitWindows.length === 1,
    'explicit windows carried for contest-history');
  check(s.website === 'https://www.wrtc2026.org', 'event url becomes website');

  // Server-provided optional fields pass through.
  const rich = R.synthesizeContestEntry({ ...WRTC, id: 'x-2026', category: 'worldwide-dx',
    sponsor: 'Someone', modes: ['CW', 'SSB'], bands: ['20m'] }, catalog);
  check(rich.category === 'worldwide-dx' && rich.sponsor === 'Someone'
    && rich.modes.length === 2 && rich.bands[0] === '20m', 'server category/sponsor/modes/bands pass through');

  // Counter boards default to operating-event.
  const counter = R.synthesizeContestEntry({ ...WRTC, id: 'y-2026', board: 'counter', tracking: { type: 'counter' } }, catalog);
  check(counter.category === 'operating-event', 'counter board defaults to operating-event category');

  check(R.synthesizeContestEntry(EV13, catalog) === null,
    'catalog-aliased event does NOT synthesize (superseded catalog row renders it)');
  check(R.synthesizeContestEntry({ id: 'no-sched-2026', name: 'X' }, catalog) === null,
    'unscheduled event does not synthesize');
  check(R.synthesizeContestEntry({ ...WRTC, id: 'cq-ww-ssb' }, catalog) === null,
    'id collision with a catalog contest does not synthesize');
}

console.log('explicitWindows -> contest-history (Phase B end-to-end):');
{
  const WRTC = {
    id: 'wrtc-2026', name: 'WRTC 2026', board: 'checklist',
    schedule: [{ region: 'ALL', start: '2026-07-11T12:00:00Z', end: '2026-07-12T12:00:00Z' }],
  };
  const entry = R.synthesizeContestEntry(WRTC, catalog);
  const qso = (d, band, mode, extra) => ({ QSO_DATE: d, BAND: band, MODE: mode, ...extra });
  // Stamped QSO inside the window attributes to the event's own id.
  const h = buildContestHistory(catalog.concat([entry]), [
    qso('20260711', '20m', 'CW', { APP_POTACAT_EVENT: 'wrtc-2026' }),
    qso('20260712', '40m', 'SSB', { APP_POTACAT_EVENT: 'wrtc-2026' }),
  ], { generatedAt: 1 });
  check(!!(h && h.contests['wrtc-2026'] && h.contests['wrtc-2026']['2026']
    && h.contests['wrtc-2026']['2026'].qsos === 2),
    'stamped QSOs attribute to the event-sourced entry via explicit windows');
  // Out-of-window QSO does not.
  const h2 = buildContestHistory(catalog.concat([entry]), [
    qso('20260720', '20m', 'CW', { APP_POTACAT_EVENT: 'wrtc-2026' }),
  ], { generatedAt: 1 });
  check(!(h2 && h2.contests && h2.contests['wrtc-2026']),
    'stamp outside the explicit window does not attribute');
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, 'event-registry tests failed');
