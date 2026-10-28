#!/usr/bin/env node
'use strict';
/**
 * Band scope from a separate SDR (lib/sdr-scope.js): the rtl_tcp protocol
 * against a FAKE server, the spectrum maths, and the main.js wiring.
 * (AB9AI / W9TEF / K6CSG 2026: a scope for radios with none on the USB cable.)
 *
 * Run: node test/sdr-scope-test.js
 */
const assert = require('assert');
const net = require('net');
const fs = require('fs');
const path = require('path');
const S = require('../lib/sdr-scope');
const A = require('../lib/scope-axis');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

function header(tuner = 5, gains = 29) {
  const b = Buffer.alloc(12);
  b.write('RTL0', 0, 'latin1');
  b.writeUInt32BE(tuner, 4);
  b.writeUInt32BE(gains, 8);
  return b;
}

/** u8 IQ with a complex tone at `toneHz` (+ optional DC offset and noise). */
function toneIq(sampleRate, toneHz, nSamples, { amp = 60, dc = 0, noise = 3 } = {}) {
  const b = Buffer.alloc(nSamples * 2);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  for (let i = 0; i < nSamples; i++) {
    const ph = 2 * Math.PI * toneHz * i / sampleRate;
    b[2 * i] = Math.max(0, Math.min(255, Math.round(127.5 + dc + amp * Math.cos(ph) + noise * rnd())));
    b[2 * i + 1] = Math.max(0, Math.min(255, Math.round(127.5 + dc + amp * Math.sin(ph) + noise * rnd())));
  }
  return b;
}

function peakBin(levels) {
  let m = -1, at = -1;
  for (let i = 0; i < levels.length; i++) if (levels[i] > m) { m = levels[i]; at = i; }
  return at;
}

/** A fake rtl_tcp: greets, records commands, streams `iq` in odd-sized chunks. */
function fakeServer({ greet = header(), iq = null, chunk = 4097, garbage = null } = {}) {
  const commands = [];
  let conns = 0;
  const sockets = new Set();
  const server = net.createServer((sock) => {
    conns++;
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    let pending = Buffer.alloc(0);
    sock.on('data', (d) => {
      pending = Buffer.concat([pending, d]);
      while (pending.length >= 5) {
        commands.push({ cmd: pending[0], param: pending.readUInt32BE(1), signed: pending.readInt32BE(1) });
        pending = pending.subarray(5);
      }
    });
    sock.on('error', () => {});
    if (garbage) { sock.write(garbage); return; }
    if (greet) {
      // The greeting split across two writes: a client must not need it whole.
      sock.write(greet.subarray(0, 5));
      setTimeout(() => {
        if (sock.destroyed) return;
        sock.write(greet.subarray(5));
        if (iq) for (let o = 0; o < iq.length; o += chunk) sock.write(iq.subarray(o, Math.min(iq.length, o + chunk)));
      }, 20);
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    server, commands, port: server.address().port,
    get conns() { return conns; },
    kick() { for (const s of sockets) s.destroy(); },
    close() { for (const s of sockets) s.destroy(); return new Promise((r) => server.close(() => r())); },
  })));
}

function until(cond, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

console.log('SDR band scope (rtl_tcp)');

// ─── protocol ────────────────────────────────────────────────────────────────

test('the RTL0 greeting parses; anything else is refused', () => {
  const h = S.parseHeader(header(5, 29));
  assert.deepStrictEqual(h, { tunerType: 5, tunerName: 'R820T/R820T2', gainCount: 29 });
  assert.strictEqual(S.parseHeader(Buffer.from('HTTP/1.1 200')), null);
  assert.strictEqual(S.parseHeader(header().subarray(0, 8)), null, 'a short greeting is not yet a greeting');
});

test('commands are one byte + a 32-bit big-endian word (negative ppm too)', () => {
  assert.deepStrictEqual([...S.buildCommand(S.CMD.FREQ, 14074000)], [0x01, 0x00, 0xd6, 0xc0, 0x90]);
  const ppm = S.buildCommand(S.CMD.PPM, -3);
  assert.strictEqual(ppm[0], 0x05);
  assert.strictEqual(ppm.readInt32BE(1), -3);
});

test('setup: rate, direct sampling, ppm, gain mode, then the dial', () => {
  const cfg = S.normalizeSdrSettings({ enabled: true, sampleRate: 2048000, directSampling: 'q', ppm: 2, gain: 'auto' });
  const cmds = S.setupCommands(cfg, 14074000).map((b) => [b[0], b.readInt32BE(1)]);
  assert.deepStrictEqual(cmds, [[0x02, 2048000], [0x09, 2], [0x05, 2], [0x03, 0], [0x08, 1], [0x01, 14074000]]);
  const manual = S.setupCommands(S.normalizeSdrSettings({ gain: 33.8 }), 0).map((b) => [b[0], b.readInt32BE(1)]);
  assert.deepStrictEqual(manual.slice(-3), [[0x03, 1], [0x08, 0], [0x04, 338]], 'manual gain is in tenths of a dB, AGC off');
});

test('settings normalise to safe defaults', () => {
  const d = S.normalizeSdrSettings(undefined);
  assert.deepStrictEqual(d, { enabled: false, host: '127.0.0.1', port: 1234, sampleRate: 1024000, gain: 'auto', directSampling: 'off', ppm: 0, offsetHz: 0, preferSdr: false });
  assert.strictEqual(S.normalizeSdrSettings({ sampleRate: 999 }).sampleRate, 1024000, 'an invalid RTL2832 rate falls back');
  assert.strictEqual(S.normalizeSdrSettings({ port: 99999 }).port, 1234);
  assert.strictEqual(S.normalizeSdrSettings({ directSampling: 'Q' }).directSampling, 'q');
});

test('the SDR tunes to the dial plus the offset (IF tap, upconverter)', () => {
  assert.strictEqual(S.sdrCenterForDial(14074000, 0), 14074000);
  assert.strictEqual(S.sdrCenterForDial(14074000, 125000000), 139074000);
  assert.strictEqual(S.sdrCenterForDial(0, 125000000), 0, 'no dial, no tune');
});

// ─── spectrum ────────────────────────────────────────────────────────────────

test('FFT: a pure tone lands in its bin', () => {
  const n = 1024, k = 37;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) { re[i] = Math.cos(2 * Math.PI * k * i / n); im[i] = Math.sin(2 * Math.PI * k * i / n); }
  S.fftInPlace(re, im);
  let m = 0, at = 0;
  for (let i = 0; i < n; i++) { const p = re[i] * re[i] + im[i] * im[i]; if (p > m) { m = p; at = i; } }
  assert.strictEqual(at, k);
  assert.ok(Math.abs(m - n * n) < 1e-6 * n * n);
});

for (const [rate, tone] of [[1024000, 100000], [1024000, -250000], [250000, 30000], [2048000, 600000]]) {
  test(`a ${tone / 1000} kHz tone at ${rate / 1e6} MS/s draws where the axis says`, () => {
    const sb = new S.SpectrumBuilder({ sampleRate: rate });
    const frames = [];
    sb.on('frame', (f) => frames.push(f));
    const iq = toneIq(rate, tone, Math.round(rate / 3));
    for (let o = 0; o < iq.length; o += 3001) sb.feed(iq.subarray(o, Math.min(iq.length, o + 3001))); // odd chunks
    assert.ok(frames.length >= 3, 'about 12 frames a second: ' + frames.length);
    const f = frames[frames.length - 1];
    assert.strictEqual(f.wf1.length, 850);
    assert.strictEqual(f.kind, 0);
    assert.strictEqual(f.aligned, true);
    const dial = 14074000;
    const axis = A.scopeAxis({ centerHz: dial, spanHz: S.spanForRate(rate) });
    const hz = A.binToHz(axis, peakBin(f.wf1));
    assert.ok(Math.abs(hz - (dial + tone)) <= axis.hzPerBin * 1.5, `peak at ${hz}, expected ${dial + tone} (±${axis.hzPerBin})`);
    // click-to-tune: the bin under the cursor maps back to the tone
    assert.ok(Math.abs(A.hzToBin(axis, dial + tone) - peakBin(f.wf1)) <= 1.5);
  });
}

test('frames come at ~12/s whatever the sample rate (the rest of the IQ is skipped)', () => {
  for (const rate of [250000, 2048000]) {
    const sb = new S.SpectrumBuilder({ sampleRate: rate });
    let n = 0;
    sb.on('frame', () => n++);
    sb.feed(toneIq(rate, 10000, rate)); // one second of IQ
    assert.ok(n >= 11 && n <= 13, `${rate}: ${n} frames in a second`);
  }
});

test('the DC spike at the centre is notched out', () => {
  const rate = 1024000;
  const sb = new S.SpectrumBuilder({ sampleRate: rate });
  const frames = [];
  sb.on('frame', (f) => frames.push(f));
  sb.feed(toneIq(rate, 0, rate / 4, { amp: 0, dc: 40, noise: 6 })); // DC offset only, no tone
  const f = frames[frames.length - 1];
  const mid = 424;
  const around = (f.wf1[mid - 30] + f.wf1[mid + 30]) / 2;
  assert.ok(Math.abs(f.wf1[mid] - around) < 40, `centre ${f.wf1[mid]} vs neighbours ${around}`);
});

test('the noise floor tracks gain: louder noise does not whiten the picture', () => {
  const rate = 1024000;
  const median = (lv) => [...lv].sort((a, b) => a - b)[425];
  const run = (noise) => {
    const sb = new S.SpectrumBuilder({ sampleRate: rate });
    let last = null;
    sb.on('frame', (f) => { last = f; });
    sb.feed(toneIq(rate, 100000, rate, { amp: 20, noise }));
    return median(last.wf1);
  };
  const quiet = run(2), loud = run(20);
  assert.ok(quiet < 80 && loud < 80, `noise stays low on screen: ${quiet} / ${loud}`);
});

// ─── the client against a fake rtl_tcp ───────────────────────────────────────

test('client: greeting, queued setup commands, IQ aligned to whole pairs', async () => {
  const rate = 1024000;
  const fake = await fakeServer({ iq: toneIq(rate, 100000, rate / 2) });
  const c = new S.RtlTcpClient({ host: '127.0.0.1', port: fake.port });
  const cfg = S.normalizeSdrSettings({ sampleRate: rate });
  for (const b of S.setupCommands(cfg, 7074000)) c.send(b); // before the connection exists
  const sb = new S.SpectrumBuilder({ sampleRate: rate });
  let hdr = null, odd = 0, bytes = 0;
  const frames = [];
  c.on('header', (h) => { hdr = h; });
  c.on('iq', (d) => { if (d.length & 1) odd++; bytes += d.length; sb.feed(d); });
  sb.on('frame', (f) => frames.push(f));
  c.start();
  try {
    await until(() => bytes >= rate - 2);
    assert.strictEqual(hdr.tunerName, 'R820T/R820T2');
    assert.strictEqual(odd, 0, 'every IQ chunk holds whole I/Q pairs');
    await until(() => fake.commands.length >= 6);
    assert.deepStrictEqual(fake.commands.map((x) => x.cmd), [0x02, 0x09, 0x05, 0x03, 0x08, 0x01], 'setup sent after the greeting, in order');
    assert.strictEqual(fake.commands[5].param, 7074000);
    c.setFrequency(14074000);
    await until(() => fake.commands.length >= 7);
    assert.deepStrictEqual(fake.commands[6], { cmd: 0x01, param: 14074000, signed: 14074000 });
    const axis = A.scopeAxis({ centerHz: 14074000, spanHz: S.spanForRate(rate) });
    assert.ok(Math.abs(A.binToHz(axis, peakBin(frames[frames.length - 1].wf1)) - 14174000) <= axis.hzPerBin * 1.5);
    assert.strictEqual(c.state, 'live');
  } finally { c.stop(); await fake.close(); }
});

test('client: nothing listening = "refused", retried with backoff', async () => {
  const probe = await fakeServer();
  const port = probe.port;
  await probe.close();
  const c = new S.RtlTcpClient({ host: '127.0.0.1', port, backoffMs: 50 });
  const problems = [];
  c.on('problem', (p) => problems.push(p));
  c.start();
  try {
    await until(() => problems.length >= 2);
    assert.strictEqual(problems[0].key, 'refused');
    assert.ok(/Nothing is listening/.test(problems[0].headline));
    assert.ok(/rtl_tcp|rsp_tcp/.test(problems[0].action));
  } finally { c.stop(); }
  assert.strictEqual(c.state, 'closed');
});

test('client: a server that never greets is named, not hung on', async () => {
  const fake = await fakeServer({ garbage: Buffer.from('SSH-2.0-OpenSSH\r\n') });
  const c = new S.RtlTcpClient({ host: '127.0.0.1', port: fake.port, backoffMs: 5000 });
  const problems = [];
  c.on('problem', (p) => problems.push(p));
  c.start();
  try {
    await until(() => problems.length >= 1);
    assert.strictEqual(problems[0].key, 'no-header');
  } finally { c.stop(); await fake.close(); }
});

test('client: samples stop = "stalled", then it reconnects on its own', async () => {
  const fake = await fakeServer({ iq: null }); // greets, then silence
  const c = new S.RtlTcpClient({ host: '127.0.0.1', port: fake.port, stallMs: 150, backoffMs: 50 });
  const problems = [];
  let headers = 0;
  c.on('problem', (p) => problems.push(p));
  c.on('header', () => headers++);
  c.start();
  try {
    await until(() => problems.some((p) => p.key === 'stalled') && headers >= 2, 4000);
    assert.ok(fake.conns >= 2, 'reconnected');
  } finally { c.stop(); await fake.close(); }
});

test('client: the server dropping the connection is recovered', async () => {
  const rate = 250000;
  const fake = await fakeServer({ iq: toneIq(rate, 10000, 5000) });
  const c = new S.RtlTcpClient({ host: '127.0.0.1', port: fake.port, backoffMs: 50, stallMs: 60000 });
  let headers = 0;
  c.on('header', () => headers++);
  c.start();
  try {
    await until(() => headers >= 1);
    fake.kick();
    await until(() => headers >= 2, 4000);
  } finally { c.stop(); await fake.close(); }
});

// ─── main.js wiring (source guards) ──────────────────────────────────────────

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function bodyOf(name) {
  const start = MAIN.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found');
  let d = 0, i = MAIN.indexOf('{', start);
  for (; i < MAIN.length; i++) { if (MAIN[i] === '{') d++; else if (MAIN[i] === '}' && --d === 0) break; }
  return MAIN.slice(start, i + 1);
}

test('main: any rig with an SDR source advertises a scope', () => {
  assert.ok(/if \(!caps\.nativeScope && sdrScopeSettingsForActiveRig\(\)\.enabled\) caps\.nativeScope = 'sdr';/.test(bodyOf('getRigCapabilities')));
  const k = bodyOf('scopeSourceKind');
  assert.ok(/sdr\.enabled && \(sdr\.preferSdr \|\| \(!native && !icom && !flex\)\)/.test(k), 'the radio\'s own scope (FT-710, Icom, Flex Direct pan) wins unless the SDR is preferred');
  assert.ok(/available: yaesuScopeSynth \|\| !!scopeSourceKind\(\)/.test(bodyOf('yaesuScopeStatePayload')));
  assert.ok(/available: yaesuScopeSynth \|\| !!scopeSourceKind\(\)/.test(bodyOf('yaesuScopeRemotePayload')));
  assert.ok(/source: s\.source/.test(bodyOf('yaesuScopeRemotePayload')), 'ECHOCAT learns the source (explicit field list)');
});

test('main: start/stop/follow route through the one scope state', () => {
  assert.ok(/const kind = synth \? null : scopeSourceKind\(\);/.test(bodyOf('startYaesuScope')) && /if \(kind === 'sdr'\) \{ startSdrScope\(\); return; \}/.test(bodyOf('startYaesuScope')));
  assert.ok(/if \(sdrScopeClient\) \{ stopSdrScope\(why\); return; \}/.test(bodyOf('stopYaesuScope')));
  assert.ok(/sdrScopeFollowDial\(hz\)/.test(bodyOf('yaesuScopeNoteFrequency')), 'the dial sink retunes the SDR');
  const st = bodyOf('startSdrScope');
  assert.ok(/yaesuScopeOnFrame\(f\)/.test(st), 'frames go through the same fan-out as the FT-710');
  assert.ok(/client\.on\('header', \(h\) => \{[\s\S]{0,200}setupCommands\(cfg, sdrScopeTunedHz\)/.test(st), 'setup is re-sent on every (re)connect');
  assert.ok(/anchor: 'center'/.test(st) && /spanForRate\(cfg\.sampleRate\)/.test(st), 'a known, centred axis');
  assert.ok(/setTimeout\([\s\S]*150\)/.test(bodyOf('sdrScopeFollowDial')), 'retune is debounced');
  assert.ok(/sdrScopeSettingsChanged\(sdrScopeBefore, sdrScopeSettingsForActiveRig\(\)\)/.test(MAIN), 'a settings save restarts on the new source');
});

test('renderer: the rig editor saves rig.sdrScope and the pop-out labels the source', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.ok(/rig\.sdrScope = rigSdrScope/.test(app));
  assert.ok(/fillSdrScopeForm\(rig\.sdrScope\)/.test(app));
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  for (const id of ['set-sdr-scope-enabled', 'set-sdr-scope-host', 'set-sdr-scope-port', 'set-sdr-scope-rate', 'set-sdr-scope-gain', 'set-sdr-scope-direct', 'set-sdr-scope-ppm', 'set-sdr-scope-offset', 'set-sdr-scope-prefer']) {
    assert.ok(html.includes('id="' + id + '"'), id);
  }
  const pop = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'scope-popout.js'), 'utf8');
  assert.ok(/state\.source === 'sdr'/.test(pop));
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message || e)); }
  }
  console.log(`\nSDR band scope: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
