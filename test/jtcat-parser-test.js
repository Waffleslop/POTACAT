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

section('isStandardCall — c28 basecall shape (mirrors pack_basecall in message.c)');
// 1x1/2x1 special-event calls ARE standard; slash/displaced-digit calls are not.
[
  ['K3SBP', true], ['W1A', true], ['K2A', true], ['N4C', true], ['W1AW', true],
  ['3G0Z', true], ['VE3ABC', true], ['K3SBP/P', true], ['K1ABC/R', true],
  ['3DA0XYZ', true], ['3XA0YZ', true], ['<W1ABC>', true],
  ['GB13COL', false], ['TM13COL', false], ['YW18FIFA', false], ['LC0LEWIS', false],
  ['PJ4/K1ABC', false], ['K3SBP/7', false], ['DL/K3SBP', false], ['W1AW/4', false],
  ['<GB13COL>', false], ['<...>', false], ['', false], [null, false],
].forEach(function (c) {
  eq(P.isStandardCall(c[0]), c[1], 'isStandardCall(' + JSON.stringify(c[0]) + ') = ' + c[1]);
});

section('formatDirectedMsg — WSJT-X bracket rules for nonstandard calls');
eq(P.formatDirectedMsg('W1ABC', 'K3SBP', '-08'), 'W1ABC K3SBP -08', 'both standard: plain');
eq(P.formatDirectedMsg('W1ABC', 'K3SBP', 'RR73'), 'W1ABC K3SBP RR73', 'both standard ack: plain');
eq(P.formatDirectedMsg('W1ABC', 'K3SBP', 'FN20'), 'W1ABC K3SBP FN20', 'both standard grid kept');
eq(P.formatDirectedMsg('GB13COL', 'K3SBP', '-08'), '<GB13COL> K3SBP -08', 'report leg hashes nonstd call');
eq(P.formatDirectedMsg('GB13COL', 'K3SBP', 'R-08'), '<GB13COL> K3SBP R-08', 'R-report leg hashes nonstd call');
eq(P.formatDirectedMsg('GB13COL', 'K3SBP', 'RR73'), 'GB13COL <K3SBP> RR73', 'ack leg = type 4, nonstd call in full');
eq(P.formatDirectedMsg('GB13COL', 'K3SBP', '73'), 'GB13COL <K3SBP> 73', '73 leg = type 4');
eq(P.formatDirectedMsg('GB13COL', 'K3SBP', 'FN20'), '<GB13COL> K3SBP', 'grid DROPPED in nonstandard QSO');
eq(P.formatDirectedMsg('GB13COL', 'K3SBP', ''), '<GB13COL> K3SBP', 'bare Tx1 to nonstd call');
eq(P.formatDirectedMsg('W1ABC', 'PJ4/K1ABC', '-08'), 'W1ABC <PJ4/K1ABC> -08', 'MY nonstd call hashed on report leg');
eq(P.formatDirectedMsg('W1ABC', 'PJ4/K1ABC', '73'), '<W1ABC> PJ4/K1ABC 73', 'MY nonstd call in full on ack leg');
eq(P.formatDirectedMsg('W1ABC', 'PJ4/K1ABC', 'FN20'), 'W1ABC <PJ4/K1ABC>', 'grid dropped when MY call nonstd');
eq(P.formatDirectedMsg('GB13COL', 'PJ4/K1ABC', '73'), null, 'both nonstandard: refused (WSJT-X rule)');
eq(P.formatDirectedMsg('<GB13COL>', 'K3SBP', 'RR73'), 'GB13COL <K3SBP> RR73', 'pre-bracketed input normalized');

section('inferReplyStep — hash-bracketed partner calls');
eq(step('K3SBP <GB13COL> -05', ME), { step: 'send-r-report', call: 'GB13COL' }, 'bracketed report -> R+report, call unbracketed');
eq(step('K3SBP <GB13COL> RR73', ME), { step: 'send-73', call: 'GB13COL' }, 'bracketed RR73 -> 73');
eq(step('K3SBP <...> -05', ME), null, 'unresolved <...> -> not actionable');
eq(step('W4XYZ <PJ4/K1ABC> 73', ME), { step: 'reply-cq', call: 'PJ4/K1ABC' }, 'bracketed tail-end FROM unwrapped');
eq(step('CQ GB13COL', ME), { step: 'reply-cq', call: 'GB13COL' }, 'nonstandard type-4 CQ (no grid) -> reply-cq');

section('inferReplyStep — empty/unknown my-call (main re-derives authoritatively)');
// Without a callsign the classifier cannot know K3SBP is "me", so it falls to
// tail-end. In production main.js always passes the configured callsign, so
// this degenerate case never drives a real reply — documented, not desired.
eq(step('K3SBP W1ABC FN42', ''), { step: 'reply-cq', call: 'W1ABC' }, 'no my-call -> tail-end (main supplies the real call)');

// ---------------------------------------------------------------------
section('classifySpotTargetTrigger — Spot Target fire policy (CQ or QSO-end only)');
function trig(text, target) {
  const r = P.classifySpotTargetTrigger(text, target, ME);
  return r ? { trigger: r.trigger, call: r.call } : null;
}
// CQ triggers
eq(trig('CQ W1ABC FN42', 'W1ABC'), { trigger: 'cq', call: 'W1ABC' }, 'plain CQ fires');
eq(trig('CQ POTA W1ABC FN42', 'W1ABC'), { trigger: 'cq', call: 'W1ABC' }, 'program-modifier CQ fires');
eq(trig('CQ NA W1ABC', 'W1ABC'), { trigger: 'cq', call: 'W1ABC' }, 'directed CQ, no grid, fires');
eq(trig('CQ K2XYZ FN31', 'W1ABC'), null, 'someone else\'s CQ does not fire');
// Tail-end triggers (target SENDS RR73/RRR/73 to a third station)
eq(trig('K2XYZ W1ABC RR73', 'W1ABC'), { trigger: 'tail', call: 'W1ABC' }, 'their RR73 to another fires');
eq(trig('K2XYZ W1ABC RRR', 'W1ABC'), { trigger: 'tail', call: 'W1ABC' }, 'their RRR to another fires');
eq(trig('K2XYZ W1ABC 73', 'W1ABC'), { trigger: 'tail', call: 'W1ABC' }, 'their 73 to another fires');
// Mid-QSO exchanges must NOT auto-trigger (they only reveal parity)
eq(trig('K2XYZ W1ABC -10', 'W1ABC'), null, 'their report leg does not fire');
eq(trig('K2XYZ W1ABC R-08', 'W1ABC'), null, 'their R-report leg does not fire');
eq(trig('K2XYZ W1ABC FN42', 'W1ABC'), null, 'their grid leg does not fire');
eq(trig('K2XYZ W1ABC', 'W1ABC'), null, 'bare two-call does not fire');
// Direction matters: target as ADDRESSEE means someone ELSE sent it
eq(trig('W1ABC K2XYZ RR73', 'W1ABC'), null, 'RR73 sent TO the target does not fire');
// Addressed to us = direct-caller machinery\'s case, not the spot target
eq(trig('K3SBP W1ABC RR73', 'W1ABC'), null, 'their RR73 addressed to US does not fire here');
// Identity robustness: portable/hashed on-air renderings of the spot call
eq(trig('CQ W1ABC/P FN42', 'W1ABC'), { trigger: 'cq', call: 'W1ABC/P' }, 'portable CQ matches, returns as-transmitted call');
eq(trig('K2XYZ <W1ABC> RR73', 'W1ABC'), { trigger: 'tail', call: 'W1ABC' }, 'hash-bracketed tail matches, brackets stripped');
eq(trig('K2XYZ W9ZZZ RR73', 'W1ABC'), null, 'unrelated tail does not fire');
eq(trig('', 'W1ABC'), null, 'empty text');
eq(trig('CQ W1ABC FN42', ''), null, 'empty target');
// Handoff contract: a firing decode must drive the reply handler to reply-cq
// (the watcher passes the raw text; main re-derives the step from it).
eq(step('CQ W1ABC FN42', ME), { step: 'reply-cq', call: 'W1ABC' }, 'CQ fire text -> inferReplyStep reply-cq');
eq(step('K2XYZ W1ABC RR73', ME), { step: 'reply-cq', call: 'W1ABC' }, 'tail fire text -> inferReplyStep reply-cq targeting sender');

// ---------------------------------------------------------------------
console.log('\n============================================================');
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('FAILURES PRESENT'); process.exit(1); }
console.log('All parser tests passed.');
