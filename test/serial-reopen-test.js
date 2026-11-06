// test/serial-reopen-test.js — KK6EZA IC-705 (2026-11-04): after a reconnect
// "Opening COM6: Access denied" every 16 s for 2.5 min. connectCat opened the
// new port 300 ms after starting to close the old one, without waiting for the
// OS release, and the log blamed "another program" for POTACAT's own handle.
'use strict';
const { readSrc } = require('./_src');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { SerialTransport, recentOwnClose } = require('../lib/transport');
const { RigController } = require('../lib/rig-controller');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

function fakePort(closeMs) {
  return { isOpen: true, path: 'COM6', set() {}, close(cb) { setTimeout(() => { this.isOpen = false; cb && cb(); }, closeMs); } };
}

(async () => {
  console.log('serial reopen:');
  await t('disconnect resolves only when the OS close callback has run', async () => {
    const tr = new SerialTransport();
    tr._target = { path: 'COM6' };
    const port = fakePort(120);
    tr._port = port;
    const t0 = Date.now();
    const p = tr.disconnect();
    assert.ok(p && typeof p.then === 'function');
    assert.strictEqual(recentOwnClose('com6').closed, false, 'remembered as ours, not yet closed');
    await p;
    assert.ok(Date.now() - t0 >= 100, 'waited for the close');
    assert.strictEqual(recentOwnClose('COM6').closed, true);
    assert.strictEqual(recentOwnClose('COM7'), null);
  });
  await t('a close that never finished stays ours past the 15 s window (tactical_index)', async () => {
    const tr = new SerialTransport();
    tr._target = { path: 'COM10' };
    tr._port = { isOpen: true, path: 'COM10', set() {}, close() { /* never calls back */ } };
    tr.disconnect();
    assert.strictEqual(recentOwnClose('COM10').closed, false);
    assert.strictEqual(recentOwnClose('COM10', -1).closed, false, 'outside the window, still ours');
    assert.strictEqual(recentOwnClose('COM6', -1), null, 'a finished close outside the window is not');
  });
  await t('nothing open: disconnect resolves at once', async () => {
    const tr = new SerialTransport();
    await tr.disconnect();
  });
  await t('"Access denied" on a port POTACAT just closed says so, not "another program"', async () => {
    const tr = new SerialTransport();
    tr._target = { path: 'COM6' };
    tr._port = fakePort(0);
    await tr.disconnect();
    const transport = new EventEmitter();
    transport.connect = () => {}; transport.disconnect = () => Promise.resolve(); transport.write = () => {};
    const codec = new EventEmitter();
    const rc = new RigController({ brand: 'Icom' }, transport, codec);
    const logs = [];
    rc._log = (m) => logs.push(m);
    rc._target = { path: 'COM6' };
    transport.emit('error', new Error('Opening COM6: Access denied'));
    assert.ok(logs.some(l => /POTACAT itself had this port open/.test(l)), logs.join(' | '));
    assert.ok(!logs.some(l => /open in another program/.test(l)));
  });
  await t('connectCat waits for the old port\'s close before opening the next', () => {
    const main = readSrc(path.join(__dirname, '..', 'main.js')).replace(/\r\n/g, '\n');
    assert.ok(main.includes('cat.disconnect();\n    _icomNetworkTransport = null;\n    const _oldCatClosed = cat._closedPromise;'));
    assert.ok(main.includes('if (_oldCatClosed) await Promise.race([_oldCatClosed, new Promise(r => setTimeout(r, 3000))]);'));
  });
  console.log('\nserial reopen: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
