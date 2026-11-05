#!/usr/bin/env node
'use strict';
// Spots on the radio's frequency: same park as the tuned spot = another
// operator at that activation; a different park on a voice/CW frequency is
// marked apart (N0KAH 2026-09-26: US-13168 and US-4583 both on 7278.0 SSB
// read as one multi-operator group). Run: node test/spot-on-freq-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
function extract(name) {
  const start = app.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' missing');
  let i = app.indexOf('{', start), depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) break;
  }
  return app.slice(start, i + 1);
}
const reLine = app.match(/const DIGITAL_MODE_RE = [^\n]+/)[0];
// eslint-disable-next-line no-new-func
const onFreqKind = new Function(`${reLine}\n${extract('spotRefSet')}\n${extract('onFreqKind')}\n${extract('spotBaseCall')}\nreturn onFreqKind;`)();

console.log('spot on-freq');

test('N0KAH case: two parks on 7278.0 SSB are not one activation', () => {
  const tuned = { callsign: 'NX9T', reference: 'US-13168', mode: 'SSB', frequency: '7278.0' };
  assert.strictEqual(onFreqKind({ callsign: 'W8LHF', reference: 'US-4583', mode: 'SSB' }, tuned), 'other-park');
});

test('same park (or an n-fer overlap) is another operator at the activation', () => {
  const tuned = { reference: 'US-13168', mode: 'SSB' };
  assert.strictEqual(onFreqKind({ reference: 'US-13168', mode: 'SSB' }, tuned), 'same-park');
  assert.strictEqual(onFreqKind({ reference: 'US-4583, US-13168', mode: 'SSB' }, tuned), 'same-park');
  assert.strictEqual(onFreqKind({ reference: 'us-13168', mode: 'CW' }, { reference: 'US-13168', mode: 'CW' }), 'same-park');
});

test('digital modes share one dial: never split', () => {
  assert.strictEqual(onFreqKind({ reference: 'US-1', mode: 'FT8' }, { reference: 'US-2', mode: 'FT8' }), 'freq');
  assert.strictEqual(onFreqKind({ reference: 'US-1', mode: 'FT4' }, { reference: 'US-2', mode: 'SSB' }), 'freq');
});

test('nothing to compare (no tuned spot, or no park and no call) stays the plain group', () => {
  assert.strictEqual(onFreqKind({ reference: 'US-1', mode: 'SSB' }, null), 'freq');
  assert.strictEqual(onFreqKind({ reference: '', mode: 'SSB' }, { reference: 'US-2', mode: 'SSB' }), 'freq');
});

test('a spot without a park (DX cluster) is told apart by station (hoogskev 10-08)', () => {
  const tuned = { callsign: 'K1ABC', reference: 'US-1234', mode: 'SSB' };
  assert.strictEqual(onFreqKind({ callsign: 'DL1XYZ', reference: '', mode: 'SSB' }, tuned), 'other-station');
  assert.strictEqual(onFreqKind({ callsign: 'K1ABC/P', reference: '', mode: 'SSB' }, tuned), 'same-station');
  assert.strictEqual(onFreqKind({ callsign: 'K1ABC', reference: '', mode: 'FT8' }, { callsign: 'W2X', mode: 'FT8' }), 'freq', 'digital still never split');
});

test('the table uses it and the other-park row has its own style', () => {
  assert.ok(/tr\.classList\.add\(kind === 'other-park' \|\| kind === 'other-station' \? 'on-freq-other' : 'on-freq'\);/.test(app));
  assert.ok(/\.on-freq-other td\.log-col,/.test(css));
  assert.ok(/table:not\(\.logging-enabled\) \.on-freq td:nth-child\(1 of :not\(\.log-col\)\)/.test(css),
    'with the Log column hidden the bar moves to the first visible cell');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
