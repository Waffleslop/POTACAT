#!/usr/bin/env node
'use strict';
// lib/cat.js CatClient (Flex TS-2000 over TCP, Elecraft K4 over the network, any
// Kenwood/Yaesu serial rig): what it writes to put the radio into transmit and
// back to receive, the ATU tune pair, CW text, and the CW key lines. The serial
// port is a fake (no real COM port is opened); TCP and K4 use a local server the
// test owns, on a port the OS picks.
// These tests describe today's behaviour. Gaps found are marked DOCUMENTED at
// the bottom and pinned as they are, not fixed here.
// Run: node test/cat-client-transmit-test.js
const assert = require('assert');
const net = require('net');
const { EventEmitter } = require('events');

// ---- fake serialport, installed before lib/cat.js loads it ----
class FakeSerialPort extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.isOpen = false;
    this.writes = [];
    this.sets = [];
    this.setError = null;
    FakeSerialPort.instances.push(this);
  }
  open(cb) {
    setImmediate(() => { this.isOpen = true; this.emit('open'); if (cb) cb(null); });
  }
  write(data) { this.writes.push(Buffer.isBuffer(data) ? data.toString('ascii') : String(data)); return true; }
  set(opts, cb) { this.sets.push(opts); if (cb) cb(this.setError); }
  close() { this.destroy(); }
  destroy() { if (!this.isOpen) return; this.isOpen = false; this.emit('close'); }
  static list() { return Promise.resolve([]); }
}
FakeSerialPort.instances = [];
const spPath = require.resolve('serialport');
require.cache[spPath] = { id: spPath, filename: spPath, loaded: true, exports: { SerialPort: FakeSerialPort } };
const { CatClient } = require('../lib/cat');

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL = /^(FA|MD0?|SM0?|RM[13]|PC|NB0?);$/;
const live = []; // clients to tear down after each test
const lastPort = () => FakeSerialPort.instances[FakeSerialPort.instances.length - 1];

// A CatClient on a fake serial port, connected. fa: the first FA reply to feed it
// (11 digits = Kenwood/Flex, 9 digits = Yaesu), or null to leave the rig unidentified.
async function serialClient({ fa = null, target = {} } = {}) {
  const c = new CatClient();
  live.push(c);
  c.connect({ type: 'serial', path: 'FAKE1', baudRate: 9600, ...target });
  await sleep(10);
  const port = lastPort();
  assert.ok(c.connected, 'connected');
  if (fa) port.emit('data', Buffer.from(fa));
  c._stopPolling(); // keep the poll chatter out of the byte log
  port.writes.length = 0;
  return { c, port };
}
const KEN = 'FA00014074000;'; // 11 digits
const YAE = 'FA014074000;';   // 9 digits
const cmds = (port) => port.writes.filter((w) => !POLL.test(w));

async function tcpServerClient(onData) {
  const server = net.createServer((s) => s.on('data', onData));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const c = new CatClient();
  live.push(c);
  c.connect({ type: 'tcp', host: '127.0.0.1', port: server.address().port });
  for (let i = 0; i < 50 && !c.connected; i++) await sleep(20);
  assert.ok(c.connected, 'tcp connected');
  c._stopPolling();
  return { c, server };
}

// ---- setTransmit ----
test('setTransmit writes nothing while not connected', () => {
  const c = new CatClient();
  c.setTransmit(true); c.setTransmit(false);
  assert.strictEqual(c.transport, null);
});

test('Kenwood / Flex serial: setTransmit is TX; / RX;', async () => {
  const { c, port } = await serialClient({ fa: KEN });
  c.setTransmit(true); c.setTransmit(false);
  assert.deepStrictEqual(cmds(port), ['TX;', 'RX;']);
});

test('before the rig is identified, setTransmit uses the Kenwood form', async () => {
  const { c, port } = await serialClient({ fa: null });
  c.setTransmit(true); c.setTransmit(false);
  assert.deepStrictEqual(cmds(port), ['TX;', 'RX;']);
});

test('Yaesu (9-digit FA) serial: setTransmit is TX1; / TX0;', async () => {
  const { c, port } = await serialClient({ fa: YAE });
  c.setTransmit(true); c.setTransmit(false);
  assert.deepStrictEqual(cmds(port), ['TX1;', 'TX0;']);
});

test('setCwKeyTxRx follows the same per-family words as setTransmit', async () => {
  let r = await serialClient({ fa: KEN });
  r.c.setCwKeyTxRx(true); r.c.setCwKeyTxRx(false);
  assert.deepStrictEqual(cmds(r.port), ['TX;', 'RX;']);
  r = await serialClient({ fa: YAE });
  r.c.setCwKeyTxRx(true); r.c.setCwKeyTxRx(false);
  assert.deepStrictEqual(cmds(r.port), ['TX1;', 'TX0;']);
});

test('Flex over TCP: a local server sees TX; then RX;', async () => {
  const got = [];
  const { c, server } = await tcpServerClient((d) => got.push(d.toString()));
  try {
    got.length = 0;
    c.setTransmit(true); c.setTransmit(false);
    await sleep(100);
    assert.strictEqual(got.join(''), 'TX;RX;');
  } finally { c.disconnect(); server.close(); }
});

test('K4 network: commands are framed (FE FD FC FB, length, 00 00 00 + ASCII, FB FC FD FE) after the auth blob', async () => {
  const chunks = [];
  const socks = [];
  const server = net.createServer((s) => { socks.push(s); s.on('data', (d) => chunks.push(d)); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const c = new CatClient(); live.push(c);
  try {
    c.connect({ type: 'k4-network', host: '127.0.0.1', port: server.address().port, password: 'pw' });
    for (let i = 0; i < 100 && !c.connected; i++) await sleep(20);
    assert.ok(c.connected, 'K4 session up');
    c._stopPolling();
    await sleep(50);
    assert.ok(Buffer.concat(chunks).toString('ascii').startsWith(require('crypto').createHash('sha384').update('pw').digest('hex')), 'SHA-384 auth blob first');
    chunks.length = 0;
    c.setTransmit(true); c.setTransmit(false);
    await sleep(100);
    const all = Buffer.concat(chunks);
    const frame = (txt) => {
      const payload = Buffer.concat([Buffer.from([0, 0, 0]), Buffer.from(txt, 'ascii')]);
      const len = Buffer.alloc(4); len.writeUInt32BE(payload.length);
      return Buffer.concat([Buffer.from([0xFE, 0xFD, 0xFC, 0xFB]), len, payload, Buffer.from([0xFB, 0xFC, 0xFD, 0xFE])]);
    };
    assert.ok(all.includes(Buffer.concat([frame('TX;'), frame('RX;')])), 'TX; then RX; framed');
  } finally { c.disconnect(); for (const s of socks) s.destroy(); server.close(); }
});

// ---- startTune / stopTune (the ATU) ----
test('startTune/stopTune on Kenwood: AC011; then AC010; (the tune never commands TX; itself)', async () => {
  const { c, port } = await serialClient({ fa: KEN });
  c.startTune(); c.stopTune();
  assert.deepStrictEqual(cmds(port), ['AC011;', 'AC010;']);
});

test('startTune: TS-590 variant sends AC111;', async () => {
  const { c, port } = await serialClient({ fa: KEN });
  c._atuCmd = 'ac111'; c.startTune();
  assert.deepStrictEqual(cmds(port), ['AC111;']);
});

test('startTune on Yaesu variants: ac002 / ac003 / default AC011', async () => {
  const { c, port } = await serialClient({ fa: YAE });
  c._atuCmd = 'ac002'; c.startTune();
  c._atuCmd = 'ac003'; c.startTune();
  c._atuCmd = 'standard'; c.startTune();
  assert.deepStrictEqual(cmds(port), ['AC002;', 'AC003;', 'AC011;']);
});

test('startTune FT-891: AC001; now, AC002; 300 ms later', async () => {
  const { c, port } = await serialClient({ fa: YAE });
  c._atuCmd = 'ft891'; c.startTune();
  assert.deepStrictEqual(cmds(port), ['AC001;']);
  await sleep(380);
  assert.deepStrictEqual(cmds(port), ['AC001;', 'AC002;']);
});

test('startTune FT-891: a disconnect inside the 300 ms never sends the second command', async () => {
  const { c, port } = await serialClient({ fa: YAE });
  c._atuCmd = 'ft891'; c.startTune();
  c.disconnect();
  await sleep(380);
  assert.deepStrictEqual(cmds(port), ['AC001;']);
});

test('stopTune on Yaesu sends AC000; twice (both model layouts)', async () => {
  const { c, port } = await serialClient({ fa: YAE });
  c.stopTune();
  assert.deepStrictEqual(cmds(port), ['AC000;', 'AC000;']);
});

test('startTune/stopTune write nothing when disconnected', () => {
  const c = new CatClient();
  c.startTune(); c.stopTune();
  assert.strictEqual(c.transport, null);
});

// ---- sendCwText ----
test('sendCwText Kenwood: cleaned, upper-cased, KY chunks of 24', async () => {
  const { c, port } = await serialClient({ fa: KEN });
  c.sendCwText('cq de k3sbp ~!{} k');
  assert.deepStrictEqual(cmds(port), ['KY CQ DE K3SBP  K;']);
  port.writes.length = 0;
  c.sendCwText('A'.repeat(50));
  assert.deepStrictEqual(cmds(port), ['KY ' + 'A'.repeat(24) + ';', 'KY ' + 'A'.repeat(24) + ';', 'KY AA;']);
});

test('sendCwText Yaesu: KY<p1> + 48 chars padded', async () => {
  const { c, port } = await serialClient({ fa: YAE });
  c.sendCwText('test');
  assert.deepStrictEqual(cmds(port), ['KY0 ' + 'TEST'.padEnd(48, ' ') + ';']);
  port.writes.length = 0;
  c._kyParam = 2; c.sendCwText('x');
  assert.strictEqual(cmds(port)[0].slice(0, 4), 'KY2 ');
});

test('sendCwText Yaesu km mode (FTDX101): text memory 5 write then KYA; playback, 50 per slot', async () => {
  const { c, port } = await serialClient({ fa: YAE });
  c._kyMode = 'km';
  c.sendCwText('B'.repeat(60));
  assert.deepStrictEqual(cmds(port), ['KM5' + 'B'.repeat(50) + ';', 'KYA;', 'KM5' + 'B'.repeat(10) + ';', 'KYA;']);
});

test('sendCwText: empty or disconnected sends nothing; setCwSpeed clamps 5..50', async () => {
  const { c, port } = await serialClient({ fa: KEN });
  c.sendCwText(''); c.sendCwText(null);
  assert.deepStrictEqual(cmds(port), []);
  c.setCwSpeed(99); c.setCwSpeed(2); c.setCwSpeed(25);
  assert.deepStrictEqual(cmds(port), ['KS050;', 'KS005;', 'KS025;']);
  const d = new CatClient(); d.sendCwText('CQ'); assert.strictEqual(d.transport, null);
});

// ---- CW key lines ----
test('setCwKeyDtr: key down raises DTR and RTS, key up drops both', async () => {
  const { c, port } = await serialClient({ fa: KEN });
  c.setCwKeyDtr(true); c.setCwKeyDtr(false);
  assert.deepStrictEqual(port.sets.slice(-2), [{ dtr: true, rts: true }, { dtr: false, rts: false }]);
});

test("setCwKeyDtr under RTS/CTS flow control or asserted RTS: DTR alone (RTS belongs to the driver)", async () => {
  for (const hs of ['hardware', 'asserted']) {
    const { c, port } = await serialClient({ fa: KEN, target: { serialHandshake: hs } });
    port.sets.length = 0;
    c.setCwKeyDtr(true); c.setCwKeyDtr(false);
    assert.deepStrictEqual(port.sets, [{ dtr: true }, { dtr: false }], hs);
  }
});

test('setCwKeyDtr over TCP is a no-op (no serial line to key)', async () => {
  const got = [];
  const { c, server } = await tcpServerClient((d) => got.push(d.toString()));
  try {
    got.length = 0;
    c.setCwKeyDtr(true);
    await sleep(60);
    assert.deepStrictEqual(got, []);
  } finally { c.disconnect(); server.close(); }
});

test('setCwKeyDtr: a failing DTR set falls back to TX/RX keying, and stays there', async () => {
  const { c, port } = await serialClient({ fa: KEN });
  port.setError = new Error('no DTR on CDC-ACM');
  c.setCwKeyDtr(true);
  assert.strictEqual(c._dtrFailed, true);
  assert.deepStrictEqual(cmds(port), ['TX;']);
  c.setCwKeyDtr(false);
  assert.deepStrictEqual(cmds(port), ['TX;', 'RX;']);
});

test('setCwKeyTa / endCwKeyTa (Kenwood): one TX; at the start, RX; and mode restore at the end', async () => {
  const { c, port } = await serialClient({ fa: KEN });
  c.setCwKeyTa(true); c.setCwKeyTa(false); c.setCwKeyTa(true);
  assert.deepStrictEqual(port.writes, ['MD;', 'MD6;', 'TX;', 'TA700;', 'TA0;', 'TA700;']); // MD; is the mode query (cmds() hides it as poll chatter)
  port.writes.length = 0;
  c.endCwKeyTa();
  assert.deepStrictEqual(cmds(port), ['TA0;', 'RX;', 'MD3;']);
  assert.strictEqual(c._cwTaActive, false);
  port.writes.length = 0;
  c.endCwKeyTa(); // a second end is silent
  assert.deepStrictEqual(cmds(port), []);
});

test('setCwKeyTa / endCwKeyTa (Yaesu): MD06 + TX1 in, TX0 + MD03 out', async () => {
  const { c, port } = await serialClient({ fa: YAE });
  c.setCwKeyTa(true);
  assert.deepStrictEqual(cmds(port), ['MD06;', 'TX1;', 'TA700;']);
  port.writes.length = 0;
  c.endCwKeyTa();
  assert.deepStrictEqual(cmds(port), ['TA0;', 'TX0;', 'MD03;']);
});

// ---- disconnect and reconnect ----
test('disconnect clears the transport and the timers; nothing reconnects', async () => {
  const { c, port } = await serialClient({ fa: KEN });
  c.disconnect();
  assert.strictEqual(c.connected, false);
  assert.strictEqual(c.transport, null);
  assert.strictEqual(c._reconnectTimer, null);
  const n = FakeSerialPort.instances.length;
  await sleep(2300);
  assert.strictEqual(FakeSerialPort.instances.length, n, 'no reconnect after an explicit disconnect');
  assert.strictEqual(port.isOpen, false);
});

test('a port that drops while keyed reconnects and the first thing written is RX; (Kenwood)', async () => {
  const { c, port } = await serialClient({ fa: KEN });
  c.setTransmit(true);
  assert.deepStrictEqual(cmds(port), ['TX;']);
  port.destroy(); // the cable drops mid-transmit
  assert.strictEqual(c.connected, false);
  await sleep(2300); // the 2 s reconnect
  const next = lastPort();
  assert.notStrictEqual(next, port);
  assert.ok(c.connected, 'reconnected');
  assert.strictEqual(next.writes[0], 'RX;', 'PTT forced off on reconnect');
});

test('a Yaesu that dropped while keyed gets TX0; first on reconnect (identity survives the reconnect)', async () => {
  const { c, port } = await serialClient({ fa: YAE });
  c.setTransmit(true);
  port.destroy();
  await sleep(2300);
  assert.strictEqual(lastPort().writes[0], 'TX0;');
});

test('a reconnect never replays a key-down: no TX/TA/DTR-high on the new port', async () => {
  const { c, port } = await serialClient({ fa: KEN });
  c.setCwKeyTxRx(true);
  c.setCwKeyDtr(true);
  port.destroy();
  await sleep(2300);
  const next = lastPort();
  assert.deepStrictEqual(next.writes.filter((w) => /^(TX;|TX1;|TA700;)$/.test(w)), []);
  assert.ok(!next.sets.some((s) => s.dtr === true), 'DTR never raised on the new port');
});

// ---- DOCUMENTED: behaviour pinned as it is today, suspected gaps (not fixed here) ----
test('DOCUMENTED: disconnect() while DTR-keyed does not itself drop DTR/RTS (it relies on the OS closing the port)', async () => {
  const { c, port } = await serialClient({ fa: KEN });
  c.setCwKeyDtr(true);
  port.sets.length = 0;
  c.disconnect();
  // Ideal: a final { dtr:false, rts:false }. Today: nothing is set, the port is just destroyed.
  assert.deepStrictEqual(port.sets, []);
});

test('DOCUMENTED: disconnect() during a TA key session leaves _cwTaActive true and sends nothing to end it', async () => {
  const { c, port } = await serialClient({ fa: KEN });
  c.setCwKeyTa(true);
  port.writes.length = 0;
  c.disconnect();
  assert.deepStrictEqual(port.writes, [], 'no TA0;/RX; written at disconnect');
  assert.strictEqual(c._cwTaActive, true, 'stale flag survives the disconnect');
});

test('DOCUMENTED: with that stale flag, the next setCwKeyTa(true) commands the tone without MD6;/TX;', async () => {
  const { c, port } = await serialClient({ fa: KEN });
  c._cwTaActive = true; // what the same client holds after a disconnect mid-session
  c.setCwKeyTa(true);
  assert.deepStrictEqual(cmds(port), ['TA700;'], 'silent (rig not keyed), not stuck');
});

test('DOCUMENTED: a rig never identified (no FA heard) is not sent RX; on reconnect', async () => {
  const { c, port } = await serialClient({ fa: null });
  c.setTransmit(true);
  port.destroy();
  await sleep(2300);
  const next = lastPort();
  assert.ok(c.connected);
  assert.ok(!next.writes.includes('RX;') && !next.writes.includes('TX0;'), 'PTT-off on reconnect is gated on _faDigitsDetected');
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + ((e && e.stack) || e)); }
    while (live.length) { try { live.pop().disconnect(); } catch {} }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
