#!/usr/bin/env node
'use strict';
// Hunt "Same as Call" with the Call dropdown set to a US state.
// Until 2026-11-26 a state target never matched any decode (renderer/cq-target.js
// "no reliable per-decode match in v1"), so Hunt with a state set silently
// answered nobody. A state now matches from decode.state, the grid-based state
// main already sets for "States I need" (lib/grid-state.js): a grid wholly in the
// state, or a straddling grid QRZ settles to it. A straddle QRZ did not settle,
// a QRZ-only state, or no grid never matches, so Hunt never answers a guess.
// The continent, country and program targets are unchanged.
// Run: node test/hunt-chase-state-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const ROOT = path.join(__dirname, '..');
const CqTarget = require('../renderer/cq-target');
const GS = require('../lib/grid-state');
const { matchesHuntFilter } = require('../lib/jtcat-state-machine');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const HOME = { homeContinent: 'NA' };

// Build a decode the way main does: entity from cty.dat, grid from the CQ,
// state from GridState.stateForDecode (QRZ's cached state when there is one),
// then chaseMatch from CqTarget.matchesDecode. Returns whether Hunt (mode
// 'chase') answers it.
function decode(text, entity, opts) {
  const o = opts || {};
  const parts = text.trim().split(/\s+/);
  const last = parts[parts.length - 1];
  const grid = /^[A-R]{2}\d{2}$/.test(last) ? last : '';
  const d = { text, entity, continent: o.continent || 'NA', grid };
  const st = GS.stateForDecode({ grid, qrzState: o.qrzState, entity });
  if (st) d.state = st;
  return d;
}
function huntAnswers(target, d, helpers) {
  const chaseMatch = CqTarget.matchesDecode(target, d, helpers || HOME);
  return matchesHuntFilter(d.text, 'chase', { chaseMatch: !target || !!chaseMatch });
}

console.log('Same as Call: US state target');

test('a grid wholly inside the state: Hunt answers', () => {
  // EM12 is entirely Texas (test/grid-state-test.js).
  assert.strictEqual(huntAnswers('TX', decode('CQ W5ABC EM12', 'United States')), true);
});

test('a grid in another state: Hunt does not answer', () => {
  assert.strictEqual(huntAnswers('FL', decode('CQ W5ABC EM12', 'United States')), false);
});

test('a straddling grid QRZ did not settle: Hunt does not answer (a guess)', () => {
  // FN20 straddles NJ, PA and NY.
  const d = decode('CQ W2ABC FN20', 'United States');
  assert.ok(d.state && d.state.candidates.length > 1, 'FN20 straddles');
  assert.strictEqual(huntAnswers('NJ', d), false);
  assert.strictEqual(huntAnswers('PA', d), false);
});

test('a straddling grid QRZ settles to the state: Hunt answers; to another state: not', () => {
  const d = decode('CQ W2ABC FN20', 'United States', { qrzState: 'NJ' });
  assert.strictEqual(huntAnswers('NJ', d), true);
  assert.strictEqual(huntAnswers('PA', d), false);
});

test('QRZ alone (no grid in the CQ): Hunt does not answer', () => {
  const d = decode('CQ W2ABC', 'United States', { qrzState: 'NJ' });
  assert.strictEqual(d.state && d.state.source, 'qrz');
  assert.strictEqual(huntAnswers('NJ', d), false);
});

test('no state at all (no grid, no QRZ): Hunt does not answer', () => {
  assert.strictEqual(huntAnswers('NJ', decode('CQ W2ABC', 'United States')), false);
});

test('a Canadian station in a border grid is never a US state', () => {
  // CN88: a VE call there is in BC, a W call is in WA.
  assert.strictEqual(huntAnswers('WA', decode('CQ VE7ABC CN88', 'Canada')), false);
  assert.strictEqual(huntAnswers('WA', decode('CQ W7ABC CN88', 'United States')), true);
});

test('a non-US station is never a US state', () => {
  assert.strictEqual(huntAnswers('TX', decode('CQ JA1ABC PM95', 'Japan', { continent: 'AS' })), false);
});

test('Alaska and Hawaii match their own state', () => {
  assert.strictEqual(huntAnswers('AK', decode('CQ KL7ABC BP51', 'Alaska')), true);
  assert.strictEqual(huntAnswers('HI', decode('CQ KH6ABC BL11', 'Hawaii')), true);
});

test('a state target never answers a non-CQ, even from that state', () => {
  const d = decode('K3SBP W5ABC EM12', 'United States');
  assert.strictEqual(huntAnswers('TX', d), false);
});

test('a lowercase state target works the same', () => {
  assert.strictEqual(huntAnswers('tx', decode('CQ W5ABC EM12', 'United States')), true);
});

console.log('Same as Call: other targets unchanged');

test('continent: EU answers EU, not NA', () => {
  assert.strictEqual(huntAnswers('EU', decode('CQ DL1ABC JO62', 'Fed. Rep. of Germany', { continent: 'EU' })), true);
  assert.strictEqual(huntAnswers('EU', decode('CQ W5ABC EM12', 'United States')), false);
});

test('DX: another continent answers, home continent does not', () => {
  assert.strictEqual(huntAnswers('DX', decode('CQ DL1ABC JO62', 'Fed. Rep. of Germany', { continent: 'EU' })), true);
  assert.strictEqual(huntAnswers('DX', decode('CQ W5ABC EM12', 'United States')), false);
});

test('country prefix: JA answers Japan, not a US station', () => {
  const h = { homeContinent: 'NA', targetEntityName: 'Japan' };
  assert.strictEqual(huntAnswers('JA', decode('CQ JA1ABC PM95', 'Japan', { continent: 'AS' }), h), true);
  assert.strictEqual(huntAnswers('JA', decode('CQ W5ABC EM12', 'United States'), h), false);
});

test('program: POTA answers CQ POTA only, whatever the station state', () => {
  assert.strictEqual(huntAnswers('POTA', decode('CQ POTA W5ABC EM12', 'United States')), true);
  assert.strictEqual(huntAnswers('POTA', decode('CQ W5ABC EM12', 'United States')), false);
  assert.strictEqual(huntAnswers('TEST', decode('CQ TEST W5ABC EM12', 'United States')), true);
});

test('Call set to everyone: Same as Call answers any CQ', () => {
  assert.strictEqual(huntAnswers('', decode('CQ W2ABC FN20', 'United States')), true);
});

console.log('Wiring');

test('main sets decode.state before chaseMatch in both decode paths', () => {
  const src = readSrc(path.join(ROOT, 'main.js'));
  const re = /workedOverlayEnrichDecode\(r,[^\n]*\n[\s\S]{0,1200}?r\.chaseMatch = CqTarget\.matchesDecode\(/g;
  const hits = src.match(re) || [];
  assert.strictEqual(hits.length, 2, 'single-slice and multi-slice paths enrich the state first');
});

test('the Same as Call tooltip says how a state matches, in the window and ECHOCAT Web', () => {
  const line = 'With Call set to a US state, only stations whose grid puts them in that state.';
  for (const f of ['renderer/jtcat-popout.html', 'renderer/remote.html']) {
    const src = readSrc(path.join(ROOT, f));
    const opt = (src.match(/<option value="chase"[^>]*>/) || [''])[0];
    assert.ok(opt.includes(line), f + ' Same as Call option carries the state line');
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
