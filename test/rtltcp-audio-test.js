#!/usr/bin/env node
'use strict';
/**
 * Listening through an rtl_tcp server (lib/rtltcp-demod.js, lib/rtltcp-audio.js):
 * the demodulator on generated IQ at all three rates, the probe, the client
 * against a FAKE rtl_tcp server (own connection and shared with the band
 * scope), and the main.js wiring. (Casey 2026-10-29: "add support for RTL_TCP nodes".)
 *
 * Run: node test/rtltcp-audio-test.js
 */
const assert = require('assert');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const D = require('../lib/rtltcp-demod');
const R = require('../lib/rtltcp-audio');
const S = require('../lib/sdr-scope');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

// ─── helpers ─────────────────────────────────────────────────────────────────

/** u8 IQ from fn(t) -> [i, q] in -1..1 (scaled to +-60 counts, a little noise). */
function iqOf(rate, n, fn, { amp = 60, noise = 2 } = {}) {
  const b = Buffer.alloc(n * 2);
  let seed = 4242;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
  for (let i = 0; i < n; i++) {
    const [r, q] = fn(i / rate);
    b[2 * i] = Math.max(0, Math.min(255, Math.round(127.5 + amp * r + noise * rnd())));
    b[2 * i + 1] = Math.max(0, Math.min(255, Math.round(127.5 + amp * q + noise * rnd())));
  }
  return b;
}
const tone = (hz) => (t) => { const p = 2 * Math.PI * hz * t; return [Math.cos(p), Math.sin(p)]; };

function goertzel(x, fs, f) {
  let s1 = 0, s2 = 0;
  const c = 2 * Math.cos(2 * Math.PI * f / fs);
  for (let i = 0; i < x.length; i++) { const s = x[i] + c * s1 - s2; s2 = s1; s1 = s; }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}
function peakHz(x, fs) {
  let best = 0, at = 0;
  for (let f = 100; f <= 5000; f += 10) { const p = goertzel(x, fs, f); if (p > best) { best = p; at = f; } }
  return at;
}
function rms(x) { let s = 0; for (const v of x) s += v * v; return Math.sqrt(s / Math.max(1, x.length)); }

/** Run IQ through a demodulator in odd-sized chunks; the audio after the filters settle. */
function demodulate(d, iq, chunkBytes = 20002) {
  const parts = [];
  for (let o = 0; o < iq.length; o += chunkBytes) parts.push(d.processU8(iq.subarray(o, Math.min(iq.length, o + chunkBytes))).audio);
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(n);
  let k = 0;
  for (const p of parts) { out.set(p, k); k += p.length; }
  return out.subarray(Math.floor(n / 4)); // skip the first quarter: filter + AGC settling
}

function header(tuner = 5, gains = 29) {
  const b = Buffer.alloc(12);
  b.write('RTL0', 0, 'latin1');
  b.writeUInt32BE(tuner, 4);
  b.writeUInt32BE(gains, 8);
  return b;
}

/** A fake rtl_tcp: greets, records commands, streams `iqFor()` while connected. */
function fakeServer({ greet = true, iqFor = null } = {}) {
  const commands = [];
  let conns = 0;
  const sockets = new Set();
  const server = net.createServer((sock) => {
    conns++;
    sockets.add(sock);
    let timer = null;
    sock.on('close', () => { sockets.delete(sock); if (timer) clearInterval(timer); });
    let pending = Buffer.alloc(0);
    sock.on('data', (d) => {
      pending = Buffer.concat([pending, d]);
      while (pending.length >= 5) {
        commands.push({ cmd: pending[0], param: pending.readUInt32BE(1) });
        pending = pending.subarray(5);
      }
    });
    sock.on('error', () => {});
    if (!greet) return; // an HTTP server: silent until asked
    sock.write(header());
    if (iqFor) timer = setInterval(() => { if (!sock.destroyed) sock.write(iqFor(commands)); }, 20);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    commands, port: server.address().port,
    get conns() { return conns; },
    close() { for (const s of sockets) s.destroy(); return new Promise((r) => server.close(() => r())); },
  })));
}

function until(cond, ms = 4000) {
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

console.log('rtl_tcp listening');

// ─── the demodulator ─────────────────────────────────────────────────────────

test('rate plans give whole-number audio rates near 12.5 kHz', () => {
  assert.deepStrictEqual([250000, 1024000, 2048000].map((r) => D.ratePlan(r).audioRate), [12500, 12800, 12800]);
  const odd = D.ratePlan(1800000);
  assert.ok(odd.ifRate >= 48000 && odd.audioRate > 8000, 'any other rate still lands at a usable IF');
});

for (const rate of [250000, 1024000, 2048000]) {
  const off = 25000;
  const n = rate / 2; // half a second
  test(`${rate / 1000} kS/s: USB hears a tone 1 kHz above the dial at 1 kHz, and not one 1 kHz below`, () => {
    const d = new D.Demodulator({ inputRate: rate, mode: 'usb', offsetHz: off });
    const a = demodulate(d, iqOf(rate, n, tone(off + 1000)));
    assert.strictEqual(peakHz(a, d.audioRate), 1000);
    const quiet = new D.Demodulator({ inputRate: rate, mode: 'usb', offsetHz: off, agc: false });
    const loud = new D.Demodulator({ inputRate: rate, mode: 'usb', offsetHz: off, agc: false });
    const wrong = rms(demodulate(quiet, iqOf(rate, n, tone(off - 1000))));
    const right = rms(demodulate(loud, iqOf(rate, n, tone(off + 1000))));
    assert.ok(20 * Math.log10(right / wrong) > 40, `the other sideband is ${(20 * Math.log10(right / wrong)).toFixed(1)} dB down`);
  });
  test(`${rate / 1000} kS/s: LSB hears 1.3 kHz below the dial as 1.3 kHz; CW plays a carrier as 600 Hz`, () => {
    const l = new D.Demodulator({ inputRate: rate, mode: 'lsb', offsetHz: off });
    assert.strictEqual(peakHz(demodulate(l, iqOf(rate, n, tone(off - 1300))), l.audioRate), 1300);
    const c = new D.Demodulator({ inputRate: rate, mode: 'cw', offsetHz: off });
    assert.strictEqual(peakHz(demodulate(c, iqOf(rate, n, tone(off))), c.audioRate), D.CW_PITCH_HZ);
  });
  test(`${rate / 1000} kS/s: AM and FM recover a 1 kHz modulating tone`, () => {
    const am = new D.Demodulator({ inputRate: rate, mode: 'am', offsetHz: off });
    const amIq = iqOf(rate, n, (t) => { const a = 0.5 * (1 + 0.5 * Math.cos(2 * Math.PI * 1000 * t)); const p = 2 * Math.PI * off * t; return [a * Math.cos(p), a * Math.sin(p)]; });
    const amA = demodulate(am, amIq);
    assert.strictEqual(peakHz(amA, am.audioRate), 1000);
    assert.ok(rms(amA) > 0.05);
    const fm = new D.Demodulator({ inputRate: rate, mode: 'nbfm', offsetHz: off });
    const fmIq = iqOf(rate, n, (t) => { const p = 2 * Math.PI * off * t + 3 * Math.sin(2 * Math.PI * 1000 * t); return [Math.cos(p), Math.sin(p)]; });
    const fmA = demodulate(fm, fmIq);
    assert.strictEqual(peakHz(fmA, fm.audioRate), 1000);
    // 3 kHz deviation on a 5 kHz full scale, halved: ~0.3 peak, ~0.21 rms.
    assert.ok(Math.abs(rms(fmA) - 0.212) < 0.03, 'FM level ' + rms(fmA).toFixed(3));
  });
}

test('the output does not depend on how TCP chopped the stream', () => {
  const rate = 250000;
  const iq = iqOf(rate, 60000, tone(26000));
  const a = demodulate(new D.Demodulator({ inputRate: rate, offsetHz: 25000, agc: false }), iq, 60000 * 2);
  const b = demodulate(new D.Demodulator({ inputRate: rate, offsetHz: 25000, agc: false }), iq, 3998);
  assert.strictEqual(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-4, 'sample ' + i);
});

test('mode names every tune site sends map onto five demodulators', () => {
  assert.deepStrictEqual(['usb', 'DIGU', 'ft8', 'lsb', 'PKTLSB', 'cw', 'cwn', 'am', 'nbfm', 'FM'].map(D.normalizeMode),
    ['usb', 'usb', 'usb', 'lsb', 'lsb', 'cw', 'cw', 'am', 'fm', 'fm']);
});

test('the relative S-meter: noise reads S1, 48 dB over it reads S9', () => {
  const m = new D.RelativeMeter();
  assert.strictEqual(m.update(-60, 0), -121);
  assert.strictEqual(m.update(-12, 0), -73);
  assert.ok(Math.abs(m.update(-12, 0.2) - -73.1) < 1e-9, 'the floor rises 0.5 dB a second');
  assert.strictEqual(m.update(-70, 0.2), -121, 'the floor falls at once');
});

// ─── the probe ───────────────────────────────────────────────────────────────

test('probe: an rtl_tcp server answers RTL0; a silent (HTTP) server is not one', async () => {
  const rtl = await fakeServer();
  const http = await fakeServer({ greet: false });
  try {
    const h = await R.probeRtlTcp('127.0.0.1', rtl.port, 1000);
    assert.ok(h && h.tunerName === 'R820T/R820T2');
    assert.strictEqual(await R.probeRtlTcp('127.0.0.1', http.port, 300), null);
    assert.strictEqual(await R.probeRtlTcp('127.0.0.1', 1, 300), null, 'nothing listening');
  } finally { await rtl.close(); await http.close(); }
});

// ─── the client ──────────────────────────────────────────────────────────────

test('own connection: 250 kS/s, the SDR 25 kHz below the dial, USB audio of the signal above it', async () => {
  const rate = 250000;
  // The fake SDR always sends a tone 1 kHz above wherever the client put the dial.
  let phase = 0;
  const fake = await fakeServer({ iqFor: (cmds) => {
    const f = [...cmds].reverse().find((c) => c.cmd === S.CMD.FREQ);
    const center = f ? f.param : 0;
    const n = 5000;
    const b = Buffer.alloc(n * 2);
    const hz = 14074000 + 1000 - center;
    for (let i = 0; i < n; i++) {
      phase += 2 * Math.PI * hz / rate;
      b[2 * i] = Math.round(127.5 + 60 * Math.cos(phase));
      b[2 * i + 1] = Math.round(127.5 + 60 * Math.sin(phase));
    }
    return b;
  } });
  const c = new R.RtlTcpAudioClient({ worker: false });
  const audio = [];
  let rateSeen = 0, meter = null;
  c.on('audio', (a, sr) => { audio.push(a); rateSeen = sr; });
  c.on('smeter', (v) => { meter = v; });
  try {
    c.tune(14074, 'usb');
    c.connect('127.0.0.1', fake.port);
    await until(() => c.connected);
    await until(() => audio.reduce((n, a) => n + a.length, 0) > 8000);
    const rateCmd = fake.commands.find((x) => x.cmd === S.CMD.SAMPLE_RATE);
    assert.strictEqual(rateCmd.param, 250000);
    assert.strictEqual(fake.commands.find((x) => x.cmd === S.CMD.FREQ).param, 14074000 - 25000);
    const all = Float32Array.from(audio.flatMap((a) => Array.from(a))).subarray(3000);
    assert.strictEqual(rateSeen, 12500);
    assert.ok(audio.every((a) => a.length >= 1024), 'packets of >= 1024 samples, as a Kiwi sends');
    assert.strictEqual(peakHz(all, rateSeen), 1000);
    assert.ok(meter != null);
    // A QSY inside the window moves only the demodulator; one outside retunes.
    const freqs = () => fake.commands.filter((x) => x.cmd === S.CMD.FREQ).length;
    const before = freqs();
    c.tune(14080, 'usb');
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(freqs(), before, '6 kHz away: no retune');
    c.tune(14300, 'usb');
    await until(() => freqs() === before + 1);
    assert.strictEqual(fake.commands.filter((x) => x.cmd === S.CMD.FREQ).pop().param, 14300000 - 25000);
  } finally { c.disconnect(); await fake.close(); }
});

test('nothing at the address: an error after three tries, then disconnected', async () => {
  const c = new R.RtlTcpAudioClient({ worker: false, backoffMs: 20 });
  let err = null;
  c.on('error', (m) => { err = m; });
  c.connect('127.0.0.1', 1);
  await until(() => err != null, 3000);
  assert.ok(/Nothing is listening/.test(err), err);
  assert.strictEqual(c.connected, false);
  c.disconnect();
});

test('shared with the band scope: the scope\'s IQ, its centre, and back to its own connection when the scope stops', async () => {
  const fake = await fakeServer();
  const scope = new EventEmitter();
  const rate = 1024000;
  const c = new R.RtlTcpAudioClient({ worker: false });
  const audio = [];
  c.on('audio', (a) => audio.push(a));
  try {
    c.host = '127.0.0.1';
    c.port = fake.port;
    c.tune(7074, 'usb');
    c.attach(scope, { sampleRate: rate, centerHz: () => 7074000 }); // the scope centres the SDR on the dial
    assert.strictEqual(c.connected, true);
    assert.strictEqual(c.shared, true);
    assert.strictEqual(fake.conns, 0, 'the scope holds the server; no second connection');
    scope.emit('iq', iqOf(rate, rate / 4, tone(1500)));
    const all = Float32Array.from(audio.flatMap((a) => Array.from(a))).subarray(1000);
    assert.strictEqual(peakHz(all, 12800), 1500);
    c.detach();
    await until(() => fake.conns === 1);
    assert.strictEqual(c.shared, false);
    assert.strictEqual(c.connected, true, 'still listening');
  } finally { c.disconnect(); await fake.close(); }
});

test('the worker gives the same audio as the inline path', async () => {
  const rate = 250000;
  const scope = new EventEmitter();
  const c = new R.RtlTcpAudioClient({});
  const audio = [];
  c.on('audio', (a, sr) => audio.push({ a, sr }));
  try {
    c.tune(14074, 'usb');
    c.attach(scope, { sampleRate: rate, centerHz: () => 14074000 - 25000 });
    const iq = iqOf(rate, rate / 2, tone(25000 + 800));
    for (let o = 0; o < iq.length; o += 32768) scope.emit('iq', iq.subarray(o, o + 32768));
    await until(() => audio.reduce((n, x) => n + x.a.length, 0) > 5000);
    const all = Float32Array.from(audio.flatMap((x) => Array.from(x.a))).subarray(1000);
    assert.strictEqual(peakHz(all, audio[0].sr), 800);
  } finally { c.disconnect(); }
});

// ─── main.js wiring ──────────────────────────────────────────────────────────

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function bodyOf(name) {
  const start = MAIN.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' exists');
  let depth = 0, i = MAIN.indexOf('{', start);
  for (; i < MAIN.length; i++) { if (MAIN[i] === '{') depth++; else if (MAIN[i] === '}' && --depth === 0) break; }
  return MAIN.slice(start, i + 1);
}

test('main.js: kiwi-connect probes any port but 8073, and a newer connect wins', () => {
  const at = MAIN.indexOf("ipcMain.on('kiwi-connect', async");
  assert.ok(at > 0, 'the handler is async (the probe)');
  const h = MAIN.slice(at, at + 9000);
  assert.ok(/const isKiwi = port === 8073/.test(h));
  assert.ok(/isKiwi \|\| scopeShare \? null : await RtlTcpAudio\.probeRtlTcp\(host, port, 1000\)/.test(h));
  assert.ok(/if \(seq !== kiwiConnectSeq\) return;/.test(h));
  assert.ok(/new RtlTcpAudio\.RtlTcpAudioClient\(\{ sdr: rtlTcpSdrSettingsFor\(host, port\) \}\)/.test(h));
  assert.ok(/kiwiClient\.attach\(scopeShare\.client, scopeShare\)/.test(h), 'shares a server the scope already holds');
  assert.ok(/kiwiKind = sdrKind;/.test(h) && /kind: kiwiKind \|\| undefined/.test(MAIN), 'kiwi-status names the kind to windows and ECHOCAT (broadcastKiwiStatus)');
});

test('main.js: the band scope hands the server to and from a listener', () => {
  assert.ok(/rtlTcpListenerFor\(cfg\.host, cfg\.port\)[\s\S]{0,120}listener\.attach\(client, rtlTcpScopeShareOf\(client, cfg\)\)[\s\S]{0,40}client\.start\(\)/.test(bodyOf('startSdrScope')),
    'the listener lets go BEFORE the scope connects (rtl_tcp takes one client)');
  assert.ok(/kiwiClient\.shared\) kiwiClient\.detach\(\);\s*client\.stop\(\)/.test(bodyOf('stopSdrScope')));
  assert.ok(/sdrScopeTunedHz/.test(bodyOf('rtlTcpScopeShareOf')), 'the shared centre is where the scope has the SDR');
});

test('the protocol registers kiwi-status kind', () => {
  const P = require('../lib/echocat-protocol');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'echocat-protocol.js'), 'utf8');
  assert.ok(/'kiwi-status':[^\n]*kind: f\.optString/.test(src));
  assert.ok(P);
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message || e)); }
  }
  console.log(`\nrtl_tcp listening: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
