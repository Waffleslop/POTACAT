#!/usr/bin/env node
'use strict';
/**
 * The SDRconnect connection and band scope (lib/sdrconnect-client.js) against
 * a FAKE SDRconnect (test/fixtures/fake-sdrconnect-server.js, on the `ws`
 * package): connect and discovery, opening the chosen receiver, the scope
 * following the dial, RF gain, spectrum frames into the scope's 850-level
 * shape, reconnect with backoff, a wrong host, a refused connection, a
 * server that is not SDRconnect, an API version mismatch, another client in
 * control, slow answers, one shared connection, and a clean shutdown that
 * puts back what POTACAT changed and leaves nothing running.
 *
 * Run: node test/sdrconnect-client-test.js
 */
const assert = require('assert');
const http = require('http');
const { FakeSdrConnect } = require('./fixtures/fake-sdrconnect-server');
const C = require('../lib/sdrconnect-client');
const P = require('../lib/sdrconnect-protocol');
const S = require('../lib/sdr-scope');

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
function timers() { return process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length; }

// ─── connect and discovery ──────────────────────────────────────────────────

test('connects, reads the API version and the receivers, and is ready', async () => {
  await withFake({}, async (fake) => {
    const s = new C.SdrConnectSession({ host: '127.0.0.1', port: fake.port, ...FAST });
    const states = [];
    s.on('state', (st) => states.push(st));
    s.start();
    const [info] = await once(s, 'ready');
    assert.strictEqual(info.apiVersion, '1.0.3');
    assert.deepStrictEqual(info.devices, ['nRSP-ST 2401AB0001', 'RSP1B 2305CD0002']);
    assert.strictEqual(info.activeDevice, 'nRSP-ST 2401AB0001');
    assert.strictEqual(info.canControl, true);
    assert.strictEqual(info.lnaMin, 0); assert.strictEqual(info.lnaMax, 9);
    assert.deepStrictEqual(states.slice(0, 3), ['connecting', 'handshake', 'live']);
    const asked = fake.events('get_property').map((m) => m.property);
    assert.strictEqual(asked[0], 'api_version', 'the version is asked first');
    for (const p of P.snapshotProps()) assert.ok(asked.includes(p), 'snapshot reads ' + p);
    assert.strictEqual(fake.sets().length, 0, 'connecting changes nothing');
    await s.stop();
  });
});

test('opens the receiver the operator picked, by display name', async () => {
  await withFake({}, async (fake) => {
    const s = new C.SdrConnectSession({ host: '127.0.0.1', port: fake.port, device: 'RSP1B 2305CD0002', ...FAST });
    s.start();
    const [info] = await once(s, 'ready', 5000);
    assert.deepStrictEqual(fake.events('selected_device_name').map((m) => m.value), ['RSP1B 2305CD0002']);
    assert.strictEqual(info.activeDevice, 'RSP1B 2305CD0002');
    await s.stop();
  });
});

test('a receiver SDRconnect does not have: a plain "does not have" problem', async () => {
  await withFake({}, async (fake) => {
    const s = new C.SdrConnectSession({ host: '127.0.0.1', port: fake.port, device: 'nRSP-ST 9999', ...FAST });
    s.start();
    const [info] = await once(s, 'problem');
    assert.strictEqual(info.key, 'no-device');
    assert.ok(/nRSP-ST 9999/.test(info.headline));
    assert.strictEqual(fake.events('selected_device_name').length, 0, 'never switches to a guess');
    await s.stop();
  });
});

test('no receiver open and none listed: no-device', async () => {
  await withFake({ props: { valid_devices: '', active_device: '' } }, async (fake) => {
    const s = new C.SdrConnectSession({ host: '127.0.0.1', port: fake.port, ...FAST });
    s.start();
    const [info] = await once(s, 'problem');
    assert.strictEqual(info.key, 'no-device');
    await s.stop();
  });
});

test('slow answers (300 ms each) still connect', async () => {
  await withFake({ getDelayMs: 300 }, async (fake) => {
    const s = new C.SdrConnectSession({ host: '127.0.0.1', port: fake.port, ...FAST, getTimeoutMs: 1000 });
    s.start();
    const [info] = await once(s, 'ready', 8000);
    assert.strictEqual(info.apiVersion, '1.0.3');
    await s.stop();
  });
});

// ─── failures ────────────────────────────────────────────────────────────────

test('refused: says SDRconnect is not answering, and backs off 40, 80, 160 ms', async () => {
  const fake = new FakeSdrConnect();
  const port = await fake.listen();
  await fake.close();
  const s = new C.SdrConnectSession({ host: '127.0.0.1', port, ...FAST });
  const waits = [];
  const problems = [];
  s.on('problem', (i) => problems.push(i.key));
  s.on('state', (st, info) => { if (st === 'retrying') waits.push(info.retryInMs); });
  s.start();
  await waitFor(() => waits.length >= 3, 4000, 'three retries');
  await s.stop();
  assert.ok(problems.every((k) => k === 'refused'), problems.join());
  assert.deepStrictEqual(waits.slice(0, 3), [40, 80, 160]);
  assert.ok(/not answering at 127\.0\.0\.1:/.test(P.describeSdrConnectError('refused', { port }).headline));
});

test('a wrong host: cannot reach', async () => {
  const s = new C.SdrConnectSession({ host: 'no-such-host.invalid', port: 5454, ...FAST });
  s.start();
  const [info] = await once(s, 'problem', 8000);
  await s.stop();
  assert.strictEqual(info.key, 'unreachable');
  assert.ok(/Cannot reach no-such-host\.invalid:5454/.test(info.headline));
});

test('a web server on the port is not SDRconnect', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end('hello'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const s = new C.SdrConnectSession({ host: '127.0.0.1', port: srv.address().port, ...FAST });
  s.start();
  const [info] = await once(s, 'problem');
  await s.stop();
  await new Promise((r) => srv.close(r));
  assert.strictEqual(info.key, 'not-sdrconnect');
});

test('a WebSocket that never answers get_property is not SDRconnect', async () => {
  await withFake({ answerGets: false }, async (fake) => {
    const s = new C.SdrConnectSession({ host: '127.0.0.1', port: fake.port, ...FAST, getTimeoutMs: 150 });
    s.start();
    const [info] = await once(s, 'problem');
    await s.stop();
    assert.strictEqual(info.key, 'not-sdrconnect');
  });
});

test('an API version mismatch is refused once, not retried', async () => {
  await withFake({ props: { api_version: '2.0.0' } }, async (fake) => {
    const s = new C.SdrConnectSession({ host: '127.0.0.1', port: fake.port, ...FAST });
    s.start();
    const [info] = await once(s, 'problem');
    assert.strictEqual(info.key, 'api-version');
    assert.ok(/2\.0\.0/.test(info.headline));
    await sleep(300);
    assert.strictEqual(fake.connections, 1, 'no reconnect loop against an SDRconnect we cannot speak to');
    assert.strictEqual(s.state, 'failed');
    assert.strictEqual(fake.sets().length, 0);
    await s.stop();
  });
});

// ─── the band scope ──────────────────────────────────────────────────────────

function scopeCfg(port, extra) {
  return S.normalizeSdrSettings({ enabled: true, kind: 'sdrconnect', host: '127.0.0.1', port, spanHz: 800000, ...(extra || {}) });
}

test('settings: SDRconnect defaults to port 5454; old rigs stay rtl_tcp', () => {
  const c = S.normalizeSdrSettings({ kind: 'sdrconnect' });
  assert.strictEqual(c.kind, 'sdrconnect'); assert.strictEqual(c.port, 5454); assert.strictEqual(c.spanHz, 800000);
  const old = S.normalizeSdrSettings({ host: '10.0.0.2', port: 1234 });
  assert.strictEqual(old.kind, 'rtltcp'); assert.strictEqual(old.device, '');
  assert.strictEqual(S.normalizeSdrSettings({ kind: 'sdrconnect', spanHz: 5000000, device: ' nRSP-ST 1 ' }).device, 'nRSP-ST 1');
});

test('the scope: rate, centre on the dial, follows the dial, gain auto leaves lna_state alone', async () => {
  await withFake({}, async (fake) => {
    const reg = new C.SessionRegistry(FAST);
    const scope = new C.SdrConnectScope({ cfg: scopeCfg(fake.port), registry: reg });
    scope.start(14074000);
    await once(scope, 'ready');
    await waitFor(() => fake.sets('device_center_frequency').length >= 1);
    assert.strictEqual(fake.sets('device_sample_rate')[0].value, '2000000');
    assert.strictEqual(fake.sets('device_center_frequency')[0].value, '14074000');
    assert.strictEqual(fake.sets('device_vfo_frequency')[0].value, '14074000', 'no listener: the VFO goes with the centre');
    assert.strictEqual(fake.sets('lna_state').length, 0, 'auto gain: SDRconnect keeps its own');
    assert.strictEqual(fake.streams.spectrum, true);
    assert.strictEqual(fake.streams.audio, false, 'the scope does not ask for audio');
    scope.setFrequency(14075500);
    await waitFor(() => fake.props.device_center_frequency === '14075500');
    assert.strictEqual(scope.tunedHz, 14075500);
    await scope.stop();
  });
});

test('the scope: an RF gain step is set, clamped into the receiver\'s range', async () => {
  await withFake({}, async (fake) => {
    const reg = new C.SessionRegistry(FAST);
    const scope = new C.SdrConnectScope({ cfg: scopeCfg(fake.port, { gain: 15 }), registry: reg });
    scope.start(7074000);
    await once(scope, 'ready');
    await waitFor(() => fake.sets('lna_state').length);
    assert.strictEqual(fake.sets('lna_state')[0].value, '9', 'clamped to lna_state_max');
    await scope.stop();
  });
});

test('the scope: spectrum bins become 850-level frames, a carrier at the right place', async () => {
  await withFake({}, async (fake) => {
    const reg = new C.SessionRegistry(FAST);
    const scope = new C.SdrConnectScope({ cfg: scopeCfg(fake.port), registry: reg, fps: 30 });
    scope.start(7100000);  // where the fake already sits
    await once(scope, 'ready');
    await waitFor(() => fake.props.device_sample_rate === '2000000' && fake.props.device_center_frequency === '7100000');
    const bins = new Uint8Array(2048).fill(30);
    bins[Math.round(2048 * (0.5 + 100000 / 2000000))] = 240;  // +100 kHz
    const framed = once(scope, 'frame');
    fake.pushSpectrum(bins);
    const [f] = await framed;
    assert.strictEqual(f.kind, 0); assert.strictEqual(f.aligned, true);
    assert.strictEqual(f.wf1.length, 850);
    const peak = f.wf1.indexOf(Math.max(...f.wf1));
    assert.ok(Math.abs(peak - Math.round(850 * 500000 / 800000)) <= 3, 'peak at ' + peak);
    assert.strictEqual(scope.spanHz, 800000);
    await scope.stop();
  });
});

test('the scope: frames are paced (no more than the frame rate)', async () => {
  await withFake({}, async (fake) => {
    const reg = new C.SessionRegistry(FAST);
    const scope = new C.SdrConnectScope({ cfg: scopeCfg(fake.port), registry: reg, fps: 5 });
    let n = 0;
    scope.on('frame', () => n++);
    scope.start(7100000);
    await once(scope, 'ready');
    for (let i = 0; i < 20; i++) fake.pushSpectrum(new Uint8Array(512).fill(20));
    await sleep(150);
    assert.ok(n >= 1 && n <= 2, 'frames drawn: ' + n);
    await scope.stop();
  });
});

test('the scope: a read-back rate smaller than the span narrows the label', async () => {
  await withFake({}, async (fake) => {
    fake.on('message', (m) => { if (m.event_type === 'set_property' && m.property === 'device_sample_rate') setTimeout(() => fake.pushProperty('device_sample_rate', '2000000'), 5); });
    const reg = new C.SessionRegistry(FAST);
    const scope = new C.SdrConnectScope({ cfg: scopeCfg(fake.port, { spanHz: 8000000 }), registry: reg });
    const spans = [];
    scope.on('span', (h) => spans.push(h));
    scope.start(7100000);
    await once(scope, 'ready');
    await waitFor(() => spans.includes(1800000), 2000, 'the span label');
    await scope.stop();
  });
});

// ─── control, reconnect ──────────────────────────────────────────────────────

test('someone else in control: nothing is sent; control back: the dial is applied', async () => {
  await withFake({ props: { can_control: 'false' } }, async (fake) => {
    const reg = new C.SessionRegistry(FAST);
    const scope = new C.SdrConnectScope({ cfg: scopeCfg(fake.port), registry: reg });
    const ctl = [];
    scope.on('control', (ok) => ctl.push(ok));
    scope.start(21074000);
    await once(scope, 'ready');
    await sleep(100);
    assert.strictEqual(fake.sets().length, 0, 'no set_property without control');
    assert.strictEqual(fake.streams.spectrum, true, 'the scope still shows what it is tuned to');
    fake.pushProperty('can_control', 'true');
    await waitFor(() => fake.props.device_center_frequency === '21074000', 2000, 'the dial applied');
    assert.deepStrictEqual(ctl, [false, true]);
    await scope.stop();
  });
});

test('a dropped connection: reconnects, sends the dial and the stream again', async () => {
  await withFake({}, async (fake) => {
    const reg = new C.SessionRegistry(FAST);
    const scope = new C.SdrConnectScope({ cfg: scopeCfg(fake.port), registry: reg });
    const problems = [];
    scope.session || null;
    scope.start(3573000);
    scope.session.on('problem', (i) => problems.push(i.key));
    await once(scope, 'ready');
    await waitFor(() => fake.props.device_center_frequency === '3573000');
    fake.props.device_center_frequency = '7100000';  // SDRconnect restarted at its own setting
    fake.streams.spectrum = false;
    const before = fake.connections;
    fake.dropAll();
    await waitFor(() => fake.connections > before, 3000, 'a new connection');
    await waitFor(() => fake.props.device_center_frequency === '3573000' && fake.streams.spectrum, 3000, 'state put back');
    assert.deepStrictEqual(problems, ['stalled']);
    await scope.stop();
  });
});

test('no frames for the stall time while streaming: reconnects', async () => {
  await withFake({}, async (fake) => {
    const reg = new C.SessionRegistry({ ...FAST, stallMs: 150 });
    const scope = new C.SdrConnectScope({ cfg: scopeCfg(fake.port), registry: reg });
    scope.start(7100000);
    await once(scope, 'ready');
    const [info] = await once(scope.session, 'problem', 2000);
    assert.strictEqual(info.key, 'stalled');
    await waitFor(() => fake.connections >= 2, 2000, 'reconnect');
    await scope.stop();
  });
});

// ─── sharing, shutdown ───────────────────────────────────────────────────────

test('one connection per SDRconnect, shared; the last release closes it', async () => {
  await withFake({}, async (fake) => {
    const reg = new C.SessionRegistry(FAST);
    const a = reg.acquire('127.0.0.1', fake.port);
    const b = reg.acquire('localhost', fake.port);
    assert.strictEqual(a, b, 'localhost and 127.0.0.1 are the same SDRconnect');
    await once(a, 'ready');
    assert.strictEqual(fake.connections, 1);
    await reg.release(a);
    assert.strictEqual(reg.size, 1, 'still held');
    assert.strictEqual(fake.clients.size, 1);
    await reg.release(b);
    assert.strictEqual(reg.size, 0);
    await waitFor(() => fake.clients.size === 0, 2000, 'socket closed');
  });
});

test('clean shutdown: puts back what POTACAT changed, stops its streams and the receiver it started, leaves nothing running', async () => {
  await withFake({ props: { started: 'false' } }, async (fake) => {
    const t0 = timers();
    const reg = new C.SessionRegistry(FAST);
    const scope = new C.SdrConnectScope({ cfg: scopeCfg(fake.port, { gain: 6, spanHz: 5000000 }), registry: reg });
    scope.start(14074000);
    await once(scope, 'ready');
    await waitFor(() => fake.props.device_center_frequency === '14074000' && fake.props.lna_state === '6');
    assert.strictEqual(fake.streams.device, true, 'a stopped receiver is started for the scope');
    const mark = fake.received.length;
    await scope.stop();
    await waitFor(() => fake.clients.size === 0, 2000, 'socket closed');
    const after = fake.received.slice(mark);
    const restored = after.filter((m) => m.event_type === 'set_property').map((m) => [m.property, m.value]);
    assert.deepStrictEqual(restored, [
      ['device_sample_rate', '2000000'], ['device_center_frequency', '7100000'], ['device_vfo_frequency', '7100000'], ['lna_state', '3'],
    ]);
    assert.ok(after.some((m) => m.event_type === 'spectrum_enable' && m.value === 'false'));
    assert.ok(after.some((m) => m.event_type === 'device_stream_enable' && m.value === 'false'), 'the receiver POTACAT started is stopped again');
    assert.strictEqual(fake.props.device_center_frequency, '7100000');
    assert.strictEqual(fake.props.lna_state, '3');
    assert.strictEqual(reg.size, 0);
    await sleep(50);
    assert.ok(timers() <= t0, `no timers left running (${timers()} vs ${t0})`);
  });
});

test('closeAll at quit: every receiver back as it was', async () => {
  await withFake({}, async (fake) => {
    const reg = new C.SessionRegistry(FAST);
    const s = reg.acquire('127.0.0.1', fake.port);
    await once(s, 'ready');
    s.set('demodulator', 'USB');
    await waitFor(() => fake.props.demodulator === 'USB');
    await reg.closeAll();
    await waitFor(() => fake.props.demodulator === 'AM' && fake.clients.size === 0, 2000, 'restored and closed');
  });
});

test('the settings probe: reads, changes nothing, closes', async () => {
  await withFake({}, async (fake) => {
    const r = await C.probeSdrConnect('127.0.0.1', fake.port, { registry: new C.SessionRegistry() });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.devices, ['nRSP-ST 2401AB0001', 'RSP1B 2305CD0002']);
    assert.strictEqual(fake.sets().length, 0);
    assert.strictEqual(fake.events('selected_device_name').length, 0, 'a probe never switches receivers');
    await waitFor(() => fake.clients.size === 0, 2000, 'probe closed');
    const port = fake.port;
    await fake.close();
    const r2 = await C.probeSdrConnect('127.0.0.1', port, { registry: new C.SessionRegistry() });
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.problem.key, 'refused');
  });
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
  }
  console.log(`\nSDRconnect client: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
