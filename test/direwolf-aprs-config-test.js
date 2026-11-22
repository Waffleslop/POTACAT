#!/usr/bin/env node
'use strict';
// APRS phase 2: Dire Wolf's receive-only APRS config (lib/direwolf-process.js
// buildDirewolfAprsRxConfig). MODEM 1200 and NO PTT line of any kind, so the
// modem has no way to key the radio: receive-only is in the config, not in a
// rule elsewhere. The Winlink config is byte-identical to before phase 2
// (test/fixtures/aprs/direwolf-winlink-config-golden.json was written by the
// phase 1 module before this change).
// Run: node test/direwolf-aprs-config-test.js

const assert = require('assert');
const D = require('../lib/direwolf-process');
const GOLDEN = require('./fixtures/aprs/direwolf-winlink-config-golden.json');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

console.log('Dire Wolf APRS receive config');

const conf = () => D.buildDirewolfAprsRxConfig({ mycall: 'k3sbp-10', audioPort: 50200, agwPort: 8012 });
const lines = (s) => s.split('\n');

test('the APRS variant is 1200 baud', () => {
  assert.ok(lines(conf()).includes('MODEM 1200'));
});

test('the APRS variant has no PTT line, no DCD/CON line and no transmit timing', () => {
  for (const l of lines(conf())) {
    assert.ok(!/^\s*(PTT|DCD|CON|TXINH|TXDELAY|TXTAIL|PERSIST|SLOTTIME|DWAIT|FULLDUP)\b/i.test(l), 'found: ' + l);
  }
});

test('the APRS variant never beacons, digipeats, iGates or opens KISS', () => {
  for (const l of lines(conf())) {
    assert.ok(!/^\s*(PBEACON|OBEACON|TBEACON|CBEACON|IBEACON|DIGIPEAT|FILTER|CDIGIPEAT|IGSERVER|IGLOGIN|IGTXVIA|IGTXLIMIT|SMARTBEACONING|KISSCOPY|NULLMODEM|SERIALKISS|AGWPORT\s+0)\b/i.test(l), 'found: ' + l);
  }
  assert.ok(lines(conf()).includes('KISSPORT 0'));
});

test('the APRS variant takes its audio from POTACAT\'s socket at 48 kHz and opens its own AGW port', () => {
  const l = lines(conf());
  assert.ok(l.includes('ADEVICE tcp:50200'));
  assert.ok(l.includes('ARATE ' + D.DIREWOLF_RATE));
  assert.ok(l.includes('AGWPORT 8012'));
  assert.ok(l.includes('MYCALL K3SBP-10'));
});

test('no callsign is still a receiver (N0CALL), never an error', () => {
  assert.ok(lines(D.buildDirewolfAprsRxConfig({ audioPort: 50200, agwPort: 8012 })).includes('MYCALL N0CALL'));
});

test('the APRS variant needs the audio port and an AGW port', () => {
  assert.throws(() => D.buildDirewolfAprsRxConfig({ agwPort: 8012 }));
  assert.throws(() => D.buildDirewolfAprsRxConfig({ audioPort: 70000, agwPort: 8012 }));
  assert.throws(() => D.buildDirewolfAprsRxConfig({ audioPort: 50200, agwPort: 'x' }));
});

test('the APRS variant does not take a shim port or any PTT option', () => {
  const c = D.buildDirewolfAprsRxConfig({ mycall: 'K3SBP', audioPort: 50200, agwPort: 8012, shimPort: 4532, ptt: 'COM3 RTS' });
  const body = c.split('\n').filter((l) => !l.startsWith('#')).join('\n');
  assert.ok(!/PTT|4532|COM3/.test(body), body);
});

test('the APRS AGW port is not Winlink\'s', () => {
  assert.strictEqual(D.aprsAgwPort(8010), 8012);
  assert.strictEqual(D.aprsAgwPort(65535), 65533);
  assert.notStrictEqual(D.aprsAgwPort(8010), 8010);
});

test('the Winlink variant is byte-identical to before phase 2', () => {
  for (const g of GOLDEN) assert.strictEqual(D.buildDirewolfConfig(g.input), g.conf);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
