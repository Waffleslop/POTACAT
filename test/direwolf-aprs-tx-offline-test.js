#!/usr/bin/env node
'use strict';
// APRS phase 7, offline with the bundled Dire Wolf: the transmit config keys
// ONLY through a fake rigctld shim (lib/rigctld-server.js on a random loopback
// port; no radio, no rigctld, no APRS-IS), sends the one AGW 'V' frame POTACAT
// hands it as AFSK on the socket audio, and lets go. The audio it played is
// then fed to the listen-only config, which must decode the same packet: what
// would go on the air is what POTACAT built, with the path per band.
// The 2 m pass also holds the channel busy first: Dire Wolf must not ask for
// PTT until the busy signal has ended (its clear-channel wait).
//
// Needs the POTACAT build of Dire Wolf (socket audio and Hamlib): assets/direwolf/
// or POTACAT_DIREWOLF_BIN. Without it the test says so and passes.
// Run: node test/direwolf-aprs-tx-offline-test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const D = require('../lib/direwolf-process');
const Mon = require('../lib/direwolf-agw-monitor');
const R = require('../lib/aprs-rf-beacon');
const AprsRfFrames = require('../lib/aprs-rf-frames');
const AprsParser = require('../lib/aprs-parser');
const { createRigctldServer } = require('../lib/rigctld-server');

const RATE = D.DIREWOLF_RATE;
const CHUNK = RATE / 50 * 2; // 20 ms of 16-bit mono

function findBin() {
  if (process.env.POTACAT_DIREWOLF_BIN) return process.env.POTACAT_DIREWOLF_BIN;
  const p = path.join(__dirname, '..', 'assets', 'direwolf', D.direwolfBinaryName(process.platform));
  return fs.existsSync(p) ? p : '';
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const randPort = () => 20000 + Math.floor(Math.random() * 20000);

/** A socket audio server: sends what is queued (else silence) by the clock, records what the modem plays. */
async function audioServer() {
  const s = { queue: [], played: [], firstPlayAt: 0 };
  s.server = net.createServer((sock) => {
    const t0 = Date.now(); let sent = 0;
    const t = setInterval(() => {
      const due = Math.floor((Date.now() - t0) / 20);
      while (sent < due) { sent++; try { sock.write(s.queue.length ? s.queue.shift() : Buffer.alloc(CHUNK)); } catch {} }
    }, 10);
    sock.on('data', (b) => { if (!s.firstPlayAt) s.firstPlayAt = Date.now(); s.played.push(b); });
    sock.on('close', () => clearInterval(t));
    sock.on('error', () => clearInterval(t));
  });
  await new Promise((r) => s.server.listen(0, '127.0.0.1', r));
  s.port = s.server.address().port;
  return s;
}

async function startDw(bin, dir, name, conf, agwPort) {
  fs.writeFileSync(path.join(dir, name), conf);
  const p = spawn(bin, D.buildDirewolfArgs({ configName: name }), { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  p.out = '';
  p.stdout.on('data', (d) => { p.out += d; });
  p.stderr.on('data', (d) => { p.out += d; });
  const until = Date.now() + 15000;
  while (Date.now() < until && !(await D.probeAgwPort({ port: agwPort })).ok) await wait(200);
  return p;
}

async function agw(port, onFrame) {
  const sock = net.connect({ host: '127.0.0.1', port });
  const parser = new Mon.AgwFrameParser();
  sock.on('data', (c) => { for (const f of parser.push(c)) onFrame(f); });
  await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j); });
  return sock;
}

/** 1200-baud Bell 202 noise-like busy signal: alternating tones, no valid frame but DCD-worthy flags. */
function busyFlags(ms) {
  // A run of HDLC flags (0x7E) as 1200-baud AFSK: Dire Wolf's DCD sees a carrier with data.
  const spb = RATE / 1200, pcm = [];
  let tone = 1200, phase = 0, acc = 0;
  const nbits = Math.floor(ms / 1000 * 1200);
  for (let i = 0; i < nbits; i++) {
    const b = (0x7e >> (i % 8)) & 1;
    if (b === 0) tone = tone === 1200 ? 2200 : 1200;
    acc += spb;
    while (acc >= 1) { phase += 2 * Math.PI * tone / RATE; pcm.push(Math.round(Math.sin(phase) * 12000)); acc -= 1; }
  }
  const buf = Buffer.alloc(pcm.length * 2);
  pcm.forEach((v, i) => buf.writeInt16LE(v, i * 2));
  const out = [];
  for (let i = 0; i < buf.length; i += CHUNK) out.push(buf.subarray(i, Math.min(buf.length, i + CHUNK)));
  return out;
}

async function oneBand(bin, band, { busyMs = 0 } = {}) {
  const r = { ptt: [], frames: [], out: '' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-dw-tx-'));
  const shim = createRigctldServer({
    getFreqHz: () => (band === '2m' ? 144390000 : 10147600),
    setFreqHz: () => false, // the beacon never tunes
    getPtt: () => r.ptt.length > 0 && r.ptt[r.ptt.length - 1].on,
    setPtt: (on) => { r.ptt.push({ on, at: Date.now() }); return true; },
  }, { host: '127.0.0.1' });
  const shimPort = await shim.listen(0);
  const audio = await audioServer();
  const agwPort = randPort();
  const beacon = R.buildRfBeacon({ settingsCall: 'K0TST', band, lat: 40.5123, lon: -75.0456, symbol: 'house', comment: 'offline test', approx: true });
  assert.ok(beacon.ok, JSON.stringify(beacon));
  r.packet = beacon.packet;
  const conf = D.buildDirewolfAprsTxConfig({ mycall: beacon.source, audioPort: audio.port, agwPort, shimPort, band, txDelayMs: 300, txTailMs: 100 });
  let p = null, sock = null;
  try {
    p = await startDw(bin, dir, 'aprs-tx.conf', conf, agwPort);
    sock = await agw(agwPort, () => {});
    if (busyMs) { for (const c of busyFlags(busyMs)) audio.queue.push(c); r.busyEndsAt = Date.now() + busyMs; await wait(200); }
    r.sentAt = Date.now();
    sock.write(R.encodeAgwUnproto(R.agwRequest(beacon)));
    const until = Date.now() + 20000 + busyMs;
    while (Date.now() < until && !(r.ptt.length >= 2 && !r.ptt[r.ptt.length - 1].on)) await wait(50);
    await wait(300);
  } finally {
    if (sock) sock.destroy();
    if (p) { r.out = p.out; p.kill(); }
    await shim.close();
    audio.server.close();
  }
  r.played = Buffer.concat(audio.played);

  // Decode what it played with the listen-only config.
  const audio2 = await audioServer();
  const agw2 = randPort();
  let p2 = null, sock2 = null;
  try {
    p2 = await startDw(bin, dir, 'aprs-rx.conf', D.buildDirewolfAprsRxConfig({ mycall: 'N0CALL', audioPort: audio2.port, agwPort: agw2, band }), agw2);
    sock2 = await agw(agw2, (f) => r.frames.push(f));
    sock2.write(Mon.encodeAgwFrame({ datakind: 'm' }));
    await wait(300);
    for (let i = 0; i < r.played.length; i += CHUNK) audio2.queue.push(r.played.subarray(i, i + CHUNK));
    const end = Date.now() + audio2.queue.length * 40 + 3000;
    while (Date.now() < end && !r.frames.some((f) => Mon.isReceivedFrame(f))) await wait(200);
  } finally {
    if (sock2) sock2.destroy();
    if (p2) p2.kill();
    audio2.server.close();
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  return r;
}

async function main() {
  console.log('Dire Wolf APRS transmit config, offline (fake shim, no radio)');
  const bin = findBin();
  if (!bin || !fs.existsSync(bin)) {
    console.log('  skip  no POTACAT Dire Wolf build here (assets/direwolf or POTACAT_DIREWOLF_BIN)');
    console.log('\n0 passed, 0 failed (skipped)');
    return;
  }
  let pass = 0, fail = 0;
  const test = (name, fn) => {
    try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
  };

  for (const band of ['30m', '2m']) {
    const r = await oneBand(bin, band, { busyMs: band === '2m' ? 2500 : 0 });
    const got = r.frames.map((f) => AprsRfFrames.packet(f, AprsParser.parse)).filter(Boolean);
    test(`${band}: Dire Wolf read the transmit config with no complaint`, () => {
      assert.ok(!/^Line \d+:/m.test(r.out), r.out.slice(0, 600));
      assert.ok(!/only available when hamlib|Unable to (open|initialize)/i.test(r.out), r.out.slice(0, 600));
    });
    test(`${band}: keyed once through the shim, then let go`, () => {
      assert.deepStrictEqual(r.ptt.map((x) => x.on), [true, false], JSON.stringify(r.ptt) + ' ' + r.out.slice(-500));
    });
    test(`${band}: the key-down lasted less than the beacon's cap`, () => {
      const held = r.ptt[1].at - r.ptt[0].at;
      const cap = R.capFor({ band, packet: r.packet, txDelayMs: 300, txTailMs: 100, drainMs: 250 }).capMs;
      assert.ok(held > 0 && held < cap, `held ${held} ms, cap ${cap} ms`);
    });
    test(`${band}: what it played decodes back to the packet POTACAT built (path per band)`, () => {
      assert.ok(got.length >= 1, 'decoded ' + got.length + ' (played ' + r.played.length + ' bytes)');
      const line = AprsRfFrames.fromMonitorFrame(r.frames.find((f) => Mon.isReceivedFrame(f))).line;
      assert.strictEqual(line, r.packet);
    });
    if (band === '2m') {
      test('2m: no key-down while the channel was busy (Dire Wolf waited for it to clear)', () => {
        assert.ok(r.ptt[0].at >= r.busyEndsAt - 100, `keyed ${r.busyEndsAt - r.ptt[0].at} ms before the busy signal ended`);
      });
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => { console.log('  FAIL ' + (e.stack || e)); process.exitCode = 1; });
