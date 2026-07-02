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
const { qsoDayInScheduleEntry } = require('../lib/event-progress');

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

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, 'event-progress matcher tests failed');
