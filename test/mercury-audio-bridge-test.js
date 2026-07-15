// Tests for lib/mercury-audio-bridge.js — pure audio format/rate conversion
// and the per-rig/per-OS audio-strategy resolver. Run: node test/mercury-audio-bridge-test.js
'use strict';

const assert = require('assert');
const { s32leToF32, f32ToS32LE, StreamingResampler, resolveMercuryAudio, MERCURY_FIFO_RATE } = require('../lib/mercury-audio-bridge');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// ---- format conversion ----
test('f32 → s32le → f32 round-trips within epsilon', () => {
  const src = Float32Array.from([0, 0.5, -0.5, 0.999, -0.999, 0.123456]);
  const back = s32leToF32(f32ToS32LE(src));
  assert.strictEqual(back.length, src.length);
  for (let i = 0; i < src.length; i++) assert.ok(Math.abs(back[i] - src[i]) < 1e-6, `idx ${i}: ${back[i]} vs ${src[i]}`);
});

test('f32ToS32LE clamps out-of-range values to full scale', () => {
  const buf = f32ToS32LE(Float32Array.from([2.0, -2.0]));
  assert.strictEqual(buf.readInt32LE(0), 2147483647);
  assert.strictEqual(buf.readInt32LE(4), -2147483647);
});

test('s32leToF32 handles trailing partial samples (floor to whole int32s)', () => {
  const buf = Buffer.alloc(10); // 2 full int32 + 2 leftover bytes
  buf.writeInt32LE(2147483647, 0);
  buf.writeInt32LE(-2147483648, 4);
  const f = s32leToF32(buf);
  assert.strictEqual(f.length, 2);
  assert.ok(Math.abs(f[0] - 1) < 1e-6);
  assert.ok(Math.abs(f[1] - (-1)) < 1e-6);
});

// ---- streaming resampler ----
test('resampler output length ≈ input * ratio (8k→12k upsample)', () => {
  const r = new StreamingResampler(8000, 12000);
  const out = r.process(new Float32Array(800)); // 0.1s @ 8k → ~0.1s @ 12k
  assert.ok(Math.abs(out.length - 1200) <= 2, 'got ' + out.length);
});

test('resampler preserves a DC signal', () => {
  const r = new StreamingResampler(8000, 12000);
  const out = r.process(Float32Array.from({ length: 100 }, () => 0.7));
  for (let i = 1; i < out.length - 1; i++) assert.ok(Math.abs(out[i] - 0.7) < 1e-6, 'idx ' + i + ' = ' + out[i]);
});

test('chunked resampling ≈ single-buffer resampling (continuity across boundary)', () => {
  const whole = Float32Array.from({ length: 240 }, (_, i) => Math.sin(2 * Math.PI * 3 * i / 240));
  const a = new StreamingResampler(8000, 12000);
  const single = a.process(whole);
  const b = new StreamingResampler(8000, 12000);
  const p1 = b.process(whole.slice(0, 120));
  const p2 = b.process(whole.slice(120));
  const joined = Float32Array.from([...p1, ...p2]);
  // Same total count (±1) and matching samples away from the seam.
  assert.ok(Math.abs(joined.length - single.length) <= 1, `${joined.length} vs ${single.length}`);
  const cmp = Math.min(joined.length, single.length);
  let maxErr = 0;
  for (let i = 0; i < cmp; i++) maxErr = Math.max(maxErr, Math.abs(joined[i] - single[i]));
  assert.ok(maxErr < 1e-6, 'max boundary error ' + maxErr);
});

test('resampler passthrough when rates equal', () => {
  const r = new StreamingResampler(8000, 8000);
  const inp = Float32Array.from([1, 2, 3]);
  assert.deepStrictEqual(Array.from(r.process(inp)), [1, 2, 3]);
});

test('MERCURY_FIFO_RATE is 8000', () => assert.strictEqual(MERCURY_FIFO_RATE, 8000));

// ---- strategy resolver ----
test('auto + Flex on Linux → fifo bridge', () => {
  const a = resolveMercuryAudio({ settings: {}, rigFamily: 'flex', platform: 'linux', fifoDir: '/ud' });
  assert.strictEqual(a.useFifo, true);
  assert.strictEqual(a.soundSystem, 'fifo');
  assert.strictEqual(a.rxFifoPath, '/ud/mercury-rx.fifo');
  assert.strictEqual(a.txFifoPath, '/ud/mercury-tx.fifo');
  assert.strictEqual(a.inputDevice, '/ud/mercury-rx.fifo');
  assert.strictEqual(a.outputDevice, '/ud/mercury-tx.fifo');
});

test('auto + Flex on WINDOWS → device (Mercury fifo is POSIX-only)', () => {
  const a = resolveMercuryAudio({ settings: {}, rigFamily: 'flex', platform: 'win32', fifoDir: 'C:\\ud' });
  assert.strictEqual(a.useFifo, false);
  assert.notStrictEqual(a.soundSystem, 'fifo');
  assert.strictEqual(a.rxFifoPath, null);
});

test('auto + generic rig on Linux → device (not a direct-audio family)', () => {
  const a = resolveMercuryAudio({ settings: {}, rigFamily: 'yaesu', platform: 'linux', fifoDir: '/ud' });
  assert.strictEqual(a.useFifo, false);
});

test('forced fifo on Windows is refused (device), with a reason', () => {
  const a = resolveMercuryAudio({ settings: { mercuryAudioBridge: 'fifo' }, rigFamily: 'flex', platform: 'win32', fifoDir: 'C:\\ud' });
  assert.strictEqual(a.useFifo, false);
  assert.ok(/POSIX-only|device-only/i.test(a.reason), a.reason);
});

test('forced device on Linux + Flex stays device', () => {
  const a = resolveMercuryAudio({ settings: { mercuryAudioBridge: 'device', mercurySoundSystem: 'alsa', mercuryInputDevice: 'plughw:0' }, rigFamily: 'flex', platform: 'linux', fifoDir: '/ud' });
  assert.strictEqual(a.useFifo, false);
  assert.strictEqual(a.soundSystem, 'alsa');
  assert.strictEqual(a.inputDevice, 'plughw:0');
});

test('forced fifo on Linux + generic rig → fifo (explicit override)', () => {
  const a = resolveMercuryAudio({ settings: { mercuryAudioBridge: 'fifo' }, rigFamily: 'yaesu', platform: 'linux', fifoDir: '/ud' });
  assert.strictEqual(a.useFifo, true);
});

console.log(`\nMercury audio bridge: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
