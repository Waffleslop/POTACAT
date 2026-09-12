// lib/event-geo.js — event stations are placed at their event city, never
// at the call-area centroid or the trustee's QRZ address; rovers never.
// Run: node test/event-geo-test.js
const assert = require('assert');
const { eventStationGeo } = require('../lib/event-geo');
const { loadBuiltinEvents } = require('../scripts/validate-events');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.error(`  FAIL ${label}`); }
}

const events = loadBuiltinEvents().events;
const during = { now: new Date('2026-09-15T12:00:00Z') };

console.log('Route 66 stations during the event:');
{
  const g = eventStationGeo(events, 'W6K', during);
  check(g && g.eventId === 'route66-2026' && g.itemId === 'W6K', 'W6K resolves to route66-2026 / W6K');
  check(g && g.lat === 35.47 && g.lon === -97.52, 'W6K is placed at Oklahoma City, not the W6 call-area centroid');
  check(g && g.locationDesc === 'Oklahoma City, OK (Route 66 On The Air)', 'locationDesc names the city and the event');
  check(eventStationGeo(events, 'w6k/m66', during).itemId === 'W6K', 'lower-case mobile W6K/M66 still places at Oklahoma City');
  check(eventStationGeo(events, 'W6KA', during) === null, 'W6KA is a real California call — untouched');
  check(eventStationGeo(events, 'W6U', during) === null, 'W6U is not a station this year');
  check(eventStationGeo(events, 'W6Z', during) === null, 'a rover has no coordinates — never placed, never invented');
}

console.log('Window and grace:');
{
  check(eventStationGeo(events, 'W6K', { now: new Date('2026-09-11T20:00:00Z') }) !== null,
    'the evening before the 0001z opening is inside the 24 h grace');
  check(eventStationGeo(events, 'W6K', { now: new Date('2026-09-10T20:00:00Z') }) === null,
    'two days before is not');
  check(eventStationGeo(events, 'W6K', { now: new Date('2026-09-21T12:00:00Z') }) !== null,
    'the day after the close is inside the grace');
  check(eventStationGeo(events, 'W6K', { now: new Date('2026-09-23T00:00:00Z') }) === null,
    'two days after the close is not — W6K goes back to being a W6 call');
  check(eventStationGeo(events, 'W6K', { now: new Date('2026-09-10T20:00:00Z'), graceMs: 3 * 86400000 }) !== null,
    'graceMs is honoured');
}

console.log('Other boards and bad input:');
{
  const regions = [{ id: 'x', board: 'regions', schedule: [{ start: '2026-09-01T00:00:00Z', end: '2026-09-30T00:00:00Z' }],
    callsignPatterns: ['W1AW/*'], tracking: { items: [{ id: 'W1AW', lat: 41, lon: -72 }] } }];
  check(eventStationGeo(regions, 'W1AW', during) === null, 'a regions board never places (its stations move by state)');
  check(eventStationGeo([], 'W6K', during) === null, 'empty catalog -> null');
  check(eventStationGeo(events, '', during) === null, 'empty call -> null');
  check(eventStationGeo(null, 'W6K', during) === null, 'no catalog -> null');
  const half = [{ id: 'h', board: 'checklist', schedule: [{ start: '2026-09-01T00:00:00Z', end: '2026-09-30T00:00:00Z' }],
    tracking: { items: [{ id: 'W6K', name: 'x', lat: 35.47 }] } }];
  check(eventStationGeo(half, 'W6K', during) === null, 'a half-present lat/lon is not a place');
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, 'event-geo tests failed');
