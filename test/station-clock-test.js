#!/usr/bin/env node
'use strict';
// Shack clock from an ECHOCAT device (2026-10-25): the decision, the corrected
// clock, a real probe round trip through the WS demux, and the wiring that
// makes every slotted mode read the corrected clock.
// Spec: potacat-app docs/desktop-handoffs/clock-from-phone.md.
// Run: node test/station-clock-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const StationClock = require('../lib/station-clock');

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message || e)); }
  });
}
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

test('the handoff fixture: shack 1865 ms fast, round trip 70 ms', () => {
  const t0 = 1000, t1 = 2900, t2 = 2910, t3 = 1080;
  const rtt = (t3 - t0) - (t2 - t1);
  const offsetMs = ((t1 - t0) + (t2 - t3)) / 2;
  assert.strictEqual(rtt, 70);
  assert.strictEqual(offsetMs, 1865);
  assert.deepStrictEqual(StationClock.decideClockApply({ offsetMs, rttMs: rtt, samples: 8 }, { ntpLevel: null }), { ok: true, aheadMs: 1865 });
});

test('refusals', () => {
  const d = (m, c) => StationClock.decideClockApply(m, c || {}).error;
  assert.strictEqual(d({ offsetMs: 500, rttMs: 50 }, { guest: true }), 'guest-pass');
  assert.strictEqual(d({ offsetMs: 500, rttMs: 401 }), 'rtt-too-high');
  assert.strictEqual(StationClock.decideClockApply({ offsetMs: 500, rttMs: 400 }, {}).ok, true, '400 ms is the limit, inclusive');
  assert.strictEqual(d({ offsetMs: 500, rttMs: 50 }, { ntpLevel: 'ok' }), 'ntp-ok');
  assert.strictEqual(StationClock.decideClockApply({ offsetMs: 500, rttMs: 50 }, { ntpLevel: 'bad' }).ok, true, 'a reachable but wrong clock still takes the device time');
  assert.strictEqual(d({ offsetMs: 'x', rttMs: 50 }), 'bad-value');
  assert.strictEqual(d({ offsetMs: 500, rttMs: -1 }), 'bad-value');
  assert.strictEqual(d({ offsetMs: 25 * 3600 * 1000, rttMs: 50 }), 'bad-value');
  for (const e of ['guest-pass', 'rtt-too-high', 'ntp-ok', 'bad-value']) {
    assert.ok(StationClock.describeApplyError(e).length > 10, e);
  }
});

test('now() runs aheadMs behind the computer clock; clear restores it', () => {
  StationClock.clear();
  assert.ok(Math.abs(StationClock.now() - Date.now()) < 5);
  StationClock.setCorrection(1865, { source: 'device', device: 'An iPhone or iPad', rttMs: 70 });
  assert.ok(Math.abs((Date.now() - StationClock.now()) - 1865) < 5);
  assert.strictEqual(StationClock.info().device, 'An iPhone or iPad');
  assert.strictEqual(StationClock.info().aheadMs, 1865);
  assert.strictEqual(StationClock.clear(), true);
  assert.strictEqual(StationClock.info(), null);
  assert.strictEqual(StationClock.clear(), false);
});

test('a corrected engine fires its slot on the corrected clock', () => {
  const { Ft8Engine } = require('../lib/ft8-engine');
  StationClock.setCorrection(-4000, { source: 'device', device: 't' }); // computer 4 s slow
  const e = new Ft8Engine();
  const lag = Date.now() - e._adjustedNow();
  StationClock.clear();
  assert.ok(Math.abs(lag + 4000) < 5, 'adjusted now = corrected now - latency (0)');
});

test('probe reply: t0/seq echoed, raw clock, asker only', () => {
  const src = read('lib/remote-server.js');
  const at = src.indexOf("case 'clock-probe': {");
  assert.ok(at > 0, 'clock-probe case');
  const caseSrc = src.slice(at, src.indexOf("case 'set-tx-drive':", at));
  assert.ok(/this\._sendTo\(ws, \{ type: 'clock-probe-reply', t0: msg\.t0, seq: msg\.seq, t1, t2: Date\.now\(\) \}\)/.test(caseSrc), 'reply to the asker\'s socket, raw Date.now()');
  assert.ok(!/_sendToAll/.test(caseSrc), 'never broadcast');
  assert.ok(/guest: !!ws\._passSession/.test(caseSrc));
});

test('the real demux answers a probe and emits an apply', () => {
  const { EventEmitter } = require('events');
  const { RemoteServer } = require('../lib/remote-server');
  const srv = Object.create(RemoteServer.prototype);
  EventEmitter.call(srv);
  const ws = { _authenticated: true, readyState: 1, _passSession: null, _clientPlatform: 'ios' };
  const other = { _authenticated: true, readyState: 1 };
  srv._client = ws;
  srv._clients = new Set([ws, other]);
  const sent = [];
  srv._sendTo = (to, msg) => sent.push({ to, msg });
  srv._sendToAll = (msg) => sent.push({ to: 'all', msg });
  const before = Date.now();
  srv._handleMessage(ws, { type: 'clock-probe', t0: 1234.5, seq: 7 });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].to, ws, 'only the asker');
  const r = sent[0].msg;
  assert.strictEqual(r.type, 'clock-probe-reply');
  assert.strictEqual(r.t0, 1234.5);
  assert.strictEqual(r.seq, 7);
  assert.ok(r.t1 >= before && r.t2 >= r.t1 && r.t2 - before < 50, 'raw clock stamps');
  StationClock.setCorrection(5000, { device: 't' });
  sent.length = 0;
  srv._handleMessage(ws, { type: 'clock-probe', t0: 1, seq: 8 });
  StationClock.clear();
  assert.ok(Math.abs(sent[0].msg.t1 - Date.now()) < 50, 'a correction in use does not change the probe stamps');
  let applied = null;
  srv.on('clock-apply', (m) => { applied = m; });
  srv._handleMessage(ws, { type: 'clock-apply', offsetMs: 1865, rttMs: 70, samples: 8 });
  assert.deepStrictEqual(applied, { offsetMs: 1865, rttMs: 70, samples: 8, guest: false, device: 'An iPhone or iPad' });
  ws._passSession = { code: 'X' };
  srv._handleMessage(ws, { type: 'clock-apply', offsetMs: 1865, rttMs: 70, samples: 8 });
  assert.strictEqual(applied.guest, true);
});

test('wiring', () => {
  const main = read('main.js');
  const rs = read('lib/remote-server.js');
  const proto = require('../lib/echocat-protocol');
  for (const t of ['clock-probe', 'clock-probe-reply', 'clock-apply', 'clock-apply-result']) {
    assert.ok(proto.MESSAGES && proto.MESSAGES[t] || read('lib/echocat-protocol.js').includes(`'${t}':`), t + ' in the registry');
  }
  assert.ok(/'clock-from-device'\]/.test(rs), 'hello capability');
  assert.ok(/now: StationClock\.now\(\)/.test(rs), 'hello carries the corrected clock');
  for (const f of ['lib/ft8-engine.js', 'lib/jtty-engine.js', 'lib/js8-engine.js']) {
    const s = read(f);
    assert.ok(s.includes("require('./station-clock')"), f);
    assert.ok(!/Date\.now\(\)/.test(s), f + ' reads no raw clock');
  }
  const listener = main.slice(main.indexOf("remoteServer.on('clock-apply'"), main.indexOf("remoteServer.on('tx-eq-set'"));
  assert.ok(/StationClock\.decideClockApply\(m, \{ guest: m\.guest/.test(listener));
  assert.ok((listener.match(/remoteServer\.sendToAsker\(\{ type: 'clock-apply-result'/g) || []).length === 2, 'both outcomes go to the asker');
  assert.ok(/function jtcatPeriodUtc[\s\S]{0,200}StationClock\.now\(\)/.test(main), 'period labels');
  assert.ok(/nowMs: StationClock\.now\(\), periodMs/.test(main), 'CQ slot choice');
  assert.ok(/jtcatWsprScheduler\.tick\(StationClock\.now\(\)\)/.test(main), 'WSPR beacon');
  assert.ok(/_ntpRawClockLevel === 'ok' && StationClock\.info\(\)/.test(main), 'NTP in spec drops the correction');
  assert.ok(/res\.offset \+ StationClock\.aheadMs\(\)/.test(main), 'NTP reading is of the corrected clock');
});

(async () => {
  for (const t of pending) await t();
  console.log(`\nStation clock: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
