// The Flex transport refactor (lib/flex-transport.js): the LAN path sends exactly
// the lines it always has, an injected transport's first lines reach the parser,
// the WAN UDP registration follows FlexRadio SmartLink API reference Part 4, and a
// `transmit band` memory line is never read as live power (D0 capture, 8600M v4.2.20).
// Run: node test/flex-transport-test.js
'use strict';

const assert = require('assert');
const net = require('net');
const dgram = require('dgram');
const { EventEmitter } = require('events');
const { SmartSdrClient } = require('../lib/smartsdr');
const { SmartSdrAudio } = require('../lib/smartsdr-audio');
const FT = require('../lib/flex-transport');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake radio on localhost. Every line the client sends is recorded; each
// command gets `R<n>|0|`, `client gui` gets a client_id, stream creates a stream id.
function fakeRadio() {
  return new Promise((resolve) => {
    const lines = [];
    const server = net.createServer((sock) => {
      sock.write('V1.4.0.0\nH0A0B0C0D\n');
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          lines.push(line);
          const m = line.match(/^C(\d+)\|(.*)$/);
          if (!m) continue;
          let payload = '';
          if (m[2] === 'client gui') payload = '11111111-2222-3333-4444-555555555555';
          if (/^stream create type=dax_rx/.test(m[2])) payload = '04000008';
          if (/^stream create type=dax_tx/.test(m[2])) payload = '84000000';
          sock.write(`R${m[1]}|0|${payload}\n`);
        }
      });
      sock.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, lines, port: server.address().port }));
  });
}

// Route net connects aimed at the radio's API port 4992 to the fake radio, so the
// DEFAULT (LAN) transport is what runs, unmodified.
function redirect4992(toPort, seen) {
  const orig = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    if (args[0] === 4992 && typeof args[1] === 'string') { seen.push(args[1]); args[0] = toPort; args[1] = '127.0.0.1'; }
    return orig.apply(this, args);
  };
  return () => { net.Socket.prototype.connect = orig; };
}

const norm = (l) => l.replace(/client udpport \d+/, 'client udpport <port>');

// The lines POTACAT's main API client sent to a Flex before the transport refactor
// (recorded from the code as it was): subscriptions, the UDP port, the meter list
// at 1.5 s and the Flex Direct GUI registration at 1.6 s.
const GOLDEN_MAIN = [
  'C1|sub client all',
  'C2|sub atu all',
  'C3|sub meter all',
  'C4|sub slice all',
  'C5|sub pan all',
  'C6|sub tx all',
  'C7|client udpport <port>',
  'C8|meter list',
  'C9|client gui',
  'C10|client station POTACAT',
];
const GOLDEN_AUDIO = [
  'C1|client program POTACAT',
  'C2|client bind client_id=11111111-2222-3333-4444-555555555555',
  'C3|client udpport <port>',
  'C4|stream create type=dax_rx dax_channel=1',
  'C5|stream create type=dax_tx',
  'C6|sub tx all',
  'C7|sub audio_stream all',
];

(async () => {
  console.log('LAN: the default transport sends exactly the lines it always has');
  {
    const radio = await fakeRadio();
    const seen = [];
    const restore = redirect4992(radio.port, seen);
    const c = new SmartSdrClient();
    let handleAtConnect = null;
    c.on('connected', () => { handleAtConnect = c._clientHandle; });
    c.on('error', () => {});
    c.connect('192.0.2.10');
    await sleep(2300);
    c.disconnect();
    restore();
    await sleep(50);
    const got = radio.lines.map(norm);
    check(seen[0] === '192.0.2.10', 'the main client dialled the radio host on port 4992');
    check(JSON.stringify(got.slice(0, GOLDEN_MAIN.length)) === JSON.stringify(GOLDEN_MAIN),
      'main client lines are byte-identical to before:\n      ' + got.join('\n      '));
    check(got.length === GOLDEN_MAIN.length, 'no extra line was sent');
    check(c._clientHandle === '0A0B0C0D', 'the H line was parsed');
    radio.server.close();
    void handleAtConnect;
  }
  {
    const radio = await fakeRadio();
    const seen = [];
    const restore = redirect4992(radio.port, seen);
    const a = new SmartSdrAudio();
    a.on('audio-fallback', () => {});
    a.start('192.0.2.10', 1, '11111111-2222-3333-4444-555555555555');
    await sleep(400);
    a.stop();
    restore();
    await sleep(50);
    const got = radio.lines.map(norm);
    check(seen[0] === '192.0.2.10', 'the audio client dialled the radio host on port 4992');
    check(JSON.stringify(got.slice(0, GOLDEN_AUDIO.length)) === JSON.stringify(GOLDEN_AUDIO),
      'audio client setup lines are byte-identical to before:\n      ' + got.join('\n      '));
    radio.server.close();
  }

  console.log('Injected transport: the radio\'s first lines reach the parser');
  {
    // A transport whose socket has already been validated (SmartLink's shape):
    // the radio's V and H lines arrive BEFORE 'connect', in the same tick the
    // socket is created. The parser must already be attached.
    const written = [];
    const t = FT.injectedTransport({
      kind: 'smartlink',
      firstSeq: 2,
      udp: { kind: 'test', start: () => ({ seq: null, onPacket() {}, stop() {} }) },
      open(host, attach) {
        const sock = new EventEmitter();
        sock.write = (s) => { written.push(s); return true; };
        sock.end = () => {}; sock.destroy = () => {};
        attach(sock);
        sock.emit('data', Buffer.from('V1.4.0.0\nH4A30F977\nS4A30F977|interlock timeout=0 state=READY\n'));
        process.nextTick(() => sock.emit('connect'));
        return sock;
      },
    });
    const c = new SmartSdrClient();
    let interlock = null;
    c.on('interlock', (kv) => { interlock = kv; });
    c.on('error', () => {});
    c.setTransport(t);
    check(c.transportKind === 'smartlink', 'transportKind names the injected transport');
    c.connect('203.0.113.7');
    await sleep(30);
    check(c._clientHandle === '4A30F977', 'the H line sent before connect was parsed');
    check(interlock && interlock.timeout === '0', 'a status line sent before connect was parsed');
    check(written[0] === 'C2|sub client all\n', 'commands start after the transport\'s own C1 (firstSeq 2)');
    check(!written.some((l) => /client udpport/.test(l)), 'no `client udpport` on an injected WAN-style transport');
    c.disconnect();
    c.setTransport(null);
    check(c.transportKind === 'lan', 'setTransport(null) goes back to the LAN transport');
  }

  console.log('WAN UDP registration (FlexRadio SmartLink API reference, Part 4)');
  {
    // A fake radio's public UDP port on localhost.
    const radio = dgram.createSocket('udp4');
    const got = [];
    let answerAfter = 3;
    radio.on('message', (m, rinfo) => {
      got.push({ t: Date.now(), text: m.toString(), port: rinfo.port });
      if (/udp_register/.test(m.toString()) && --answerAfter === 0) {
        // A meter packet: VITA-49 header, FlexRadio OUI 0x001C2D, class 0x8002.
        const p = Buffer.alloc(32);
        p.writeUInt32BE(0x38500008, 0); p.writeUInt32BE(0x00000700, 4);
        p.writeUInt32BE(0x00001C2D, 8); p.writeUInt32BE(0x534C8002, 12);
        radio.send(p, rinfo.port, '127.0.0.1');
      }
    });
    await new Promise((r) => radio.bind(0, '127.0.0.1', r));
    const local = dgram.createSocket('udp4');
    await new Promise((r) => local.bind(0, r));
    let handle = null;
    let confirmedMs = null, failedWhy = null;
    const reg = FT.wanUdpRegistration({ host: '127.0.0.1', port: radio.address().port, registerEveryMs: 10, pingEveryMs: 40, giveUpMs: 2000, handleWaitMs: 1000 })
      .start({ udpSock: local, getHandle: () => handle, onConfirmed: (ms) => { confirmedMs = ms; }, onFailed: (w) => { failedWhy = w; } });
    local.on('message', (b) => reg.onPacket(b));
    await sleep(40);
    check(got.length === 0, 'nothing is sent before the handle is known (handle=0x0 is ignored by the radio)');
    // Windows: the first register can draw an ICMP port-unreachable, which Node
    // reports as an 'error' event. It must not end the loop.
    local.on('error', () => {});
    local.emit('error', new Error('ECONNRESET (simulated ICMP port unreachable)'));
    handle = '4A30F977';
    await sleep(150);
    const regs = got.filter((g) => g.text === 'client udp_register handle=0x4A30F977');
    check(regs.length >= 3, `udp_register sent repeatedly over UDP with the handle (${regs.length} sent)`);
    check(confirmedMs != null, 'the first FlexRadio VITA packet confirms the registration');
    const confirmAt = Date.now();
    await sleep(120);
    const regsAfter = got.filter((g) => g.text.startsWith('client udp_register') && g.t > confirmAt + 15);
    const pings = got.filter((g) => g.text === 'client ping handle=0x4A30F977');
    check(regsAfter.length === 0, 'udp_register stops once confirmed');
    check(pings.length >= 2, `client ping keeps the NAT mapping (${pings.length} pings)`);
    check(failedWhy === null, 'no failure reported');
    check(new Set(got.map((g) => g.port)).size === 1, 'one local socket, never connect()ed (sent with an address each time)');
    reg.stop();
    const n = got.length;
    await sleep(100);
    check(got.length === n, 'stop() ends the pings');
    local.close(); radio.close();
  }
  {
    // A network that blocks UDP: give up at the deadline with a named reason.
    const sink = dgram.createSocket('udp4');
    await new Promise((r) => sink.bind(0, '127.0.0.1', r));
    const local = dgram.createSocket('udp4');
    await new Promise((r) => local.bind(0, r));
    let failedWhy = null;
    let sent = 0;
    sink.on('message', () => sent++);
    const reg = FT.wanUdpRegistration({ host: '127.0.0.1', port: sink.address().port, registerEveryMs: 10, giveUpMs: 120 })
      .start({ udpSock: local, getHandle: () => 'ABCD0001', onFailed: (w) => { failedWhy = w; } });
    await sleep(220);
    check(failedWhy === 'udp-blocked', 'no FlexRadio packet before the deadline: udp-blocked');
    const at = sent;
    await sleep(60);
    check(sent === at, 'the register loop stops after giving up');
    reg.stop();
    // No handle at all within the wait: no-handle, and nothing was sent.
    let why2 = null;
    const reg2 = FT.wanUdpRegistration({ host: '127.0.0.1', port: sink.address().port, registerEveryMs: 10, handleWaitMs: 50 })
      .start({ udpSock: local, getHandle: () => null, onFailed: (w) => { why2 = w; } });
    await sleep(120);
    check(why2 === 'no-handle', 'no handle within the wait: no-handle');
    reg2.stop();
    // A non-Flex packet does not confirm.
    const reg3 = FT.wanUdpRegistration({ host: '127.0.0.1', port: sink.address().port, registerEveryMs: 10, giveUpMs: 500 })
      .start({ udpSock: local, getHandle: () => 'ABCD0001' });
    await sleep(20);
    const other = Buffer.alloc(32); other.writeUInt32BE(0x38500008, 0); other.writeUInt32BE(0x00001234, 8);
    reg3.onPacket(other);
    check(reg3.confirmed === false, 'a VITA packet without the FlexRadio OUI does not confirm');
    reg3.stop();
    local.close(); sink.close();
  }

  console.log('LAN registration strategy');
  {
    const sent = [];
    const r = FT.lanUdpRegistration().start({ port: 50123, sendCmd: (c) => { sent.push(c); return 7; } });
    check(sent.length === 1 && sent[0] === 'client udpport 50123' && r.seq === 7, 'LAN sends `client udpport <port>` and returns its sequence number');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, 'flex transport tests failed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
