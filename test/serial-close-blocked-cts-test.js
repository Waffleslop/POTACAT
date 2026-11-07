// test/serial-close-blocked-cts-test.js — issue #174 (tactical_index, FT-450D
// through an LDG YT-1200): under RTS/CTS flow control with CTS never asserted,
// a write blocks for good and port.close() never finishes. Switching the rig to
// None and back then failed every reopen with "Opening COMx: Access denied".
// A fake serialport only: no real port is ever opened.
'use strict';
const { readSrc } = require('./_src');
const assert = require('assert');
const path = require('path');
const { EventEmitter } = require('events');

// Fake serialport module, installed before lib/transport.js loads it.
const ports = [];
class FakeSerialPort extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.path = opts.path;
    this.isOpen = false;
    this.calls = [];
    this.pendingWrite = false;
    this.closeHangs = false;
    this.ctsHigh = false; // false: the far end never raises CTS (YT-1200)
    ports.push(this);
  }
  open(cb) { this.isOpen = true; setImmediate(() => { cb && cb(null); this.emit('open'); }); }
  write() { this.calls.push('write'); if (this.opts.rtscts) this.pendingWrite = true; return true; }
  set(lines, cb) { this.calls.push('set'); cb && setImmediate(() => cb(null)); }
  get(cb) { setImmediate(() => cb(null, { cts: this.ctsHigh })); }
  drain(cb) {
    // Waits for pending writes: done at once with CTS high, never with CTS low.
    this.calls.push('drain');
    if (this.ctsHigh || !this.pendingWrite) {
      setImmediate(() => { this.pendingWrite = false; this.calls.push('drained'); cb && cb(null); });
    }
  }
  flush(cb) {
    // PurgeComm(PURGE_TXABORT|...) / tcflush: aborts the write stuck on CTS.
    this.calls.push('flush');
    this.pendingWrite = false;
    setImmediate(() => cb && cb(null));
  }
  close(cb) {
    this.calls.push('close');
    // The driver will not let go while a write is still waiting on CTS.
    if (this.closeHangs || this.pendingWrite) return;
    this.isOpen = false;
    setImmediate(() => { cb && cb(null); this.emit('close'); });
  }
}
const spPath = require.resolve('serialport');
require.cache[spPath] = { id: spPath, filename: spPath, loaded: true, exports: { SerialPort: FakeSerialPort } };

const { SerialTransport, recentOwnClose } = require('../lib/transport');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const tick = () => new Promise(r => setImmediate(r));
async function openTransport(handshake, portName) {
  const tr = new SerialTransport();
  tr._closeTimeoutMs = 400;
  tr._drainTimeoutMs = 50;
  const logs = [];
  tr.on('log', (m) => logs.push(m));
  tr.on('error', () => {});
  tr.connect({ path: portName, baudRate: 4800, serialHandshake: handshake });
  await tick(); await tick();
  assert.strictEqual(tr.connected, true);
  return { tr, logs, port: ports[ports.length - 1] };
}

let finished = false;
process.on('exit', () => { if (!finished) { console.log('  FAIL a disconnect never resolved (the event loop ran dry)'); process.exitCode = 1; } });

(async () => {
  console.log('serial close with a write blocked on CTS (#174):');

  await t('hardware, working CTS (TS-590/990/2000): the last write drains, no flush, close as before', async () => {
    const { tr, logs, port } = await openTransport('hardware', 'COM20');
    port.ctsHigh = true;
    tr.write('RX;');
    const t0 = Date.now();
    assert.strictEqual(await tr.disconnect(), true, 'resolves true: closed');
    assert.ok(Date.now() - t0 < 45, 'closed without waiting out the drain cap');
    assert.ok(!port.calls.includes('flush'), 'the receive command is never discarded: ' + port.calls.join(','));
    const di = port.calls.indexOf('drained'), ci = port.calls.indexOf('close');
    assert.ok(di >= 0 && ci > di, 'drained before close: ' + port.calls.join(','));
    assert.ok(!logs.some(l => /waiting on CTS/.test(l)), logs.join(' | '));
    assert.strictEqual(port.isOpen, false);
  });

  await t('hardware, CTS never raised: drain cap, one log line, flush, then close', async () => {
    const { tr, logs, port } = await openTransport('hardware', 'COM21');
    tr.write('FA;');
    assert.strictEqual(port.pendingWrite, true);
    const t0 = Date.now();
    assert.strictEqual(await tr.disconnect(), true, "resolves true: closed");
    const took = Date.now() - t0;
    assert.ok(took >= 45 && took < 390, 'after the drain cap, inside the close cap: ' + took);
    const di = port.calls.indexOf('drain'), fi = port.calls.indexOf('flush'), ci = port.calls.indexOf('close');
    assert.ok(di >= 0 && fi > di && ci > fi, 'drain, flush, close: ' + port.calls.join(','));
    assert.strictEqual(logs.filter(l => /COM21: a write is still waiting on CTS; discarding it so the port can close/.test(l)).length, 1, logs.join(' | '));
    assert.strictEqual(port.isOpen, false);
    assert.strictEqual(recentOwnClose('COM21').closed, true);
  });

  await t('hardware: a close that never finishes is bounded and logged', async () => {
    const { tr, logs, port } = await openTransport('hardware', 'COM22');
    port.closeHangs = true;
    tr.write('FA;');
    const t0 = Date.now();
    assert.strictEqual(await tr.disconnect(), false, "resolves false: still closing at the timeout");
    const took = Date.now() - t0;
    assert.ok(took >= 390 && took < 1500, 'resolved at the timeout, took ' + took);
    assert.ok(logs.some(l => /COM22.*did not finish closing/.test(l)), logs.join(' | '));
    assert.strictEqual(recentOwnClose('COM22').closed, false, 'still remembered as ours (Access denied hint)');
  });

  await t('hardware: reconnect after a drained close opens a fresh port', async () => {
    const { tr, port } = await openTransport('hardware', 'COM23');
    tr.write('FA;');
    await tr.disconnect();
    tr.connect({ path: 'COM23', baudRate: 4800, serialHandshake: 'hardware' });
    await tick(); await tick();
    const next = ports[ports.length - 1];
    assert.notStrictEqual(next, port);
    assert.strictEqual(next.isOpen, true);
    assert.strictEqual(tr.connected, true);
    tr._target = null; await tr.disconnect();
  });

  for (const mode of [undefined, 'asserted']) {
    await t(`${mode || 'none'}: close is unchanged (no flush, plain close)`, async () => {
      const { tr, port } = await openTransport(mode, 'COM3' + (mode ? 1 : 0));
      tr.write('FA;');
      await tr.disconnect();
      assert.ok(!port.calls.includes('flush') && !port.calls.includes('drain'), port.calls.join(','));
      assert.deepStrictEqual(port.calls.slice(-2), ['set', 'close']);
      assert.strictEqual(port.isOpen, false);
    });
  }

  await t('connectCat keeps the old close across None and waits on it before the next open', () => {
    const main = readSrc(path.join(__dirname, '..', 'main.js')).replace(/\r\n/g, '\n');
    assert.ok(/let _pendingCatClose = null;/.test(main), 'module-level pending close');
    const i = main.indexOf('async function connectCat');
    const body = main.slice(i, main.indexOf("if (!target && settings.catNone)", i));
    assert.ok(body.includes('_rememberCatClose(cat)'), 'connectCat keeps the close promise');
    assert.ok(body.includes('await _awaitPendingCatClose('), 'and waits on it whether or not cat is set');
    assert.ok(main.includes('did not finish closing'), 'logs a close that timed out');
    assert.ok(/_pendingCatClose = p;[\s\S]*ok !== false/.test(main), 'a transport close that timed out (false) is logged too');
    for (const site of [
      'cat.disconnect();\n      _rememberCatClose(cat);\n      cat = null;',
      'cat.disconnect(); _rememberCatClose(cat); } catch {}\n    cat = null;',
      'cat.disconnect(); _rememberCatClose(cat); } catch {} cat = null; }',
    ]) {
      assert.ok(main.includes(site), 'other teardown sites keep the close: ' + site);
    }
  });

  finished = true;
  console.log('\nserial close blocked CTS: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
