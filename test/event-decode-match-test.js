// Event ↔ FT8-decode classification (lib/event-decode-match.js) — the
// desktop half of the ft8-watchlist-stroke-parity GO decision. Semantics
// must mirror ECHOCAT mobile's eventSpotStatusOf + eventSlots.ts exactly
// (the phone treats a published eventMatch as authoritative).
// Run: node test/event-decode-match-test.js
'use strict';

const assert = require('assert');
const { eventDecodeMatch, spotIsNewSlot } = require('../lib/event-decode-match');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}

// Synthetic 13 Colonies — same shape as the live events feed.
const THIRTEEN_C = {
  id: '13c-test', name: '13 Colonies', board: 'checklist',
  badge: '13C', badgeColor: '#1776cf',
  schedule: [{ region: 'ALL', start: '2026-07-01T13:00:00Z', end: '2026-07-08T04:00:00Z' }],
  tracking: { type: 'checklist', items: [
    { id: 'K2A', name: 'New York' }, { id: 'K2H', name: 'Massachusetts' }, { id: 'GB13COL', name: 'Bonus: England' },
  ] },
};
const REGIONS_EV = {
  id: 'was-test', board: 'regions', badge: 'WAS', callsignPatterns: ['W1AW/*'],
  schedule: [{ region: 'NY', start: '2026-07-01T00:00:00Z', end: '2026-07-08T00:00:00Z' }],
};
const IN_WINDOW = new Date('2026-07-06T18:00:00Z');
const AFTER = new Date('2026-07-20T00:00:00Z');

function states(progress) { return { '13c-test': { optedIn: true, progress: progress || {} }, 'was-test': { optedIn: true, progress: {} } }; }
const EVENTS = [REGIONS_EV, THIRTEEN_C];

console.log('classification:');
{
  const m = eventDecodeMatch(EVENTS, states(), 'K2A', '20m', 'FT8', IN_WINDOW);
  check(!!m && m.status === 'needed' && m.badge === '13C' && m.badgeColor === '#1776cf' && m.id === '13c-test',
    'unworked tracked station → needed, carries badge + color');
  const worked = states({ K2A: { call: 'K2A', band: '20m', mode: 'FT8' } });
  check(eventDecodeMatch(EVENTS, worked, 'K2A', '20m', 'FT8', IN_WINDOW).status === 'worked',
    'same band+mode already worked → worked');
  check(eventDecodeMatch(EVENTS, worked, 'K2A', '40m', 'FT8', IN_WINDOW).status === 'new-slot',
    'different band → new-slot');
  const ssbWorked = states({ K2A: { call: 'K2A', band: '20m', mode: 'SSB' } });
  check(eventDecodeMatch(EVENTS, ssbWorked, 'K2A', '20m', 'FT8', IN_WINDOW).status === 'new-slot',
    'worked on SSB, decoding FT8 → new-slot (mode differs)');
}

console.log('matching + gating:');
{
  check(eventDecodeMatch(EVENTS, states(), 'K2A/P', '20m', 'FT8', IN_WINDOW) !== null, 'portable suffix K2A/P matches');
  check(eventDecodeMatch(EVENTS, states(), 'K2AB', '20m', 'FT8', IN_WINDOW) === null, 'K2AB is NOT K2A (no prefix bleed)');
  check(eventDecodeMatch(EVENTS, states(), 'GB13COL', '20m', 'FT8', IN_WINDOW).status === 'needed', 'bonus station matches');
  check(eventDecodeMatch(EVENTS, states(), 'K2A', '20m', 'FT8', AFTER) === null, 'outside schedule window → null');
  const notOpted = { '13c-test': { optedIn: false, progress: {} } };
  check(eventDecodeMatch(EVENTS, notOpted, 'K2A', '20m', 'FT8', IN_WINDOW) === null, 'not opted in → null');
  check(eventDecodeMatch(EVENTS, states(), 'W1AW/4', '20m', 'FT8', IN_WINDOW) === null, 'regions boards never classify (checklist only)');
  check(eventDecodeMatch(null, states(), 'K2A', '20m', 'FT8', IN_WINDOW) === null, 'null events → null');
  check(eventDecodeMatch(EVENTS, null, 'K2A', '20m', 'FT8', IN_WINDOW) === null, 'null states → null');
}

console.log('slot semantics (mirrors mobile eventSlots.ts):');
{
  check(spotIsNewSlot({ band: '20M', mode: 'usb' }, '20m', 'SSB') === false, 'band case-fold + USB→SSB fold cover');
  check(spotIsNewSlot({ band: '20m', mode: 'CW-R' }, '20m', 'CW') === false, 'CW-R folds to CW');
  check(spotIsNewSlot({}, '20m', 'FT8') === false, 'manual tick (no band/mode) covers everything — never re-alerts');
  check(spotIsNewSlot({ band: '20m', mode: 'SSB' }, '', '') === false, 'decode missing band+mode → conservative worked');
  // Future slots-array contract (13colonies-progress-slots): read when present.
  const multi = { band: '20m', mode: 'SSB', slots: [{ band: '20m', mode: 'SSB' }, { band: '40m', mode: 'FT8' }] };
  check(spotIsNewSlot(multi, '40m', 'FT8') === false, 'slots[] read when present — 40m FT8 covered');
  check(spotIsNewSlot(multi, '40m', 'CW') === true, 'slots[] — 40m CW still a new slot');
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, 'event-decode-match tests failed');
