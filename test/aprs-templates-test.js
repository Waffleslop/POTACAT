#!/usr/bin/env node
'use strict';
// APRS A2: message templates (lib/aprs-templates.js). Each built-in's fill and
// its fit in 67 characters, the activation and radio fields, the fields left
// for the operator, the templates held back, and my templates' round trip.
// Run: node test/aprs-templates-test.js

const assert = require('assert');
const T = require('../lib/aprs-templates');
const M = require('../lib/aprs-message');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const CTX = { park: 'US-1234', summit: 'W3/PD-001', freq: '14.062', mode: 'CW', call: 'K3SBP' };

console.log('APRS message templates');

test('the groups and their order: Groups and nets, Gateways (the plan and mock-up, less what is held)', () => {
  assert.deepStrictEqual(T.BUILT_IN.map((g) => g.group), ['Groups and nets', 'Gateways']);
  assert.deepStrictEqual(T.BUILT_IN[0].items.map((t) => t.id), ['ansrvr-cq', 'hotg-join', 'hotg-leave']);
  assert.deepStrictEqual(T.BUILT_IN[1].items.map((t) => t.id), ['email', 'wxbot']);
});

test('every built-in: a To APRS can send to, a hint, and text that fits 67 characters', () => {
  for (const g of T.BUILT_IN) for (const t of g.items) {
    assert.ok(M.checkAddressee(t.to).ok, t.id + ' To');
    assert.ok(t.hint && t.hint.length > 10, t.id + ' hint');
    assert.ok(T.fill(t, CTX).fits, t.id + ' fits');
    assert.strictEqual(M.cleanText(t.text), t.text, t.id + ' has no reserved characters');
  }
});

test('Group CQ: To ANSRVR, "CQ <GROUP> <TEXT>", both fields left for the operator', () => {
  const f = T.fill(T.findBuiltIn('ansrvr-cq'), CTX);
  assert.strictEqual(f.to, 'ANSRVR');
  assert.strictEqual(f.text, 'CQ <GROUP> <TEXT>');
  assert.deepStrictEqual(f.left, ['<GROUP>', '<TEXT>']);
  assert.deepStrictEqual(f.filled, []);
});

test('APRSThursday: join is "CQ HOTG <TEXT>", leave is "U HOTG" (aprs.to)', () => {
  assert.deepStrictEqual([T.fill(T.findBuiltIn('hotg-join')).to, T.fill(T.findBuiltIn('hotg-join')).text], ['ANSRVR', 'CQ HOTG <TEXT>']);
  const leave = T.fill(T.findBuiltIn('hotg-leave'));
  assert.deepStrictEqual([leave.to, leave.text, leave.left], ['ANSRVR', 'U HOTG', []]);
});

test('Email: To EMAIL-2, the address first (aprs-is.net/Email.aspx)', () => {
  const f = T.fill(T.findBuiltIn('email'), CTX);
  assert.deepStrictEqual([f.to, f.text, f.left], ['EMAIL-2', '<ADDRESS> <TEXT>', ['<ADDRESS>', '<TEXT>']]);
});

test('Weather report: To WXBOT, City,ST or a zip (KI6WJP)', () => {
  const f = T.fill(T.findBuiltIn('wxbot'), CTX);
  assert.deepStrictEqual([f.to, f.text, f.left], ['WXBOT', '<City,ST or ZIP>', ['<City,ST or ZIP>']]);
});

test('held back and never shown: APSPOT, APRS2SOTA, WHO-IS, SMSGTE, each with its reason', () => {
  const shown = T.BUILT_IN.flatMap((g) => g.items.map((t) => t.to));
  for (const h of T.HELD) {
    assert.ok(!shown.includes(h.to), h.to + ' not shown');
    assert.ok(h.reason, h.to + ' reason');
    assert.strictEqual(T.findBuiltIn(h.id), null);
  }
  assert.deepStrictEqual(T.HELD.map((h) => h.to), ['APSPOT', 'APRS2SOTA', 'WHO-IS', 'SMSGTE']);
});

test('fields from the activation and the radio: park, summit, frequency, mode, callsign', () => {
  const f = T.fill({ to: 'ansrvr', text: 'CQ POTA <CALL> at <PARK> <FREQ> <MODE>' }, CTX);
  assert.strictEqual(f.to, 'ANSRVR');
  assert.strictEqual(f.text, 'CQ POTA K3SBP at US-1234 14.062 CW');
  assert.deepStrictEqual(f.filled, ['CALL', 'PARK', 'FREQ', 'MODE']);
  assert.deepStrictEqual(f.left, []);
  assert.strictEqual(T.filledWords(f.filled, true), 'Filled from your activation: callsign, park, frequency and mode');
  assert.strictEqual(T.filledWords(['FREQ', 'MODE'], false), 'Filled from your radio and Settings: frequency and mode');
  assert.strictEqual(T.filledWords([], true), '');
});

test('a field with nothing to fill it stays for the operator (no activation: <PARK> stays)', () => {
  const f = T.fill({ to: 'ANSRVR', text: 'CQ POTA <PARK> <FREQ> <MODE>' }, { freq: '7.074', mode: 'FT8' });
  assert.strictEqual(f.text, 'CQ POTA <PARK> 7.074 FT8');
  assert.deepStrictEqual(f.left, ['<PARK>']);
  assert.deepStrictEqual(T.unfilled('nothing left'), []);
});

test('the fit: a fill longer than 67 characters says so', () => {
  const f = T.fill({ to: 'W1AW', text: 'x'.repeat(60) + ' <PARK>' }, { park: 'US-12345' });
  assert.strictEqual(f.length, 69);
  assert.strictEqual(f.fits, false);
});

test('save the current message as a template, use it, replace it by name, delete it (round trip)', () => {
  let list = [];
  const r = T.saveMine(list, { name: 'Park recap', to: 'ansrvr', text: 'CQ POTA <CALL> QRT <PARK>, thanks all' }, 1700000000000);
  assert.ok(r.ok);
  list = JSON.parse(JSON.stringify(r.list)); // as settings keeps it
  assert.deepStrictEqual(list, [{ id: 'm700000000000', name: 'Park recap', to: 'ANSRVR', text: 'CQ POTA <CALL> QRT <PARK>, thanks all' }]);
  assert.strictEqual(T.fill(T.normalizeMine(list)[0], CTX).text, 'CQ POTA K3SBP QRT US-1234, thanks all');
  const r2 = T.saveMine(list, { name: 'park RECAP', to: 'ANSRVR', text: 'CQ POTA QRT' }, 2);
  assert.strictEqual(r2.list.length, 1, 'the same name replaces');
  assert.strictEqual(r2.list[0].id, 'm700000000000');
  assert.strictEqual(r2.list[0].text, 'CQ POTA QRT');
  assert.deepStrictEqual(T.removeMine(r2.list, 'm700000000000'), []);
});

test('saving refuses in plain words: no name, no To, a bad To, no text, too long, too many', () => {
  assert.strictEqual(T.saveMine([], { name: '', to: 'W1AW', text: 'hi' }).sentence, 'Give the template a name.');
  assert.strictEqual(T.saveMine([], { name: 'a', to: '', text: 'hi' }).sentence, 'Type who the message is to first.');
  assert.match(T.saveMine([], { name: 'a', to: 'W1AW/P', text: 'hi' }).sentence, /not a call APRS can send to/);
  assert.strictEqual(T.saveMine([], { name: 'a', to: 'W1AW', text: '  ' }).sentence, 'Type the message first.');
  assert.match(T.saveMine([], { name: 'a', to: 'W1AW', text: 'x'.repeat(68) }).sentence, /at most 67/);
  const full = Array.from({ length: 30 }, (_, i) => ({ id: 'm' + i, name: 'n' + i, to: 'W1AW', text: 't' }));
  assert.match(T.saveMine(full, { name: 'new', to: 'W1AW', text: 't' }).sentence, /30 templates/);
  assert.ok(T.saveMine(full, { name: 'n3', to: 'W1AW', text: 'changed' }).ok, 'replacing by name still works when full');
});

test('a saved list read back from settings: anything malformed is dropped, at most 30', () => {
  const got = T.normalizeMine([null, 'x', { id: 'a', name: 'ok', to: 'w1aw', text: 'hi|there' }, { id: 'a', name: 'dupe', to: 'W1AW', text: 'x' },
    { id: 'b', name: '', to: 'W1AW', text: 'x' }, { id: 'c', name: 'bad to', to: 'W1AW/P', text: 'x' }]);
  assert.deepStrictEqual(got, [{ id: 'a', name: 'ok', to: 'W1AW', text: 'hithere' }]);
  assert.deepStrictEqual(T.normalizeMine('garbage'), []);
  assert.strictEqual(T.normalizeMine(Array.from({ length: 40 }, (_, i) => ({ id: 'm' + i, name: 'n' + i, to: 'W1AW', text: 't' }))).length, 30);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
