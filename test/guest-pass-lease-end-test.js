#!/usr/bin/env node
'use strict';
/**
 * A Guest Pass ends HARD (docs/share-my-rig-lease-plan.md, phase A; Casey
 * 2026-10-27). Until now the end of a pass sent `pass-ended` and nothing
 * else: the guest's socket stayed open and authenticated, PassEnforcement
 * dropped to idle (every limit gone), and whatever the guest had running —
 * an FT8 Run, the WSPR beacon, CW, SSTV, a held PTT — carried on under the
 * owner's call.
 *
 * Now: transmit is refused from endPass() until the settle to idle, main
 * stops every transmitter before the guest is told, and the guest's sockets
 * are closed. CW text and the paddle go through the same privilege gate as
 * every other key. The owner's voice recordings, activation and WSPR beacon
 * are not part of a pass.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { PassEnforcement } = require('../lib/pass-enforcement');
const { RemoteServer } = require('../lib/remote-server');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('PassEnforcement');
  await checkAsync('an ended session refuses transmit until it settles to idle, then the host is free again', async () => {
    const pe = new PassEnforcement({ revalidateMs: 0, log: () => {} });
    pe._state = 'active';
    pe._pass = { code: 'abcd1234', privilege_class: 'us_extra', privilege_class_short: 'extra', max_power_w: 100, allowed_modes: [] };
    pe._expiresAtMs = Date.now() + 60000;
    assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', freqHz: 14074000, mode: 'CW' }).allowed, true);
    pe.endPass('expired');
    assert.strictEqual(pe.getState(), 'ended');
    const r = pe.interceptCatCommand({ type: 'tx_enable', freqHz: 14074000, mode: 'CW' });
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.reason, 'ended');
    assert.strictEqual(pe.interceptCatCommand({ type: 'tune', freqHz: 14074000 }).allowed, true, 'listening is still fine');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(pe.getState(), 'idle');
    assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', freqHz: 14074000, mode: 'CW' }).allowed, true);
  });

  console.log('RemoteServer');
  await checkAsync('the end of a pass closes the guest socket and forgets the session', async () => {
    const PORT = 17397;
    const rs = new RemoteServer();
    rs.on('log', () => {});
    const expires = new Date(Date.now() + 3600_000).toISOString();
    rs.setPassValidator(async (code) => ({
      code, privilege_class: 'general', max_power_w: 100, allowed_modes: [], expires_at: expires,
      station_callsign: 'K3SBP', owner_callsign: 'W7RTA', status: 'active',
    }));
    rs.setPassAuthCallback(async () => {});
    rs.start(PORT, 'lease-end-token', { requireToken: true, certDir: require('os').tmpdir() });
    await sleep(600);
    const got = [];
    const ws = new WebSocket(`wss://127.0.0.1:${PORT}`, { rejectUnauthorized: false });
    let closed = null;
    ws.on('message', (raw) => { try { got.push(JSON.parse(raw)); } catch {} });
    ws.on('close', (code) => { closed = code; });
    ws.on('error', () => {});
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'auth', mode: 'pass', passCode: 'abcd1234', sessionId: 'a'.repeat(64) }));
    for (let i = 0; i < 40 && !got.some((m) => m.type === 'auth-ok'); i++) await sleep(50);
    const ok = got.find((m) => m.type === 'auth-ok');
    assert.ok(ok, 'the guest was admitted: ' + JSON.stringify(got.map((m) => m.type)));
    assert.strictEqual(ok.stationCallsign, 'K3SBP', 'the pass station call is the on-air call');
    assert.strictEqual(rs.hasActivePassClient(), true);

    rs.broadcastPassEnded('expired', 'abcd1234');
    for (let i = 0; i < 40 && closed == null; i++) await sleep(50);
    assert.ok(got.some((m) => m.type === 'pass-ended' && m.reason === 'expired'), 'pass-ended was sent first');
    assert.strictEqual(closed, 4001, 'then the socket was closed by the shack');
    assert.strictEqual(rs.hasActivePassClient(), false, 'no live pass client remains');
    rs.stop();
    await sleep(200);
  });

  console.log('main.js wiring');
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const rsSrc = fs.readFileSync(path.join(ROOT, 'lib/remote-server.js'), 'utf8');
  check('the ended handler stops every transmitter before the guest is told', () => {
    const i = main.indexOf("passEnforcement.on('ended'");
    const b = main.slice(i, i + 1200);
    const stop = b.indexOf('passLeaseStopTransmitters(info.reason)');
    const tell = b.indexOf('broadcastPassEnded(');
    assert.ok(stop > 0 && tell > stop, 'stop first, broadcast second');
  });
  check('passLeaseStopTransmitters covers Run, Hunt, WSPR, JTCAT TX, CW, SSTV, Mercury and PTT', () => {
    const i = main.indexOf('function passLeaseStopTransmitters(');
    const b = main.slice(i, main.indexOf('\nfunction jtcatHaltTxNow', i));
    for (const needle of ['stopFullAutoCq(', "setJtcatHuntMode('off')", 'setWsprBeacon(false', 'jtcatHaltTxNow()', 'cancelAllCwSends()', 'keyer.stop()', 'smartSdr.cwStop()', 'sstvHaltTxNow()', 'mercuryClient.abort()', 'handleRemotePtt(false)', 'gatedSetTransmit(false)', 'gatedSmartSdrTransmit(false)']) {
      assert.ok(b.includes(needle), 'missing ' + needle);
    }
  });
  check('CW text and the paddle ask the pass before keying', () => {
    const cw = main.slice(main.indexOf("remoteServer.on('cw-text'"), main.indexOf("remoteServer.on('cw-text'") + 300);
    assert.ok(/passTxAllowed\('CW'\)/.test(cw), 'cw-text');
    const paddle = main.slice(main.indexOf('paddleKeyRig = ({ down }) =>'), main.indexOf('paddleKeyRig = ({ down }) =>') + 300);
    assert.ok(/down && !passTxAllowed\('CW'\)/.test(paddle), 'paddle');
    const gate = main.slice(main.indexOf('function passTxAllowed('), main.indexOf('function passTxAllowed(') + 500);
    assert.ok(/interceptCatCommand\(\{ type: 'tx_enable'/.test(gate), 'the one gate');
  });
  check('the owner\'s recordings, activation and WSPR beacon are refused to a guest', () => {
    for (const t of ['voice-macro-sync', 'voice-macro-delete', 'voice-macro-get', 'voice-macro-play', 'set-activator-park', 'jtcat-wspr-beacon']) {
      const i = rsSrc.indexOf(`case '${t}':`);
      assert.ok(i > 0, t);
      const b = rsSrc.slice(i, i + 400);
      assert.ok(/if \(ws\._passSession\)/.test(b), t + ' has no guest check');
    }
  });
  check('broadcastPassEnded closes the socket and clears the session', () => {
    const i = rsSrc.indexOf('broadcastPassEnded(reason, code = null)');
    const b = rsSrc.slice(i, i + 1500);
    assert.ok(/client\._passSession = null;/.test(b));
    assert.ok(/client\._authenticated = false;/.test(b));
    assert.ok(/client\.close\(4001/.test(b));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
