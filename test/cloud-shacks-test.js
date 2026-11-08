#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// A Cloud address per shack (Casey 2026-11-08: "I want the phone app to be
// able to switch between rigs while a Cloud member"). The first shack keeps
// <call>.potacat.com; another gets <call>-<name>.potacat.com, up to 3 per
// membership. The real CloudTunnelManager and CloudSyncClient against a fake
// cloudlog with per-shack addresses, plus an OLD fake that ignores the new
// fields, plus wiring guards.
// Run: node test/cloud-shacks-test.js
const assert = require('assert');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const CloudSyncClient = require('../lib/cloud-sync');
const { CloudTunnelManager } = require('../lib/cloud-tunnel');
const CS = require('../lib/cloud-shacks');
const TC = require('../lib/tunnel-claim');

const queue = [];
function test(name, fn) { queue.push([name, fn]); }
let passed = 0, failed = 0;

// ── Fake cloudlog with a Cloud address per shack ──────────────────────
// perShack:false = a server from before this change (provision ignores the
// new fields, /shacks is a 404).
function fakeCloud({ perShack = true, limit = 3, call = 'k3sbp' } = {}) {
  const st = { tunnels: new Map(), calls: [], bodies: [], claims: new Map(), deletes: [], revokes: [], passBodies: [] };
  const prefix = call + '-', suffix = '.potacat.com';
  const shackList = () => [...st.tunnels.entries()].map(([deviceId, t]) => ({ deviceId, name: t.name, cloudHost: t.host, primary: t.primary, online: true, lastSeen: 't' }));
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const json = body ? JSON.parse(body) : {};
      st.calls.push(`${req.method} ${u.pathname}${u.search}`);
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const html404 = () => { res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<pre>Cannot ' + req.method + '</pre>'); };
      if (u.pathname === '/v1/cloud-tunnel/provision') {
        st.bodies.push(json);
        if (!perShack || !json.deviceId) return send(200, { tunnelToken: 'tok-main', cloudHost: call + suffix, tunnelId: 'tid-main' });
        const have = st.tunnels.get(json.deviceId);
        if (have) return send(200, { tunnelToken: 'tok-' + json.deviceId, cloudHost: have.host, tunnelId: 'tid-' + json.deviceId, perShack: true, primary: have.primary, existing: true });
        if (st.tunnels.size === 0) {
          st.tunnels.set(json.deviceId, { name: json.name, host: call + suffix, primary: true });
          return send(200, { tunnelToken: 'tok-' + json.deviceId, cloudHost: call + suffix, tunnelId: 'tid-' + json.deviceId, perShack: true, primary: true });
        }
        if (st.tunnels.size >= limit) return send(409, { error: 'shack_limit', limit, shacks: shackList() });
        if (!json.shackName) return send(409, { error: 'shack_name_required', prefix, suffix, limit, shacks: shackList() });
        if (!/^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/.test(json.shackName)) return send(400, { error: 'shack_name_invalid', message: 'Use letters and numbers only, up to 20 characters.' });
        const host = prefix + json.shackName + suffix;
        if (shackList().some((x) => x.cloudHost === host)) return send(409, { error: 'shack_name_taken', prefix, suffix, limit, shacks: shackList() });
        st.tunnels.set(json.deviceId, { name: json.name, host, primary: false });
        return send(200, { tunnelToken: 'tok-' + json.deviceId, cloudHost: host, tunnelId: 'tid-' + json.deviceId, perShack: true, primary: false });
      }
      if (u.pathname === '/v1/cloud-tunnel/status') {
        const t = st.tunnels.get(u.searchParams.get('deviceId'));
        return send(200, { healthy: true, cloudHost: t ? t.host : call + suffix });
      }
      if (u.pathname === '/v1/cloud-tunnel/claim' && req.method === 'POST') {
        // One legacy holder on the main address, the per-shack offer on the 409.
        // A shack with an address of its own claims ITS tunnel, never the main one.
        const own = st.tunnels.get(json.deviceId);
        if (own && !own.primary) return send(200, { ok: true, connectors: [] });
        const holder = st.claims.get('main');
        if (holder && holder.deviceId !== json.deviceId && !json.takeover) {
          return send(409, { error: 'tunnel_in_use', connectors: [holder], ...(perShack ? { ownAddress: { available: st.tunnels.size < limit, prefix, suffix, limit, used: st.tunnels.size } } : {}) });
        }
        return send(200, { ok: true, connectors: [] });
      }
      if (u.pathname === '/v1/cloud-tunnel/claim') return send(200, { superseded: null, connectors: [] });
      if (u.pathname === '/v1/cloud-tunnel/release') return send(200, { ok: true });
      if (u.pathname === '/v1/cloud-tunnel/revoke') { st.revokes.push(json); if (perShack && json.deviceId) st.tunnels.delete(json.deviceId); return send(200, { revoked: true }); }
      if (u.pathname === '/v1/cloud-tunnel/shacks' && req.method === 'GET') {
        if (!perShack) return html404();
        return send(200, { limit, shacks: shackList() });
      }
      if (u.pathname.startsWith('/v1/cloud-tunnel/shacks/') && req.method === 'DELETE') {
        if (!perShack) return html404();
        const id = decodeURIComponent(u.pathname.split('/').pop());
        st.deletes.push(id); st.tunnels.delete(id);
        return send(200, { removed: true });
      }
      send(404, { error: 'not_found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ st, server, base: `http://127.0.0.1:${server.address().port}` })));
}

function desktop(base, { id, name, shackName = '' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-shacks-'));
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
  const box = { shackName };
  const m = new CloudTunnelManager({
    userDataPath: dir, configPath: path.join(dir, 'cloud-tunnel.json'),
    getCloudSync: () => sync, getCloudflaredPath: () => 'cloudflared-fake', spawn: fakeSpawn,
    getDeviceInfo: () => ({ deviceId: id, name, rigModel: '' }), getShackName: () => box.shackName, claimPollMs: 100000,
  });
  m.stopHealthCheck = () => {}; m.startHealthCheck = () => {};
  return { m, box, spawned, running: () => spawned.some((c) => !c.killed) };
}

// ── Pure rules ────────────────────────────────────────────────────────

test('a shack name becomes a clean label; the preview is the server prefix + name + suffix', () => {
  assert.strictEqual(CS.sanitizeShackName('AZ Shack #2!!'), 'az-shack-2');
  assert.strictEqual(CS.sanitizeShackName('  --Field--  '), 'field');
  assert.strictEqual(CS.sanitizeShackName('Tórtola'), 'tortola', 'accents fold, never dropped into a hyphen');
  assert.strictEqual(CS.sanitizeShackName('!!!'), '');
  assert.strictEqual(CS.sanitizeShackName('a'.repeat(30)).length, CS.NAME_MAX);
  assert.ok(!/-$/.test(CS.sanitizeShackName('abcdefghijklmnopqrs-tuv')), 'cut at 20 never ends on a hyphen');
  assert.strictEqual(CS.shackHostPreview('k3sbp-', '.potacat.com', 'AZ'), 'k3sbp-az.potacat.com');
  assert.strictEqual(CS.shackHostPreview('', '.potacat.com', 'az'), '', 'never builds a host without the server prefix');
});

test('the cloud reply: an unbound legacy primary is listed and removable; a long label is caught', () => {
  const list = CS.cleanShacks([
    { deviceId: null, name: '', cloudHost: 'k3sbp.potacat.com', primary: true, shackName: null },
    { deviceId: 'dev-b', name: 'AZ', cloudHost: 'k3sbp-az.potacat.com', primary: false, shackName: 'az' },
    { deviceId: null, primary: false },
  ]);
  assert.strictEqual(list.length, 2, 'a row with no device that is not the primary is dropped');
  assert.strictEqual(list[0].deviceId, CS.UNBOUND_PRIMARY_ID);
  assert.strictEqual(list[0].deviceId, 'primary', 'DELETE /v1/cloud-tunnel/shacks/primary removes it');
  assert.strictEqual(list[0].unbound, true);
  assert.ok(/Main address/.test(list[0].name));
  assert.strictEqual(list[1].shackName, 'az');
  assert.strictEqual(CS.shackLabelTooLong('k3sbp-', 'az'), false);
  assert.strictEqual(CS.shackLabelTooLong('vp2ezz-', 'a'.repeat(20)), false, '27 characters fits');
  assert.strictEqual(CS.shackLabelTooLong('kh6abc/vp2ezz12-', 'a'.repeat(20)), true, 'over 32 is refused');
});

test('the server answers are told apart; anything else is an error', () => {
  const e = (code, body) => Object.assign(new Error('x'), { status: 409, code, body: { error: code, ...body } });
  assert.strictEqual(CS.interpretProvision(null, e('shack_name_required', { prefix: 'k-', suffix: '.p', limit: 3 })).state, 'name-required');
  assert.strictEqual(CS.interpretProvision(null, e('shack_name_taken', {})).state, 'name-taken');
  assert.strictEqual(CS.interpretProvision(null, e('shack_name_invalid', { message: 'm' })).message, 'm');
  const lim = CS.interpretProvision(null, e('shack_limit', { limit: 3, shacks: [{ deviceId: 'a', name: 'MAC', cloud_host: 'k.potacat.com' }] }));
  assert.strictEqual(lim.state, 'limit');
  assert.strictEqual(lim.shacks[0].cloudHost, 'k.potacat.com', 'snake_case rows are read too');
  assert.ok(/includes 3 shack addresses, and all 3 are in use: MAC \(k\.potacat\.com\)/.test(CS.provisionMessage(lim)));
  assert.strictEqual(CS.interpretProvision(null, new Error('boom')).state, 'error');
  assert.deepStrictEqual(CS.interpretProvision({ perShack: true, primary: false }, null), { state: 'ok', perShack: true, primary: false });
  assert.deepStrictEqual(CS.interpretProvision({ tunnelToken: 't' }, null), { state: 'ok', perShack: false, primary: true }, 'an old server');
});

test('the conflict question offers an own address only when the server does', () => {
  const who = [{ deviceId: 'mac', name: 'MAC' }];
  const plain = TC.conflictDialog(who, 0, 'k3sbp.potacat.com');
  assert.deepStrictEqual(plain.choices, ['takeover', 'keep', 'cancel']);
  const offer = TC.conflictDialog(who, 0, 'k3sbp.potacat.com', { available: true, prefix: 'k3sbp-', suffix: '.potacat.com', limit: 3, used: 1 });
  assert.deepStrictEqual(offer.choices, ['own', 'takeover', 'keep', 'cancel']);
  assert.strictEqual(offer.buttons[0], 'Give this shack its own address');
  assert.strictEqual(offer.defaultId, 0);
  assert.strictEqual(offer.cancelId, 3);
  assert.ok(offer.detail.includes('k3sbp-<name>.potacat.com'));
  const full = TC.conflictDialog(who, 0, 'k3sbp.potacat.com', { available: false, limit: 3, used: 3 });
  assert.deepStrictEqual(full.choices, ['takeover', 'keep', 'cancel'], 'a full membership is not offered as a button');
  assert.ok(/3 shack addresses are all in use/.test(full.detail));
  const r = TC.interpretClaim(null, { status: 409, body: { error: 'tunnel_in_use', connectors: who, ownAddress: { prefix: 'k-', suffix: '.p', limit: 3, used: 1 } } }, 'win');
  assert.strictEqual(r.ownAddress.available, true, 'the claim answer carries the offer');
});

// ── The manager against a per-shack server ───────────────────────────

test('the first shack keeps the main address; a second is asked for a name, then gets its own', async () => {
  const { st, server, base } = await fakeCloud();
  const a = desktop(base, { id: 'mac-0001', name: 'K3SBP-MAC' });
  const sa = await a.m.enable();
  assert.strictEqual(sa.cloudHost, 'k3sbp.potacat.com');
  assert.strictEqual(sa.ownAddress, null);
  assert.deepStrictEqual(st.bodies[0], { deviceId: 'mac-0001', name: 'K3SBP-MAC' }, 'deviceId + name ride on provision; no empty shackName');

  const b = desktop(base, { id: 'tx-0002', name: 'DESKTOP-TX' });
  const sb = await b.m.enable();
  assert.strictEqual(sb.enabled, false);
  assert.strictEqual(sb.status, 'off');
  assert.strictEqual(sb.ownAddress.state, 'name-required');
  assert.ok(/k3sbp-field\.potacat\.com/.test(sb.ownAddress.message), 'the card says what the address will look like');
  assert.ok(!b.running(), 'nothing runs on the other shack\'s address meanwhile');

  const sb2 = await b.m.enable({ shackName: 'TX Shack' });
  assert.strictEqual(st.bodies[2].shackName, 'tx-shack', 'the name is cleaned before it is sent');
  assert.strictEqual(sb2.cloudHost, 'k3sbp-tx-shack.potacat.com');
  assert.strictEqual(sb2.ownAddress, null);
  assert.strictEqual(sb2.perShack, true);
  assert.ok(b.running());

  await b.m._checkOnce();
  assert.ok(st.calls.includes('GET /v1/cloud-tunnel/status?deviceId=tx-0002'), 'the health check asks about THIS shack');
  assert.strictEqual(b.m.getState().cloudHost, 'k3sbp-tx-shack.potacat.com', 'and keeps its own address');
  a.m.shutdown(); b.m.shutdown(); server.close();
});

test('a saved name is used without asking; a taken name and a full membership are explained', async () => {
  const { server, base } = await fakeCloud({ limit: 2 });
  const a = desktop(base, { id: 'mac-0001', name: 'MAC' });
  await a.m.enable();
  const b = desktop(base, { id: 'tx-0002', name: 'TX', shackName: 'tx' });
  assert.strictEqual((await b.m.enable()).cloudHost, 'k3sbp-tx.potacat.com', 'getShackName supplies it');
  const c = desktop(base, { id: 'az-0003', name: 'AZ', shackName: 'tx' });
  const sc = await c.m.enable();
  assert.strictEqual(sc.ownAddress.state, 'limit', 'limit 2: both in use');
  assert.ok(/MAC \(k3sbp\.potacat\.com\) and TX \(k3sbp-tx\.potacat\.com\)/.test(sc.ownAddress.message));
  const list = await c.m.listShacks();
  assert.strictEqual(list.supported, true);
  assert.strictEqual(list.limit, 2);
  assert.deepStrictEqual(list.shacks.map((x) => x.self), [false, false]);
  await c.m.removeShack('tx-0002');
  assert.strictEqual(c.m.getState().ownAddress, null, 'a freed slot clears the limit notice');
  const sc2 = await c.m.enable({ shackName: 'tx' });
  assert.strictEqual(sc2.cloudHost, 'k3sbp-tx.potacat.com', 'the freed name is reusable');
  a.m.shutdown(); b.m.shutdown(); c.m.shutdown(); server.close();
});

test('the conflict answer "own" moves a shack off the shared address onto its own', async () => {
  const { st, server, base } = await fakeCloud();
  st.tunnels.set('mac-0001', { name: 'MAC', host: 'k3sbp.potacat.com', primary: true });
  st.claims.set('main', { deviceId: 'mac-0001', name: 'MAC', rigModel: 'FT-710', since: 't', lastSeen: 't' });
  // An older desktop's saved token for the main address; it claims at launch.
  const b = desktop(base, { id: 'tx-0002', name: 'TX', shackName: 'az' });
  const conflicts = [];
  b.m.on('conflict', (c) => conflicts.push(c));
  await b.m._startConnector('launch');
  assert.strictEqual(conflicts.length, 1);
  assert.strictEqual(conflicts[0].ownAddress.available, true);
  const s = await b.m.resolveConflict('own');
  assert.strictEqual(s.cloudHost, 'k3sbp-az.potacat.com');
  assert.ok(b.running());
  // Without a saved name: the card asks.
  const c = desktop(base, { id: 'fd-0003', name: 'FD' });
  c.m.on('conflict', () => {});
  await c.m._startConnector('launch');
  const sc = await c.m.resolveConflict('own');
  assert.strictEqual(sc.ownAddress.state, 'name-required');
  assert.strictEqual(sc.ownAddress.prefix, 'k3sbp-', 'the offer\'s prefix reaches the card for the preview');
  assert.ok(!c.running());
  b.m.shutdown(); c.m.shutdown(); server.close();
});

test('an older server: nothing changes (one address, no shack list)', async () => {
  const { st, server, base } = await fakeCloud({ perShack: false });
  const a = desktop(base, { id: 'mac-0001', name: 'MAC', shackName: 'home' });
  const s = await a.m.enable();
  assert.strictEqual(s.cloudHost, 'k3sbp.potacat.com');
  assert.strictEqual(s.perShack, false);
  assert.strictEqual(s.ownAddress, null);
  assert.strictEqual(st.bodies[0].shackName, 'home', 'sent, and ignored');
  const list = await a.m.listShacks();
  assert.strictEqual(list.supported, false, 'a 404 hides the shack list');
  a.m.shutdown(); server.close();
});

// ── Wiring ───────────────────────────────────────────────────────────

test('wiring: main, preload, Guest Pass, Cloud card', () => {
  const root = path.join(__dirname, '..');
  const main = readSrc(path.join(root, 'main.js'));
  assert.ok(/'cloudShackName',/.test(main), 'machine-scoped like cloudDeviceId');
  assert.ok(/getShackName: \(\) => settings\.cloudShackName \|\| ''/.test(main));
  assert.ok(/TunnelClaim\.conflictDialog\(c\.connectors, c\.unclaimed, cloudTunnel\.getState\(\)\.cloudHost, c\.ownAddress\)/.test(main));
  assert.ok(/const after = await cloudTunnel\.resolveConflict\([\s\S]{0,200}if \(after && after\.ownAddress\) focusMainWindowAndOpenCloudPanel\(\)/.test(main));
  assert.ok(/ipcMain\.handle\('cloud-tunnel-enable', async \(_e, opts\)[\s\S]{0,600}CloudShacks\.sanitizeShackName\(opts\.shackName\)[\s\S]{0,300}cloudTunnel\.enable\(typed \? \{ shackName: typed \} : \{\}\)/.test(main));
  assert.ok(/ipcMain\.handle\('cloud-tunnel-shacks'/.test(main));
  assert.ok(/ipcMain\.handle\('cloud-tunnel-remove-shack'[\s\S]{0,1500}buttons: \['Remove the address', 'Cancel'\][\s\S]{0,300}removeShack\(deviceId\)/.test(main));
  const pre = readSrc(path.join(root, 'preload.js'));
  assert.ok(/cloudTunnelEnable: \(opts\) => ipcRenderer\.invoke\('cloud-tunnel-enable', opts \|\| \{\}\)/.test(pre));
  assert.ok(/cloudTunnelShacks: \(\) => ipcRenderer\.invoke\('cloud-tunnel-shacks'\)/.test(pre));
  assert.ok(/cloudTunnelRemoveShack: \(deviceId\) => ipcRenderer\.invoke\('cloud-tunnel-remove-shack', deviceId\)/.test(pre));
  const ipc = readSrc(path.join(root, 'lib', 'cloud-ipc.js'));
  assert.ok(/'\/v1\/passes', dev \? \{ \.\.\.\(body \|\| \{\}\), shackDeviceId: dev \} : body\)/.test(ipc), 'a Guest Pass leads to the shack that issued it');
  const html = readSrc(path.join(root, 'renderer', 'index.html'));
  assert.ok(html.indexOf('<script src="../lib/cloud-shacks.js"></script>') !== -1);
  assert.ok(html.indexOf('../lib/cloud-shacks.js') < html.indexOf('<script src="cloud-ui.js"></script>'), 'loaded before the Cloud card');
  for (const id of ['cloud-tunnel-own', 'cloud-tunnel-shack-name', 'cloud-tunnel-own-btn', 'cloud-tunnel-own-preview', 'cloud-tunnel-shacks', 'cloud-tunnel-shacks-list']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  const ui = readSrc(path.join(root, 'renderer', 'cloud-ui.js'));
  assert.ok(/const CS = window\.CloudShacks/.test(ui));
  assert.ok(/window\.api\.cloudTunnelEnable\(\{ shackName: name \}\)/.test(ui));
  assert.ok(/renderOwnAddress\(state\)[\s\S]{0,80}refreshShackList\(!!state\.ownAddress\)/.test(ui));
  assert.ok(!/potacat\.com'\s*\+|\+\s*'\.potacat\.com/.test(ui), 'the card never builds a hostname itself');
});

(async () => {
  console.log('Cloud address per shack');
  for (const [name, fn] of queue) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
