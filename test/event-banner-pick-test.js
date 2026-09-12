// Tests for the event banner's event selection (pickBannerEvent) and the
// Contests view's "ended" status, both in renderer/app.js.
//
// Why these exist (Casey 2026-09-12, "there is no way to track Route 66"):
// the banner used to take the FIRST event in feed order with a live schedule
// entry. The feed lists America250 first and it runs all year, so the
// banner's Track It — the opt-in most operators actually see — never once
// offered 13 Colonies or Route 66, which start and finish inside one of
// America250's weeks. And a one-shot contest pushed from the events feed
// (WRTC 2026) sat under "This week" as "starting soon" two months after it
// ended, because _contestsStatus had no ended branch.
//
// app.js is a renderer file (DOM at top level), so we can't require() it. We
// extract the pure functions' source and eval them — same approach as
// test/voice-macros-test.js — so we test the REAL shipped code.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

function grab(re, name) {
  const m = src.match(re);
  if (!m) {
    console.error(`FAIL: could not locate ${name} in renderer/app.js`);
    process.exit(1);
  }
  return m[0];
}

const fnEntries = grab(/function getActiveScheduleEntries\(event\) \{[\s\S]*?\n\}/, 'getActiveScheduleEntries');
const fnSpan = grab(/function eventScheduleSpanMs\(ev\) \{[\s\S]*?\n\}/, 'eventScheduleSpanMs');
const fnPick = grab(/function pickBannerEvent\(\) \{[\s\S]*?\n\}/, 'pickBannerEvent');
const fnParse = grab(/function _contestsParseDate\(s\) \{.*\}/, '_contestsParseDate');
const fnStatus = grab(/function _contestsStatus\(c, now\) \{[\s\S]*?\n\}/, '_contestsStatus');

// pickBannerEvent closes over the renderer's module-level `activeEvents`;
// the factory supplies it. Date is stubbed so "now" is fixed.
// eslint-disable-next-line no-new-func
const makePick = new Function('activeEvents', 'Date',
  fnEntries + '\n' + fnSpan + '\n' + fnPick + '\nreturn pickBannerEvent;');
// eslint-disable-next-line no-new-func
const contestsStatus = new Function(fnParse + '\n' + fnStatus + '\nreturn _contestsStatus;')();

const RealDate = Date;
function fixedDate(iso) {
  const fixed = new RealDate(iso).getTime();
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed); else super(...args);
    }
    static now() { return fixed; }
  }
  return FixedDate;
}

function pickAt(iso, events) {
  return makePick(events, fixedDate(iso))();
}

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}

// Fixtures shaped like the live feed: a year-long event with weekly cohorts
// listed FIRST, a nine-day event inside one of its weeks, a finished one-shot.
function yearLong(extra) {
  const schedule = [];
  for (let w = 0; w < 52; w++) {
    const start = new RealDate(RealDate.UTC(2026, 0, 6 + 7 * w, 0, 0, 0));
    const end = new RealDate(start.getTime() + 7 * 24 * 3600000);
    schedule.push({ region: 'R' + w, regionName: 'State ' + w, start: start.toISOString(), end: end.toISOString() });
  }
  return { id: 'yearlong', name: 'Year-long', schedule, ...extra };
}
function nineDay(extra) {
  return {
    id: 'nineday', name: 'Nine days',
    schedule: [{ region: 'ALL', regionName: 'Nine days', start: '2026-09-12T00:01:00Z', end: '2026-09-20T23:59:59Z' }],
    ...extra,
  };
}
function finished(extra) {
  return {
    id: 'finished', name: 'Finished',
    schedule: [{ region: 'ALL', regionName: 'Finished', start: '2026-07-11T12:00:00Z', end: '2026-07-12T12:00:00Z' }],
    ...extra,
  };
}

const MID = '2026-09-15T12:00:00Z'; // both the year-long and the nine-day event are live

console.log('pickBannerEvent — which event owns the banner:');
{
  let p = pickAt(MID, [yearLong(), finished(), nineDay()]);
  check(p && p.ev.id === 'nineday' && !p.isUpcoming, 'the shortest LIVE event wins, not the first in feed order');
  check(p && p.entries.length === 1 && p.entries[0].region === 'ALL', 'its live entries ride along');

  p = pickAt(MID, [yearLong({ optedIn: true }), nineDay()]);
  check(p && p.ev.id === 'nineday', 'a short untracked event still outranks a tracked year-long one (that is the discovery the banner is for)');

  p = pickAt(MID, [yearLong(), nineDay({ dismissed: true })]);
  check(p && p.ev.id === 'yearlong', 'a dismissed, untracked event is skipped — the next candidate takes the banner instead of it going dark');

  p = pickAt(MID, [yearLong(), nineDay({ dismissed: true, optedIn: true })]);
  check(p && p.ev.id === 'nineday', 'dismissed but tracked keeps the banner (progress is still shown)');

  p = pickAt(MID, [yearLong(), nineDay({ snoozeUntil: new RealDate('2026-09-16T00:00:00Z').getTime() })]);
  check(p && p.ev.id === 'yearlong', 'a snoozed event is skipped until the snooze expires');

  p = pickAt(MID, [yearLong(), nineDay({ snoozeUntil: new RealDate('2026-09-14T00:00:00Z').getTime() })]);
  check(p && p.ev.id === 'nineday', 'an expired snooze no longer hides it');

  p = pickAt(MID, [yearLong({ dismissed: true }), nineDay({ dismissed: true })]);
  check(p === null, 'every candidate dismissed → no banner');

  // Two nine-day events at once: same span → feed order breaks the tie.
  const other = { ...nineDay(), id: 'nineday-b', name: 'Other nine days' };
  p = pickAt(MID, [other, nineDay()]);
  check(p && p.ev.id === 'nineday-b', 'equal spans keep feed order');

  // A year-long event's cohort entries are returned as the ARRAY of concurrent states.
  const twoStates = yearLong();
  twoStates.schedule.push({ ...twoStates.schedule[36], region: 'X', regionName: 'Second state' });
  p = pickAt(MID, [twoStates]);
  check(p && p.ev.id === 'yearlong' && p.entries.length === 2, 'concurrent cohort entries are all returned for the banner subject');
}

console.log('\npickBannerEvent — upcoming fallback:');
{
  // Nothing live: 2026-09-08 is before the nine-day event and between year-long cohorts? No —
  // the year-long event is live every week, so drop it for these cases.
  let p = pickAt('2026-09-08T12:00:00Z', [finished(), nineDay()]);
  check(p && p.ev.id === 'nineday' && p.isUpcoming, 'with nothing live, an event starting within 7 days is previewed');

  p = pickAt('2026-09-01T12:00:00Z', [finished(), nineDay()]);
  check(p === null, 'more than 7 days out is not previewed');

  const sooner = { id: 'sooner', name: 'Sooner', schedule: [{ region: 'ALL', regionName: 'Sooner', start: '2026-09-10T00:00:00Z', end: '2026-09-11T00:00:00Z' }] };
  p = pickAt('2026-09-08T12:00:00Z', [nineDay(), sooner]);
  check(p && p.ev.id === 'sooner', 'among upcoming events the earliest start wins regardless of feed order');

  p = pickAt('2026-09-13T12:00:00Z', [sooner, nineDay(), { id: 'next', name: 'Next', schedule: [{ region: 'ALL', regionName: 'Next', start: '2026-09-14T00:00:00Z', end: '2026-09-15T00:00:00Z' }] }]);
  check(p && p.ev.id === 'nineday' && !p.isUpcoming, 'a live event beats an upcoming one even when the upcoming one is listed later');

  p = pickAt('2026-09-08T12:00:00Z', [nineDay({ snoozeUntil: new RealDate('2026-09-12T00:01:00Z').getTime() })]);
  check(p === null, 'dismissing a countdown snoozes it until its start — no preview');
}

console.log('\n_contestsStatus — a one-shot whose window has passed:');
{
  const now = new RealDate('2026-09-12T15:00:00Z');
  const wrtc = { start: '2026-07-11T12:00:00Z', end: '2026-07-12T12:00:00Z' };
  let s = contestsStatus(wrtc, now);
  check(s.kind === 'ended' && s.label === 'ended', 'WRTC 2026 in September is "ended", not "starting soon"');
  s = contestsStatus({ start: '2026-09-12T00:01:00Z', end: '2026-09-21T00:00:00Z' }, now);
  check(s.kind === 'live', 'a contest inside its window is live');
  s = contestsStatus({ start: '2026-09-13T00:00:00Z', end: '2026-09-14T00:00:00Z' }, now);
  check(s.kind === 'imminent' && s.label === 'in 9h', 'hours away is imminent');
  s = contestsStatus({ start: '2026-09-20T00:00:00Z', end: '2026-09-21T00:00:00Z' }, now);
  check(s.kind === 'soon' && s.label === 'in 7d', 'days away is soon');
  s = contestsStatus({ whenRule: 'See sponsor' }, now);
  check(s.kind === 'unscheduled', 'no start date is unscheduled');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
