// Serial CAT Test Connection opens the port the way the live link does
// (W7OSG FTDX101D, 1.13.9: "test connection reports that the rig failed to
// respond. But, in reality everything works fine" — his rig is on RTS/CTS
// flow control, which the test never used), and reads an FT-817/818/857/897
// with its own 5-byte command (they never answer "FA;").
// Run: node test/serial-cat-test-connection-test.js
'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const main = readSrc(path.join(__dirname, '..', 'main.js')).replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

// probeSerialCat lifted from main.js, run on a fake serial port.
function liftProbe(radio) {
  const at = main.indexOf('function probeSerialCat(');
  const end = main.indexOf('\nfunction armSerialHandshakeNoAnswerTrial(', at);
  assert.ok(at > 0 && end > at);
  const opened = [];
  class FakePort extends EventEmitter {
    constructor(o) { super(); this.o = o; opened.push(o); }
    open(cb) { setImmediate(() => { cb(null); this.emit('open'); }); }
    set() {}
    close() {}
    write(d) { const r = radio(d, this.o); if (r) setImmediate(() => this.emit('data', Buffer.from(r))); }
  }
  // eslint-disable-next-line no-new-func
  const fn = new Function('require', main.slice(at, end) + '\nreturn probeSerialCat;')(() => ({ SerialPort: FakePort }));
  return { probe: fn, opened };
}

(async () => {
  await test('RTS/CTS when asked: a radio that answers only under flow control passes', async () => {
    const { probe, opened } = liftProbe((d, o) => (o.rtscts && String(d) === 'FA;' ? 'FA014074000;' : null));
    const r = await probe({ portPath: 'COM3', baudRate: 38400, rtscts: true, stopBits: 1 });
    assert.deepStrictEqual(r, { success: true, frequency: '14.074000' });
    assert.strictEqual(opened[0].rtscts, true);
  });

  await test('FT-818: the 5-byte read, BCD 10 Hz units, two stop bits', async () => {
    const { probe, opened } = liftProbe((d) => (Buffer.isBuffer(d) && d.equals(Buffer.from([0, 0, 0, 0, 3])) ? [0x01, 0x40, 0x74, 0x00, 0x01] : null));
    const r = await probe({ portPath: '/dev/cu.x', baudRate: 9600, rtscts: false, stopBits: 2, legacy: true });
    assert.deepStrictEqual(r, { success: true, frequency: '14.074000' });
    assert.strictEqual(opened[0].stopBits, 2);
  });

  await test('a port that will not open is marked, so no second try is made', async () => {
    const at = main.indexOf('function probeSerialCat(');
    const end = main.indexOf('\nfunction armSerialHandshakeNoAnswerTrial(', at);
    class Busy extends EventEmitter { open(cb) { setImmediate(() => cb(new Error('Access denied'))); } close() {} }
    // eslint-disable-next-line no-new-func
    const probe = new Function('require', main.slice(at, end) + '\nreturn probeSerialCat;')(() => ({ SerialPort: Busy }));
    const r = await probe({ portPath: 'COM3', baudRate: 9600 });
    assert.strictEqual(r.portError, true);
  });

  await test('the handler resolves the rig\'s RTS line and model, and retries a silent Yaesu on Auto with RTS/CTS', () => {
    const h = main.slice(main.indexOf("handleCatTest('test-serial-cat'"), main.indexOf("handleCatTest('test-icom-civ'"));
    assert.ok(/resolveSerialHandshake\(model, \{ serialHandshake: config\.serialHandshake \}\)/.test(h));
    assert.ok(/rtscts: hs\.handshake === 'hardware'/.test(h));
    assert.ok(/hs\.source === 'model' && hs\.handshake !== 'hardware' && !legacy && SerialHsTrial\.trialApplies\(model\)/.test(h));
    const app = readSrc(path.join(__dirname, '..', 'renderer', 'app.js'));
    assert.ok(/testSerialCat\(\{ portPath, baudRate, dtrOff, serialHandshake, model \}\)/.test(app));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
