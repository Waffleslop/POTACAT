#!/usr/bin/env node
'use strict';
/**
 * CW Key Port replaced while it is opening (stein_12464, Discord 2026-11-01).
 * A settings save that changed the key port reopened it (connectCwKeyPort,
 * async open) and then restarted ECHOCAT, whose disconnectRemote() called
 * disconnectCwKeyPort() before the open had landed. That dropped the handle
 * without closing it; the open then completed on an orphan that held the
 * (exclusive, on Windows) port, the radio keyed once from the open's DTR
 * blip, and every later open failed: "Opened COM10 (lazy)" then "CW Key Port
 * did not become ready". Also: the port picked in Settings > ECHOCAT saved
 * only settings.cwKeyPort, and the active rig's own copy put COM9 back.
 *
 * Runs the REAL connectCwKeyPort / disconnectCwKeyPort from main.js against
 * a fake SerialPort. Run: node test/cw-key-port-race-test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function bodyOf(name) {
  const start = MAIN.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found');
  let d = 0, i = MAIN.indexOf(') {', start) + 2;
  for (; i < MAIN.length; i++) { if (MAIN[i] === '{') d++; else if (MAIN[i] === '}' && --d === 0) break; }
  return MAIN.slice(start, i + 1);
}

// A fake node-serialport: open() completes when the test says so.
const ports = [];
class FakeSerialPort {
  constructor(opts) { this.path = opts.path; this.isOpen = false; this.handlers = {}; this.sets = []; this.closed = false; ports.push(this); }
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  open(cb) { this._openCb = cb; }
  finishOpen() { this.isOpen = true; (this.handlers.open || []).forEach((f) => f()); if (this._openCb) this._openCb(null); }
  failOpen(msg) { if (this._openCb) this._openCb(new Error(msg)); }
  set(state, cb) { this.sets.push(state); if (cb) cb(null); }
  close() { this.isOpen = false; this.closed = true; (this.handlers.close || []).forEach((f) => f()); }
}

function harness() {
  const logs = [];
  const env = {
    settings: { cwKeyPort: 'COM10', catTarget: { type: 'rigctld', serialPort: 'COM3' } },
    cwKeyPort: null, _cwKeyPortPathForPython: null, _cwKeyPortIoctlLatched: false, _cwKeyPortEverOpened: false,
    logs,
  };
  // eslint-disable-next-line no-new-func
  const make = new Function('env', 'FakeSerialPort', `
    let settings = env.settings, cwKeyPort = null, _cwKeyPortPathForPython = null, _cwKeyPortIoctlLatched = false, _cwKeyPortEverOpened = false;
    const sendCatLog = (l) => env.logs.push(l);
    const killCwPersistentKeyer = () => {};
    const _setCwPaddleAvailability = () => {};
    const require = (m) => m === 'serialport' ? { SerialPort: FakeSerialPort } : {};
    ${bodyOf('connectCwKeyPort')}
    ${bodyOf('disconnectCwKeyPort')}
    return { connectCwKeyPort, disconnectCwKeyPort, current: () => cwKeyPort };`);
  return Object.assign(env, make(env, FakeSerialPort));
}

test('dropped while opening: the open completes, is closed at once, and never becomes the key port', () => {
  ports.length = 0;
  const h = harness();
  h.connectCwKeyPort();                 // settings save reopens COM10 (async)
  const first = ports[0];
  h.disconnectCwKeyPort();              // ECHOCAT restart drops it mid-open
  assert.strictEqual(h.current(), null);
  first.finishOpen();                   // the open lands afterwards
  assert.ok(first.closed, 'the late open must be closed, not orphaned');
  assert.deepStrictEqual(first.sets[0], { dtr: false, rts: false }, 'key line down before closing');
  assert.ok(h.logs.some((l) => /Closed COM10 again at once/.test(l)));
  assert.ok(!h.logs.some((l) => /Opened COM10/.test(l)), 'no "Opened" for a handle that is not the key port');
});
test('after that, the next open (a CW send) gets the port', () => {
  ports.length = 0;
  const h = harness();
  h.connectCwKeyPort();
  h.disconnectCwKeyPort();
  ports[0].finishOpen();
  h.connectCwKeyPort();                 // the lazy open from a CW send
  const second = ports[1];
  second.finishOpen();
  assert.strictEqual(h.current(), second);
  assert.ok(second.isOpen && !second.closed);
});
test('a replaced port\'s close never clears the newer handle', () => {
  ports.length = 0;
  const h = harness();
  h.connectCwKeyPort();
  const first = ports[0];
  h.connectCwKeyPort();                 // replaced while opening (connect calls disconnect first)
  const second = ports[1];
  first.finishOpen();                   // closes itself; its close handler runs
  second.finishOpen();
  assert.strictEqual(h.current(), second);
});
test('a failed open is said in the log, not only the console', () => {
  ports.length = 0;
  const h = harness();
  h.connectCwKeyPort();
  ports[0].failOpen('Access denied');
  assert.ok(h.logs.some((l) => /Could not open COM10: Access denied/.test(l)));
  assert.strictEqual(h.current(), null);
});
test('a normal open still opens, drops the key line and logs it', () => {
  ports.length = 0;
  const h = harness();
  h.connectCwKeyPort();
  ports[0].finishOpen();
  assert.strictEqual(h.current(), ports[0]);
  assert.ok(h.logs.some((l) => /Opened COM10 \(lazy\)/.test(l)));
});
test('Settings > ECHOCAT key port also updates the active rig\'s own copy (no revert to the old port)', () => {
  assert.ok(/if \(has\('cwKeyPort'\) && !has\('rigs'\) && Array\.isArray\(settings\.rigs\)\) \{[\s\S]{0,300}activeRig\.cwKeyPort = settings\.cwKeyPort \|\| '';/.test(MAIN));
});

console.log(`\nCW key port race: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
