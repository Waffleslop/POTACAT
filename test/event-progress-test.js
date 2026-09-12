// Event-progress date-window matcher unit tests.
//
// Regression guard for the "13 Colonies checklist loses its checkmarks after a
// restart" bug: scanLogForEvents synthesized every logged QSO at 12:00Z and
// required instant >= window.start, which dropped start-day QSOs for a window
// that opens at 1300z (and end-day QSOs for one that closes at 0400z). The log
// re-scan on launch rebuilds progress from scratch, so the checkmarks vanished.
// The fix compares at UTC-day granularity, inclusive of both boundary days.
// Run: node test/event-progress-test.js

'use strict';

const assert = require('assert');
const { qsoDayInScheduleEntry, matchChecklistItem, matchRegionPatterns, matchEventQsoForStamp, retroStampMatches, matchingRegionEntry } = require('../lib/event-progress');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}

// The real 13 Colonies window: 1300z Jul 1 -> 0400z Jul 8.
const COL = { region: 'ALL', start: '2026-07-01T13:00:00Z', end: '2026-07-08T04:00:00Z' };

console.log('13 Colonies window (1300z Jul 1 - 0400z Jul 8):');
// The exact bug: a QSO made on the opening day. Old code synthesized 12:00Z,
// which is before the 1300z start, so it was dropped on the restart re-scan.
check(qsoDayInScheduleEntry('20260701', COL) === true, 'start-day QSO (Jul 1) counts');
check(qsoDayInScheduleEntry('20260702', COL) === true, 'mid-event QSO (Jul 2) counts');
check(qsoDayInScheduleEntry('20260707', COL) === true, 'busy final day (Jul 7) counts');
check(qsoDayInScheduleEntry('20260708', COL) === true, 'end-day QSO (Jul 8, before 0400z close) counts');
check(qsoDayInScheduleEntry('20260630', COL) === false, 'day before the event does not count');
check(qsoDayInScheduleEntry('20260709', COL) === false, 'day after the event does not count');

// Even if a stale remote events cache still carries the old (short by a day)
// end, the day-inclusive match still rescues the reported case (Jul 1 QSOs).
console.log('Stale/short window (end mistakenly 0400z Jul 7):');
const SHORT = { region: 'ALL', start: '2026-07-01T13:00:00Z', end: '2026-07-07T04:00:00Z' };
check(qsoDayInScheduleEntry('20260701', SHORT) === true, 'start-day QSO still counts with short end');
check(qsoDayInScheduleEntry('20260707', SHORT) === true, 'Jul 7 QSO counts (inclusive end day)');
check(qsoDayInScheduleEntry('20260708', SHORT) === false, 'Jul 8 excluded when cache ends Jul 7');

// Full-day WAS/regions windows must behave identically (no regression there).
console.log('Full-day WAS window (regression check):');
const WAS = { region: 'NY', start: '2026-01-07T00:00:00Z', end: '2026-01-13T23:59:59Z' };
check(qsoDayInScheduleEntry('20260107', WAS) === true, 'first WAS day counts');
check(qsoDayInScheduleEntry('20260113', WAS) === true, 'last WAS day counts');
check(qsoDayInScheduleEntry('20260114', WAS) === false, 'day after WAS window excluded');

console.log('Malformed / missing input:');
check(qsoDayInScheduleEntry('', COL) === false, 'empty QSO date -> false');
check(qsoDayInScheduleEntry('2026070', COL) === false, 'short QSO date -> false');
check(qsoDayInScheduleEntry('20260701', null) === false, 'null entry -> false');
check(qsoDayInScheduleEntry('20260701', { start: '', end: '' }) === false, 'blank window -> false');

// ---------------------------------------------------------------------------
// Identity-proven event stamping (2026-07-09): only station-identity matches
// (checklist items, region callsign patterns) may stamp a QSO with the event;
// counter boards (any QSO in the window) never stamp. Shared predicates keep
// checkEventQso's progress marking and saveQsoRecord's stamping in lockstep.
// ---------------------------------------------------------------------------
console.log('\nChecklist / pattern predicates:');
const ITEMS = [{ id: 'K2A', name: 'New York' }, { id: 'GB13COL', name: 'Bonus: England' }];
check(matchChecklistItem(ITEMS, 'K2A').name === 'New York', 'exact checklist call matches');
check(matchChecklistItem(ITEMS, 'K2A/4').name === 'New York', 'portable-suffixed event station matches');
check(matchChecklistItem(ITEMS, 'K2AB') === null, 'longer call is NOT a prefix match');
check(matchChecklistItem(ITEMS, 'W1AW') === null, 'unrelated call -> null');
check(matchRegionPatterns(['W2S/*', 'K3SBP'], 'W2S/7') === true, 'wildcard pattern matches');
check(matchRegionPatterns(['W2S/*', 'K3SBP'], 'K3SBP') === true, 'exact pattern matches');
check(matchRegionPatterns(['W2S/*'], 'W2SA') === false, 'wildcard requires the slash');

console.log('\nmatchEventQsoForStamp:');
const NOW = new Date('2026-07-04T18:00:00Z');
const EVENTS = [
  { id: '13col-2026', name: '13 Colonies 2026', board: 'checklist',
    schedule: [{ region: 'ALL', start: '2026-07-01T13:00:00Z', end: '2026-07-08T04:00:00Z' }],
    tracking: { items: ITEMS } },
  { id: 'america250', name: 'America 250 WAS', board: 'regions',
    schedule: [{ region: 'PA', regionName: 'Pennsylvania', start: '2026-07-01T00:00:00Z', end: '2026-07-31T23:59:59Z' }],
    callsignPatterns: ['W2S/*', 'K2ZZZ'] },
  { id: 'some-sprint', name: 'Window Sprint', board: 'counter',
    schedule: [{ region: 'ALL', start: '2026-07-01T00:00:00Z', end: '2026-07-31T23:59:59Z' }] },
];
const STATE = { '13col-2026': { optedIn: true, progress: {} }, 'america250': { optedIn: true, progress: {} }, 'some-sprint': { optedIn: true, progress: {} } };
{
  const m = matchEventQsoForStamp(EVENTS, STATE, 'K2A', NOW);
  check(m && m.eventId === '13col-2026' && m.item === 'K2A' && m.itemName === 'New York',
    'checklist station stamps with event + item');
}
{
  // District derivation (WG9I fix): PA is district 3, so only /3 stamps it.
  const m = matchEventQsoForStamp(EVENTS, STATE, 'W2S/3', NOW);
  check(m && m.eventId === 'america250' && m.item === 'PA' && m.itemName === 'Pennsylvania',
    'region-pattern station stamps with the active region');
}
{
  // The pre-fix behavior stamped ANY W2S/x with the first covering state —
  // that is exactly how /7 Oregon got stamped New Jersey. Wrong-district
  // suffixes must now refuse to stamp rather than guess.
  const m = matchEventQsoForStamp(EVENTS, STATE, 'W2S/7', NOW);
  check(m === null, 'wrong-district suffix does NOT stamp a derivable region');
}
check(matchEventQsoForStamp(EVENTS, STATE, 'DL1ABC', NOW) === null,
  'random call during a counter-board window does NOT stamp (identity required)');
check(matchEventQsoForStamp(EVENTS, { ...STATE, '13col-2026': { optedIn: false, progress: {} } }, 'K2A', NOW) === null,
  'not opted in -> no stamp');
check(matchEventQsoForStamp(EVENTS, STATE, 'K2A', new Date('2026-08-01T00:00:00Z')) === null,
  'outside the schedule window -> no stamp');
check(matchEventQsoForStamp(EVENTS, undefined, 'K2A', NOW) === null, 'missing state -> no stamp');

// ---------------------------------------------------------------------------
// Retro-stamping (events-roadmap #3): find PAST log records that belong to an
// event but carry no stamp. Explicit-button feature; these tables pin the
// candidate rules (identity + day window, skip stamped, counter never).
// ---------------------------------------------------------------------------
console.log('\nretroStampMatches:');
{
  const ev13 = EVENTS[0]; // checklist, Jul 1 1300z - Jul 8 0400z
  const raw = (call, date, extra) => ({ CALL: call, QSO_DATE: date, ...extra });
  const log = [
    raw('K2A', '20260701'),                       // start day — matches
    raw('K2A/4', '20260703'),                     // portable event station — matches
    raw('W1AW', '20260703'),                      // not an event station
    raw('GB13COL', '20260709'),                   // outside the day window
    raw('GB13COL', '20260707', { APP_POTACAT_EVENT: '13col-2026' }), // already stamped — skip
    raw('GB13COL', '20260706'),                   // matches (bonus station)
  ];
  const m = retroStampMatches(ev13, log);
  check(m.length === 3, `checklist retro-stamp finds 3 candidates (got ${m.length})`);
  check(m.map(x => x.index).join(',') === '0,1,5', 'candidate indexes are 0,1,5');
  check(m[0].item === 'K2A' && m[0].itemName === 'New York', 'candidate carries item id + name');
}
{
  const evReg = EVENTS[1]; // regions, W2S/* pattern, July
  const log = [
    { CALL: 'W2S/3', QSO_DATE: '20260710' },     // district-correct — matches PA
    { CALL: 'W2S/7', QSO_DATE: '20260710' },     // wrong district — refuses
    { CALL: 'K1ABC', QSO_DATE: '20260710' },
  ];
  const m = retroStampMatches(evReg, log);
  check(m.length === 1 && m[0].item === 'PA' && m[0].itemName === 'Pennsylvania',
    'regions retro-stamp matches pattern calls with the covering region');
}
{
  const evCounter = EVENTS[2]; // counter — never stamps
  const m = retroStampMatches(evCounter, [{ CALL: 'K2A', QSO_DATE: '20260710' }]);
  check(m.length === 0, 'counter boards produce no retro-stamp candidates');
}
check(retroStampMatches(null, [{ CALL: 'K2A', QSO_DATE: '20260701' }]).length === 0, 'null event -> none');
check(retroStampMatches(EVENTS[0], []).length === 0, 'empty log -> none');

// ---------------------------------------------------------------------------
// Per-entry `patterns` disambiguation (website-agent audit 2026-07-09):
// America250 runs 2–4 states per week, all matching event-level "W1AW/*".
// Entry-level patterns pick the RIGHT state; absent patterns fall back.
// ---------------------------------------------------------------------------
console.log('\nmatchingRegionEntry (concurrent same-week regions):');
{
  const ev = { callsignPatterns: ['W1AW/*'] };
  const week = [
    { region: 'GA', regionName: 'Georgia', patterns: ['W1AW/4'] },
    { region: 'IN', regionName: 'Indiana', patterns: ['W1AW/9'] },
    { region: 'UT', regionName: 'Utah' }, // no patterns → event-level fallback
  ];
  check(matchingRegionEntry(ev, 'W1AW/9', week).region === 'IN',
    'per-entry patterns pick the right concurrent state');
  check(matchingRegionEntry(ev, 'W1AW/4', week).region === 'GA',
    'first entry only wins when its own patterns match');
  // Utah is district 7 — a pattern-less entry now derives W1AW/7 from its
  // region instead of falling to the match-anything event wildcard, so a /0
  // call matches NOTHING this week (the pre-fix wildcard fallback is how
  // WG9I's /7 Oregon QSO got stamped New Jersey).
  check(matchingRegionEntry(ev, 'W1AW/7', week).region === 'UT',
    'pattern-less entry derives its district pattern from the region');
  check(matchingRegionEntry(ev, 'W1AW/0', week) === null,
    'a suffix matching no covering state refuses instead of guessing');
  const underivable = [{ region: 'XX', regionName: 'Mystery' }];
  check(matchingRegionEntry(ev, 'W1AW/5', underivable).region === 'XX',
    'underivable region keeps the event-level wildcard fallback');
  check(matchingRegionEntry(ev, 'K1ABC', week) === null, 'non-matching call -> null');
  const bare = [{ region: 'PA' }, { region: 'OH' }];
  check(matchingRegionEntry(ev, 'W1AW/3', bare).region === 'PA',
    'no per-entry patterns anywhere -> legacy first-covering-entry behavior');
}
{
  // End-to-end through the stamp matcher: two concurrent regions entries.
  const ev = {
    id: 'america250', name: 'America 250 WAS', board: 'regions',
    callsignPatterns: ['W1AW/*'],
    schedule: [
      { region: 'GA', regionName: 'Georgia', patterns: ['W1AW/4'],
        start: '2026-07-01T00:00:00Z', end: '2026-07-08T00:00:00Z' },
      { region: 'IN', regionName: 'Indiana', patterns: ['W1AW/9'],
        start: '2026-07-01T00:00:00Z', end: '2026-07-08T00:00:00Z' },
    ],
  };
  const st = { america250: { optedIn: true, progress: {} } };
  const m = matchEventQsoForStamp([ev], st, 'W1AW/9', new Date('2026-07-04T12:00:00Z'));
  check(m && m.item === 'IN' && m.itemName === 'Indiana',
    'stamp matcher attributes the concurrent-week QSO to the correct state');
}

// ---------------------------------------------------------------------------
// retroCorrectStamps - the healing half (WG9I 2026-08-14: stamps written by
// the first-entry-wins matcher name the wrong state; the explicit retro
// button recomputes and fixes them).
// ---------------------------------------------------------------------------
console.log('\nretroCorrectStamps:');
{
  const { retroCorrectStamps, deriveRegionPatterns, US_CALL_DISTRICT } = require('../lib/event-progress');
  check(US_CALL_DISTRICT.OH === '8' && US_CALL_DISTRICT.IA === '0' && US_CALL_DISTRICT.HI === 'KH6',
    'district table: OH=8, IA=0, HI=KH6 (the transposed rows, fixed)');
  const ev = {
    id: 'america250', name: 'America 250 WAS', board: 'regions',
    callsignPatterns: ['W1AW/*'],
    schedule: [
      { region: 'NJ', regionName: 'New Jersey', start: '2026-08-05T00:00:00Z', end: '2026-08-11T23:59:59Z' },
      { region: 'OR', regionName: 'Oregon', start: '2026-08-05T00:00:00Z', end: '2026-08-11T23:59:59Z' },
    ],
  };
  check(deriveRegionPatterns(ev, ev.schedule[1]).join() === 'W1AW/7', 'OR derives W1AW/7');
  const log = [
    { CALL: 'W1AW/7', QSO_DATE: '20260808', APP_POTACAT_EVENT: 'america250', APP_POTACAT_EVENT_ITEM: 'NJ' },
    { CALL: 'W1AW/2', QSO_DATE: '20260808', APP_POTACAT_EVENT: 'america250', APP_POTACAT_EVENT_ITEM: 'NJ' },
    { CALL: 'W1AW/6', QSO_DATE: '20260808', APP_POTACAT_EVENT: 'america250', APP_POTACAT_EVENT_ITEM: 'NJ' },
    { CALL: 'W1AW/7', QSO_DATE: '20260808', APP_POTACAT_EVENT: 'other-ev', APP_POTACAT_EVENT_ITEM: 'ZZ' },
    { CALL: 'W1AW/7', QSO_DATE: '20260808' },
  ];
  const r = retroCorrectStamps(ev, log);
  check(r.corrections.length === 1 && r.corrections[0].index === 0 &&
        r.corrections[0].item === 'OR' && r.corrections[0].prevItem === 'NJ',
    'mis-stamped /7 corrects NJ -> OR, correct stamps untouched');
  check(r.unresolvable === 1, 'unmatchable stamp counted, not touched');
}


// ---------------------------------------------------------------------------
// Route 66 On The Air 2026 (route66-2026) against the REAL fallback
// definition in main.js, so a station-list edit that breaks matching fails
// here rather than on the air. 22 stations, all exact patterns; mobiles
// sign /m66 (the CALL/suffix rule that already carries K2A/4).
// ---------------------------------------------------------------------------
console.log('\nRoute 66 On The Air (BUILTIN route66-2026):');
{
  const { loadBuiltinEvents } = require('../scripts/validate-events');
  const r66 = loadBuiltinEvents().events.find((e) => e.id === 'route66-2026');
  check(!!r66, 'route66-2026 is in BUILTIN_EVENTS');
  const items = r66.tracking.items;
  check(items.length === 22 && r66.tracking.total === 22 && r66.callsignPatterns.length === 22,
    '22 stations: items, total and patterns agree');
  check(matchChecklistItem(items, 'W6K').name === 'Oklahoma City, OK', 'W6K = Oklahoma City');
  check(matchChecklistItem(items, 'W6K/M66').name === 'Oklahoma City, OK', 'a mobile signing W6K/M66 still ticks W6K');
  check(matchChecklistItem(items, 'W6KA') === null, 'W6KA (a real California call) is not W6K');
  check(matchChecklistItem(items, 'W6U') === null, 'W6U is unused this year — no item, no tick');
  check(matchChecklistItem(items, 'W6Z').group === 'Rovers', 'rover stations carry group: Rovers');
  check(!('lat' in matchChecklistItem(items, 'W6Z')), 'rovers have NO coordinates (never invented)');
  check(r66.callsignPatterns.every((p) => !p.includes('*')), 'every pattern is exact — a W6* wildcard would badge every California call');
  const onRoute = items.filter((it) => it.route).sort((a, b) => a.route - b.route);
  check(onRoute.length === 17 && onRoute[0].id === 'W6Q' && onRoute[16].id === 'W6A',
    'route order runs Chicago (W6Q) -> Santa Monica (W6A), 17 stops');
  check(matchChecklistItem(items, 'W6M').offRoute === true && !matchChecklistItem(items, 'W6M').route,
    'Tribune KS (W6M) is off-route: pin only, not on the polyline');

  const state = { 'route66-2026': { optedIn: true, progress: {} } };
  const stamp = (call, iso) => matchEventQsoForStamp([r66], state, call, new Date(iso));
  const opening = stamp('W6K', '2026-09-12T00:01:00Z');
  check(opening && opening.item === 'W6K' && opening.itemName === 'Oklahoma City, OK' && opening.eventName === 'Route 66 On The Air',
    'live path stamps W6K at the 0001z opening');
  check(stamp('W6K', '2026-09-12T00:00:30Z') === null, 'live path: 30 s before 0001z is before the event');
  check(stamp('W6A', '2026-09-20T23:59:00Z') !== null, 'live path stamps through the closing minute on the 20th');
  check(stamp('W6A', '2026-09-21T00:00:00Z') === null, 'live path: the 21st is after the event');
  // The log rebuild / retro-stamp is day-granular and must stay at least as
  // lenient as live: the 30-s-early QSO IS a Route 66 contact on rebuild.
  const entry = r66.schedule[0];
  check(qsoDayInScheduleEntry('20260912', entry) && qsoDayInScheduleEntry('20260920', entry),
    'rebuild covers the 12th and the 20th');
  check(!qsoDayInScheduleEntry('20260911', entry) && !qsoDayInScheduleEntry('20260921', entry),
    'rebuild excludes the 11th and the 21st');
  const m = retroStampMatches(r66, [
    { CALL: 'W6K', QSO_DATE: '20260912', TIME_ON: '000030' },
    { CALL: 'W6KA', QSO_DATE: '20260913' },
    { CALL: 'W6A', QSO_DATE: '20260921' },
  ]);
  check(m.length === 1 && m[0].index === 0 && m[0].item === 'W6K', 'retro-stamp finds only the W6K contact');
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, 'event-progress matcher tests failed');
