// SPDX-License-Identifier: Apache-2.0
'use strict';
// The band scope from a TCI rig's IQ stream: float32 IQ in the SDR scope's
// builder (lib/sdr-scope.js), the IQ stream on the TCI link (lib/tci-rig.js)
// and the scope source 'tci' in main.js. Based on PR #632 by w5lee.
// Run: node test/tci-scope-test.js

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { readSrc } = require('./_src');
const S = require('../lib/sdr-scope');
const A = require('../lib/scope-axis');
const TciRig = require('../lib/tci-rig');
const { startFakeTciServer } = require('./fixtures/fake-tci-server');

const MAIN = readSrc(path.join(__dirname, '..', 'main.js'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting'); await wait(5); }
}

// A tone over a little noise (a noiseless picture saturates the level scale).
function toneF32(rate, toneHz, n, amp = 0.2, noise = 0.01) {
  const b = Buffer.alloc(n * 8);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  for (let i = 0; i < n; i++) {
    const ph = 2 * Math.PI * toneHz * i / rate;
    b.writeFloatLE(amp * Math.cos(ph) + noise * rnd(), 8 * i);
    b.writeFloatLE(amp * Math.sin(ph) + noise * rnd(), 8 * i + 4);
  }
  return b;
}
function iqFrame(payload, { rate = 48000, channels = 2, type = 0 } = {}) {
  const h = Buffer.alloc(64);
  h.writeUInt32LE(rate, 4);
  h.writeUInt32LE(3, 8);
  h.writeUInt32LE(payload.length / 4, 20);
  h.writeUInt32LE(type, 24);
  h.writeUInt32LE(channels, 28);
  return Buffer.concat([h, payload]);
}
const peakBin = (lv) => lv.reduce((at, v, i) => (v > lv[at] ? i : at), 0);

for (const [rate, tone] of [[48000, 6000], [96000, -20000], [192000, 50000]]) {
  test(`float32 IQ: a ${tone / 1000} kHz tone at ${rate / 1000} kS/s draws where the axis says`, () => {
    const sb = new S.SpectrumBuilder({ sampleRate: rate, float32: true });
    const frames = [];
    sb.on('frame', (f) => frames.push(f));
    const iq = toneF32(rate, tone, rate);
    for (let o = 0; o < iq.length; o += 3001) sb.feed(iq.subarray(o, Math.min(iq.length, o + 3001))); // chunks split mid-sample
    assert.ok(frames.length >= 3, 'frames: ' + frames.length);
    const f = frames.at(-1);
    const dial = 14074000;
    const axis = A.scopeAxis({ centerHz: dial, spanHz: S.spanForRate(rate) });
    const hz = A.binToHz(axis, peakBin(f.wf1));
    assert.ok(Math.abs(hz - (dial + tone)) <= axis.hzPerBin * 1.5, `peak at ${hz}, expected ${dial + tone}`);
  });
}

test('float32 and u8 IQ agree on where a tone is; a non-number reads as 0', () => {
  const n = 1024, k = 100;
  const f32 = Buffer.alloc(n * 8), u8 = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const c = Math.cos(2 * Math.PI * k * i / n), s = Math.sin(2 * Math.PI * k * i / n);
    f32.writeFloatLE(0.4 * c, 8 * i); f32.writeFloatLE(0.4 * s, 8 * i + 4);
    u8[2 * i] = Math.round(127.5 + 50 * c); u8[2 * i + 1] = Math.round(127.5 + 50 * s);
  }
  const a = S.powerSpectrumF32(f32, 0, n), b = S.powerSpectrumU8(u8, 0, n);
  const pk = (p) => p.reduce((at, v, i) => (v > p[at] ? i : at), 0);
  assert.equal(pk(a), pk(b));
  f32.writeFloatLE(NaN, 0);
  assert.ok(S.powerSpectrumF32(f32, 0, n).every(Number.isFinite));
});

test('decodeIqFrame: stereo float32 IQ only (Zeus leaves channels 0)', () => {
  const p = toneF32(48000, 1000, 64);
  assert.equal(TciRig.decodeIqFrame(iqFrame(p)).rate, 48000);
  assert.ok(TciRig.decodeIqFrame(iqFrame(p, { channels: 0 })));
  assert.equal(TciRig.decodeIqFrame(iqFrame(p, { type: 1 })), null, 'RX audio');
  assert.equal(TciRig.decodeIqFrame(iqFrame(p, { channels: 1 })), null);
  assert.equal(TciRig.decodeIqFrame(iqFrame(p, { rate: 1000 })), null);
  const f = iqFrame(p);
  assert.equal(TciRig.decodeIqFrame(f.subarray(0, f.length - 4)), null, 'truncated');
});

test('the link asks for IQ only when told, centres on dds, and stops on TX', async () => {
  const server = await startFakeTciServer();
  const got = [];
  const rig = TciRig.connectTciRig({ host: '127.0.0.1', port: server.port, server: 'zeus', log: () => {}, on: { iq: (payload, rate, center) => got.push({ n: payload.length, rate, center }) } });
  try {
    await until(() => rig.connected);
    await wait(30);
    assert.ok(!server.frames.some((f) => f.includes('iq_start')), 'no IQ unless the scope asks');
    assert.ok(rig.setIq(true));
    await until(() => server.frames.some((f) => f === 'dds:0;iq_start:0;'));
    const frame = iqFrame(toneF32(48000, 1000, 128));
    server.send(frame); // no dds yet: no axis, nothing drawn
    server.send('dds:0,14070000;');
    await wait(20);
    server.send(frame);
    await until(() => got.length === 1);
    assert.deepEqual(got[0], { n: 128 * 8, rate: 48000, center: 14070000 });
    server.send('trx:0,true;');
    await until(() => rig.transmitting);
    server.send(frame);
    await wait(30);
    assert.equal(got.length, 1, 'never our own transmission');
    server.send('trx:0,false;');
    rig.setIq(false);
    await until(() => server.frames.some((f) => f === 'iq_stop:0;'));
  } finally { rig.close(); await server.close(); }
});

test('main.js: the scope source tci, gated on the TCI rig', () => {
  const kind = MAIN.slice(MAIN.indexOf('function scopeSourceKind() {'), MAIN.indexOf('// ═══ The Flex\'s own panadapter'));
  assert.match(kind, /if \(tciRigTarget\(\) && !\(sdr\.enabled && sdr\.preferSdr\)\) return 'tci';/);
  assert.match(MAIN, /if \(kind === 'tci'\) \{ startTciScope\(\); return; \}/);
  assert.match(MAIN, /if \(tciScopeOn\) \{ stopTciScope\(why\); return; \}/);
  assert.match(MAIN, /if \(s\.source === 'tci'\) return SdrScope\.levelScale\(\);/);
  assert.match(MAIN, /const tciCentre = tciScopeOn \? yaesuScopeState\.centerHz : null;[\s\S]{0,140}if \(tciCentre != null\) yaesuScopeState\.centerHz = tciCentre;/, 'the centre is the server\'s, not the dial');
  assert.match(MAIN, /new SdrScope\.SpectrumBuilder\(\{ sampleRate: rate, fps: 12, float32: true \}\)/);
  assert.match(MAIN, /iq\(payload, rate, center\) \{ if \(tciRig === rig && tciScopeOn\) feedTciScope\(payload, rate, center\); \}/);
});
