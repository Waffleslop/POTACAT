#!/usr/bin/env node
'use strict';
/**
 * The Guest Pass transmit gate judges WHAT IS SENT, not the radio's mode
 * (artificialjump's friend, a Technician on NA4DQ's Guest Pass, Discord
 * 2026-10-29). FT8 on 28.074 MHz with the shack's radio left in USB was
 * refused: "Out of band: 28.074 MHz allows CW/digital only on tech
 * privileges". FT8 is digital and a Technician may send it there.
 * handleRemotePtt now carries the key-down's emission (DATA for FT8, SSTV,
 * Winlink) into gatedSetTransmit / gatedSmartSdrTransmit.
 *
 * Run: node test/guest-pass-emission-test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PassEnforcement } = require('../lib/pass-enforcement');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

function techPass() {
  const pe = new PassEnforcement({ revalidateMs: 0, log: () => {} });
  pe._state = 'active';
  pe._pass = { code: 'TEST', guest_callsign: 'KF0WWL', privilege_class: 'us_technician', privilege_class_short: 'tech', max_power_w: 25 };
  pe._expiresAtMs = Date.now() + 3600_000;
  pe._rigPowerReadable = () => true;
  return pe;
}

test('premise: judged as USB (the radio\'s mode), FT8 on 28.074 is refused to a Technician', () => {
  const r = techPass().interceptCatCommand({ type: 'tx_enable', freqHz: 28074000, mode: 'USB' });
  assert.strictEqual(r.allowed, false);
  assert.ok(/allows CW\/digital only on tech/.test(r.userVisible), r.userVisible);
});
test('judged as what is sent (DATA), it is allowed', () => {
  assert.strictEqual(techPass().interceptCatCommand({ type: 'tx_enable', freqHz: 28074000, mode: 'DATA', currentWatts: 20, powerAgeMs: 0 }).allowed, true);
});
test('the gate still refuses real phone where a Technician has none (USB on 28.074)', () => {
  assert.strictEqual(techPass().interceptCatCommand({ type: 'tx_enable', freqHz: 28074000, mode: 'USB' }).allowed, false);
});
test('and DATA outside every Technician HF segment is still refused (14.074)', () => {
  assert.strictEqual(techPass().interceptCatCommand({ type: 'tx_enable', freqHz: 14074000, mode: 'DATA' }).allowed, false);
});

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
test('handleRemotePtt hands its emission to both transmit gates', () => {
  const at = MAIN.indexOf('function handleRemotePtt(');
  const body = MAIN.slice(at, MAIN.indexOf('\n}\n', at));
  assert.ok(/const pttEmission = opts\.emission \|\| \(opts\.forceDataMode \? 'DATA' : null\);/.test(body));
  assert.ok(/gatedSmartSdrTransmit\(state, pttEmission\)/.test(body), 'Flex');
  assert.strictEqual((body.match(/gatedSetTransmit\(state, pttEmission\)/g) || []).length, 3, 'CAT (Flex fallback, Icom delay, plain)');
  assert.ok(!/gatedSetTransmit\(state\)/.test(body) && !/gatedSmartSdrTransmit\(state\)/.test(body), 'no key-down without the emission');
});
test('the gates check the emission first, the radio\'s mode only when none was given', () => {
  for (const fn of ['gatedSetTransmit', 'gatedSmartSdrTransmit']) {
    const at = MAIN.indexOf(`function ${fn}(state, emission)`);
    assert.ok(at > 0, fn);
    assert.ok(/mode: emission \|\| _currentMode/.test(MAIN.slice(at, at + 300)), fn);
  }
});

console.log(`\nGuest Pass emission: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
