// Watchlist-group resolution + FT8 decode matching (lib/watchlist-groups.js).
// Contract shared with ECHOCAT mobile — spec of record:
// potacat-app docs/desktop-asks/ft8-watchlist-stroke-parity.md.
// Run: node test/watchlist-groups-test.js
'use strict';

const assert = require('assert');
const { parseCallsignList, buildGroupLookup, matchDecode } = require('../lib/watchlist-groups');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}

console.log('parseCallsignList:');
{
  check(parseCallsignList('k3sbp, W1AW;n3vd\ng5how').join(',') === 'K3SBP,W1AW,N3VD,G5HOW', 'mixed separators, uppercased');
  check(parseCallsignList('K3SBP:20m:cw').join(',') === 'K3SBP', 'legacy :qualifiers stripped');
  check(parseCallsignList('').length === 0 && parseCallsignList(null).length === 0, 'empty/null → []');
}

console.log('buildGroupLookup (resolution contract):');
{
  const groups = [
    { color: '#f00', emoji: '🔴', callsigns: 'K3SBP, W1AW', remoteEntries: [
      { call: 'W1AW', emoji: '📻' },   // also manual in SAME group — manual wins (group emoji)
      { call: 'N3VD', emoji: '🌪️' },  // per-call PoLo emoji wins over group fallback
      { call: 'K0NR' },                // no per-call emoji → group fallback
    ] },
    { color: '#00f', emoji: '🔵', callsigns: 'K3SBP, G5HOW', remoteEntries: [] }, // K3SBP dupe — group 0 wins
    null, // missing group tolerated
  ];
  const lu = buildGroupLookup(groups);
  check(lu.get('K3SBP').idx === 0, 'lower group index wins across groups');
  check(lu.get('W1AW').emoji === '🔴', 'manual beats remote within a group (group emoji, not per-call)');
  check(lu.get('N3VD').emoji === '🌪️', 'per-call PoLo emoji beats group fallback');
  check(lu.get('K0NR').emoji === '🔴', 'remote entry without emoji → group fallback');
  check(lu.get('G5HOW').idx === 1, 'group 1 entries resolve');
  check(buildGroupLookup(null).size === 0 && buildGroupLookup([]).size === 0, 'null/empty groups → empty map');
}

console.log('matchDecode (spec match rules):');
{
  const lu = buildGroupLookup([{ color: '#f00', emoji: '⭐', callsigns: 'W1FRIEND, K1A', remoteEntries: [] }]);
  check(matchDecode(lu, 'W1FRIEND', 'CQ W1FRIEND FN20').idx === 0, 'rule 1: transmitting call exact hit');
  check(matchDecode(lu, 'K4XYZ', 'K4XYZ W1FRIEND FN20').idx === 0, 'rule 2: watched friend BEING CALLED lights up');
  check(matchDecode(lu, 'K4XYZ', 'K4XYZ <W1FRIEND> R-07').idx === 0, 'rule 2: <> stripped from nonstandard-call tokens');
  check(matchDecode(lu, 'k4xyz', 'k4xyz w1friend fn20') !== null, 'case-insensitive');
  check(matchDecode(lu, 'K1ABC', 'CQ K1ABC FN42') === null, 'NO substring: K1A on the list never lights K1ABC');
  check(matchDecode(lu, 'K1A', 'CQ K1A FN42').idx === 0, 'exact K1A still matches K1A');
  check(matchDecode(lu, null, 'CQ DX K9XYZ EM69') === null, 'no match → null');
  check(matchDecode(null, 'W1FRIEND', 'x') === null && matchDecode(new Map(), 'W1FRIEND', 'x') === null, 'null/empty lookup → null');
  check(matchDecode(lu, 'W1FRIEND', 'CQ W1FRIEND FN20').emoji === '⭐', 'match carries the emoji');
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, 'watchlist-groups tests failed');
