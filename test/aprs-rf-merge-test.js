#!/usr/bin/env node
'use strict';
// APRS phase 2: a station heard on the radio and reported by APRS-IS is ONE
// row carrying both marks (lib/aprs-stations.js), and the "Heard by me" filter
// shows only what the radio heard.
// Run: node test/aprs-rf-merge-test.js

const assert = require('assert');
const P = require('../lib/aprs-parser');
const S = require('../lib/aprs-stations');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
function store() {
  let t = 1000000;
  const s = S.createStore({ home: { lat: 41.5, lon: -72.5 }, now: () => t });
  s.tick = (ms) => { t += ms; };
  return s;
}
const IS_LINE = 'W1AW-9>APRS,TCPIP*,qAC,T2BOSTON:!4140.00N/07243.00W>From the internet';
const RF_LINE = 'W1AW-9>APRS:!4140.10N/07243.10W>From the radio';
const rf = (line, via) => Object.assign(P.parse(line), { rf: via || { kind: 'direct', digi: '' } });

console.log('APRS RF and internet merge');

test('internet first, then the radio: one row, both marks', () => {
  const s = store();
  s.add(P.parse(IS_LINE));
  s.tick(1000);
  s.add(rf(RF_LINE));
  assert.strictEqual(s.size, 1);
  const r = s.get('W1AW-9');
  assert.ok(r.isHeard, 'internet mark');
  assert.ok(r.rf, 'radio mark');
  assert.strictEqual(r.rf.kind, 'direct');
  assert.strictEqual(r.packets, 2);
});

test('the radio first, then the internet: the radio mark stays', () => {
  const s = store();
  s.add(rf(RF_LINE, { kind: 'digi', digi: 'KB1XYZ-1' }));
  s.add(P.parse(IS_LINE));
  const r = s.get('W1AW-9');
  assert.deepStrictEqual({ kind: r.rf.kind, digi: r.rf.digi }, { kind: 'digi', digi: 'KB1XYZ-1' });
  assert.ok(r.isHeard);
});

test('a later direct copy replaces "via digipeater" (the latest packet says how it came)', () => {
  const s = store();
  s.add(rf(RF_LINE, { kind: 'digi', digi: 'KB1XYZ-1' }));
  s.tick(5000);
  s.add(rf(RF_LINE));
  assert.strictEqual(s.get('W1AW-9').rf.kind, 'direct');
});

test('an internet-only station has no radio mark', () => {
  const s = store();
  s.add(P.parse(IS_LINE));
  assert.strictEqual(s.get('W1AW-9').rf, null);
});

test('"Heard by me" lists only the stations the radio heard', () => {
  const s = store();
  s.add(P.parse(IS_LINE));
  s.add(rf('K3SBP-7>APDR16,KB1XYZ-1*:=3958.21N/07510.47W-House', { kind: 'digi', digi: 'KB1XYZ-1' }));
  assert.deepStrictEqual(s.list({}).map((r) => r.key).sort(), ['K3SBP-7', 'W1AW-9']);
  assert.deepStrictEqual(s.list({ heardByMe: true }).map((r) => r.key), ['K3SBP-7']);
});

test('the radio mark counts and times its own packets', () => {
  const s = store();
  s.add(rf(RF_LINE));
  s.tick(60000);
  s.add(P.parse(IS_LINE));
  s.tick(1000);
  s.add(rf(RF_LINE));
  const r = s.get('W1AW-9');
  assert.strictEqual(r.rf.packets, 2);
  assert.strictEqual(r.rf.lastHeard, 1000000 + 61000);
});

test('a status packet heard on the radio marks an existing row', () => {
  const s = store();
  s.add(P.parse(IS_LINE));
  s.add(rf('W1AW-9>APRS:>On the air'));
  assert.ok(s.get('W1AW-9').rf);
  assert.strictEqual(s.get('W1AW-9').status, 'On the air');
});

test('the phase 1 behaviour is unchanged for internet packets (no rf field)', () => {
  const s = store();
  const r = s.add(P.parse(IS_LINE));
  assert.strictEqual(r.call, 'W1AW-9');
  assert.strictEqual(r.packets, 1);
  assert.strictEqual(s.list({ query: 'internet' }).length, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
