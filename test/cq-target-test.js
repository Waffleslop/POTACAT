// Tests for renderer/cq-target.js — the shared "Chase Target" module that
// drives the FT8 CQ tag and the incoming-decode highlight in both the JTCAT
// popout and the ECHOCAT phone. Pure (no DOM/Node deps; cty.dat lookups are
// injected), so we just require() it.
//
// Run: node test/cq-target-test.js
'use strict';

const CqTarget = require('../renderer/cq-target');

let passed = 0, failed = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log(`  ✗ FAIL: ${label} (got ${a}, expected ${e})`); }
}
function truthy(v, label) { eq(!!v, true, label); }
function falsy(v, label) { eq(!!v, false, label); }

console.log('=== normalizeTag / validateTag (protocol: ≤4 chars, UPPERCASE) ===');
eq(CqTarget.normalizeTag('fl'), 'FL', 'lowercase fl -> FL');
eq(CqTarget.normalizeTag(' po-ta '), 'POTA', 'strips spaces/punct');
eq(CqTarget.normalizeTag(null), '', 'null -> ""');
eq(CqTarget.validateTag('POTA'), { ok: true, tag: 'POTA', reason: '' }, 'POTA valid');
eq(CqTarget.validateTag(''), { ok: true, tag: '', reason: '' }, 'empty (none) valid');
eq(CqTarget.validateTag('fl').tag, 'FL', 'validate uppercases');
truthy(!CqTarget.validateTag('TOOLONG').ok, 'TOOLONG rejected (>4 chars)');
truthy(CqTarget.validateTag('TOOLONG').reason.length > 0, 'rejection carries a reason');
truthy(CqTarget.validateTag('TEST').ok, 'TEST (exactly 4) valid');

console.log('\n=== buildCqTxMsg (single CQ builder for popout/phone/auto) ===');
eq(CqTarget.buildCqTxMsg('K3SBP', 'FN30', 'POTA'), 'CQ POTA K3SBP FN30', 'POTA -> CQ POTA K3SBP FN30');
eq(CqTarget.buildCqTxMsg('K3SBP', 'FN30', ''), 'CQ K3SBP FN30', 'no tag -> bare CQ');
eq(CqTarget.buildCqTxMsg('K3SBP', 'FN30', 'pota'), 'CQ POTA K3SBP FN30', 'lowercase tag uppercased');
eq(CqTarget.buildCqTxMsg('K3SBP', 'FN30', 'TOOLONG'), 'CQ TOOL K3SBP FN30', 'over-long tag clamped to 4 (defense-in-depth)');

console.log('\n=== classifyTarget (collision ordering) ===');
eq(CqTarget.classifyTarget('').kind, 'none', '"" -> none');
eq(CqTarget.classifyTarget('EU').kind, 'continent', 'EU -> continent');
eq(CqTarget.classifyTarget('DX').kind, 'continent', 'DX -> continent (special)');
eq(CqTarget.classifyTarget('POTA').kind, 'program', 'POTA -> program (never dxcc)');
eq(CqTarget.classifyTarget('TEST').kind, 'contest', 'TEST -> contest');
eq(CqTarget.classifyTarget('FL').kind, 'usstate', 'FL -> usstate (USPS set)');
eq(CqTarget.classifyTarget('JA').kind, 'dxcc', 'JA -> dxcc prefix');
eq(CqTarget.classifyTarget('G').kind, 'dxcc', 'G -> dxcc prefix');

console.log('\n=== cqTagOf ===');
eq(CqTarget.cqTagOf('CQ POTA W1AW FN31'), 'POTA', 'extracts POTA tag');
eq(CqTarget.cqTagOf('CQ DX K3SBP FN20'), 'DX', 'extracts DX tag');
eq(CqTarget.cqTagOf('CQ K1ABC FN42'), '', 'plain CQ -> no tag');
eq(CqTarget.cqTagOf('K3SBP W1AW -12'), '', 'non-CQ -> no tag');

console.log('\n=== matchesDecode ===');
const JA = { name: 'Japan' };
const helpers = {
  homeContinent: 'NA',
  resolvePrefixEntity: (tag) => (tag === 'JA' ? JA : null),
};

// program
truthy(CqTarget.matchesDecode('POTA', { text: 'CQ POTA W1AW FN31' }, helpers), 'POTA matches a CQ POTA decode');
falsy(CqTarget.matchesDecode('POTA', { text: 'CQ K1ABC FN42' }, helpers), 'POTA does not match a plain CQ');

// continent
truthy(CqTarget.matchesDecode('EU', { continent: 'EU', entity: 'Italy' }, helpers), 'EU matches a EU decode');
falsy(CqTarget.matchesDecode('EU', { continent: 'NA', entity: 'United States' }, helpers), 'EU does not match a NA decode');
// DX = any non-home continent
truthy(CqTarget.matchesDecode('DX', { continent: 'EU' }, helpers), 'DX matches a non-home (EU) decode');
falsy(CqTarget.matchesDecode('DX', { continent: 'NA' }, helpers), 'DX does not match a home-continent (NA) decode');
falsy(CqTarget.matchesDecode('DX', { continent: 'EU' }, {}), 'DX with unknown home continent -> no match (safe)');

// dxcc prefix via injected resolver, and via precomputed name
truthy(CqTarget.matchesDecode('JA', { entity: 'Japan', call: 'JA1XYZ' }, helpers), 'JA matches a Japan-entity decode (resolver)');
falsy(CqTarget.matchesDecode('JA', { entity: 'United States', call: 'W1AW' }, helpers), 'JA does not match a US decode');
truthy(CqTarget.matchesDecode('JA', { entity: 'Japan' }, { targetEntityName: 'Japan' }), 'JA matches via precomputed targetEntityName');

// usstate — documented v1 no-op for incoming highlight
falsy(CqTarget.matchesDecode('FL', { entity: 'United States', grid: 'EL98' }, helpers), 'FL (US state) does not highlight in v1 (documented limitation)');

// none / guards
falsy(CqTarget.matchesDecode('', { text: 'CQ POTA W1AW' }, helpers), 'empty target never matches');
falsy(CqTarget.matchesDecode('EU', null, helpers), 'null decode -> no match');

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
