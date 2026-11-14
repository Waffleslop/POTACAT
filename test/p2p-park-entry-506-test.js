#!/usr/bin/env node
'use strict';
// #506: the other station's park (the activation screen's P2P box) was not
// cleared when a new callsign was typed. An abandoned park-to-park QSO's park
// was then logged on the next caller's contact as SIG/SIG_INFO: a false P2P
// credit uploaded to POTA. Typing one reference over an old one could also
// log the old one.
// Run: node test/p2p-park-entry-506-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const P = require('../lib/p2p-park-entry');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const app = readSrc(path.join(__dirname, '..', 'renderer', 'app.js'));
const html = readSrc(path.join(__dirname, '..', 'renderer', 'index.html'));

// Replay a sequence of callsign-box values against a park that came with `owner`.
function typeCalls(owner, values) {
  let call = owner, cleared = false;
  for (const v of values) {
    const r = P.parkCallAfterEdit(call, v);
    call = r.parkCall;
    if (r.clear) { cleared = true; break; }
  }
  return cleared;
}
const infer = (ref) => (/\//.test(ref) ? 'SOTA' : 'POTA');
const resolve = (text, stored, badgeShown) =>
  P.resolveHunterParks({ text, stored, badgeShown, max: 6, inferProgram: infer });

console.log('#506: a new callsign clears their park');
test('typing a different station over a P2P spot\'s call clears the park', () => {
  // Select-all and type the next caller: the first key already differs.
  assert.strictEqual(typeCalls('K3SBP', ['W', 'W1', 'W1A', 'W1AW']), true);
  // Same first letter: clears at the first letter that differs.
  assert.strictEqual(typeCalls('K3SBP', ['K', 'KD', 'KD9']), true);
});
test('emptying the callsign box clears the park', () => {
  assert.strictEqual(typeCalls('K3SBP', ['K3SB', 'K3S', 'K3', 'K', '']), true);
});
test('typing on, or backspacing inside the same call, keeps it', () => {
  assert.strictEqual(typeCalls('K3SBP', ['K3SBP/', 'K3SBP/P']), false);
  assert.strictEqual(typeCalls('K3SBP', ['K3SB', 'K3SBP']), false);
  assert.strictEqual(typeCalls('K3SBP', ['K3SBP,', 'K3SBP,W1AW']), false, 'a second activator at the same park');
});
test('backspacing then a different ending is a different call', () => {
  assert.strictEqual(typeCalls('K3SBP', ['K3SB', 'K3SBX']), true);
});
test('a park typed before the callsign belongs to the call then typed', () => {
  let r = P.parkCallAfterEdit('', 'N');
  assert.deepStrictEqual(r, { clear: false, parkCall: 'N' });
  assert.strictEqual(typeCalls('', ['N', 'N1', 'N1M', 'N1MM']), false);
  // ...and once typed, replacing that call clears it.
  r = P.parkCallAfterEdit('N1MM', 'W');
  assert.strictEqual(r.clear, true);
});

console.log('#506: what the box shows is what is logged');
test('a single reference typed over an old one replaces it', () => {
  const r = resolve('US-5678', [{ ref: 'US-1234', name: 'Old Park', program: 'POTA' }], false);
  assert.deepStrictEqual(r.refs.map((p) => p.ref), ['US-5678']);
  assert.strictEqual(r.refs[0].name, '', 'the old park\'s name does not ride along');
});
test('an empty box logs no park, whatever was stored', () => {
  assert.deepStrictEqual(resolve('', [{ ref: 'US-1234', name: '', program: 'POTA' }], false).refs, []);
  assert.deepStrictEqual(resolve('  ', [{ ref: 'US-1234' }, { ref: 'US-5678' }], true).refs, []);
});
test('the multi-park dialog: first park in the box, the rest behind a visible +N badge, all logged', () => {
  const stored = [
    { ref: 'US-1234', name: 'A', program: 'POTA' },
    { ref: 'W4C/CM-001', name: 'B', program: 'SOTA' },
    { ref: 'US-9999', name: 'C', program: 'POTA' },
  ];
  const r = resolve('US-1234', stored, true);
  assert.deepStrictEqual(r.refs, stored, 'names and programs kept');
  // Typing over the first keeps the badge's parks: the operator can see them.
  assert.deepStrictEqual(resolve('US-4321', stored, true).refs.map((p) => p.ref), ['US-4321', 'W4C/CM-001', 'US-9999']);
});
test('a comma list edited down drops the removed park when no badge shows', () => {
  const stored = [{ ref: 'US-1234', name: '', program: 'POTA' }, { ref: 'US-5678', name: '', program: 'POTA' }];
  assert.deepStrictEqual(resolve('US-1234', stored, false).refs.map((p) => p.ref), ['US-1234']);
  assert.deepStrictEqual(resolve('US-1234, ', stored, false).refs.map((p) => p.ref), ['US-1234']);
});
test('a stored name and program are kept for a reference still in the box', () => {
  const r = resolve('us-1234', [{ ref: 'US-1234', name: 'Shenandoah', program: 'WWFF' }], false);
  assert.deepStrictEqual(r.refs, [{ ref: 'US-1234', name: 'Shenandoah', program: 'WWFF' }]);
  assert.strictEqual(resolve('W4C/CM-001', [], false).refs[0].program, 'SOTA');
});
test('a bad token is refused, never dropped', () => {
  assert.deepStrictEqual(resolve('US-1234, Shenandoah', [], false), { refs: null, bad: ['SHENANDOAH'] });
});

console.log('#506: the renderer is wired to it');
test('the library is loaded before app.js', () => {
  const lib = html.indexOf('../lib/p2p-park-entry.js');
  assert.ok(lib > 0 && lib < html.indexOf('<script src="app.js"'));
});
test('the callsign box asks parkCallAfterEdit on every edit and clears their park', () => {
  const at = app.indexOf('P2pParkEntry.parkCallAfterEdit(hunterParkCall, activatorCallsignInput.value)');
  assert.ok(at > 0);
  const block = app.slice(at, at + 500);
  assert.ok(/if \(own\.clear[\s\S]{0,200}hunterParkRefs = \[\];\s*updateHunterParkDisplay\(\);/.test(block));
});
test('a spot click owns its park; Clear, the dialog and typing a park set the owner', () => {
  assert.ok(/hunterParkRefs = hunterParkRefsFromSpot\(s\);\s*hunterParkCall = P2pParkEntry\.normCall\(s\.callsign\);/.test(app));
  const clearFn = (app.match(/function clearActivatorEntry\(\) \{[\s\S]*?\n\}\n/) || [''])[0];
  assert.ok(/hunterParkCall = '';/.test(clearFn));
  assert.ok(/hunterParkRefs = refs\.map[^\n]*\n\s*hunterParkCall = P2pParkEntry\.normCall\(activatorCallsignInput\.value\);/.test(app));
  assert.ok(/hunterParkInput\.style\.outline = '';[\s\S]{0,120}hunterParkCall = P2pParkEntry\.normCall\(activatorCallsignInput\.value\);/.test(app));
});
test('the log reads the box through resolveHunterParks, with the badge as shown', () => {
  const fn = (app.match(/function activatorReadEntry\(\) \{[\s\S]*?\n\}\n/) || [''])[0];
  assert.ok(/P2pParkEntry\.resolveHunterParks\(\{/.test(fn));
  assert.ok(/badgeShown: !!\(hunterBadge && !hunterBadge\.classList\.contains\('hidden'\)\)/.test(fn));
  assert.ok(!/hunterParkRefs\.length === 0/.test(fn), 'no stored ref outranks the typed one');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
