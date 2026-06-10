#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// Shared FT8 message-parser regression suite (renderer/jtcat-parser.js).
// Covers the bugs fixed 2026-06-10:
//   - non-standard CQ formats (directed / contest / event / numeric serial)
//   - "reply to my CQ -> grid instead of report" (incl. portable/hashed/empty)
//   - 6-char grids, tail-end targeting, callsign-shape discrimination
//
// Run:  node test/jtcat-parser-test.js
// =====================================================================

const P = require('../renderer/jtcat-parser');

let pass = 0, fail = 0;
function eq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; }
  else { fail++; console.log(`  ✗ ${msg}\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
function section(n) { console.log('\n=== ' + n + ' ==='); }

// Helper: classify text and return just the {step, call} we care about.
function step(text, me) {
  const r = P.inferReplyStep({ text }, me);
  return r ? { step: r.step, call: r.call } : null;
}
function cqCall(text) { return P.parseCq(text).call; }

const ME = 'K3SBP';

// ---------------------------------------------------------------------
section('looksLikeCallsign — discriminates calls from modifiers/grids/reports');
eq(P.looksLikeCallsign('W1ABC'), true, 'plain call');
eq(P.looksLikeCallsign('W1L'), true, '1x1 special-event call');
eq(P.looksLikeCallsign('LC0LEWIS'), true, 'long special-event call (5-char suffix)');
eq(P.looksLikeCallsign('W1ABC/P'), true, 'portable call');
eq(P.looksLikeCallsign('DL/W1ABC'), true, 'prefixed portable call');
eq(P.looksLikeCallsign('POTA'), false, 'POTA modifier (no digit)');
eq(P.looksLikeCallsign('DX'), false, 'DX modifier (too short / no digit)');
eq(P.looksLikeCallsign('NA'), false, 'NA directed modifier');
eq(P.looksLikeCallsign('TEST'), false, 'TEST contest modifier');
eq(P.looksLikeCallsign('075'), false, 'numeric serial (no letter)');
eq(P.looksLikeCallsign('FN42'), false, 'grid is not a call');
eq(P.looksLikeCallsign('FN42AA'), false, '6-char grid is not a call');
eq(P.looksLikeCallsign('-12'), false, 'signal report is not a call');
eq(P.looksLikeCallsign('R-12'), false, 'R-report is not a call');
eq(P.looksLikeCallsign('RR73'), false, 'RR73 is not a call');

// ---------------------------------------------------------------------
section('normalizeCall — base call for identity comparison');
eq(P.normalizeCall('K3SBP'), 'K3SBP', 'plain');
eq(P.normalizeCall('K3SBP/P'), 'K3SBP', 'strip /P suffix');
eq(P.normalizeCall('K3SBP/QRP'), 'K3SBP', 'strip /QRP suffix');
eq(P.normalizeCall('DL/K3SBP'), 'K3SBP', 'strip DL/ prefix');
eq(P.normalizeCall('<K3SBP>'), 'K3SBP', 'strip hash brackets');
eq(P.normalizeCall(''), '', 'empty');

// ---------------------------------------------------------------------
section('parseCq — standard formats (unchanged behavior)');
eq(cqCall('CQ W1ABC FN42'), 'W1ABC', 'CQ CALL GRID');
eq(cqCall('CQ W1ABC'), 'W1ABC', 'CQ CALL (no grid)');
eq(cqCall('CQ DX W1ABC FN42'), 'W1ABC', 'CQ DX CALL GRID');
eq(P.parseCq('CQ W1ABC FN42').grid, 'FN42', 'grid captured');

section('parseCq — the non-standard formats that used to mis-parse');
eq(cqCall('CQ NA W1ABC'), 'W1ABC', 'directed CQ, NO grid (was: NA)');
eq(cqCall('CQ EU W1ABC'), 'W1ABC', 'directed CQ EU, no grid (was: EU)');
eq(cqCall('CQ POTA W1AW'), 'W1AW', 'CQ POTA, no grid — IU7RAL (was: POTA)');
eq(cqCall('CQ SOTA W1ABC'), 'W1ABC', 'CQ SOTA, no grid (was: SOTA)');
eq(cqCall('CQ TEST K1ABC'), 'K1ABC', 'contest CQ, no grid (was: TEST)');
eq(cqCall('CQ TEST K1ABC FN42'), 'K1ABC', 'contest CQ with grid');
eq(cqCall('CQ FD W1ABC'), 'W1ABC', 'Field Day 2-letter modifier (was: FD)');
eq(cqCall('CQ 075 W1ABC FN42'), 'W1ABC', 'numeric serial/marathon (was: 075)');
eq(cqCall('CQ DX K1ABC FN42'), 'K1ABC', 'CQ DX with grid');
eq(cqCall('CQ W1L FN42'), 'W1L', '1x1 special-event call');
eq(cqCall('CQ LC0LEWIS FN42'), 'LC0LEWIS', 'long special-event call');
eq(cqCall('CQ POTA W1L'), 'W1L', 'modifier + 1x1 event call, no grid');

// ---------------------------------------------------------------------
section('inferReplyStep — reply to MY CQ yields a REPORT, not my grid');
eq(step('K3SBP W1ABC FN42', ME), { step: 'send-report', call: 'W1ABC' }, 'they answered my CQ w/ grid -> send-report (the Casey bug)');
eq(step('K3SBP/P W1ABC FN42', ME), { step: 'send-report', call: 'W1ABC' }, 'they answered my /P -> send-report (portable)');
eq(step('K3SBP W1ABC FN42', 'K3SBP/P'), { step: 'send-report', call: 'W1ABC' }, 'my settings call has /P -> still send-report');
eq(step('<K3SBP> W1ABC FN42', ME), { step: 'send-report', call: 'W1ABC' }, 'hashed my-call -> send-report');
eq(step('K3SBP W1ABC FN42AA', ME), { step: 'send-report', call: 'W1ABC' }, '6-char grid -> send-report (was: reply-cq/grid)');

section('inferReplyStep — full QSO ladder addressed to me');
eq(step('K3SBP W1ABC -05', ME), { step: 'send-r-report', call: 'W1ABC' }, 'their report -> R+report');
eq(step('K3SBP W1ABC R-05', ME), { step: 'send-rr73', call: 'W1ABC' }, 'their R-report -> RR73');
eq(step('K3SBP W1ABC RR73', ME), { step: 'send-73', call: 'W1ABC' }, 'RR73 -> 73');
eq(step('K3SBP W1ABC 73', ME), { step: 'send-73', call: 'W1ABC' }, '73 -> 73');
eq(step('K3SBP W1ABC RRR', ME), { step: 'send-73', call: 'W1ABC' }, 'RRR -> 73');

section('inferReplyStep — CQ + tail-end + null');
eq(step('CQ W1ABC FN42', ME), { step: 'reply-cq', call: 'W1ABC' }, 'CQ -> reply-cq');
eq(step('CQ NA W1ABC', ME), { step: 'reply-cq', call: 'W1ABC' }, 'directed grid-less CQ -> reply-cq W1ABC');
eq(step('CQ POTA W1AW', ME), { step: 'reply-cq', call: 'W1AW' }, 'CQ POTA grid-less -> reply-cq W1AW');
eq(step('W4XYZ NA7C 73', ME), { step: 'reply-cq', call: 'NA7C' }, 'third-party 73 -> tail-end FROM');
eq(step('K3ABC NA7C -12', ME), { step: 'reply-cq', call: 'NA7C' }, 'third-party mid-QSO -> tail-end FROM');
eq(step('', ME), null, 'empty -> null');
eq(step('XYZZY ABC', ME), null, 'garbage -> null');

section('inferReplyStep — empty/unknown my-call (main re-derives authoritatively)');
// Without a callsign the classifier cannot know K3SBP is "me", so it falls to
// tail-end. In production main.js always passes the configured callsign, so
// this degenerate case never drives a real reply — documented, not desired.
eq(step('K3SBP W1ABC FN42', ''), { step: 'reply-cq', call: 'W1ABC' }, 'no my-call -> tail-end (main supplies the real call)');

// ---------------------------------------------------------------------
console.log('\n============================================================');
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('FAILURES PRESENT'); process.exit(1); }
console.log('All parser tests passed.');
