// BUILTIN_EVENTS (main.js) passes the same rules the website feed is held
// to (scripts/validate-events.js). The fallback is what a first-launch
// install sees before its first feed fetch — and what everyone sees when
// potacat.com is unreachable — so it must be as sound as the feed: exact
// patterns that all map to a checklist item, `total` = item count, dated
// windows that parse with start < end, coordinates in range, route numbers
// unique. Run: node test/events-catalog-test.js
const assert = require('assert');
const { validateEventsCatalog, loadBuiltinEvents } = require('../scripts/validate-events');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.error(`  FAIL ${label}`); }
}

console.log('BUILTIN_EVENTS validates:');
const builtin = loadBuiltinEvents();
const problems = validateEventsCatalog(builtin);
problems.forEach((p) => console.error(`       - ${p}`));
check(problems.length === 0, `no problems (${builtin.events.length} events)`);
check(builtin.events.some((e) => e.id === '13colonies-2026'), '13colonies-2026 present');
check(builtin.events.some((e) => e.id === 'route66-2026'), 'route66-2026 present');

console.log('The validator still catches the ways a definition rots:');
const clone = () => JSON.parse(JSON.stringify(builtin));
const r66 = (cat) => cat.events.find((e) => e.id === 'route66-2026');
{
  const c = clone(); r66(c).callsignPatterns[0] = 'W6*';
  check(validateEventsCatalog(c).length > 0, 'a W6* wildcard on a checklist event is refused');
}
{
  const c = clone(); r66(c).tracking.items.pop();
  check(validateEventsCatalog(c).length > 0, 'an item missing for a pattern (and total drift) is refused');
}
{
  const c = clone(); r66(c).tracking.items[0].lat = 141.88;
  check(validateEventsCatalog(c).length > 0, 'an out-of-range latitude is refused');
}
{
  const c = clone(); r66(c).tracking.items[1].route = 1;
  check(validateEventsCatalog(c).length > 0, 'a duplicated route number is refused');
}
{
  const c = clone(); r66(c).schedule[0].end = '2026-09-01T00:00:00Z';
  check(validateEventsCatalog(c).length > 0, 'end before start is refused');
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, 'events-catalog tests failed');
