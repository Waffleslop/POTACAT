#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
/**
 * #913: while a Guest Pass is live, the pass judges a key-down by the GUEST's
 * class; the owner's own Settings > Station class no longer refuses it too.
 * WC5T on a one-hour Extra pass, a General owner's Flex, 2026-11-22: the pass
 * allowed 7.021 MHz CW, then "[TX] Refused: 7.021 MHz CW is outside US
 * General privileges" from the owner's check. Paused or idle, the owner is
 * the operator again and the owner's class applies.
 *
 * Run: node test/guest-pass-owner-class-test.js
 */
const assert = require('assert');
const path = require('path');
const { PassEnforcement, passJudgesTx } = require('../lib/pass-enforcement');
const P = require('../lib/privileges');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('premise: the owner\'s General class refuses 7.021 MHz CW', () => {
  assert.ok(P.txPrivilegeRefusal({ freqHz: 7021000, mode: 'CW', licenseClass: 'us_general' }));
});
test('premise: an Extra pass allows 7.021 MHz CW', () => {
  const pe = new PassEnforcement({ revalidateMs: 0, log: () => {} });
  pe._state = 'active';
  pe._pass = { code: 'TEST', guest_callsign: 'WC5T', privilege_class: 'us_extra', privilege_class_short: 'extra', max_power_w: 100 };
  pe._expiresAtMs = Date.now() + 3600_000;
  pe._rigPowerReadable = () => true;
  assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', freqHz: 7021000, mode: 'CW', currentWatts: 50, powerAgeMs: 0 }).allowed, true);
});
test('the pass judges while active or expiring', () => {
  assert.strictEqual(passJudgesTx('active'), true);
  assert.strictEqual(passJudgesTx('expiring'), true);
});
test('paused, idle or ended: the owner\'s class applies', () => {
  for (const s of ['idle', 'paused', 'ended', 'validating', undefined, null]) assert.strictEqual(passJudgesTx(s), false, String(s));
});

const MAIN = readSrc(path.join(__dirname, '..', 'main.js')).replace(/\r\n/g, '\n');
const body = (name) => { const at = MAIN.indexOf(`function ${name}(`); assert.ok(at > 0, name); return MAIN.slice(at, MAIN.indexOf('\n}\n', at)); };

test('ownTxPrivilegeRefused steps aside for a live pass before judging the owner\'s class', () => {
  const b = body('ownTxPrivilegeRefused');
  const skip = b.indexOf('PassEnforcementLib.passJudgesTx(passEnforcement.getState())');
  assert.ok(skip > 0, 'the pass check');
  assert.ok(skip < b.indexOf('Privileges.txPrivilegeRefusal('), 'before the owner\'s class');
  assert.ok(/passJudgesTx\(passEnforcement\.getState\(\)\)\) return false;/.test(b), 'it allows (the pass judges), it never refuses');
});
test('every pass gate still judges the key-down by the pass', () => {
  for (const g of ['gatedSetTransmit', 'gatedSmartSdrTransmit', 'passTxAllowed']) {
    assert.ok(/passEnforcement\.interceptCatCommand\(\{ type: 'tx_enable'/.test(body(g)), g);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
