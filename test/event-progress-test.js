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
  const m = matchEventQsoForStamp(EVENTS, STATE, 'W2S/7', NOW);
  check(m && m.eventId === 'america250' && m.item === 'PA' && m.itemName === 'Pennsylvania',
    'region-pattern station stamps with the active region');
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
    { CALL: 'W2S/7', QSO_DATE: '20260710' },
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
  check(matchingRegionEntry(ev, 'W1AW/0', week).region === 'UT',
    'pattern-less entry falls back to event-level patterns');
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

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, 'event-progress matcher tests failed');
