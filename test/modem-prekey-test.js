// The modem's transmit audio that arrives before its PTT request is held and
// sent at key-down, not discarded (lib/modem-prekey.js, GitHub #289: 44 of 50
// ARDOP connect requests went out without their first 200 ms, the leader).
// Run: node test/modem-prekey-test.js
'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const path = require('path');
const { PreKeyBuffer, PREKEY_DEFAULTS } = require('../lib/modem-prekey');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

function clock(start = 1000) { let t = start; const now = () => t; now.advance = (ms) => { t += ms; }; return now; }
function ramp(n, from = 0) { const f = new Float32Array(n); for (let i = 0; i < n; i++) f[i] = (from + i) / 100000; return f; }

console.log('modem-prekey');

test('the #289 shape: two 100 ms buffers land before PTT and both are sent at key-down, in order', () => {
  const now = clock();
  const b = new PreKeyBuffer({ now });
  const a1 = ramp(2400, 0), a2 = ramp(2400, 2400);   // 2 x 100 ms at 24 kHz
  b.hold(a1, 24000);
  b.hold(a2, 24000);
  now.advance(6);                                     // the PTT request's trip through Pat
  assert.strictEqual(b.heldMs, 200);
  const got = b.take();
  assert.strictEqual(got.ms, 200);
  assert.strictEqual(got.chunks.length, 2);
  assert.deepStrictEqual(Array.from(got.chunks[0].slice(0, 3)), Array.from(a1.slice(0, 3)));
  assert.deepStrictEqual(Array.from(got.chunks[1].slice(0, 3)), Array.from(a2.slice(0, 3)));
  assert.strictEqual(b.take().ms, 0, 'taken once');
});

test('held audio is a copy: the caller may reuse its buffer', () => {
  const b = new PreKeyBuffer({ now: clock() });
  const a = ramp(240);
  b.hold(a, 24000);
  a.fill(9);
  assert.notStrictEqual(b.take().chunks[0][5], 9);
});

test('audio with no PTT request behind it is dropped: a stray never reaches a later over', () => {
  const now = clock();
  const b = new PreKeyBuffer({ now });
  b.hold(ramp(2400), 24000);
  now.advance(PREKEY_DEFAULTS.maxAgeMs + 1);
  assert.strictEqual(b.heldMs, 0);
  assert.deepStrictEqual(b.take(), { chunks: [], ms: 0 });
  // Only the recent part survives a mixed queue.
  b.hold(ramp(2400), 24000);
  now.advance(PREKEY_DEFAULTS.maxAgeMs - 50);
  b.hold(ramp(1200), 24000);
  now.advance(100);
  const got = b.take();
  assert.strictEqual(got.chunks.length, 1);
  assert.strictEqual(got.ms, 50);
});

test('never more than maxHoldMs of audio is held; the oldest goes first', () => {
  const now = clock();
  const b = new PreKeyBuffer({ now, maxHoldMs: 300 });
  for (let i = 0; i < 5; i++) b.hold(ramp(2400, i * 2400), 24000); // 500 ms
  const got = b.take();
  assert.strictEqual(got.ms, 300);
  assert.strictEqual(Math.round(got.chunks[0][0] * 100000), 2 * 2400, 'the two oldest were dropped');
});

test('clear() empties it (carrier dropped, session over); empty and bad input are ignored', () => {
  const b = new PreKeyBuffer({ now: clock() });
  b.hold(ramp(2400), 24000);
  b.clear();
  assert.strictEqual(b.take().ms, 0);
  b.hold(null, 24000); b.hold(new Float32Array(0), 24000); b.hold(ramp(10), 0);
  assert.strictEqual(b.take().ms, 0);
});

test('main.js: early modem audio is held, sent at key-down after PTT is asserted, and cleared at unkey', () => {
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  // The hold runs in the modem audio lane (#187), the same PreKeyBuffer.
  const lane = readSrc(path.join(__dirname, '..', 'lib', 'modem-audio-lane.js'));
  assert.ok(/const \{ PreKeyBuffer \} = require\('\.\/modem-prekey'\);/.test(lane));
  assert.ok(/if \(!this\.keyed\) \{ this\.preKey\.hold\(pcm, TX_RATE\); return; \}/.test(lane), 'not keyed yet: held, never dispatched');
  assert.ok(!/if \(!winlinkTxActive\) return; \/\/ the modem only sends while it has PTT/.test(main), 'the old discard is gone');
  const shim = main.slice(main.indexOf('async function startWinlinkShim('), main.indexOf('function winlinkUnkeyNow('));
  const key = shim.indexOf('handleRemotePtt(true,');
  const flush = shim.indexOf('winlinkLaneKeyDown()');
  assert.ok(key > 0 && flush > key, 'the held audio goes out after the radio was asked to key');
  assert.ok(shim.indexOf('_swrTripped') < key && shim.indexOf('_winlinkShimArmed') < key, 'every refusal still comes first');
  const keyOn = lane.slice(lane.indexOf('  key(on,'), lane.indexOf('  endOver('));
  assert.ok(/const early = this\.preKey\.take\(\);\n\s*for \(const c of early\.chunks\) this\._out\(c, true\);/.test(keyOn), 'through the same meter and dispatch as live audio');
  const unkey = main.slice(main.indexOf('function winlinkUnkeyNow('), main.indexOf('function winlinkTxBurstEnd('));
  assert.ok(/if \(winlinkAudio\) winlinkAudio\.key\(false\);/.test(unkey) && /this\.preKey\.clear\(\);/.test(keyOn), 'nothing held survives the carrier drop');
  const list = readSrc(path.join(__dirname, '..', 'scripts', 'run-tests.js'));
  assert.ok(list.includes("'test/modem-prekey-test.js'"), 'this test is in the list CI runs');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
