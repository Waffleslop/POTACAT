// Contest catalog date-rule resolution (lib/contests-db.js) — added for the
// POTA Support Your Parks fix (W7RTA 2026-07-14: the old single pota-plaque
// entry carried a stale monthly-first-weekend rule and showed Summer SYP on
// 2026-08-01 instead of Jul 18-19). Guards the resolver's nth-full-weekend
// math against POTA's published seasonal dates and pins the catalog shape.
// Run: node test/contests-db-test.js
'use strict';

const { resolveOccurrence, resolveStartForYear } = require('../lib/contests-db');
const catalog = require('../data/contests.json').contests;

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
function iso(d) { return d ? d.toISOString().slice(0, 10) : String(d); }

console.log('nth-weekend-of resolver (POTA published SYP dates):');
{
  // POTA's own schedule (docs.pota.app / W7RTA's report): 3rd FULL weekend.
  check(iso(resolveStartForYear('nth-weekend-of:7:3', 2026)) === '2026-07-18', 'Summer 2026 = Jul 18');
  check(iso(resolveStartForYear('nth-weekend-of:10:3', 2026)) === '2026-10-17', 'Autumn 2026 = Oct 17');
  check(iso(resolveStartForYear('nth-weekend-of:1:3', 2027)) === '2027-01-16', 'Winter 2027 = Jan 16');
  check(iso(resolveStartForYear('nth-weekend-of:4:3', 2027)) === '2027-04-17', 'Spring 2027 = Apr 17');
  // Full-weekend subtlety: Oct 2026 has 5 Saturdays but Sat Oct 31's Sunday
  // is Nov 1 — only 4 FULL weekends, so "last" must be Oct 24, not Oct 31.
  check(iso(resolveStartForYear('nth-weekend-of:10:-1', 2026)) === '2026-10-24',
    'last FULL weekend of Oct 2026 = Oct 24 (Sat Oct 31 excluded — its Sunday is in November)');
  check(resolveStartForYear('nth-weekend-of:10:5', 2026) === null, '5th full weekend of Oct 2026 does not exist');
}

console.log('catalog shape (pota-plaque replaced by four seasonal entries):');
{
  check(!catalog.find(c => c.id === 'pota-plaque'), 'stale pota-plaque entry is gone');
  const syp = catalog.filter(c => c.id.startsWith('pota-syp-'));
  check(syp.length === 4, 'exactly four pota-syp-* entries');
  const rules = Object.fromEntries(syp.map(c => [c.id, c.whenComputed]));
  check(rules['pota-syp-winter'] === 'nth-weekend-of:1:3', 'winter rule');
  check(rules['pota-syp-spring'] === 'nth-weekend-of:4:3', 'spring rule');
  check(rules['pota-syp-summer'] === 'nth-weekend-of:7:3', 'summer rule');
  check(rules['pota-syp-autumn'] === 'nth-weekend-of:10:3', 'autumn rule');
  check(syp.every(c => c.durationHours === 48 && c.category === 'pota-sota'),
    'all four: 48h duration (Sat 0000Z through Sunday UTC), pota-sota category');
}

console.log('resolveOccurrence from the report date (now = 2026-07-14):');
{
  const now = new Date('2026-07-14T00:00:00Z');
  const get = (id) => catalog.find(c => c.id === id);
  const summer = resolveOccurrence(get('pota-syp-summer'), now);
  check(iso(summer.start) === '2026-07-18' && summer.end.toISOString() === '2026-07-20T00:00:00.000Z',
    `summer resolves to Jul 18 (covers Sun) — was 2026-08-01 in the bug (got ${iso(summer.start)})`);
  check(iso(resolveOccurrence(get('pota-syp-autumn'), now).start) === '2026-10-17', 'autumn → Oct 17 2026');
  // Winter/Spring 2026 already passed — resolver must roll to 2027.
  check(iso(resolveOccurrence(get('pota-syp-winter'), now).start) === '2027-01-16', 'winter rolls over → Jan 16 2027');
  check(iso(resolveOccurrence(get('pota-syp-spring'), now).start) === '2027-04-17', 'spring rolls over → Apr 17 2027');
  // Mid-event: Saturday afternoon of the summer weekend must read as running.
  const during = resolveOccurrence(get('pota-syp-summer'), new Date('2026-07-18T18:00:00Z'));
  check(iso(during.start) === '2026-07-18', 'mid-weekend query still resolves the LIVE occurrence');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
