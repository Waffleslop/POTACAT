#!/usr/bin/env node
'use strict';
/**
 * Listening through SDRconnect (lib/sdrconnect-audio.js) against a FAKE
 * SDRconnect: the KiwiSdrClient shape main.js drives (connect, tune, setAgc,
 * disconnect, connected; log, connected, disconnected, error, audio, smeter),
 * 16-bit stereo to 48 kHz mono packets, the demodulator from the rig mode,
 * JTCAT's 3 kHz passband, the S-meter, sharing the band scope's connection,
 * giving up on a dead address, the reach for the listen arbiter, and the
 * main.js wiring.
 *
 * Run: node test/sdrconnect-audio-test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { readSrc } = require('./_src');
const { FakeSdrConnect } = require('./fixtures/fake-sdrconnect-server');
const A = require('../lib/sdrconnect-audio');
const C = require('../lib/sdrconnect-client');
const S = require('../lib/sdr-scope');
const ListenSource = require('../lib/listen-source');
const JtcatRxSource = require('../lib/jtcat-rx-source');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const FAST = { backoffMs: 40, maxBackoffMs: 200, connectTimeoutMs: 1500, getTimeoutMs: 600, stallMs: 5000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waitFor(cond, ms = 3000, what = 'condition') {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      let v; try { v = cond(); } catch { v = false; }
      if (v) return resolve(v);
      if (Date.now() - t0 > ms) return reject(new Error('timed out waiting for ' + what));
      setTimeout(tick, 10);
    };
    tick();
  });
}
function once(em, ev, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no ' + ev)), ms);
    em.once(ev, (...a) => { clearTimeout(t); resolve(a); });
  });
}
async function withFake(opts, fn) {
  const fake = new FakeSdrConnect(opts);
  await fake.listen();
  try { await fn(fake); } finally { await fake.close(); }
}
function client(extra) { return new A.SdrConnectAudioClient({ registry: new C.SessionRegistry(FAST), smeterPollMs: 100, ...(extra || {}) }); }

test('the KiwiSdrClient shape', () => {
  const c = client();
  for (const m of ['connect', 'tune', 'setAgc', 'disconnect', 'sameServer']) assert.strictEqual(typeof c[m], 'function', m);
  assert.strictEqual(c.connected, false);
  assert.strictEqual(c.kind, 'sdrconnect');
  assert.deepStrictEqual(c.reach, [[1e3, 2000e6]], 'SDRplay range for the listen arbiter');
  assert.ok(ListenSource.covers(c.reach, 162.55e6) && ListenSource.covers(c.reach, 7.074e6));
});

test('connects, tunes the receiver to the rig mode, plays 48 kHz mono', async () => {
  await withFake({}, async (fake) => {
    const c = client();
    c.tune(14074, 'USB');                      // main.js tunes first, as for rtl_tcp
    c.connect('127.0.0.1', fake.port);
    await once(c, 'connected');
    await waitFor(() => fake.props.device_vfo_frequency === '14074000');
    assert.strictEqual(fake.props.demodulator, 'USB');
    assert.strictEqual(fake.props.filter_bandwidth, '2700');
    assert.strictEqual(fake.props.device_center_frequency, String(14074000 - A.IF_SHIFT_HZ), 'own connection: centre below the signal');
    assert.strictEqual(fake.streams.audio, true);
    assert.strictEqual(fake.streams.spectrum, false);
    const got = [];
    c.on('audio', (pcm, rate) => got.push([pcm, rate]));
    const frames = [];
    for (let i = 0; i < 1200; i++) frames.push([8192, 8192]);
    fake.pushAudio(frames); fake.pushAudio(frames);
    await waitFor(() => got.length >= 1);
    assert.strictEqual(got[0][1], 48000);
    assert.ok(got[0][0] instanceof Float32Array);
    assert.ok(got[0][0].length >= A.AUDIO_PACKET, 'packets of at least ' + A.AUDIO_PACKET);
    assert.ok(Math.abs(got[0][0][0] - 0.25) < 1e-6);
    c.tune(14200, 'LSB');
    await waitFor(() => fake.props.demodulator === 'LSB' && fake.props.device_vfo_frequency === '14200000');
    c.tune(7200, 'AM');
    await waitFor(() => fake.props.device_center_frequency === String(7200000 - A.IF_SHIFT_HZ), 2000, 'retuned to a new window');
    c.setAgc(true);
    await waitFor(() => fake.props.agc_enable === 'true');
    await c.disconnect();
    await waitFor(() => fake.clients.size === 0, 2000, 'closed');
    assert.strictEqual(fake.props.demodulator, 'AM', 'demodulator put back');
    assert.strictEqual(fake.props.agc_enable, 'false', 'audio AGC put back');
    assert.strictEqual(fake.props.device_center_frequency, '7100000');
  });
});

test("JTCAT's receive source: USB with a 3 kHz filter on JTCAT's dial", async () => {
  await withFake({}, async (fake) => {
    const c = client();
    c.connect('127.0.0.1', fake.port);
    await once(c, 'connected');
    const t = JtcatRxSource.websdrTuneForDial(7074);
    c.tune(t.freqKhz, t.mode, t.opts);
    await waitFor(() => fake.props.device_vfo_frequency === '7074000');
    assert.strictEqual(fake.props.demodulator, 'USB');
    assert.strictEqual(fake.props.filter_bandwidth, '3000');
    await c.disconnect();
  });
});

test('the S-meter: from pushed signal_power, and polled when nothing is pushed', async () => {
  await withFake({}, async (fake) => {
    const c = client();
    const m = [];
    c.on('smeter', (db) => m.push(db));
    c.connect('127.0.0.1', fake.port);
    await once(c, 'connected');
    await waitFor(() => m.includes(-93.5), 2000, 'a polled reading');
    fake.pushProperty('signal_power', '-73');
    await waitFor(() => m.includes(-73), 2000, 'a pushed reading');
    await c.disconnect();
  });
});

test('sharing the band scope: one connection, the listener moves only the VFO inside the scope window', async () => {
  await withFake({}, async (fake) => {
    const reg = new C.SessionRegistry(FAST);
    const scope = new C.SdrConnectScope({ cfg: S.normalizeSdrSettings({ enabled: true, kind: 'sdrconnect', port: fake.port }), registry: reg });
    scope.start(14074000);
    await once(scope, 'ready');
    await waitFor(() => fake.props.device_center_frequency === '14074000');
    const c = new A.SdrConnectAudioClient({ registry: reg });
    const logs = [];
    c.on('log', (l) => logs.push(l));
    c.tune(14080, 'USB');
    c.connect('127.0.0.1', fake.port);
    await once(c, 'connected');
    await waitFor(() => fake.props.device_vfo_frequency === '14080000');
    assert.strictEqual(fake.connections, 1, 'one connection for both');
    assert.strictEqual(fake.props.device_center_frequency, '14074000', 'the scope keeps the centre');
    assert.ok(fake.streams.audio && fake.streams.spectrum);
    c.tune(146520, 'FM');
    await sleep(100);
    assert.strictEqual(fake.props.device_center_frequency, '14074000', 'a frequency outside the window does not pull the scope away');
    assert.ok(logs.some((l) => /outside what the SDR receives/.test(l)));
    await c.disconnect();
    assert.strictEqual(fake.clients.size, 1, 'the scope still holds it');
    await waitFor(() => fake.streams.audio === false, 2000, 'audio stream off when the listener goes');
    await scope.stop();
    await waitFor(() => fake.clients.size === 0, 2000, 'closed');
  });
});

test('nothing there: gives up after three tries with one plain sentence', async () => {
  const fake = new FakeSdrConnect();
  const port = await fake.listen();
  await fake.close();
  const c = client();
  c.connect('127.0.0.1', port);
  const [msg] = await once(c, 'error', 5000);
  assert.ok(/SDRconnect is not answering at 127\.0\.0\.1:\d+\. Start SDRconnect/.test(msg), msg);
  assert.strictEqual(c.connected, false);
  assert.strictEqual(c.session, null, 'released, no retry loop left');
});

test('a newer API version: an error at once', async () => {
  await withFake({ props: { api_version: '2.1.0' } }, async (fake) => {
    const c = client();
    c.connect('127.0.0.1', fake.port);
    const [msg] = await once(c, 'error');
    assert.ok(/newer version \(2\.1\.0\)/.test(msg), msg);
  });
});

test('listen-source: SDRconnect reach is known', () => {
  assert.deepStrictEqual(ListenSource.sdrReach({ kind: 'sdrconnect' }), ListenSource.SDRPLAY_REACH);
});

// ─── main.js wiring (source) ────────────────────────────────────────────────

const MAIN = readSrc(path.join(__dirname, '..', 'main.js'));
function bodyOf(name) {
  const start = MAIN.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' exists');
  let depth = 0, i = MAIN.indexOf('{', start);
  for (; i < MAIN.length; i++) { if (MAIN[i] === '{') depth++; else if (MAIN[i] === '}' && --depth === 0) break; }
  return MAIN.slice(start, i + 1);
}

test('main.js: the scope picks SDRconnect from the rig setting', () => {
  assert.ok(/cfg\.kind === 'sdrconnect'[\s\S]{0,80}startSdrConnectScope\(cfg/.test(bodyOf('startSdrScope')));
  const b = bodyOf('startSdrConnectScope');
  assert.ok(/new SdrConnect\.SdrConnectScope\(/.test(b));
  assert.ok(/yaesuScopeOnFrame\(SdrScope\.orientFrame\(f, cfg\)\)/.test(b), 'frames go where the rtl_tcp frames go');
  assert.ok(/on\('span'/.test(b), 'the span label follows what SDRconnect gave');
});

test('main.js: kiwi-connect takes port 5454 (or the scope\'s SDRconnect) as SDRconnect, before the rtl_tcp probe', () => {
  const at = MAIN.indexOf("ipcMain.on('kiwi-connect', async");
  const h = MAIN.slice(at, at + 12000);
  const sc = h.indexOf('isSdrConnect');
  const probe = h.indexOf('RtlTcpAudio.probeRtlTcp');
  assert.ok(sc > 0 && probe > sc, 'decided before the probe');
  assert.ok(/new SdrConnectAudio\.SdrConnectAudioClient\(/.test(h));
  assert.ok(/'sdrconnect'/.test(h), "kiwi-status kind 'sdrconnect'");
});

test('main.js: the SDR list treats a 5454 entry as SDRplay reach, quit restores every receiver', () => {
  assert.ok(/SDRPLAY_REACH/.test(bodyOf('sdrCandidateFor')));
  assert.ok(/SdrConnect\.defaultRegistry\.closeAll\(\)/.test(MAIN));
});

test('main.js: the settings probe is read-only IPC', () => {
  assert.ok(/ipcMain\.handle\('sdrconnect-probe'/.test(MAIN));
  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  assert.ok(/sdrconnectProbe: \(host, port\) => ipcRenderer\.invoke\('sdrconnect-probe'/.test(pre));
});

test('ECHOCAT: kiwi-status kind lists sdrconnect', () => {
  const src = readSrc(path.join(__dirname, '..', 'lib', 'echocat-protocol.js'));
  assert.ok(/'kiwi-status':[^\n]*sdrconnect/.test(src));
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
  }
  console.log(`\nSDRconnect listening: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
