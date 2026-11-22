#!/usr/bin/env node
'use strict';
// #840: APRS 30 m listening sets the receive filter so 1450 to 1950 Hz is
// passed, and puts the radio's own filter back when listening stops (Casey
// 2026-11-21). Tested against a fake FlexRadio slice left on a narrow filter:
// the slice keeps its edges, takes `filt` as one command, and reports its
// mode and RIT the way lib/smartsdr.js status lines do (strings).
// Run: node test/aprs-rx-filter-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const F = require('../lib/aprs-rx-filter');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

/** A Flex slice: edges as the status line has them (strings), `filt` sets both at once. */
function fakeFlex({ lo = '1500', hi = '1800', mode = 'DIGU', ritOn = '0', ritHz = '0', idx = 0 } = {}) {
  const radio = { idx, lo, hi, mode, ritOn, ritHz, sent: [], connected: true };
  const logs = [];
  const guard = F.createRxFilterGuard({
    read: () => (radio.connected ? { idx: radio.idx, lo: radio.lo, hi: radio.hi, mode: radio.mode, ritOn: radio.ritOn, ritHz: radio.ritHz } : null),
    set: (i, l, h) => { radio.sent.push(`filt ${i} ${l} ${h}`); radio.lo = String(l); radio.hi = String(h); },
    log: (l) => logs.push(l),
  });
  return { radio, guard, logs };
}

console.log('APRS 30 m receive filter, set and put back');

test('a Flex left on a narrow 1500-1800 Hz filter is widened to pass 1450-1950 Hz, and put back when listening stops', () => {
  const { radio, guard, logs } = fakeFlex({ lo: '1500', hi: '1800' });
  const r = guard.widen('30m');
  assert.strictEqual(r.action, 'widen');
  assert.deepStrictEqual(radio.sent, ['filt 0 1400 2000']);
  assert.ok(Number(radio.lo) <= 1450 && Number(radio.hi) >= 1950, 'the slice passes both tones now');
  assert.strictEqual(r.sentence, 'POTACAT widened your receive filter from 1500-1800 Hz to 1400-2000 Hz for APRS. It goes back when listening stops.');
  assert.ok(logs.some((l) => /1500-1800 Hz widened to 1400-2000 Hz/.test(l)));
  const back = guard.restore('switched off');
  assert.strictEqual(back.action, 'restored');
  assert.deepStrictEqual(radio.sent, ['filt 0 1400 2000', 'filt 0 1500 1800']);
  assert.strictEqual(radio.lo, '1500'); assert.strictEqual(radio.hi, '1800');
  assert.strictEqual(guard.held, null);
});

test('the wider edge the operator had is kept: 100-1700 Hz becomes 100-2000 Hz', () => {
  const { radio, guard } = fakeFlex({ lo: '100', hi: '1700' });
  guard.widen('30m');
  assert.deepStrictEqual(radio.sent, ['filt 0 100 2000']);
  guard.restore('stop');
  assert.deepStrictEqual(radio.sent[1], 'filt 0 100 1700');
});

test('a filter that already passes 1450-1950 Hz is never touched', () => {
  const { radio, guard } = fakeFlex({ lo: '100', hi: '3100' });
  assert.strictEqual(guard.widen('30m').action, 'none');
  assert.strictEqual(guard.restore('stop').action, 'none');
  assert.deepStrictEqual(radio.sent, []);
});

test('2 m is never touched', () => {
  const { radio, guard } = fakeFlex({ lo: '1500', hi: '1800', mode: 'FM' });
  assert.strictEqual(guard.widen('2m').action, 'none');
  assert.deepStrictEqual(radio.sent, []);
});

test('the operator changed the filter while listening: theirs stays, nothing is sent back', () => {
  const { radio, guard, logs } = fakeFlex({ lo: '1500', hi: '1800' });
  guard.widen('30m');
  radio.lo = '200'; radio.hi = '2800';
  assert.strictEqual(guard.restore('stop').action, 'left');
  assert.deepStrictEqual(radio.sent, ['filt 0 1400 2000']);
  assert.ok(logs.some((l) => /changed to 200-2800 Hz while listening/.test(l)));
});

test('the slice moved to another mode (a spot click to 20 m USB): the USB filter is never overwritten', () => {
  const { radio, guard, logs } = fakeFlex({ lo: '1500', hi: '1800' });
  guard.widen('30m');
  radio.mode = 'USB'; radio.lo = '100'; radio.hi = '2900';
  assert.strictEqual(guard.restore('the radio moved').action, 'left');
  assert.deepStrictEqual(radio.sent, ['filt 0 1400 2000']);
  assert.ok(logs.some((l) => /slice is in USB now/.test(l)));
});

test('the status after our set has not arrived yet: still ours, put back', () => {
  const { radio, guard } = fakeFlex({ lo: '1500', hi: '1800' });
  guard.widen('30m');
  radio.lo = '1500'; radio.hi = '1800'; // stale status
  assert.strictEqual(guard.restore('stop').action, 'restored');
  assert.strictEqual(radio.sent[radio.sent.length - 1], 'filt 0 1500 1800');
});

test('the Flex is gone at the stop: nothing sent, the log says the filter was not put back', () => {
  const { radio, guard, logs } = fakeFlex({ lo: '1500', hi: '1800' });
  guard.widen('30m');
  radio.connected = false;
  assert.strictEqual(guard.restore('quit').action, 'not-connected');
  assert.ok(logs.some((l) => /could not be put back to 1500-1800 Hz/.test(l)));
});

test('a second start puts the first one back before widening again (never saves our own filter as theirs)', () => {
  const { radio, guard } = fakeFlex({ lo: '1500', hi: '1800' });
  guard.widen('30m');
  guard.widen('30m');
  assert.deepStrictEqual(radio.sent, ['filt 0 1400 2000', 'filt 0 1500 1800', 'filt 0 1400 2000']);
  guard.restore('stop');
  assert.strictEqual(radio.lo, '1500'); assert.strictEqual(radio.hi, '1800');
});

test('RIT keeps its warning and is never changed', () => {
  const { radio, guard } = fakeFlex({ lo: '100', hi: '3100', ritOn: '1', ritHz: '120' });
  const r = guard.widen('30m');
  assert.strictEqual(r.rit, 'RIT is on (+120 Hz), so your radio listens beside 10.1476 MHz. Turn RIT off to decode APRS.');
  assert.deepStrictEqual(radio.sent, []);
  assert.strictEqual(F.ritSentence({ band: '30m', ritOn: '1', ritHz: '0' }), '');
  assert.strictEqual(F.ritSentence({ band: '30m', ritOn: '0', ritHz: '200' }), '');
  assert.strictEqual(F.ritSentence({ band: '2m', ritOn: '1', ritHz: '200' }), '');
});

test('no Flex, or no edges reported: unknown, nothing sent (the width warning stays)', () => {
  const g = F.createRxFilterGuard({ read: () => null, set: () => { throw new Error('no set'); } });
  assert.strictEqual(g.widen('30m').action, 'unknown');
  assert.strictEqual(F.planRxFilter({ band: '30m', edges: { lo: '', hi: '' } }).action, 'unknown');
  assert.strictEqual(F.planRxFilter({ band: '30m', edges: { lo: -2800, hi: -100 } }).action, 'unknown', 'a lower-sideband filter is not widened');
});

test('main wires it: widened after the tune and before the modem, put back on every way out', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = main.slice(main.indexOf('async function aprsListenStart('), main.indexOf('function aprsListenStop('));
  assert.ok(start.indexOf('await aprsRxFilterWiden(seq)') > start.indexOf('aprsWaitDial('), 'after the radio took the frequency');
  assert.ok(start.indexOf('await aprsRxFilterWiden(seq)') < start.indexOf('await aprsSpawnDirewolf(seq)'), 'before the modem');
  const stop = main.slice(main.indexOf('function aprsListenStop('), main.indexOf('function aprsListenYieldToWinlink('));
  assert.ok(/aprsRxFilter\.restore\(why\)/.test(stop) && stop.indexOf('aprsRxFilter.restore(why)') < stop.indexOf('aprsReturn.end('), 'stop: put back before the radio goes back');
  const yieldFn = main.slice(main.indexOf('function aprsListenYieldToWinlink('), main.indexOf('function aprsListenCheckMoved('));
  assert.ok(/aprsRxFilter\.restore\(/.test(yieldFn), 'Winlink takes the radio: put back');
  const moved = main.slice(main.indexOf('function aprsListenMovedOff('), main.indexOf('function aprsListenOnDial('));
  assert.ok(/aprsRxFilter\.restore\('the radio moved'\)/.test(moved), 'the radio moved: put back if still ours');
  assert.ok(/smartSdr\.setSliceFilter\(idx, lo, hi\)/.test(main), 'one `filt` command with both edges');
  assert.ok(!/rit_on=|setRit\(/.test(main.slice(main.indexOf('function aprsFlexSliceNow('), main.indexOf('async function aprsListenStart('))), 'RIT is never set');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
