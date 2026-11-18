#!/usr/bin/env node
'use strict';
// APRS phase 3: Dire Wolf's receive-only config for 30 m HF APRS
// (lib/direwolf-process.js buildDirewolfAprsRxConfig with band '30m').
// 300 baud AFSK on the 1600/1800 Hz pair, seven decoders 30 Hz apart for
// mistuning (Dire Wolf User Guide 1.8, section 9.2.4: "MODEM 300 A- 7@30"),
// and still NO PTT line. The 2 m APRS config and the Winlink config stay
// byte-identical (goldens written by the phase 2 module before this change).
// Run: node test/direwolf-aprs-hf-config-test.js

const assert = require('assert');
const D = require('../lib/direwolf-process');
const WINLINK_GOLDEN = require('./fixtures/aprs/direwolf-winlink-config-golden.json');
const APRS_2M_GOLDEN = require('./fixtures/aprs/direwolf-aprs-2m-config-golden.json');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

console.log('Dire Wolf APRS 30 m receive config');

const hf = (o) => D.buildDirewolfAprsRxConfig({ mycall: 'k3sbp-10', audioPort: 50200, agwPort: 8012, band: '30m', ...(o || {}) });
const lines = (s) => s.split('\n');

test('30 m is 300 baud on 1600/1800 Hz with seven decoders 30 Hz apart (single slicer, as @ requires)', () => {
  const modem = lines(hf()).filter((l) => /^MODEM\b/.test(l));
  assert.deepStrictEqual(modem, ['MODEM 300 1600:1800 A- 7@30']);
  assert.strictEqual(D.APRS_MODEM_LINES['30m'], 'MODEM 300 1600:1800 A- 7@30');
});

test('the decoders span 1510/1710 to 1690/1890 Hz: 100 Hz of mistuning either way passes', () => {
  // Dire Wolf centres num@offset on the pair: offsets -(n-1)/2..+(n-1)/2 times the step.
  const n = 7, step = 30;
  const lows = Array.from({ length: n }, (_, k) => 1600 + (k - (n - 1) / 2) * step);
  assert.strictEqual(lows[0], 1510);
  assert.strictEqual(lows[n - 1], 1690);
  // Dire Wolf's own limit: the step may not exceed half the shift (config.c, MODEM num@offset).
  assert.ok(step <= (1800 - 1600) / 2);
});

test('30 m has no PTT line, no DCD/CON line and no transmit timing', () => {
  for (const l of lines(hf())) {
    assert.ok(!/^\s*(PTT|DCD|CON|TXINH|TXDELAY|TXTAIL|PERSIST|SLOTTIME|DWAIT|FULLDUP)\b/i.test(l), 'found: ' + l);
  }
});

test('30 m never beacons, digipeats, iGates or opens KISS', () => {
  for (const l of lines(hf())) {
    assert.ok(!/^\s*(PBEACON|OBEACON|TBEACON|CBEACON|IBEACON|DIGIPEAT|FILTER|CDIGIPEAT|IGSERVER|IGLOGIN|IGTXVIA|IGTXLIMIT|SMARTBEACONING|KISSCOPY|NULLMODEM|SERIALKISS)\b/i.test(l), 'found: ' + l);
  }
  assert.ok(lines(hf()).includes('KISSPORT 0'));
});

test('30 m takes the same audio socket, rate and AGW port as 2 m; only the MODEM line differs', () => {
  const two = D.buildDirewolfAprsRxConfig({ mycall: 'k3sbp-10', audioPort: 50200, agwPort: 8012 });
  const a = lines(two), b = lines(hf());
  assert.strictEqual(a.length, b.length);
  const diff = a.map((l, i) => (l === b[i] ? null : [l, b[i]])).filter(Boolean);
  assert.deepStrictEqual(diff, [['MODEM 1200', 'MODEM 300 1600:1800 A- 7@30']]);
});

test('30 m ignores a shim port or any PTT option', () => {
  const body = lines(hf({ shimPort: 4532, ptt: 'COM3 RTS' })).filter((l) => !l.startsWith('#')).join('\n');
  assert.ok(!/PTT|4532|COM3/.test(body), body);
});

test('a band with no APRS modem line is refused, never guessed', () => {
  assert.throws(() => hf({ band: '20m' }));
  assert.throws(() => hf({ band: '70cm' }));
});

test('the 2 m APRS config is byte-identical to phase 2 (no band, and band 2m)', () => {
  for (const g of APRS_2M_GOLDEN) {
    assert.strictEqual(D.buildDirewolfAprsRxConfig(g.input), g.conf);
    assert.strictEqual(D.buildDirewolfAprsRxConfig({ ...g.input, band: '2m' }), g.conf);
  }
});

test('the Winlink config is byte-identical to before APRS', () => {
  for (const g of WINLINK_GOLDEN) assert.strictEqual(D.buildDirewolfConfig(g.input), g.conf);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
