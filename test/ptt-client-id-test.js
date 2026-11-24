#!/usr/bin/env node
'use strict';
// #941: with "more than one device" on, an unpaired browser that reconnects
// left its old (dead) socket holding PTT for about 45 s, and the shack ignored
// the PTT off from the new socket. A page now sends a random per-page id in
// its hello (lib/ptt-client-id.js); the same id, authenticated the same way,
// coming back while the old socket holds PTT releases it at once and closes
// the old socket. A different id, or none, changes nothing. Never keys.
// Real RemoteServer on 127.0.0.1 only, raw WebSocket clients.
// Run: node test/ptt-client-id-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { readSrc } = require('./_src');
const PttClientId = require('../lib/ptt-client-id');
const { RemoteServer } = require('../lib/remote-server');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
}
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' - ' + e.message.split('\n')[0]); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (b) => crypto.randomFillSync(b);
const ID_A = 'a'.repeat(8) + '0123456789abcdef0123456789';
const ID_B = 'b'.repeat(8) + '0123456789abcdef0123456789';

// ── the pure rules ─────────────────────────────────────────────────
console.log('lib/ptt-client-id.js');
t('make: 32 hex characters, valid, different each time', () => {
  const a = PttClientId.make(rand), b = PttClientId.make(rand);
  assert.ok(/^[0-9a-f]{32}$/.test(a) && PttClientId.valid(a));
  assert.notStrictEqual(a, b);
});
t('valid: refuses short, long, odd characters and non-strings', () => {
  assert.ok(!PttClientId.valid('abc'));
  assert.ok(!PttClientId.valid('x'.repeat(65)));
  assert.ok(!PttClientId.valid('a'.repeat(30) + ' <'));
  assert.ok(!PttClientId.valid(12345678901234567890123));
  assert.ok(!PttClientId.valid(null) && !PttClientId.valid(undefined));
});
t('load: keeps the stored id; makes and stores one when missing or bad; survives storage that throws', () => {
  const store = {};
  const ss = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
  const first = PttClientId.load(ss, rand);
  assert.strictEqual(store[PttClientId.STORAGE_KEY], first);
  assert.strictEqual(PttClientId.load(ss, rand), first, 'a reload keeps it');
  store[PttClientId.STORAGE_KEY] = 'junk';
  assert.notStrictEqual(PttClientId.load(ss, rand), 'junk');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.ok(PttClientId.valid(PttClientId.load(broken, rand)));
  assert.ok(PttClientId.valid(PttClientId.load(null, rand)));
  const renewed = PttClientId.renew(ss, rand);
  assert.ok(renewed !== first && store[PttClientId.STORAGE_KEY] === renewed, 'a duplicated tab takes a new id');
});
t('sameClient: same id and same way in only', () => {
  const me = { id: ID_A, scope: 'owner', deviceId: '' };
  assert.ok(PttClientId.sameClient(me, { ...me }));
  assert.ok(!PttClientId.sameClient(me, { ...me, id: ID_B }), 'a different id');
  assert.ok(!PttClientId.sameClient({ ...me, id: '' }, { ...me, id: '' }), 'no id on either side (older clients)');
  assert.ok(!PttClientId.sameClient(me, { ...me, id: '' }), 'no id on the newcomer');
  assert.ok(!PttClientId.sameClient(me, { ...me, scope: 'pass:ABC123' }), 'a Guest Pass never matches the owner');
  assert.ok(!PttClientId.sameClient({ ...me, scope: 'pass:ABC123' }, { ...me, scope: 'pass:XYZ789' }), 'two passes never match');
  assert.ok(!PttClientId.sameClient({ ...me, deviceId: 'd1' }, { ...me, deviceId: 'd2' }), 'two paired devices never match');
  assert.ok(PttClientId.sameClient({ ...me, deviceId: 'd1' }, { ...me, deviceId: '' }), 'paired stamp arriving later still matches');
});
t('releasesStaleHolder: only while PTT is on and held by the same client', () => {
  const holder = { id: ID_A, scope: 'owner', deviceId: '' };
  assert.ok(PttClientId.releasesStaleHolder({ pttActive: true, holder, newcomer: { ...holder } }));
  assert.ok(!PttClientId.releasesStaleHolder({ pttActive: false, holder, newcomer: { ...holder } }), 'PTT off: nothing to release');
  assert.ok(!PttClientId.releasesStaleHolder({ pttActive: true, holder: null, newcomer: holder }));
  assert.ok(!PttClientId.releasesStaleHolder({ pttActive: true, holder, newcomer: holder }), 'the holder itself');
  assert.ok(!PttClientId.releasesStaleHolder({ pttActive: true, holder, newcomer: { ...holder, id: ID_B } }));
});

// ── the page and the wire ──────────────────────────────────────────
console.log('\nwiring');
t('ECHOCAT Web sends pttClientId in its hello and gets the module inlined', () => {
  const js = readSrc(path.join(__dirname, '..', 'renderer', 'remote.js'));
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'remote.html'));
  const srv = readSrc(path.join(__dirname, '..', 'lib', 'remote-server.js'));
  assert.ok(/PttClientId\.load\(/.test(js), 'the page loads its id');
  assert.ok(/type: 'hello'[\s\S]{0,4000}pttClientId: pttClientId/.test(js), 'the hello carries it');
  assert.ok(/BroadcastChannel\('echocat-ptt-client-id'\)/.test(js), 'a duplicated tab is told to take a new id');
  assert.ok(html.includes('<!-- ptt-client-id-js -->'), 'remote.html has the marker');
  assert.ok(srv.includes("['ptt-client-id-js', 'ptt-client-id.js']"), 'remote-server inlines it');
});
t('the protocol registry lists pttClientId as an optional hello field', () => {
  const protocol = require('../lib/echocat-protocol');
  const v = protocol.validate({ type: 'hello', protocolVersion: 1, pttClientId: ID_A }, protocol.Dir.C2S);
  assert.ok(v.ok, v.error);
  assert.ok(protocol.validate({ type: 'hello', protocolVersion: 1 }, protocol.Dir.C2S).ok, 'absent is fine');
  assert.ok(!protocol.validate({ type: 'hello', protocolVersion: 1, pttClientId: 5 }, protocol.Dir.C2S).ok, 'a non-string is refused');
});

// ── a real shack ───────────────────────────────────────────────────
function openClient(port, { id, token } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const got = [];
    const c = { ws, got, closed: false };
    ws.on('message', (d) => { try { got.push(JSON.parse(d)); } catch {} });
    ws.on('close', () => { c.closed = true; });
    ws.on('error', () => {});
    ws.on('open', () => {
      const hello = { type: 'hello', protocolVersion: 1, clientVersion: 'web', clientPlatform: 'web' };
      if (id) hello.pttClientId = id;
      ws.send(JSON.stringify(hello));
      if (token) ws.send(JSON.stringify({ type: 'auth', token }));
    });
    const started = Date.now();
    (function wait() {
      if (got.some(m => m.type === 'auth-ok') || Date.now() - started > 4000) return setTimeout(() => resolve(c), 150);
      setTimeout(wait, 20);
    })();
  });
}
const send = (c, obj) => c.ws.send(JSON.stringify(obj));

async function shack(port, opts) {
  const rs = new RemoteServer();
  rs.setMultiClient(true);
  const ptts = [];
  const logs = [];
  rs.on('ptt', (p) => ptts.push(p.state));
  rs.on('log', (m) => logs.push(String(m)));
  rs.on('error', () => {});
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptt-client-id-'));
  rs.start(port, 'ptt-client-id-token', { certDir, host: '127.0.0.1', mdns: false, ...opts });
  await sleep(600);
  return { rs, ptts, logs };
}

(async () => {
  const TOKEN = 'ptt-client-id-token';
  const PORT = 17461;

  console.log('\nmulti-device on, unpaired browser (shared token)');
  const { rs, ptts, logs } = await shack(PORT, { requireToken: true });
  const reset = () => { ptts.length = 0; logs.length = 0; };

  // same id reconnects while the stale socket holds PTT
  {
    reset();
    const stale = await openClient(PORT, { id: ID_A, token: TOKEN });
    send(stale, { type: 'ptt', state: true });
    await sleep(200);
    check(rs._pttActive === true && ptts.join() === 'true', 'the first socket keys');
    // The stale socket is never closed by the page: from the shack it is still OPEN.
    const fresh = await openClient(PORT, { id: ID_A, token: TOKEN });
    await sleep(250);
    check(rs._pttActive === false, 'same id: PTT released at once');
    check(ptts.join() === 'true,false', 'exactly one unkey, no key');
    check(stale.closed === true, 'the stale socket is closed');
    check(logs.filter(l => l === 'PTT released: the same client reconnected').length === 1, 'one log line');
    check(!logs.some(l => l.includes(ID_A)), 'the id is never logged');
    check(rs._openClients().length === 1 && rs._openClients()[0] !== undefined, 'the new socket stays connected');
    const list = fresh.got.filter(m => m.type === 'clients-list').pop();
    check(list && !list.clients.some(c => c.keyed) && !JSON.stringify(fresh.got).includes(ID_A), 'presence shows nobody keyed and never carries the id');
    send(fresh, { type: 'ptt', state: false }); // #940's owed off arrives: harmless
    await sleep(150);
    check(!ptts.slice(2).includes(true), 'the owed off never keys');
    fresh.ws.close(); await sleep(250);
  }

  // a different id: no release
  {
    reset();
    const holder = await openClient(PORT, { id: ID_A, token: TOKEN });
    send(holder, { type: 'ptt', state: true });
    await sleep(200);
    const other = await openClient(PORT, { id: ID_B, token: TOKEN });
    await sleep(250);
    check(rs._pttActive === true && holder.closed === false, 'different id: PTT kept, holder stays connected');
    send(other, { type: 'ptt', state: false });
    await sleep(150);
    check(rs._pttActive === true, 'different id: its release still cannot cut the holder off');
    send(other, { type: 'ptt', state: true });
    await sleep(150);
    check(other.got.some(m => m.type === 'ptt-refused') && ptts.filter(Boolean).length === 1, 'different id: cannot take PTT');
    send(other, { type: 'estop' });
    await sleep(150);
    check(rs._pttActive === false, 'estop still stops anyone (unchanged)');
    holder.ws.close(); other.ws.close(); await sleep(250);
  }

  // no id (an older client): today's behaviour
  {
    reset();
    const holder = await openClient(PORT, { token: TOKEN });
    send(holder, { type: 'ptt', state: true });
    await sleep(200);
    const again = await openClient(PORT, { token: TOKEN });
    await sleep(250);
    check(rs._pttActive === true && holder.closed === false, 'no id on either side: PTT kept until the heartbeat (as before)');
    send(again, { type: 'ptt', state: false });
    await sleep(150);
    check(rs._pttActive === true, 'no id: the new socket\'s release is ignored as before');
    holder.ws.close(); await sleep(250);
    check(rs._pttActive === false, 'the holder leaving still releases');
    again.ws.close(); await sleep(250);
  }
  {
    reset();
    const holder = await openClient(PORT, { id: ID_A, token: TOKEN });
    send(holder, { type: 'ptt', state: true });
    await sleep(200);
    const older = await openClient(PORT, { token: TOKEN });
    await sleep(250);
    check(rs._pttActive === true && holder.closed === false, 'a newcomer with no id never releases a holder that has one');
    holder.ws.close(); older.ws.close(); await sleep(250);
  }

  // release only, never a key: same id while the old socket is NOT keyed
  {
    reset();
    const first = await openClient(PORT, { id: ID_A, token: TOKEN });
    const second = await openClient(PORT, { id: ID_A, token: TOKEN });
    await sleep(250);
    check(ptts.length === 0 && rs._pttActive === false, 'same id with nothing keyed: no PTT event at all');
    check(first.closed === false, 'same id with nothing keyed: the old socket is left to the heartbeat');
    first.ws.close(); second.ws.close(); await sleep(250);
  }
  rs.stop();
  await sleep(300);

  // A LAN shack with no token admits at connect, before the hello is read.
  console.log('\nmulti-device on, LAN with no token (hello read after admission)');
  {
    const lan = await shack(PORT + 1, { requireToken: false });
    const stale = await openClient(PORT + 1, { id: ID_A });
    send(stale, { type: 'ptt', state: true });
    await sleep(200);
    const fresh = await openClient(PORT + 1, { id: ID_A });
    await sleep(250);
    check(lan.rs._pttActive === false && lan.ptts.join() === 'true,false' && stale.closed, 'same id: released and the stale socket closed');
    const other = await openClient(PORT + 1, { id: ID_B });
    send(fresh, { type: 'ptt', state: true });
    await sleep(150);
    const late = await openClient(PORT + 1, { id: ID_B });
    await sleep(250);
    check(lan.rs._pttActive === true && !fresh.closed, 'different id: no release');
    fresh.ws.close(); other.ws.close(); late.ws.close();
    await sleep(250);
    lan.rs.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
