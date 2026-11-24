#!/usr/bin/env node
'use strict';
// ECHOCAT's LAN trust is for LAN hosts, not for any web page a LAN browser
// happens to open (2026-11-22). Five rules, each pinned here:
//   1. A WebSocket upgrade whose Origin is present and not this server is
//      refused at the upgrade, before auth-mode / auth-ok. No Origin (the
//      ECHOCAT app, desktop-to-desktop over Node ws) and our own page still
//      auto-authenticate on the LAN.
//   2. /api/ptt sends no Access-Control-Allow-Origin, and refuses (403, no
//      keying) a foreign Origin or a Sec-Fetch-Site other than same-origin /
//      none. Native callers (Stream Deck HTTP, Apple Shortcuts) send neither
//      header and keep working; the token rule is unchanged.
//   3. A device's save-settings writes only allowlisted keys
//      (lib/device-settings.js); program paths, hosts, the access door,
//      tokens and credentials are refused and logged by name once.
//   4. A public source with the Cloud Tunnel off must present the token, and
//      is refused when no token is set. LAN, loopback and Tailscale
//      100.64/10 are not public.
//   5. ECHOCAT Web's Directory cards escape every sheet field.
// Real RemoteServer bound to 127.0.0.1, raw HTTPS and WebSocket clients.
// Nothing transmits: _handlePtt is replaced by a recorder.
// Run: node test/remote-origin-security-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const WebSocket = require('ws');
const { readSrc } = require('./_src');
const WebGate = require('../lib/echocat-web-gate');
const DeviceSettings = require('../lib/device-settings');
const DirectoryCards = require('../lib/directory-cards');
const { RemoteServer } = require('../lib/remote-server');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ok  ' + label); }
  else { failed++; console.log('  FAIL ' + label); }
}
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + ' - ' + String(e.message).split('\n')[0]); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ROOT = path.join(__dirname, '..');

// ── pure rules ─────────────────────────────────────────────────────
console.log('lib/echocat-web-gate.js: public direct sources and cross-site requests');
t('publicDirectMode: only a public source with the tunnel off', () => {
  const M = WebGate.publicDirectMode;
  assert.strictEqual(M({ fromTunnel: false, tunnelExposed: false, requireToken: false }), null, 'LAN stays local trust');
  assert.strictEqual(M({ fromTunnel: true, tunnelExposed: true, requireToken: false }), null, 'the tunnel path is decided by the tunnel gate');
  assert.strictEqual(M({ fromTunnel: true, tunnelExposed: false, requireToken: false }), 'refuse', 'no token set: refused');
  assert.strictEqual(M({ fromTunnel: true, tunnelExposed: false, requireToken: true, hasToken: false }), 'refuse', 'token required but none set: refused');
  assert.strictEqual(M({ fromTunnel: true, tunnelExposed: false, requireToken: true, hasToken: true }), 'token');
});
t('decideHttpGate and wsAuthModeFor agree on a public direct source', () => {
  const base = { fromTunnel: true, tunnelExposed: false, method: 'GET', pathname: '/' };
  assert.strictEqual(WebGate.decideHttpGate({ ...base, requireToken: false }).action, 'refuse-public');
  assert.strictEqual(WebGate.wsAuthModeFor({ ...base, requireToken: false }), 'refuse');
  const tok = WebGate.decideHttpGate({ ...base, requireToken: true, hasToken: true });
  assert.deepStrictEqual([tok.action, tok.authMode], ['serve', 'token']);
  assert.strictEqual(WebGate.wsAuthModeFor({ ...base, requireToken: true, hasToken: true }), 'token');
  assert.strictEqual(WebGate.decideHttpGate({ ...base, method: 'POST', pathname: '/api/pair', requireToken: false }).action, 'open', 'credential-protected open paths are unchanged');
});
t('crossSiteRefusal: native callers pass, other web pages do not', () => {
  const R = (h) => WebGate.crossSiteRefusal(Object.assign({ host: '192.168.1.50:7300' }, h), 'k3sbp.potacat.com');
  assert.strictEqual(R({}), null, 'no Origin, no Sec-Fetch-Site (Shortcuts, Stream Deck HTTP)');
  assert.strictEqual(R({ 'sec-fetch-site': 'none' }), null, 'typed or bookmarked URL');
  assert.strictEqual(R({ 'sec-fetch-site': 'same-origin', origin: 'https://192.168.1.50:7300' }), null, 'our own page');
  assert.strictEqual(R({ origin: 'https://evil.example' }), 'origin');
  assert.strictEqual(R({ origin: 'null' }), 'origin', 'an opaque origin is not ours');
  assert.strictEqual(R({ 'sec-fetch-site': 'cross-site' }), 'sec-fetch-site', 'an <img> from another site carries no Origin but does carry this');
  assert.strictEqual(R({ 'sec-fetch-site': 'same-site' }), 'sec-fetch-site');
});
t('originAllowed ignores a default port on the Host header (wss://host:443 from a native client)', () => {
  assert.strictEqual(WebGate.originAllowed('https://k3sbp.potacat.com', 'k3sbp.potacat.com:443', ''), true);
  assert.strictEqual(WebGate.originAllowed('https://192.168.1.50:7300', '192.168.1.50:7300', ''), true);
  assert.strictEqual(WebGate.originAllowed('http://k3sbp.potacat.com', 'k3sbp.potacat.com:443', ''), false, 'scheme-aware');
  assert.strictEqual(WebGate.originAllowed('https://192.168.1.50', '192.168.1.50:7300', ''), false, 'another port is another origin');
});

console.log('\nRemoteServer._isTunnelOrPublicRequest: what counts as public');
t('LAN, loopback, Tailscale and link-local are not public; a public IPv4 is', () => {
  const P = (ip) => RemoteServer._isTunnelOrPublicRequest({}, ip);
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.50', '::ffff:192.168.1.50',
    '100.64.0.1', '100.100.100.100', '100.127.255.254', '169.254.10.10', '::1', 'fd7a:115c:a1e0::1234']) {
    assert.strictEqual(P(ip), false, ip + ' must not be public');
  }
  for (const ip of ['8.8.8.8', '::ffff:8.8.8.8', '100.63.255.255', '100.128.0.1', '172.32.0.1']) {
    assert.strictEqual(P(ip), true, ip + ' is public');
  }
});

console.log('\nlib/device-settings.js: the keys a device may write');
const PHONE_KEYS = ['myCallsign', 'grid', 'licenseClass', 'hideOutOfBand', 'potaAgeLimit', 'respotDefault', 'logCommentTags',
  'enableDxe', 'enableDxeSources', 'watchlistGroups', 'jtcatUseDataMode', 'jttySerial', 'jttyMacroStyle', 'sstvCwId',
  'sstvPostProcess', 'kiwiSdrList', 'kiwiSdrLabel1', 'kiwiSdrLabel2', 'kiwiSdrLabel3', 'kiwiSdrHost1', 'kiwiSdrHost2', 'kiwiSdrHost3'];
const WEB_KEYS = ['enableDxe', 'enableDxeSources', 'pskMacros', 'jttyAudioFreq', 'jttyMacroStyle', 'jttySerial',
  'kiwiSdrLabel1', 'kiwiSdrLabel2', 'kiwiSdrLabel3', 'kiwiSdrHost1', 'kiwiSdrHost2', 'kiwiSdrHost3', 'sstvTemplates'];
t('every key the ECHOCAT app and ECHOCAT Web write is allowed', () => {
  for (const k of PHONE_KEYS.concat(WEB_KEYS)) assert.ok(DeviceSettings.isDeviceWritable(k), k);
});
t('every save-settings key in renderer/remote.js is on the list', () => {
  const web = readSrc(path.join(ROOT, 'renderer', 'remote.js'));
  const re = /type: 'save-settings', settings: \{([^}]*)\}/g;
  let m, seen = 0;
  while ((m = re.exec(web))) {
    for (const part of m[1].split(',')) {
      const key = part.split(':')[0].trim();
      if (key) { seen++; assert.ok(DeviceSettings.isDeviceWritable(key), 'remote.js writes ' + key); }
    }
  }
  assert.ok(seen >= 6, 'found the literal sends (' + seen + ')');
});
t('program paths, hosts, the access door, tokens and credentials are refused', () => {
  const S = require('../lib/settings-secrets');
  const refused = ['rigctldPath', 'winlinkPatPath', 'tqslPath', 'adifLogPath', 'kiwiSdrHost', 'winlinkVaraHost', 'winlinkVaraFmHost',
    'remoteAccess', 'enableRemote', 'remoteToken', 'remoteRequireToken', 'remotePort', 'remoteCwEnabled', 'echocatToken',
    'cloudAccessToken', 'cloudRefreshToken', 'cloudDeviceId', 'pairedDevices', 'connectionTargets', 'qrzPassword',
    '__proto__', 'constructor', 'somethingNew'].concat(S.SECRET_KEYS);
  for (const k of refused) assert.ok(!DeviceSettings.isDeviceWritable(k), k + ' must be refused');
});
t('no allowlisted key matches a refusal pattern', () => {
  for (const k of DeviceSettings.DEVICE_WRITABLE_KEYS) assert.strictEqual(DeviceSettings.refusalPattern(k), '', k);
});
t('filterDevicePatch keeps the allowed keys and names the rest', () => {
  const r = DeviceSettings.filterDevicePatch({ respotDefault: true, rigctldPath: 'C:\\x.exe', remoteAccess: 'off', grid: 'FN20' });
  assert.deepStrictEqual(r.patch, { respotDefault: true, grid: 'FN20' });
  assert.deepStrictEqual(r.refused, ['rigctldPath', 'remoteAccess']);
  assert.deepStrictEqual(DeviceSettings.filterDevicePatch(null), { patch: {}, refused: [] });
  assert.deepStrictEqual(DeviceSettings.filterDevicePatch(['x']), { patch: {}, refused: [] });
  const proto = DeviceSettings.filterDevicePatch(JSON.parse('{"__proto__": {"polluted": 1}, "grid": "FN20"}'));
  assert.deepStrictEqual(proto.patch, { grid: 'FN20' });
  assert.strictEqual({}.polluted, undefined);
});

console.log('\nlib/directory-cards.js: sheet fields render as text');
t('net card escapes name, mode, days, frequency text and status', () => {
  const x = '<img src=x onerror=alert(1)>';
  const html = DirectoryCards.netCardHtml({ name: x, mode: x, days: x }, { cd: { status: x, label: x }, band: x, freqText: x });
  assert.ok(!/<img/i.test(html), html);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(DirectoryCards.netCardHtml({ name: 'Net' }, { freqText: '7.200' }).includes('<span class="dir-card-name">Net</span>'));
});
t('SWL card escapes station, frequency, language and power', () => {
  const x = '"><script>alert(1)</script>';
  const html = DirectoryCards.swlCardHtml({ station: x, frequency: x, language: x, powerKw: x }, { band: x, cd: { status: 'live', label: 'LIVE' } });
  assert.ok(!/<script/i.test(html), html);
  assert.ok(html.includes('&quot;&gt;&lt;script&gt;'));
  assert.ok(DirectoryCards.swlCardHtml({ station: 'BBC', frequency: 9410 }, {}).includes('9410 kHz'));
});
t('ECHOCAT Web builds both cards with DirectoryCards, and the page inlines it', () => {
  const web = readSrc(path.join(ROOT, 'renderer', 'remote.js'));
  const html = readSrc(path.join(ROOT, 'renderer', 'remote.html'));
  const srv = readSrc(path.join(ROOT, 'lib', 'remote-server.js'));
  assert.ok(web.includes('window.DirectoryCards.netCardHtml(n,'), 'nets');
  assert.ok(web.includes('window.DirectoryCards.swlCardHtml(s,'), 'SWL');
  assert.ok(!web.includes("'<span class=\"dir-card-name\">' + (n.name"), 'no raw net name into innerHTML');
  assert.ok(!web.includes("'<span class=\"dir-card-name\">' + (s.station"), 'no raw station into innerHTML');
  assert.ok(html.includes('<!-- directory-cards-js -->'), 'remote.html marker');
  assert.ok(srv.includes("['directory-cards-js', 'directory-cards.js']"), 'remote-server inlines it');
});

// ── a real shack ───────────────────────────────────────────────────
function httpReq(port, p, headers) {
  return new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: headers || {}, rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('error', (e) => resolve({ status: -1, error: e.message, headers: {}, text: '' }));
    req.end();
  });
}

// Opens a socket and waits for auth-ok, a refused upgrade or a close.
function wsOpen(port, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const wsOpts = { rejectUnauthorized: false };
    if (o.origin) wsOpts.origin = o.origin;
    if (o.headers) wsOpts.headers = o.headers;
    const ws = new WebSocket(`wss://127.0.0.1:${port}`, wsOpts);
    const r = { ws, got: [], refusedStatus: 0, refusedBody: '', closed: false, closeReason: '' };
    let done = false;
    const finish = () => { if (!done) { done = true; setTimeout(() => resolve(r), 100); } };
    ws.on('unexpected-response', (_req, res) => {
      r.refusedStatus = res.statusCode;
      res.on('data', (c) => { r.refusedBody += c; });
      res.on('end', finish);
    });
    ws.on('message', (d) => {
      let m; try { m = JSON.parse(d); } catch { return; }
      r.got.push(m);
      if (m.type === 'auth-mode' && o.token) ws.send(JSON.stringify({ type: 'auth', token: o.token }));
      if (m.type === 'auth-ok' || m.type === 'auth-fail') finish();
      if (m.type === 'auth-mode' && m.mode !== 'none' && !o.token) finish();
    });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1, clientVersion: 'test', clientPlatform: 'test' })));
    ws.on('close', (_c, reason) => { r.closed = true; r.closeReason = String(reason || ''); finish(); });
    ws.on('error', () => finish());
    setTimeout(finish, 4000);
  });
}
const authed = (r) => r.got.some((m) => m.type === 'auth-ok');

async function shack(port, token, opts) {
  const rs = new RemoteServer();
  rs._serverVersion = 'test';
  const ptts = [];
  const logs = [];
  const saves = [];
  rs._handlePtt = (state) => { ptts.push(state); rs._pttActive = state; }; // never reaches a radio
  rs.on('log', (m) => logs.push(String(m)));
  rs.on('save-settings', (p) => saves.push(p));
  rs.on('error', () => {});
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-origin-sec-'));
  rs.start(port, token, Object.assign({ certDir, host: '127.0.0.1', mdns: false }, opts || {}));
  await sleep(700);
  return { rs, ptts, logs, saves, port: rs._port };
}

(async () => {
  const realClassify = RemoteServer._isTunnelOrPublicRequest;
  const origLog = console.log;
  try {
    console.log('\nLAN shack, fresh-install defaults (no token, tunnel off)');
    const A = await shack(17611, null, {});
    const P = A.port;

    // 1. WebSocket Origin
    {
      const hostile = await wsOpen(P, { origin: 'https://evil.example' });
      check(hostile.refusedStatus === 403 && !authed(hostile) && hostile.got.length === 0,
        'a hostile-Origin WebSocket is refused at the upgrade (403), before auth-mode or auth-ok');
      check(/origin/i.test(hostile.refusedBody), 'the refusal says why: ' + JSON.stringify(hostile.refusedBody));
      check(A.logs.some((l) => l.includes('WebSocket refused') && l.includes('evil.example')), 'one log line names the origin');
      const opaque = await wsOpen(P, { origin: 'null' });
      check(opaque.refusedStatus === 403 && !authed(opaque), 'Origin: null (sandboxed page) is refused');
      const lookalike = await wsOpen(P, { origin: `https://127.0.0.1.evil.example:${P}` });
      check(lookalike.refusedStatus === 403, 'a look-alike host is refused');
      const same = await wsOpen(P, { origin: `https://127.0.0.1:${P}` });
      check(authed(same), 'our own page (Origin = Host) still auto-authenticates on the LAN');
      same.ws.close();
      await sleep(150);
      const native = await wsOpen(P, {});
      check(authed(native), 'a client with no Origin (ECHOCAT app, Node ws desktop-to-desktop) still auto-authenticates');

      // 3. save-settings allowlist, over the authenticated native socket
      native.ws.send(JSON.stringify({ type: 'save-settings', settings: {
        rigctldPath: 'C:\\evil\\rigctld.exe', winlinkPatPath: '\\\\host\\share\\pat.exe', remoteAccess: 'off',
        remoteToken: 'abc', echocatToken: 'def', cloudAccessToken: 'ghi', respotDefault: true } }));
      await sleep(250);
      check(A.saves.length === 1 && JSON.stringify(A.saves[0]) === JSON.stringify({ respotDefault: true }),
        'save-settings: only the allowed key reaches main (' + JSON.stringify(A.saves) + ')');
      const refusedLines = A.logs.filter((l) => l.includes('save-settings from a device: refused'));
      check(refusedLines.length === 1 && ['rigctldPath', 'winlinkPatPath', 'remoteAccess', 'remoteToken', 'echocatToken', 'cloudAccessToken'].every((k) => refusedLines[0].includes(k)),
        'the refused keys are logged by name');
      check(refusedLines.length > 0 && !refusedLines[0].includes('evil') && !refusedLines[0].includes('abc'), 'the log carries names only, never values');
      native.ws.send(JSON.stringify({ type: 'save-settings', settings: { rigctldPath: 'x', remoteToken: 'y' } }));
      await sleep(250);
      check(A.saves.length === 1, 'a patch with nothing allowed emits nothing');
      check(A.logs.filter((l) => l.includes('save-settings from a device: refused')).length === 1, 'the same refused names are not logged again');
      native.ws.send(JSON.stringify({ type: 'save-settings', settings: { grid: 'FN20', kiwiSdrHost1: 'sdr.example:8073' } }));
      await sleep(250);
      check(A.saves.length === 2 && A.saves[1].grid === 'FN20' && A.saves[1].kiwiSdrHost1 === 'sdr.example:8073', 'allowed keys still save');
      native.ws.close();
      await sleep(150);
    }

    // 2. /api/ptt
    {
      const hostile = await httpReq(P, '/api/ptt/on', { origin: 'https://evil.example' });
      check(hostile.status === 403 && A.ptts.length === 0, '/api/ptt with a hostile Origin: 403, nothing keyed');
      const img = await httpReq(P, '/api/ptt/on', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' });
      check(img.status === 403 && A.ptts.length === 0, '/api/ptt with Sec-Fetch-Site cross-site (an <img> on another site): 403, nothing keyed');
      const sameSite = await httpReq(P, '/api/ptt/toggle', { 'sec-fetch-site': 'same-site' });
      check(sameSite.status === 403 && A.ptts.length === 0, '/api/ptt with Sec-Fetch-Site same-site: 403');
      check(!('access-control-allow-origin' in hostile.headers) && !('access-control-allow-origin' in img.headers), 'refusals carry no ACAO');
      const plain = await httpReq(P, '/api/ptt/on', {});
      check(plain.status === 200 && A.ptts.join() === 'true', '/api/ptt with no headers (Shortcuts, Stream Deck HTTP) still keys');
      check(!('access-control-allow-origin' in plain.headers), 'no Access-Control-Allow-Origin header on the reply');
      const typed = await httpReq(P, '/api/ptt/off', { 'sec-fetch-site': 'none' });
      check(typed.status === 200 && A.ptts.join() === 'true,false', 'a typed or bookmarked URL (Sec-Fetch-Site none) still works');
      const own = await httpReq(P, '/api/ptt/off', { origin: `https://127.0.0.1:${P}`, 'sec-fetch-site': 'same-origin' });
      check(own.status === 200, 'our own page still works');
      const bad = await httpReq(P, '/api/ptt/bogus', {});
      check(bad.status === 400 && !('access-control-allow-origin' in bad.headers), 'an unknown action is a 400 with no ACAO');
    }

    // 4. LAN and loopback sources are still local trust
    {
      const page = await httpReq(P, '/', {});
      check(page.status === 200 && page.text.includes('window.__authMode="none"'), 'a loopback/LAN browser still gets the page with auth mode none');
    }
    A.rs.stop();
    await sleep(200);

    console.log('\nA public source with the Cloud Tunnel off (simulated: the classifier says public)');
    RemoteServer._isTunnelOrPublicRequest = () => true;
    const B = await shack(17612, null, {});
    {
      const page = await httpReq(B.port, '/', {});
      check(page.status === 403 && /ECHOCAT token/.test(page.text), 'no token set: the page is refused with a clear message');
      const ptt = await httpReq(B.port, '/api/ptt/on', {});
      check(ptt.status === 403 && B.ptts.length === 0, 'no token set: /api/ptt is refused, nothing keyed');
      const ws = await wsOpen(B.port, {});
      check(ws.refusedStatus === 403 && !authed(ws) && /token/i.test(ws.refusedBody), 'no token set: the WebSocket is refused at the upgrade');
      check(B.logs.some((l) => l.includes('from the internet')), 'logged');
    }
    B.rs.stop();
    await sleep(200);

    const TOKEN = 'remote-origin-sec-token-0123456789';
    const C = await shack(17613, TOKEN, { requireToken: true });
    {
      const page = await httpReq(C.port, '/', {});
      check(page.status === 200 && page.text.includes('window.__authMode="token"'), 'token set: the page asks for the token');
      const ws = await wsOpen(C.port, {});
      check(!authed(ws) && ws.got.some((m) => m.type === 'auth-mode' && m.mode === 'token'), 'token set: the socket must authenticate (no auto-auth)');
      ws.ws.close();
      const wsTok = await wsOpen(C.port, { token: TOKEN });
      check(authed(wsTok), 'token set: the right token authenticates');
      wsTok.ws.close();
      const noTok = await httpReq(C.port, '/api/ptt/on', {});
      check(noTok.status === 401 && C.ptts.length === 0, 'token set: /api/ptt without it is 401');
      const withTok = await httpReq(C.port, '/api/ptt/on?token=' + TOKEN, {});
      check(withTok.status === 200 && C.ptts.join() === 'true', 'token set: /api/ptt with it works');
      await httpReq(C.port, '/api/ptt/off?token=' + TOKEN, {});
    }
    C.rs.stop();
    await sleep(200);

    console.log('\nGuest Pass guest through the Cloud Tunnel (a desktop guest: Node ws, no Origin, mode pass)');
    RemoteServer._isTunnelOrPublicRequest = realClassify; // the real rule: cf-ray marks the tunnel
    const E = await shack(17615, null, { tunnelExposed: true });
    {
      const END = new Date(Date.now() + 3600e3).toISOString();
      E.rs.setPassValidator(async (code) => ({
        code, privilege_class: 'general', max_power_w: 100, allowed_modes: [], expires_at: END,
        station_callsign: '', owner_callsign: 'N0CALL', status: 'active', guest_callsign: 'N1GST',
      }));
      E.rs.setPassAuthCallback(async () => {});
      const CF = { 'cf-ray': '8a-EWR', 'cf-connecting-ip': '203.0.113.7' };
      const g = await new Promise((resolve) => {
        const ws = new WebSocket(`wss://127.0.0.1:${E.port}`, { rejectUnauthorized: false, headers: CF });
        const r = { ws, got: [], refusedStatus: 0 };
        let done = false;
        const finish = () => { if (!done) { done = true; setTimeout(() => resolve(r), 150); } };
        ws.on('unexpected-response', (_q, res) => { r.refusedStatus = res.statusCode; finish(); });
        ws.on('message', (d) => {
          let m; try { m = JSON.parse(d); } catch { return; }
          r.got.push(m);
          if (m.type === 'auth-mode') ws.send(JSON.stringify({ type: 'auth', mode: 'pass', passCode: 'abcd1234', sessionId: 'c'.repeat(64) }));
          if (m.type === 'auth-ok' || m.type === 'auth-fail') finish();
        });
        ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1, clientVersion: 'test', clientPlatform: 'desktop' })));
        ws.on('error', finish);
        setTimeout(finish, 5000);
      });
      check(g.refusedStatus === 0 && g.got.some((m) => m.type === 'auth-mode' && m.mode === 'token'),
        'tunnel + no Origin: the upgrade is admitted and asks for a credential (not the public-source refusal)');
      const ok = g.got.find((m) => m.type === 'auth-ok');
      check(!!(ok && ok.passSession), 'mode pass authenticates the guest (auth-ok with passSession)');
      const before = E.saves.length;
      g.ws.send(JSON.stringify({ type: 'save-settings', settings: { respotDefault: true, rigctldPath: 'x' } }));
      await sleep(250);
      check(E.saves.length === before && g.got.some((m) => m.type === 'settings-update'),
        'a guest\'s save-settings is still refused whole, before the allowlist (unchanged)');
      g.ws.close();
      const evil = await wsOpen(E.port, { origin: 'https://evil.example', headers: CF });
      check(evil.refusedStatus === 403, 'tunnel + a foreign Origin is refused at the upgrade');
    }
    E.rs.stop();
    await sleep(200);

    console.log('\nLAN with a token required (unchanged)');
    RemoteServer._isTunnelOrPublicRequest = realClassify;
    const D = await shack(17614, TOKEN, { requireToken: true });
    {
      const ws = await wsOpen(D.port, {});
      check(!authed(ws) && ws.got.some((m) => m.type === 'auth-mode' && m.mode === 'token'), 'LAN + token: auth-mode token, as before');
      ws.ws.close();
      const hostile = await wsOpen(D.port, { origin: 'https://evil.example', token: TOKEN });
      check(hostile.refusedStatus === 403 && !authed(hostile), 'a hostile page is refused even when it holds the token');
    }
    D.rs.stop();
    await sleep(200);
  } catch (e) {
    failed++;
    origLog('  FAIL unexpected error: ' + (e && e.stack || e));
  } finally {
    RemoteServer._isTunnelOrPublicRequest = realClassify;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
