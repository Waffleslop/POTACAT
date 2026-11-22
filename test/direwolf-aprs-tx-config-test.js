#!/usr/bin/env node
'use strict';
// APRS phase 7: the one Dire Wolf config that may key the radio for APRS, and
// only for the length of one manual beacon (lib/direwolf-process.js
// buildDirewolfAprsTxConfig). Its only PTT is POTACAT's rigctld shim, it
// carries channel-access timing per band, and it never beacons, digipeats or
// iGates on its own: the one frame comes from POTACAT over the AGW port.
// The listen-only 2 m and 30 m configs and the Winlink config stay byte for
// byte what they were (goldens).
// Run: node test/direwolf-aprs-tx-config-test.js

const assert = require('assert');
const D = require('../lib/direwolf-process');
const WINLINK_GOLDEN = require('./fixtures/aprs/direwolf-winlink-config-golden.json');
const APRS_2M_GOLDEN = require('./fixtures/aprs/direwolf-aprs-2m-config-golden.json');
const APRS_30M_GOLDEN = require('./fixtures/aprs/direwolf-aprs-30m-config-golden.json');
const APRS_TX_GOLDEN = require('./fixtures/aprs/direwolf-aprs-tx-config-golden.json');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

console.log('Dire Wolf APRS transmit config (one manual beacon)');

const tx = (o) => D.buildDirewolfAprsTxConfig({ mycall: 'k3sbp', audioPort: 50200, agwPort: 8014, shimPort: 4551, band: '2m', txDelayMs: 500, txTailMs: 200, ...(o || {}) });
const lines = (s) => s.split('\n');

test('the transmit config exists and is a function of its own', () => {
  assert.strictEqual(typeof D.buildDirewolfAprsTxConfig, 'function');
});

test('golden: 2 m and 30 m transmit configs, byte for byte', () => {
  for (const g of APRS_TX_GOLDEN) assert.strictEqual(D.buildDirewolfAprsTxConfig(g.input), g.conf, JSON.stringify(g.input));
});

test('its only PTT is POTACAT\'s loopback rigctld shim (Hamlib NET rig 2)', () => {
  const ptt = lines(tx()).filter((l) => /^\s*PTT\b/i.test(l));
  assert.deepStrictEqual(ptt, ['PTT RIG 2 127.0.0.1:4551']);
  for (const l of lines(tx())) assert.ok(!/^\s*(DCD|CON|TXINH)\b/i.test(l), 'no other keying line: ' + l);
});

test('no shim port: no config (it would have no way to key through POTACAT)', () => {
  assert.throws(() => tx({ shimPort: 0 }), /shim/);
  assert.throws(() => tx({ shimPort: undefined }), /shim/);
});

test('no callsign: no config (never N0CALL on the air)', () => {
  assert.throws(() => tx({ mycall: '' }), /callsign/);
});

test('never beacons, digipeats, iGates or opens KISS on its own', () => {
  for (const l of lines(tx()).concat(lines(tx({ band: '30m' })))) {
    assert.ok(!/^\s*(PBEACON|OBEACON|TBEACON|CBEACON|IBEACON|DIGIPEAT|FILTER|CDIGIPEAT|IGSERVER|IGLOGIN|IGTXVIA|IGTXLIMIT|SMARTBEACONING|KISSCOPY|NULLMODEM|SERIALKISS|FULLDUP)\b/i.test(l), 'found: ' + l);
  }
  assert.ok(lines(tx()).includes('KISSPORT 0'));
});

test('channel access per band: DWAIT, SLOTTIME, PERSIST (Dire Wolf audio.h VHF defaults on 2 m; a longer slot on 30 m)', () => {
  const two = lines(tx());
  assert.ok(two.includes('DWAIT 0') && two.includes('SLOTTIME 10') && two.includes('PERSIST 63'), two.join('|'));
  const hf = lines(tx({ band: '30m' }));
  assert.ok(hf.includes('DWAIT 0') && hf.includes('SLOTTIME 30') && hf.includes('PERSIST 63'), hf.join('|'));
  assert.deepStrictEqual(D.APRS_CHANNEL_ACCESS['2m'], { dwait: 0, slottime: 10, persist: 63 });
  assert.deepStrictEqual(D.APRS_CHANNEL_ACCESS['30m'], { dwait: 0, slottime: 30, persist: 63 });
});

test('the MODEM line is the listen config\'s, so it hears the channel it keys on', () => {
  assert.ok(lines(tx()).includes(D.APRS_MODEM_LINES['2m']));
  assert.ok(lines(tx({ band: '30m' })).includes(D.APRS_MODEM_LINES['30m']));
  assert.throws(() => tx({ band: '6m' }), /6m/);
});

test('TXDELAY / TXTAIL in 10 ms units, clamped like packet (500 ms / 200 ms -> 50 / 20)', () => {
  assert.ok(lines(tx()).includes('TXDELAY 50') && lines(tx()).includes('TXTAIL 20'));
  assert.ok(lines(tx({ txDelayMs: 99999, txTailMs: 1 })).includes('TXDELAY 100'));
  assert.ok(lines(tx({ txDelayMs: 99999, txTailMs: 1 })).includes('TXTAIL 1'));
});

test('a different AGW port from listening and from Winlink (never "port in use" in the swap)', () => {
  assert.strictEqual(D.aprsTxAgwPort(8010), 8014);
  assert.notStrictEqual(D.aprsTxAgwPort(8010), D.aprsAgwPort(8010));
  assert.strictEqual(D.aprsTxAgwPort(65534), 65530);
});

test('the listen-only 2 m config is unchanged (phase 2 golden)', () => {
  for (const g of APRS_2M_GOLDEN) assert.strictEqual(D.buildDirewolfAprsRxConfig(g.input), g.conf);
});

test('the listen-only 30 m config is unchanged (phase 3 golden)', () => {
  for (const g of APRS_30M_GOLDEN) assert.strictEqual(D.buildDirewolfAprsRxConfig(g.input), g.conf);
});

test('the Winlink config is unchanged (golden)', () => {
  for (const g of WINLINK_GOLDEN) assert.strictEqual(D.buildDirewolfConfig(g.input), g.conf);
});

test('the listen configs still have no PTT line', () => {
  for (const band of ['2m', '30m']) {
    const c = D.buildDirewolfAprsRxConfig({ mycall: 'K3SBP', audioPort: 50200, agwPort: 8012, band, shimPort: 4551 });
    assert.ok(!/^\s*PTT\b/m.test(c), band);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
