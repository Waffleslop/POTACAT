#!/usr/bin/env node
'use strict';
// lib/winkeyer.js, the K1EL WinKeyer host: the bytes it sends (host open and
// close, text, clear, speed, weight, PTT lead-in and tail, mode register) and
// how it reads what comes back (version, echo, speed pot, status busy/idle/XOFF).
// The serial port is a fake; no real COM port is opened. These describe the
// code as it is; anything that looks wrong is marked DOCUMENTED, not fixed.
// Run: node test/winkeyer-test.js
const assert = require('assert');
const { EventEmitter } = require('events');

let lastOpts = null;
class FakeSerialPort extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts; lastOpts = opts;
    this.isOpen = false;
    this.writes = [];
    this.closed = false;
    this.openError = null;
    FakeSerialPort.last = this;
  }
  open(cb) {
    if (FakeSerialPort.failOpen) { setImmediate(() => cb(new Error('no such port'))); return; }
    setImmediate(() => { this.isOpen = true; this.emit('open'); if (cb) cb(null); });
  }
  write(data, cb) { this.writes.push([...Buffer.from(data)]); if (cb) setImmediate(() => cb(null)); return true; }
  close(cb) { this.closed = true; this.isOpen = false; setImmediate(() => { this.emit('close'); if (cb) cb(); }); }
}
const spPath = require.resolve('serialport');
require.cache[spPath] = { id: spPath, filename: spPath, loaded: true, exports: { SerialPort: FakeSerialPort } };
const { WinKeyer } = require('../lib/winkeyer');

const origLog = console.log;
let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An opened WinKeyer whose host-open reply (version 23 = WK2) has arrived.
async function openKeyer(version = 23) {
  const wk = new WinKeyer();
  wk.connect('FAKE-WK');
  await sleep(10);
  const port = FakeSerialPort.last;
  assert.ok(port.isOpen);
  if (version) { port.emit('data', Buffer.from([version])); }
  port.writes.length = 0;
  return { wk, port };
}
const status = (busy, { xoff = false, breakin = false } = {}) => 0xC0 | (xoff ? 0x20 : 0) | (busy ? 0x04 : 0) | (breakin ? 0x01 : 0);

// ---- open / init ----
test('connect opens 1200 baud 8N2 with no flow control and hupcl off', async () => {
  const wk = new WinKeyer(); wk.connect('FAKE-WK'); await sleep(10);
  assert.strictEqual(lastOpts.path, 'FAKE-WK');
  assert.strictEqual(lastOpts.baudRate, 1200);
  assert.strictEqual(lastOpts.dataBits, 8);
  assert.strictEqual(lastOpts.stopBits, 2);
  assert.strictEqual(lastOpts.parity, 'none');
  assert.strictEqual(lastOpts.rtscts, false);
  assert.strictEqual(lastOpts.hupcl, false);
  wk.disconnect();
});

test('on open the first bytes are Host Open: 00 02', async () => {
  const wk = new WinKeyer(); wk.connect('FAKE-WK'); await sleep(10);
  assert.deepStrictEqual(FakeSerialPort.last.writes, [[0x00, 0x02]]);
  assert.strictEqual(wk.connected, false, 'not connected until the version byte comes back');
  wk.disconnect();
});

test('the version byte completes the open: connected + version + a connected event', async () => {
  const wk = new WinKeyer(); wk.connect('FAKE-WK'); await sleep(10);
  const events = []; wk.on('connected', (e) => events.push(e));
  FakeSerialPort.last.emit('data', Buffer.from([0x00, 0xFF, 23])); // junk before the version is ignored
  assert.strictEqual(wk.connected, true);
  assert.strictEqual(wk.version, 23);
  assert.deepStrictEqual(events, [{ version: 23 }]);
  wk.disconnect();
});

test('connect with no path does nothing; a failed open emits error and drops the port', async () => {
  const none = new WinKeyer(); none.connect(''); assert.strictEqual(none._port, null);
  FakeSerialPort.failOpen = true;
  const wk = new WinKeyer(); const errs = []; wk.on('error', (e) => errs.push(e.message));
  wk.connect('FAKE-WK'); await sleep(10);
  FakeSerialPort.failOpen = false;
  assert.deepStrictEqual(errs, ['no such port']);
  assert.strictEqual(wk._port, null);
});

test('disconnect sends Host Close 00 03, THEN closes the port, and clears state at once', async () => {
  const { wk, port } = await openKeyer();
  wk.disconnect();
  assert.strictEqual(wk.connected, false);
  assert.strictEqual(wk._port, null);
  assert.deepStrictEqual(port.writes, [[0x00, 0x03]]);
  assert.strictEqual(port.closed, false, 'close waits for the write to drain');
  await sleep(20);
  assert.strictEqual(port.closed, true);
  wk.sendText('CQ'); // no throw, nothing sent
  assert.deepStrictEqual(port.writes, [[0x00, 0x03]]);
});

test('an unexpected port close while connected emits disconnected and resets busy/xoff/buffer', async () => {
  const { wk, port } = await openKeyer();
  let n = 0; wk.on('disconnected', () => n++);
  wk._busy = true; wk._xoff = true; wk._txBuffer = 'LEFT';
  port.close(); await sleep(10);
  assert.strictEqual(n, 1);
  assert.strictEqual(wk.connected, false);
  assert.strictEqual(wk.busy, false);
  assert.strictEqual(wk._xoff, false);
  assert.strictEqual(wk._txBuffer, '');
});

test('errors during a clean disconnect are swallowed; otherwise re-emitted', async () => {
  const { wk, port } = await openKeyer();
  const errs = []; wk.on('error', (e) => errs.push(e.message));
  port.emit('error', new Error('boom'));
  assert.deepStrictEqual(errs, ['boom']);
  wk.disconnect();
  port.emit('error', new Error('WriteFileEx invalid handle'));
  assert.deepStrictEqual(errs, ['boom']);
});

// ---- sendText / cancelText ----
test('sendText writes the cleaned ASCII text', async () => {
  const { wk, port } = await openKeyer();
  wk.sendText('cq de k3sbp');
  assert.deepStrictEqual(port.writes, [[...Buffer.from('CQ DE K3SBP', 'ascii')]]);
});

test('sendText strips what CW cannot send and keeps the punctuation it can', async () => {
  const { wk, port } = await openKeyer();
  wk.sendText('a~b!c#d$e%f^g&h*i(j)k{l}m|n:o;p"q\'r');
  assert.deepStrictEqual(port.writes, [[...Buffer.from('ABCDEFGHIJKLMNOPQR', 'ascii')]]);
  port.writes.length = 0;
  wk.sendText('599 /?.=,-_+<>@[]');
  assert.deepStrictEqual(port.writes, [[...Buffer.from('599 /?.=,-_+<>@[]', 'ascii')]]);
  port.writes.length = 0;
  wk.sendText('~~~'); // nothing left after cleaning
  assert.deepStrictEqual(port.writes, []);
});

test('sendText is a no-op until the keyer has answered the host open', async () => {
  const { wk, port } = await openKeyer(0);
  wk.sendText('CQ');
  assert.deepStrictEqual(port.writes, []);
});

test('sendText chunks at 50 characters; the rest waits in the buffer until the keyer goes idle', async () => {
  const { wk, port } = await openKeyer();
  wk.sendText('E'.repeat(120));
  assert.deepStrictEqual(port.writes, [[...Buffer.from('E'.repeat(50))]]);
  assert.strictEqual(wk._txBuffer.length, 70);
  // keyer goes busy then idle: the next chunk follows
  port.emit('data', Buffer.from([status(true)]));
  port.emit('data', Buffer.from([status(false)]));
  assert.deepStrictEqual(port.writes[1], [...Buffer.from('E'.repeat(50))]);
  assert.strictEqual(wk._txBuffer.length, 20);
});

test('while XOFF (buffer 2/3 full) text is held, then sent on XON', async () => {
  const { wk, port } = await openKeyer();
  port.emit('data', Buffer.from([status(true, { xoff: true })]));
  wk.sendText('hold me');
  assert.deepStrictEqual(port.writes, []);
  assert.strictEqual(wk._txBuffer, 'HOLD ME');
  port.emit('data', Buffer.from([status(true, { xoff: false })])); // XON
  assert.deepStrictEqual(port.writes, [[...Buffer.from('HOLD ME')]]);
  assert.strictEqual(wk._txBuffer, '');
});

test('cancelText sends the Clear Buffer command 0A, empties the pending text and lifts XOFF', async () => {
  const { wk, port } = await openKeyer();
  port.emit('data', Buffer.from([status(true, { xoff: true })]));
  wk.sendText('queued');
  wk.cancelText();
  assert.deepStrictEqual(port.writes, [[0x0A]]);
  assert.strictEqual(wk._txBuffer, '');
  assert.strictEqual(wk._xoff, false);
});

test('cancelText with the port gone still clears the pending text and sends nothing', async () => {
  const wk = new WinKeyer(); wk._txBuffer = 'X';
  wk.cancelText();
  assert.strictEqual(wk._txBuffer, '');
});

// ---- setters ----
test('setSpeed: [02, wpm] clamped to 5..99 and remembered even before open', async () => {
  const { wk, port } = await openKeyer();
  wk.setSpeed(25); wk.setSpeed(2); wk.setSpeed(150); wk.setSpeed(18.6);
  assert.deepStrictEqual(port.writes, [[0x02, 25], [0x02, 5], [0x02, 99], [0x02, 19]]);
  const idle = new WinKeyer(); idle.setSpeed(30);
  assert.strictEqual(idle._wpm, 30);
});

test('setWeight: [03, weight] clamped to 10..90', async () => {
  const { wk, port } = await openKeyer();
  wk.setWeight(50); wk.setWeight(0); wk.setWeight(200);
  assert.deepStrictEqual(port.writes, [[0x03, 50], [0x03, 10], [0x03, 90]]);
});

test('setPttLeadIn: [04, ms/10] rounded and clamped to 0..25 (250 ms)', async () => {
  const { wk, port } = await openKeyer();
  wk.setPttLeadIn(0); wk.setPttLeadIn(40); wk.setPttLeadIn(44); wk.setPttLeadIn(46); wk.setPttLeadIn(1000); wk.setPttLeadIn(-50);
  assert.deepStrictEqual(port.writes, [[0x04, 0], [0x04, 4], [0x04, 4], [0x04, 5], [0x04, 25], [0x04, 0]]);
});

test('setPttTail: [05, ms/10] rounded and clamped to 0..25 (250 ms)', async () => {
  const { wk, port } = await openKeyer();
  wk.setPttTail(0); wk.setPttTail(100); wk.setPttTail(255); wk.setPttTail(9999);
  assert.deepStrictEqual(port.writes, [[0x05, 0], [0x05, 10], [0x05, 25], [0x05, 25]]);
});

test('PTT setters and speed send nothing when no port is open', () => {
  const wk = new WinKeyer();
  wk.setPttLeadIn(50); wk.setPttTail(50); wk.setWeight(50); wk.setSpeed(20); wk.enablePaddleEcho();
  assert.strictEqual(wk._port, null);
});

test('enablePaddleEcho: [0E, 40]; with paddle swap on: [0E, 48]', async () => {
  const { wk, port } = await openKeyer();
  wk.enablePaddleEcho();
  wk.setPaddleSwap(true);   // re-applies at once because the keyer is open
  wk.setPaddleSwap(false);
  assert.deepStrictEqual(port.writes, [[0x0E, 0x40], [0x0E, 0x48], [0x0E, 0x40]]);
});

test('setPaddleSwap before the keyer is open only remembers it; the next enable carries it', async () => {
  const wk = new WinKeyer(); wk.connect('FAKE-WK'); await sleep(10);
  const port = FakeSerialPort.last; port.writes.length = 0;
  wk.setPaddleSwap(true);
  assert.deepStrictEqual(port.writes, []);
  port.emit('data', Buffer.from([23]));
  wk.enablePaddleEcho();
  assert.deepStrictEqual(port.writes, [[0x0E, 0x48]]);
  wk.disconnect();
});

// ---- inbound: status, echo, speed pot ----
test('status byte: busy edge emits busy once, idle edge emits idle once, both emit status', async () => {
  const { wk, port } = await openKeyer();
  const ev = [];
  for (const e of ['busy', 'idle', 'status', 'breakin']) wk.on(e, (d) => ev.push([e, d]));
  port.emit('data', Buffer.from([status(true), status(true), status(false), status(false)]));
  assert.deepStrictEqual(ev.map((x) => x[0]), ['busy', 'status', 'status', 'idle', 'status', 'status']);
  assert.deepStrictEqual(ev[1][1], { busy: true, breakin: false, xoff: false });
  assert.strictEqual(wk.busy, false);
});

test('status byte 0xC5: busy and breakin', async () => {
  const { wk, port } = await openKeyer();
  const ev = []; for (const e of ['busy', 'breakin']) wk.on(e, () => ev.push(e));
  port.emit('data', Buffer.from([0xC5]));
  assert.deepStrictEqual(ev, ['busy', 'breakin']);
  assert.strictEqual(wk.busy, true);
});

test('status byte 0xC0 with nothing set reports idle without emitting idle (it was never busy)', async () => {
  const { wk, port } = await openKeyer();
  const ev = []; wk.on('idle', () => ev.push('idle')); wk.on('busy', () => ev.push('busy'));
  port.emit('data', Buffer.from([0xC0]));
  assert.deepStrictEqual(ev, []);
});

test('echo bytes (printable ASCII) emit echo with the character', async () => {
  const { wk, port } = await openKeyer();
  const chars = []; wk.on('echo', (e) => chars.push(e.char));
  port.emit('data', Buffer.from('CQ'));
  assert.deepStrictEqual(chars, ['C', 'Q']);
});

test('speed pot byte 0x80-0xBF sets wpm (>= 5) and emits speed', async () => {
  const { wk, port } = await openKeyer();
  const sp = []; wk.on('speed', (e) => sp.push(e.wpm));
  port.emit('data', Buffer.from([0x80 | 22, 0x80 | 3]));
  assert.deepStrictEqual(sp, [22]);
  assert.strictEqual(wk._wpm, 22);
});

test('a version byte of 0 or 40 and up is not accepted as a version', async () => {
  const wk = new WinKeyer(); wk.connect('FAKE-WK'); await sleep(10);
  FakeSerialPort.last.emit('data', Buffer.from([0, 40, 200]));
  assert.strictEqual(wk.connected, false);
  wk.disconnect();
});

// ---- DOCUMENTED: behaviour pinned as it is, suspected gaps (not fixed here) ----
test('DOCUMENTED: connect() sends only Host Open; no speed, weight, PTT lead-in/tail or mode byte is sent on open (the caller must)', async () => {
  const wk = new WinKeyer(); wk.connect('FAKE-WK'); await sleep(10);
  FakeSerialPort.last.emit('data', Buffer.from([23]));
  assert.deepStrictEqual(FakeSerialPort.last.writes, [[0x00, 0x02]]);
  wk.disconnect();
});

test('DOCUMENTED: setPttLeadIn/setPttTail send even before the version reply (_connected is not checked, only the port)', async () => {
  const { wk, port } = await openKeyer(0);
  wk.setPttLeadIn(50);
  assert.deepStrictEqual(port.writes, [[0x04, 5]]);
});

test('DOCUMENTED: cancelText sends 0A but does not itself end an over in flight: busy stays true until the next status byte', async () => {
  const { wk, port } = await openKeyer();
  port.emit('data', Buffer.from([status(true)]));
  wk.cancelText();
  assert.strictEqual(wk.busy, true);
});

test('DOCUMENTED: a text chunk split at 50 characters can split a prosign or word mid-letter (no word-boundary aware split)', async () => {
  const { wk, port } = await openKeyer();
  wk.sendText('A'.repeat(49) + ' BCD');
  assert.strictEqual(Buffer.from(port.writes[0]).toString(), 'A'.repeat(49) + ' ');
  assert.strictEqual(wk._txBuffer, 'BCD');
});

test('DOCUMENTED: new text sent while a long message still has a pending remainder goes out FIRST (out of order)', async () => {
  const { wk, port } = await openKeyer();
  wk.sendText('E'.repeat(60));  // 50 now, 10 held
  wk.sendText('73');            // not in XOFF: written straight away
  assert.strictEqual(Buffer.from(port.writes[1]).toString(), '73');
  assert.strictEqual(wk._txBuffer, 'E'.repeat(10), 'the held E remainder will follow the 73');
});

(async () => {
  console.log = () => {}; // the module logs every send
  const results = [];
  for (const { name, fn } of queue) {
    try { await fn(); pass++; results.push('  ok  ' + name); }
    catch (e) { fail++; results.push('  FAIL ' + name + '\n       ' + ((e && e.stack) || e)); }
  }
  console.log = origLog;
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
