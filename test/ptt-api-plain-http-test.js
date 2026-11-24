#!/usr/bin/env node
'use strict';
// /api/ptt over the plain-HTTP fallback (2026-11-23).
//
// ECHOCAT serves plain HTTP only when it could not make its TLS certificate
// at start and the Cloud Tunnel is off. Browsers send Sec-Fetch-* only to
// https URLs, and an <img> GET carries no Origin, so on that fallback the
// cross-site refusal (#970) cannot tell a web page from Stream Deck. The rule:
//   1. On plain HTTP, a call that would key the radio (on, or toggle while
//      receiving) is refused (403, the reason in plain words) unless the
//      ECHOCAT password is on and the right ?token= is given.
//   2. Releasing is never refused by this rule: off, and toggle while
//      transmitting, still unkey. Unkeying is the safe direction.
//   3. HTTPS is unchanged.
//   4. A hostile Origin is still refused on both (#970).
//   5. Each successful call stamps pttApiLastUsed + the route in a local
//      file, at most once a minute; never in settings, never synced, never
//      device-writable.
// Real RemoteServer bound to 127.0.0.1; nothing transmits (_handlePtt is a
// recorder). Run: node test/ptt-api-plain-http-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const { readSrc } = require('./_src');
const PttApiGate = require('../lib/ptt-api-gate');
const PttApiUsage = require('../lib/ptt-api-usage');
const DeviceSettings = require('../lib/device-settings');
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptt-api-plain-http-'));

// ── the pure decision ───────────────────────────────────────────────
console.log('lib/ptt-api-gate.js: decidePttApi');
const D = PttApiGate.decidePttApi;
const HTTPS = { https: true, requireToken: false, tokenSet: false, tokenOk: false, pttActive: false };
const PLAIN = { ...HTTPS, https: false };
const PLAIN_PW = { ...PLAIN, requireToken: true, tokenSet: true };

t('HTTPS, no password: on / off / toggle behave as before', () => {
  assert.deepStrictEqual(D({ ...HTTPS, action: 'on' }), { status: 200, ptt: true });
  assert.deepStrictEqual(D({ ...HTTPS, action: 'off' }), { status: 200, ptt: false });
  assert.deepStrictEqual(D({ ...HTTPS, action: 'toggle' }), { status: 200, ptt: true });
  assert.deepStrictEqual(D({ ...HTTPS, action: 'toggle', pttActive: true }), { status: 200, ptt: false });
  assert.strictEqual(D({ ...HTTPS, action: 'bogus' }).status, 400);
});
t('HTTPS with the password on: wrong or missing token is 401, the right one works (as before)', () => {
  const pw = { ...HTTPS, requireToken: true, tokenSet: true };
  assert.strictEqual(D({ ...pw, action: 'on' }).status, 401);
  assert.strictEqual(D({ ...pw, action: 'off' }).status, 401);
  assert.deepStrictEqual(D({ ...pw, action: 'on', tokenOk: true }), { status: 200, ptt: true });
});
t('plain HTTP, no password: on and toggle-from-receive are refused with the reason', () => {
  for (const d of [D({ ...PLAIN, action: 'on' }), D({ ...PLAIN, action: 'toggle' })]) {
    assert.strictEqual(d.status, 403);
    assert.strictEqual(d.ptt, undefined, 'nothing keys');
    assert.ok(/plain HTTP/.test(d.error) && /secure/.test(d.error) && /Restart POTACAT/.test(d.error) && /token=/.test(d.error), d.error);
  }
});
t('plain HTTP, password on but not given or wrong: never keys', () => {
  assert.strictEqual(D({ ...PLAIN_PW, action: 'on' }).status, 401);
  assert.strictEqual(D({ ...PLAIN_PW, action: 'toggle' }).status, 401);
});
t('plain HTTP, a token set but the password switch off: still refused (the switch is the credential)', () => {
  assert.strictEqual(D({ ...PLAIN, tokenSet: true, tokenOk: true, action: 'on' }).status, 403);
});
t('plain HTTP, password on and the right token: on and toggle key', () => {
  assert.deepStrictEqual(D({ ...PLAIN_PW, tokenOk: true, action: 'on' }), { status: 200, ptt: true });
  assert.deepStrictEqual(D({ ...PLAIN_PW, tokenOk: true, action: 'toggle' }), { status: 200, ptt: true });
});
t('plain HTTP: off, and toggle while transmitting, always release (no password needed)', () => {
  assert.deepStrictEqual(D({ ...PLAIN, action: 'off' }), { status: 200, ptt: false });
  assert.deepStrictEqual(D({ ...PLAIN, action: 'off', pttActive: true }), { status: 200, ptt: false });
  assert.deepStrictEqual(D({ ...PLAIN, action: 'toggle', pttActive: true }), { status: 200, ptt: false });
});
t('plain HTTP with the password on: off still needs the token, exactly as on HTTPS', () => {
  assert.strictEqual(D({ ...PLAIN_PW, action: 'off', pttActive: true }).status, 401);
  assert.deepStrictEqual(D({ ...PLAIN_PW, tokenOk: true, action: 'off', pttActive: true }), { status: 200, ptt: false });
});
t('every refusal carries no ptt state, and has no emoji', () => {
  const all = [D({ ...PLAIN, action: 'on' }), D({ ...PLAIN_PW, action: 'on' }), D({ ...PLAIN, action: 'x' })];
  for (const d of all) {
    assert.ok(d.status !== 200 && d.ptt === undefined && typeof d.error === 'string');
    assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(d.error));
  }
});

// ── the usage stamp ─────────────────────────────────────────────────
console.log('\nlib/ptt-api-usage.js: local, throttled stamp');
t('the first call writes pttApiLastUsed (ISO) and the route', () => {
  const file = path.join(tmp, 'u1.json');
  let now = Date.parse('2026-11-23T12:00:00.000Z');
  const u = PttApiUsage.createPttApiUsage({ filePath: file, now: () => now });
  assert.strictEqual(u.read(), null, 'nothing yet');
  assert.strictEqual(u.record('https'), true);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(j, { pttApiLastUsed: '2026-11-23T12:00:00.000Z', pttApiLastRoute: 'https' });
  assert.deepStrictEqual(u.read(), j);
});
t('throttled: at most one write a minute', () => {
  const file = path.join(tmp, 'u2.json');
  let now = Date.parse('2026-11-23T12:00:00.000Z');
  let writes = 0;
  const realWrite = fs.writeFileSync;
  const u = PttApiUsage.createPttApiUsage({ filePath: file, now: () => now,
    fs: { ...fs, writeFileSync: (...a) => { writes++; return realWrite(...a); } } });
  u.record('https');
  now += 10e3; assert.strictEqual(u.record('http'), false);
  now += 40e3; assert.strictEqual(u.record('http'), false);
  assert.strictEqual(writes, 1, 'one write in the first minute');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).pttApiLastRoute, 'https');
  now += 10e3; assert.strictEqual(u.record('http'), true, 'a minute later it writes again');
  assert.strictEqual(writes, 2);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { pttApiLastUsed: '2026-11-23T12:01:00.000Z', pttApiLastRoute: 'http' });
});
t('an unwritable path never throws (the radio is never in its way)', () => {
  const bad = path.join(tmp, 'file-not-dir');
  fs.writeFileSync(bad, 'x');
  const u = PttApiUsage.createPttApiUsage({ filePath: path.join(bad, 'u.json') });
  assert.doesNotThrow(() => u.record('http'));
});
t('only https or http is recorded as the route', () => {
  const u = PttApiUsage.createPttApiUsage({ filePath: path.join(tmp, 'u3.json') });
  u.record('javascript:alert(1)');
  assert.strictEqual(u.read().pttApiLastRoute, 'http');
});
t('not device-writable: the stamp keys are off the save-settings allowlist', () => {
  for (const k of ['pttApiLastUsed', 'pttApiLastRoute']) {
    assert.strictEqual(DeviceSettings.isDeviceWritable(k), false, k);
    assert.deepStrictEqual(DeviceSettings.filterDevicePatch({ [k]: 'x' }).patch, {}, k);
  }
});
t('not in settings, so never in settings-update to a device, an export, or Cloud', () => {
  const main = readSrc(path.join(ROOT, 'main.js'));
  assert.ok(!/settings\.pttApi/.test(main), 'main.js never puts the stamp into settings');
  assert.ok(/ptt-api-usage\.json/.test(main), 'main.js keeps it in its own file in userData');
  for (const f of fs.readdirSync(path.join(ROOT, 'lib')).filter((n) => /^cloud-|^sync-/.test(n) && n.endsWith('.js'))) {
    assert.ok(!/pttApi|ptt-api-usage/.test(readSrc(path.join(ROOT, 'lib', f))), f + ' does not read the stamp');
  }
});
t('main.js records the stamp from the server event inside onRemoteServer', () => {
  const main = readSrc(path.join(ROOT, 'main.js'));
  assert.ok(/onRemoteServer\(\(rs\) => \{\s*rs\.on\('ptt-api-used'/.test(main), 'wired through onRemoteServer');
});

// ── a real shack ───────────────────────────────────────────────────
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function req(secure, port, p, headers) {
  const mod = secure ? https : http;
  return new Promise((resolve) => {
    const r = mod.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: headers || {}, rejectUnauthorized: false }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    r.on('error', (e) => resolve({ status: -1, error: e.message, headers: {}, text: '' }));
    r.end();
  });
}
const badCertDir = path.join(tmp, 'cert-not-a-dir');
fs.writeFileSync(badCertDir, 'x');

async function shack(token, opts, plain) {
  const port = await freePort();
  const rs = new RemoteServer();
  rs._serverVersion = 'test';
  const ptts = [];
  const used = [];
  const logs = [];
  rs._handlePtt = (state) => { ptts.push(state); rs._pttActive = state; }; // never reaches a radio
  rs.on('ptt-api-used', (e) => used.push(e));
  rs.on('log', (m) => logs.push(String(m)));
  rs.on('error', () => {});
  const certDir = plain ? badCertDir : fs.mkdtempSync(path.join(tmp, 'cert-'));
  rs.start(port, token, Object.assign({ certDir, host: '127.0.0.1', mdns: false }, opts || {}));
  for (let i = 0; i < 50 && !rs.running; i++) await sleep(50);
  return { rs, ptts, used, logs, port };
}

(async () => {
  try {
    console.log('\nPlain-HTTP fallback, fresh-install defaults (no password)');
    const A = await shack(null, {}, true);
    check(A.rs.running && A.rs._https === false, 'the server is in its plain-HTTP fallback');
    {
      const on = await req(false, A.port, '/api/ptt/on');
      check(on.status === 403 && A.ptts.length === 0, 'on without a password: 403, nothing keyed');
      check(/plain HTTP/.test(on.text) && /Restart POTACAT/.test(on.text), 'the reply says why: ' + on.text);
      const tog = await req(false, A.port, '/api/ptt/toggle');
      check(tog.status === 403 && A.ptts.length === 0, 'toggle from receive: 403, nothing keyed');
      const img = await req(false, A.port, '/api/ptt/on', { accept: 'image/avif,image/webp,*/*' });
      check(img.status === 403 && A.ptts.length === 0, 'an <img> GET (no Origin, no Sec-Fetch-*) keys nothing');
      check(A.logs.some((l) => /plain HTTP/.test(l) && /PTT/.test(l)), 'the refusal is logged');
      check(A.used.length === 0, 'a refusal is not stamped as use');
      // Keyed by another path (the ECHOCAT page, a phone): every release still works.
      A.rs._pttActive = true;
      const off = await req(false, A.port, '/api/ptt/off');
      check(off.status === 200 && A.ptts.join() === 'false', 'off while keyed: 200, unkeyed');
      A.rs._pttActive = true;
      const togOff = await req(false, A.port, '/api/ptt/toggle');
      check(togOff.status === 200 && A.ptts.join() === 'false,false' && JSON.parse(togOff.text).ptt === false, 'toggle while keyed: 200, unkeyed');
      check(A.used.length === 2 && A.used.every((e) => e.route === 'http'), 'successful calls are reported with route http');
      const hostile = await req(false, A.port, '/api/ptt/off', { origin: 'https://evil.example' });
      check(hostile.status === 403 && A.ptts.length === 2, 'a hostile Origin is still refused (#970), even for off');
      const hostileOn = await req(false, A.port, '/api/ptt/on', { origin: 'https://evil.example' });
      check(hostileOn.status === 403 && A.ptts.length === 2, 'a hostile Origin on: refused');
      const page = await req(false, A.port, '/');
      check(page.status === 200, 'the ECHOCAT page itself is still served on the fallback');
    }
    A.rs.stop();
    await sleep(150);

    const TOKEN = 'ptt-api-plain-http-token-0123456789';
    console.log('\nPlain-HTTP fallback with the ECHOCAT password on');
    const B = await shack(TOKEN, { requireToken: true }, true);
    check(B.rs.running && B.rs._https === false, 'plain-HTTP fallback');
    {
      const none = await req(false, B.port, '/api/ptt/on');
      check(none.status === 401 && B.ptts.length === 0, 'no token: 401, nothing keyed');
      const wrong = await req(false, B.port, '/api/ptt/toggle?token=nope');
      check(wrong.status === 401 && B.ptts.length === 0, 'wrong token: 401, nothing keyed');
      const ok = await req(false, B.port, '/api/ptt/on?token=' + TOKEN);
      check(ok.status === 200 && B.ptts.join() === 'true', 'the right token: on keys');
      const off = await req(false, B.port, '/api/ptt/off?token=' + TOKEN);
      check(off.status === 200 && B.ptts.join() === 'true,false', 'off with the token unkeys');
      const tog = await req(false, B.port, '/api/ptt/toggle?token=' + TOKEN);
      check(tog.status === 200 && B.ptts.join() === 'true,false,true', 'toggle with the token keys');
      await req(false, B.port, '/api/ptt/off?token=' + TOKEN);
      const hostile = await req(false, B.port, '/api/ptt/on?token=' + TOKEN, { origin: 'https://evil.example' });
      check(hostile.status === 403 && B.ptts.length === 4, 'a hostile page holding the token is still refused');
    }
    B.rs.stop();
    await sleep(150);

    console.log('\nHTTPS, fresh-install defaults: unchanged');
    const C = await shack(null, {}, false);
    check(C.rs.running && C.rs._https === true, 'HTTPS');
    {
      const on = await req(true, C.port, '/api/ptt/on');
      check(on.status === 200 && C.ptts.join() === 'true', 'on with no token keys, as before');
      const tog = await req(true, C.port, '/api/ptt/toggle');
      check(tog.status === 200 && C.ptts.join() === 'true,false', 'toggle unkeys');
      const tog2 = await req(true, C.port, '/api/ptt/toggle');
      check(tog2.status === 200 && C.ptts.join() === 'true,false,true', 'toggle keys');
      const off = await req(true, C.port, '/api/ptt/off');
      check(off.status === 200 && C.ptts.join() === 'true,false,true,false', 'off unkeys');
      check(C.used.length === 4 && C.used.every((e) => e.route === 'https'), 'route https reported');
      const hostile = await req(true, C.port, '/api/ptt/on', { origin: 'https://evil.example' });
      check(hostile.status === 403 && C.ptts.length === 4, 'a hostile Origin is refused (#970)');
      const img = await req(true, C.port, '/api/ptt/on', { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image' });
      check(img.status === 403 && C.ptts.length === 4, 'a cross-site <img> is refused (#970)');
      check(C.used.length === 4, 'refusals are not stamped');
    }
    C.rs.stop();
    await sleep(150);
  } catch (e) {
    failed++;
    console.log('  FAIL unexpected error: ' + (e && e.stack || e));
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
