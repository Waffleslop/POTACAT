#!/usr/bin/env node
'use strict';
// One shack per POTACAT Cloud address (KQ5O, three shacks on kq5o.potacat.com,
// 2026-11-03). The real CloudTunnelManager and the real CloudSyncClient against
// a fake cloudlog over HTTP, with a fake cloudflared, so the 409 / 404 / body
// shapes are the ones the desktop really sees.
// Run: node test/cloud-tunnel-claim-test.js
const assert = require('assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const CloudSyncClient = require('../lib/cloud-sync');
const { CloudTunnelManager } = require('../lib/cloud-tunnel');
const TC = require('../lib/tunnel-claim');

const queue = [];
function test(name, fn) { queue.push([name, fn]); }
let passed = 0, failed = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Fake cloudlog ─────────────────────────────────────────────────────
// Claims per device; `routes: false` = an old server with no claim routes.
function fakeCloud({ routes = true } = {}) {
  const st = { claims: new Map(), revokes: [], releases: [], calls: [], routes, revoked: false };
  const active = (exceptId) => [...st.claims.values()].filter((c) => !c.released && !c.superseded && c.deviceId !== exceptId)
    .map(({ deviceId, name, rigModel }) => ({ deviceId, name, rigModel, since: 't', lastSeen: 't' }));
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const json = body ? JSON.parse(body) : {};
      st.calls.push(`${req.method} ${u.pathname}`);
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.pathname === '/v1/cloud-tunnel/provision') return send(200, { tunnelToken: 'tok', cloudHost: 'kq5o.potacat.com', tunnelId: 'tid' });
      if (u.pathname === '/v1/cloud-tunnel/status') return send(200, { healthy: true, cloudHost: 'kq5o.potacat.com' });
      if (u.pathname.startsWith('/v1/cloud-tunnel/claim') || u.pathname === '/v1/cloud-tunnel/release') {
        if (!st.routes) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<pre>Cannot ' + req.method + '</pre>'); }
      }
      if (u.pathname === '/v1/cloud-tunnel/claim' && req.method === 'POST') {
        const others = active(json.deviceId);
        if (others.length && !json.takeover) return send(409, { error: 'tunnel_in_use', connectors: others });
        if (json.takeover) for (const c of st.claims.values()) if (c.deviceId !== json.deviceId && !c.released) c.superseded = { byDeviceId: json.deviceId, byName: json.name, at: 't' };
        st.claims.set(json.deviceId, { deviceId: json.deviceId, name: json.name, rigModel: json.rigModel });
        return send(200, { ok: true, connectors: [] });
      }
      if (u.pathname === '/v1/cloud-tunnel/claim' && req.method === 'GET') {
        const id = u.searchParams.get('deviceId');
        const mine = st.claims.get(id);
        return send(200, { superseded: (mine && mine.superseded) || null, connectors: active(id) });
      }
      if (u.pathname === '/v1/cloud-tunnel/release') {
        st.releases.push(json.deviceId);
        const c = st.claims.get(json.deviceId); if (c) c.released = true;
        return send(200, { ok: true });
      }
      if (u.pathname === '/v1/cloud-tunnel/revoke') {
        if (st.routes && !json.force) {
          const others = active(json.deviceId);
          if (others.length) return send(409, { error: 'tunnel_in_use', connectors: others });
        }
        st.revokes.push(json); st.revoked = true;
        return send(200, { revoked: true });
      }
      send(404, { error: 'not_found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ st, server, base: `http://127.0.0.1:${server.address().port}` })));
}

// A desktop: the real manager, the real sync client, a fake cloudflared.
function desktop(base, { id, name, rig }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-claim-'));
  const sync = new CloudSyncClient({ apiBase: base, accessToken: 'jwt' });
  const spawned = [];
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter(); child.stdout = new EventEmitter();
    child.exitCode = null; child.signalCode = null;
    child.kill = () => { child.killed = true; };
    spawned.push(child);
    return child;
  };
  const m = new CloudTunnelManager({
    userDataPath: dir, configPath: path.join(dir, 'cloud-tunnel.json'),
    getCloudSync: () => sync, getCloudflaredPath: () => 'cloudflared-fake', spawn: fakeSpawn,
    getDeviceInfo: () => ({ deviceId: id, name, rigModel: rig }), claimPollMs: 40,
  });
  m.stopHealthCheck = () => {}; m.startHealthCheck = () => {}; // the 5-min tick is not under test
  const events = [];
  for (const e of ['conflict', 'superseded', 'others']) m.on(e, (x) => events.push([e, x]));
  return { m, spawned, events, running: () => spawned.some((c) => !c.killed) };
}

test('pure: a 409 names the other shack; a 404 is an old server; a 409 naming nobody starts', () => {
  const r = TC.interpretClaim(null, { status: 409, body: { error: 'tunnel_in_use', connectors: [{ deviceId: 'mac', name: 'KQ5O-MAC', rigModel: 'FT-710' }] } }, 'win');
  assert.strictEqual(r.state, 'in-use');
  assert.strictEqual(TC.describeOthers(r.connectors, r.unclaimed), 'KQ5O-MAC (FT-710)');
  assert.strictEqual(TC.interpretClaim(null, Object.assign(new Error('HTTP 404: <pre>'), {}), 'win').state, 'unsupported');
  assert.strictEqual(TC.interpretClaim(null, { status: 409, body: { connectors: [{ deviceId: 'win' }] } }, 'win').state, 'ok', 'only ourselves');
  assert.strictEqual(TC.interpretClaim(null, new Error('ECONNREFUSED'), 'win').state, 'error');
  assert.ok(/older version/.test(TC.describeOthers([], 1)));
  assert.strictEqual(TC.sharedNotice([{ deviceId: 'a', name: 'DELL', rigModel: 'FTDX101D' }], 0), 'Another shack (DELL (FTDX101D)) is also on your Cloud address; your phone may reach either.');
  const d = TC.conflictDialog([{ deviceId: 'a', name: 'KQ5O-MAC', rigModel: 'FT-710' }], 0, 'kq5o.potacat.com');
  assert.deepStrictEqual(d.buttons, ['Use this shack instead', 'Keep the other shack', 'Cancel']);
  assert.deepStrictEqual(d.choices, ['takeover', 'keep', 'cancel']);
});

test('alone on the address: enable claims and runs', async () => {
  const { st, server, base } = await fakeCloud();
  const a = desktop(base, { id: 'mac', name: 'KQ5O-MAC', rig: 'FT-710' });
  await a.m.enable();
  assert.ok(a.running(), 'cloudflared started');
  assert.ok(st.calls.includes('POST /v1/cloud-tunnel/claim'));
  assert.strictEqual(a.m.getState().status, 'connecting');
  a.m.shutdown(); server.close();
});

test('a second shack is never started silently: it holds and asks, naming the first', async () => {
  const { server, base } = await fakeCloud();
  const a = desktop(base, { id: 'mac', name: 'KQ5O-MAC', rig: 'FT-710' });
  const b = desktop(base, { id: 'win', name: 'SHACK-PC', rig: 'FT-991A' });
  await a.m.enable();
  const s = await b.m.enable();
  assert.ok(!b.running(), 'the second shack did not start');
  assert.strictEqual(s.status, 'held');
  assert.strictEqual(b.events[0][0], 'conflict');
  assert.strictEqual(TC.describeOthers(s.conflict.connectors, s.conflict.unclaimed), 'KQ5O-MAC (FT-710)');
  a.m.shutdown(); b.m.shutdown(); server.close();
});

test('"Use this shack instead": the new one runs, the old one is told and stops WITHOUT revoking', async () => {
  const { st, server, base } = await fakeCloud();
  const a = desktop(base, { id: 'mac', name: 'KQ5O-MAC', rig: 'FT-710' });
  const b = desktop(base, { id: 'win', name: 'SHACK-PC', rig: 'FT-991A' });
  await a.m.enable();
  await b.m.enable();
  await b.m.resolveConflict('takeover');
  assert.ok(b.running(), 'the new shack runs');
  await wait(150); // a's claim poll runs every 40 ms here
  assert.ok(!a.running(), 'the old shack stopped its connector');
  assert.strictEqual(a.m.getState().enabled, false);
  assert.strictEqual(a.m.getState().superseded.by.name, 'SHACK-PC');
  assert.ok(a.events.some(([e]) => e === 'superseded'));
  assert.strictEqual(st.revokes.length, 0, 'nobody revoked the address');
  assert.ok(/SHACK-PC took over your Cloud address/.test(TC.supersededNotice(a.m.getState().superseded.by)));
  a.m.shutdown(); b.m.shutdown(); server.close();
});

test('"Keep the other shack": this one goes off locally, no revoke; Cancel stays held', async () => {
  const { st, server, base } = await fakeCloud();
  const a = desktop(base, { id: 'mac', name: 'KQ5O-MAC', rig: 'FT-710' });
  const b = desktop(base, { id: 'win', name: 'SHACK-PC', rig: 'FT-991A' });
  const c = desktop(base, { id: 'dell', name: 'DELL', rig: 'FTDX101D' });
  await a.m.enable();
  await b.m.enable();
  const kept = await b.m.resolveConflict('keep');
  assert.strictEqual(kept.enabled, false);
  assert.strictEqual(kept.status, 'off');
  assert.ok(!b.running());
  await c.m.enable();
  const held = await c.m.resolveConflict('cancel');
  assert.strictEqual(held.status, 'held');
  assert.ok(!c.running());
  assert.strictEqual(st.revokes.length, 0);
  assert.ok(a.running(), 'the first shack never noticed');
  a.m.shutdown(); b.m.shutdown(); c.m.shutdown(); server.close();
});

test('while running: another shack appearing raises the "also on your address" notice, once', async () => {
  const { st, server, base } = await fakeCloud();
  const a = desktop(base, { id: 'mac', name: 'KQ5O-MAC', rig: 'FT-710' });
  await a.m.enable();
  // An older-behaving desktop that claimed without asking (or a race).
  st.claims.set('dell', { deviceId: 'dell', name: 'DELL', rigModel: 'FTDX101D' });
  await wait(150);
  const others = a.events.filter(([e]) => e === 'others');
  assert.strictEqual(others.length, 1, 'said once, not every poll');
  assert.strictEqual(TC.sharedNotice(others[0][1].connectors, others[0][1].unclaimed), 'Another shack (DELL (FTDX101D)) is also on your Cloud address; your phone may reach either.');
  assert.ok(a.running(), 'a notice, not a stop');
  a.m.shutdown(); server.close();
});

test('an old server (no claim routes) starts exactly as before, and Off revokes as before', async () => {
  const { st, server, base } = await fakeCloud({ routes: false });
  const a = desktop(base, { id: 'mac', name: 'KQ5O-MAC', rig: 'FT-710' });
  await a.m.enable();
  assert.ok(a.running(), 'started without the check');
  await a.m.disable();
  assert.strictEqual(st.revokes.length, 1, 'revoked as before');
  a.m.shutdown(); server.close();
});

test('the launch auto-start claims too, and holds for another shack', async () => {
  const { server, base } = await fakeCloud();
  const a = desktop(base, { id: 'mac', name: 'KQ5O-MAC', rig: 'FT-710' });
  await a.m.enable();
  const b = desktop(base, { id: 'win', name: 'SHACK-PC', rig: 'FT-991A' });
  fs.writeFileSync(b.m._configPath, JSON.stringify({ enabled: true, cloudHost: 'kq5o.potacat.com', tunnelId: 'tid', tunnelToken: 'tok', tokenEncrypted: false }));
  b.m.loadFromDisk();
  await wait(80);
  assert.ok(!b.running(), 'launch did not start a second connector');
  assert.strictEqual(b.m.getState().status, 'held');
  assert.ok(b.events.some(([e]) => e === 'conflict'));
  a.m.shutdown(); b.m.shutdown(); server.close();
});

test('Off with another shack on the address: released, not revoked, and the address stays for it', async () => {
  const { st, server, base } = await fakeCloud();
  const a = desktop(base, { id: 'mac', name: 'KQ5O-MAC', rig: 'FT-710' });
  const b = desktop(base, { id: 'win', name: 'SHACK-PC', rig: 'FT-991A' });
  await a.m.enable();
  await b.m.enable();
  await b.m.resolveConflict('takeover');
  await wait(150); // a stops (superseded)
  // Now the laptop that is NOT on the address any more turns its tunnel off... and the
  // live shack keeps the address. Re-enable a as the "other shack" to test b's Off:
  st.claims.get('mac').superseded = null; st.claims.get('mac').released = false;
  const s = await b.m.disable();
  assert.strictEqual(st.revoked, false, 'the address was not removed');
  assert.ok(st.releases.includes('win'), 'our claim was released');
  assert.strictEqual(s.keptFor, 'KQ5O-MAC (FT-710)');
  assert.strictEqual(s.enabled, false);
  a.m.shutdown(); b.m.shutdown(); server.close();
});

test('Off as the last shack removes the address, and "Remove my Cloud address" forces it', async () => {
  const { st, server, base } = await fakeCloud();
  const a = desktop(base, { id: 'mac', name: 'KQ5O-MAC', rig: 'FT-710' });
  await a.m.enable();
  await a.m.disable();
  assert.strictEqual(st.revokes.length, 1, 'last shack off = address removed');
  assert.deepStrictEqual(st.revokes[0], { deviceId: 'mac' }, 'our own id rides along so our claim never counts');
  // Force: with another shack on it.
  const c = desktop(base, { id: 'dell', name: 'DELL', rig: 'FTDX101D' });
  await c.m.enable();
  st.claims.set('mac', { deviceId: 'mac', name: 'KQ5O-MAC', rigModel: 'FT-710' });
  const o = await c.m.otherShacks();
  assert.strictEqual(TC.describeOthers(o.connectors, o.unclaimed), 'KQ5O-MAC (FT-710)', 'the confirmation can name who loses it');
  await c.m.removeAddress();
  assert.deepStrictEqual(st.revokes[1], { deviceId: 'dell', force: true });
  a.m.shutdown(); c.m.shutdown(); server.close();
});

test('wiring: main asks with three buttons, notices reach the window and ECHOCAT, Remove is confirmed', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(/cloudTunnel\.on\('conflict', \(c\) => \{ cloudTunnelAskConflict\(c\)/.test(main));
  assert.ok(/dialog\.showMessageBox\(win, \{ type: 'question', title: d\.title[\s\S]{0,300}resolveConflict\(d\.choices\[r\.response\] \|\| 'cancel'\)/.test(main));
  assert.ok(/remoteServer\.sendToClient\(\{ type: 'cloud-shack-notice', kind, text \}\)/.test(main));
  assert.ok(/ipcMain\.handle\('cloud-tunnel-remove-address'[\s\S]{0,1500}buttons: \['Remove the address', 'Cancel'\][\s\S]{0,300}removeAddress\(\)/.test(main));
  const P = fs.readFileSync(path.join(__dirname, '..', 'lib', 'echocat-protocol.js'), 'utf8');
  assert.ok(/'cloud-shack-notice': \{ dir: Dir\.S2C, feature: 'cloud'/.test(P));
  const web = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote.js'), 'utf8');
  assert.ok(/case 'cloud-shack-notice':\s*\/\/[^\n]*\n\s*showToast\(msg\.text/.test(web));
});

(async () => {
  console.log('Cloud address: one shack at a time');
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
