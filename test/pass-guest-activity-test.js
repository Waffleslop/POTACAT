#!/usr/bin/env node
'use strict';
/**
 * Guest Pass: the owner's take-over dialog learns whether the guest is
 * connected and when they last used the radio (ECHOCAT handoff 2026-11-22,
 * lib/pass-guest-activity.js).
 *
 * auth-ok.passGuest and pass-guest-waiting carry {connected, lastActiveAt}.
 * The clock starts when the guest's session began; an action on the radio is
 * the hand-back rule's list (lib/pass-owner-activity.js). A waiting owner
 * device hears again only when connected flips or the guest acts after 2
 * minutes or more without an action. Nothing about what the guest did is sent.
 */
const assert = require('assert');
const os = require('os');
const WebSocket = require('ws');
const GA = require('../lib/pass-guest-activity');
const protocol = require('../lib/echocat-protocol');
const { RemoteServer } = require('../lib/remote-server');

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
async function until(fn, ms = 2000) {
  for (let t = 0; t < ms; t += 25) { if (fn()) return true; await sleep(25); }
  return false;
}

const MIN = 60 * 1000;

console.log('lib/pass-guest-activity');
check('the clock starts with the session; the same pass keeps it, another pass starts again', () => {
  const s = GA.startSession(null, 'ABCD1234', 1000);
  assert.deepStrictEqual(s, { code: 'abcd1234', startedAt: 1000, lastActiveAt: 1000 });
  assert.strictEqual(GA.startSession(s, 'abcd1234', 9000), s, 'a reconnect keeps the clock');
  assert.strictEqual(GA.startSession(s, 'other999', 9000).lastActiveAt, 9000);
  assert.strictEqual(GA.startSession(null, '', 5), null);
});
check('an action on the radio is the hand-back rule\'s list; pings, reads and key-ups are not', () => {
  for (const m of [{ type: 'tune', freqKhz: 14074 }, { type: 'set-mode', mode: 'USB' }, { type: 'ptt', state: true },
    { type: 'cw-text', text: 'CQ' }, { type: 'jtcat-call-cq' }, { type: 'sstv-photo' }, { type: 'voice-macro-play' }]) {
    assert.ok(GA.actionKind(m), m.type + ' counts');
  }
  for (const m of [{ type: 'ping' }, { type: 'ptt', state: false }, { type: 'get-audio-devices' }, { type: 'aprs-subscribe', on: true }, { type: 'paddle', state: false }]) {
    assert.strictEqual(GA.actionKind(m), null, m.type + ' does not count');
  }
});
check('an action moves lastActiveAt; it wakes only after 2 minutes or more without one', () => {
  let s = GA.startSession(null, 'abcd1234', 0);
  let r = GA.noteMessage(s, { type: 'ping' }, 5 * MIN);
  assert.strictEqual(r.state.lastActiveAt, 0, 'a ping is not an action');
  assert.strictEqual(r.woke, false);
  r = GA.noteMessage(s, { type: 'set-mode', mode: 'CW' }, 1 * MIN);
  assert.strictEqual(r.state.lastActiveAt, 1 * MIN);
  assert.strictEqual(r.woke, false, 'active within 2 minutes of the start: no wake');
  s = r.state;
  r = GA.noteMessage(s, { type: 'tune', freqKhz: 7074 }, 1 * MIN + GA.GUEST_IDLE_MS);
  assert.strictEqual(r.woke, true, 'exactly 2 minutes idle, then an action: wake');
  r = GA.noteMessage(r.state, { type: 'tune', freqKhz: 7075 }, 1 * MIN + GA.GUEST_IDLE_MS + 1000);
  assert.strictEqual(r.woke, false, 'the next action is not news');
  assert.deepStrictEqual(GA.noteMessage(null, { type: 'tune' }, 1), { state: null, woke: false });
});
check('the fields are only connected and lastActiveAt; lastActiveAt is absent for another pass or no clock', () => {
  const s = { code: 'abcd1234', startedAt: 10, lastActiveAt: 20, secret: 'x' };
  assert.deepStrictEqual(GA.waitingFields(s, { connected: true, code: 'ABCD1234' }), { connected: true, lastActiveAt: 20 });
  assert.deepStrictEqual(GA.waitingFields(s, { connected: false, code: 'zzzz0000' }), { connected: false });
  assert.deepStrictEqual(GA.waitingFields(null, { connected: true }), { connected: true });
});
check('re-send only on a real change', () => {
  assert.strictEqual(GA.shouldResend(null, { connected: true }, false), true);
  assert.strictEqual(GA.shouldResend({ connected: true }, { connected: true, lastActiveAt: 5 }, false), false);
  assert.strictEqual(GA.shouldResend({ connected: true }, { connected: false }, false), true);
  assert.strictEqual(GA.shouldResend({ connected: true }, { connected: true }, true), true);
});
check('the protocol registry lists both fields on pass-guest-waiting', () => {
  const v = protocol.validate({ type: 'pass-guest-waiting', callsign: 'K3SBP', connected: false, lastActiveAt: Date.now() }, protocol.Dir.S2C);
  assert.ok(v.ok, JSON.stringify(v));
  const bad = protocol.validate({ type: 'pass-guest-waiting', connected: 'yes' }, protocol.Dir.S2C);
  assert.ok(!bad.ok, 'connected is a boolean');
});

console.log('clients-list: the pass a guest is on, for owner devices only (lib/clients-list.js)');
check('the owner copy has passCode and call on the guest row; the guest copy has neither', () => {
  const rs = new RemoteServer();
  rs._remoteSettings = { myCallsign: 'W7RTA' };
  const sent = [];
  rs._sendTo = (ws, m) => sent.push({ ws, m });
  const mk = (id, extra) => ({ readyState: WebSocket.OPEN, _authenticated: true, _clientId: id, _clientPlatform: 'ios', ...extra });
  const ownerWs = mk('c1');
  const guestWs = mk('c2', { _passSession: { code: 'abcd1234', passProfile: { guest_callsign: 'wc5t' } } });
  const anonWs = mk('c3', { _passSession: { code: 'anon0000', passProfile: { guest_callsign: null } } });
  rs._clients = new Set([ownerWs, guestWs, anonWs]);
  rs._broadcastClientsList();
  const copy = (ws) => sent.find((x) => x.ws === ws).m.clients;
  const o = copy(ownerWs);
  const og = o.find((r) => r.id === 'c2');
  assert.strictEqual(og.guest, true);
  assert.strictEqual(og.passCode, 'abcd1234');
  assert.strictEqual(og.call, 'WC5T', 'the on-air call of the guest');
  const oa = o.find((r) => r.id === 'c3');
  assert.strictEqual(oa.passCode, 'anon0000');
  assert.strictEqual(oa.call, '', 'an anonymous guest: no call, never the owner call');
  const oo = o.find((r) => r.id === 'c1');
  assert.ok(!('passCode' in oo) && !('call' in oo), 'the own row of the owner is unchanged');
  assert.strictEqual(oo.you, true);
  for (const g of [guestWs, anonWs]) {
    for (const r of copy(g)) {
      assert.ok(!('passCode' in r) && !('call' in r), 'a guest sees no pass code or call on any row');
      assert.ok(!('ownerOnly' in r));
    }
  }
  assert.strictEqual(copy(guestWs).find((r) => r.id === 'c2').you, true);
  for (const x of sent) for (const r of x.m.clients) assert.ok(!('ownerOnly' in r), 'the internal field never leaves');
});

// ── RemoteServer ───────────────────────────────────────────────────────
const TOKEN = 'guest-activity-token';
const CODE = 'abcd1234';

function client(port) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  const c = { ws, got: [], closed: null };
  ws.on('message', (raw) => { try { c.got.push(JSON.parse(raw)); } catch {} });
  ws.on('close', (code) => { c.closed = code; });
  ws.on('error', () => {});
  c.open = new Promise((r) => ws.on('open', r));
  c.send = (m) => ws.send(JSON.stringify(m));
  c.all = (type) => c.got.filter((m) => m.type === type);
  c.find = (type) => c.got.find((m) => m.type === type);
  return c;
}
function server(port, clock) {
  const rs = new RemoteServer();
  rs.on('log', () => {});
  rs._clock = () => clock.now;
  const expires = new Date(Date.now() + 3600_000).toISOString();
  rs.setPassValidator(async (code) => ({
    code, privilege_class: 'general', max_power_w: 100, allowed_modes: [], expires_at: expires,
    station_callsign: '', owner_callsign: 'W7RTA', status: 'active', guest_callsign: 'K3SBP',
  }));
  const live = { live: false, paused: false, code: null, call: '', endsAt: expires };
  rs.setPassAuthCallback(async (code) => { Object.assign(live, { live: true, code, call: 'K3SBP' }); });
  rs.setPassLiveCheck(() => ({ ...live }));
  rs.start(port, TOKEN, { requireToken: true, certDir: os.tmpdir() });
  return { rs, live };
}
async function guest(port) {
  const g = client(port);
  await g.open;
  g.send({ type: 'auth', mode: 'pass', passCode: CODE, sessionId: 'a'.repeat(64) });
  await until(() => g.find('auth-ok') || g.find('auth-fail'));
  return g;
}
async function owner(port) {
  const o = client(port);
  await o.open;
  o.send({ type: 'auth', token: TOKEN });
  await until(() => o.find('auth-ok') || o.find('auth-fail'));
  return o;
}

(async () => {
  console.log('RemoteServer');
  await checkAsync('a waiting owner device hears connected and lastActiveAt, and again only on a real change', async () => {
    const PORT = 17481;
    const clock = { now: 1_000_000 };
    const { rs } = server(PORT, clock);
    await sleep(500);
    try {
      const g = await guest(PORT);
      assert.ok(g.find('auth-ok'), 'guest admitted');
      clock.now += 10 * MIN;
      const o = await owner(PORT);
      const pg = o.find('auth-ok').passGuest;
      assert.ok(pg, 'auth-ok carries passGuest');
      assert.deepStrictEqual(Object.keys(pg).sort(), ['callsign', 'connected', 'endsAt', 'lastActiveAt']);
      assert.strictEqual(pg.connected, true);
      assert.strictEqual(pg.lastActiveAt, 1_000_000, 'the clock started with the session: idle 10 minutes');

      // A ping and a key-up are not actions; nothing is sent.
      g.send({ type: 'ping', ts: 1 });
      g.send({ type: 'ptt', state: false });
      await sleep(200);
      assert.strictEqual(o.all('pass-guest-waiting').length, 0, 'no re-send for a ping or a key-up');

      // Idle to active: one re-send.
      g.send({ type: 'set-mode', mode: 'USB' });
      assert.ok(await until(() => o.all('pass-guest-waiting').length === 1), 'idle to active is news');
      const w1 = o.all('pass-guest-waiting')[0];
      assert.strictEqual(w1.connected, true);
      assert.strictEqual(w1.lastActiveAt, clock.now);
      assert.deepStrictEqual(Object.keys(w1).sort(), ['callsign', 'connected', 'endsAt', 'lastActiveAt', 'type'], 'nothing about what the guest did');

      // Active again a minute later: not news.
      clock.now += 1 * MIN;
      g.send({ type: 'set-mode', mode: 'CW' });
      await sleep(200);
      assert.strictEqual(o.all('pass-guest-waiting').length, 1, 'no re-send on every action');

      // The guest drops: connected false, the clock kept.
      const lastAt = clock.now;
      g.ws.close();
      assert.ok(await until(() => o.all('pass-guest-waiting').length === 2), 'a drop is news');
      const w2 = o.all('pass-guest-waiting')[1];
      assert.strictEqual(w2.connected, false);
      assert.strictEqual(w2.lastActiveAt, lastAt);

      // Back inside the hold: connected true, same clock.
      clock.now += 30 * 1000;
      const g2 = await guest(PORT);
      assert.ok(g2.find('auth-ok'));
      assert.ok(await until(() => o.all('pass-guest-waiting').length === 3), 'a reconnect is news');
      const w3 = o.all('pass-guest-waiting')[2];
      assert.strictEqual(w3.connected, true);
      assert.strictEqual(w3.lastActiveAt, lastAt, 'a reconnect keeps the clock');

      // An owner device connecting inside the hold sees connected false.
      g2.ws.close();
      assert.ok(await until(() => o.all('pass-guest-waiting').length === 4));
      const o2 = await owner(PORT);
      assert.strictEqual(o2.find('auth-ok').passGuest.connected, false);
      o.ws.close(); o2.ws.close();
    } finally { rs.stop(); await sleep(200); }
  });

  await checkAsync('Lend my rig: the owner device that moves to waiting gets the fields once', async () => {
    const PORT = 17482;
    const clock = { now: 5_000_000 };
    const { rs } = server(PORT, clock);
    await sleep(500);
    try {
      const o = await owner(PORT);
      o.send({ type: 'owner-presence', operating: false });
      await sleep(100);
      const g = await guest(PORT);
      assert.ok(g.find('auth-ok'));
      assert.ok(await until(() => o.all('pass-guest-waiting').length >= 1));
      await sleep(200);
      const w = o.all('pass-guest-waiting');
      assert.strictEqual(w.length, 1, 'one message, not a second for the same news');
      assert.strictEqual(w[0].connected, true);
      assert.strictEqual(w[0].lastActiveAt, 5_000_000);
      o.ws.close(); g.ws.close();
    } finally { rs.stop(); await sleep(200); }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
