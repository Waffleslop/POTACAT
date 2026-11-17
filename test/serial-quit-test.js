'use strict';
// #657: quitting on macOS aborted (SIGABRT) because a serialport AsyncWorker
// finished while Node was freeing its environment. lib/serial-quit.js counts
// every native serial call and open port through the shared binding, and
// settle() closes the ports and waits for the calls before the app exits.
// These tests drive it with a fake binding shaped like @serialport/bindings-cpp.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createSerialQuit } = require('../lib/serial-quit');

function deferred() { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; }

function fakeSerialport({ closeMs = 20 } = {}) {
  const calls = [];
  class PortBinding {
    constructor() { this.fd = 3; }
    get isOpen() { return this.fd !== null; }
    async close() { calls.push('close'); this.fd = null; await new Promise((r) => setTimeout(r, closeMs)); calls.push('closed'); }
    async set() { calls.push('set'); }
    async read() { return new Promise(() => {}); } // never resolves, like a blocked read
  }
  const binding = {
    async list() { calls.push('list'); return []; },
    async open() { return new PortBinding(); },
  };
  class SerialPort {}
  SerialPort.binding = binding;
  SerialPort.list = binding.list;
  return { serialport: { SerialPort }, binding, calls };
}

test('install wraps the binding once', () => {
  const q = createSerialQuit();
  const f = fakeSerialport();
  assert.strictEqual(q.install(f.serialport), true);
  assert.strictEqual(q.install(f.serialport), false);
  assert.strictEqual(q.install({}), false);
});

test('nothing open: not busy, settle resolves at once', async () => {
  const q = createSerialQuit();
  q.install(fakeSerialport().serialport);
  assert.strictEqual(q.busy(), false);
  assert.strictEqual(await q.settle({ timeoutMs: 50 }), true);
});

test('an open port is closed by settle and the close is awaited', async () => {
  const q = createSerialQuit();
  const f = fakeSerialport({ closeMs: 30 });
  q.install(f.serialport);
  const port = await f.binding.open({ path: '/dev/cu.x' });
  assert.strictEqual(q.busy(), true);
  assert.strictEqual(await q.settle({ timeoutMs: 1000 }), true);
  assert.deepStrictEqual(f.calls, ['close', 'closed']);
  assert.strictEqual(port.isOpen, false);
  assert.strictEqual(q.busy(), false);
});

test('a close already started by its owner is waited for, not repeated', async () => {
  const q = createSerialQuit();
  const f = fakeSerialport({ closeMs: 40 });
  q.install(f.serialport);
  const port = await f.binding.open({});
  port.close(); // gracefulCleanup did this; the worker is still in flight
  assert.strictEqual(q.busy(), true);
  const t0 = Date.now();
  assert.strictEqual(await q.settle({ timeoutMs: 1000 }), true);
  assert.ok(Date.now() - t0 >= 30, 'waited for the close');
  assert.deepStrictEqual(f.calls, ['close', 'closed']);
});

test('an open still in flight is waited for, then closed', async () => {
  const q = createSerialQuit();
  const f = fakeSerialport();
  q.install(f.serialport);
  const opening = f.binding.open({});
  const ok = await q.settle({ timeoutMs: 1000 });
  const port = await opening;
  assert.strictEqual(ok, true);
  assert.strictEqual(port.isOpen, false);
});

test('a port list in flight (SerialPort.list) is waited for', async () => {
  const q = createSerialQuit();
  const f = fakeSerialport();
  const gate = deferred();
  f.serialport.SerialPort.list = () => gate.p;
  q.install(f.serialport);
  f.serialport.SerialPort.list();
  assert.strictEqual(q.busy(), true);
  setTimeout(() => gate.resolve([]), 30);
  assert.strictEqual(await q.settle({ timeoutMs: 1000 }), true);
});

test('a call that never finishes is capped', async () => {
  const q = createSerialQuit();
  const f = fakeSerialport();
  f.binding.list = () => new Promise(() => {});
  q.install(f.serialport);
  f.binding.list();
  const t0 = Date.now();
  assert.strictEqual(await q.settle({ timeoutMs: 60 }), false);
  assert.ok(Date.now() - t0 < 500);
});

test('a failing call still counts as finished', async () => {
  const q = createSerialQuit();
  const f = fakeSerialport();
  q.install(f.serialport);
  const port = await f.binding.open({});
  await port.close();
  await port.close().catch(() => {}); // second close on a closed binding
  assert.strictEqual(q.busy(), false);
});

test('main.js installs it and waits in before-quit after gracefulCleanup', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(src, /SerialQuit\.install\(require\('serialport'\)\)/);
  const at = src.indexOf("app.on('before-quit'");
  const body = src.slice(at, src.indexOf('\n});', at));
  const gc = body.indexOf('gracefulCleanup();');
  const wait = body.indexOf('SerialQuit.settle(');
  assert.ok(gc > 0 && wait > gc, 'settle runs after gracefulCleanup in before-quit');
});
