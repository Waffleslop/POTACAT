// Cloud Tunnel web-UI gate (regression, 2026-06-13). Turning on the
// Cloud Tunnel made the plain LAN/Tailscale web URL serve the
// "paired devices only" stub instead of the ECHOCAT web app — killing
// the free, no-app/no-subscription path. The stub must show ONLY for
// public visitors arriving over the tunnel; LAN, Tailscale, and local
// browsers get the real UI.
//
// ECHOCAT Web over POTACAT Cloud (2026-09-11): an anonymous tunnel
// visitor's GET / is now a static CONNECT PAGE (still leak-free — no
// version, callsign, or authMode), every other anonymous tunnel path
// stays the stub, and a browser carrying a live __Host- cookie (owner
// device token from /api/pair-account {web:true}, or a Guest Pass session
// from /api/pass-gate) is served the SPA with __authMode="cookie" and
// pre-authenticated on the WS. The third block below exercises that end
// to end against a real RemoteServer.
// Run: node test/tunnel-webui-gate-test.js

'use strict';

const https = require('https');
const WebSocket = require('ws');
const { RemoteServer } = require('../lib/remote-server');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Unit: the discriminator ────────────────────────────────────────
console.log('=== _isTunnelOrPublicRequest ===');
const T = (h, ip) => RemoteServer._isTunnelOrPublicRequest(h, ip);
check(T({ 'cf-ray': '8a1b2c3d-EWR' }, '127.0.0.1') === true, 'Cloudflare cf-ray header → tunnel (even from loopback)');
check(T({ 'cf-connecting-ip': '203.0.113.9' }, '127.0.0.1') === true, 'cf-connecting-ip header → tunnel');
check(T({}, '192.168.1.50') === false, 'direct LAN 192.168 → not tunnel');
check(T({}, '10.0.0.9') === false, 'direct LAN 10/8 → not tunnel');
check(T({}, '172.20.1.1') === false, 'direct LAN 172.16/12 → not tunnel');
check(T({}, '100.94.0.7') === false, 'Tailscale CGNAT 100.64/10 → not tunnel (must be allowed!)');
check(T({}, '127.0.0.1') === false, 'loopback / local browser → not tunnel');
check(T({}, '::1') === false, 'IPv6 loopback → not tunnel');
check(T({}, '::ffff:192.168.1.5') === false, 'IPv6-mapped LAN → not tunnel');
check(T({}, 'fe80::1') === false, 'IPv6 link-local → not tunnel');
check(T({}, '169.254.5.5') === false, 'IPv4 link-local → not tunnel');
check(T({}, '8.8.8.8') === true, 'plain public IPv4 (direct port-forward) → tunnel/public');
check(T({}, '') === false, 'unknown source → treated as direct (token still gates actions)');
check(T(null, '192.168.1.1') === false, 'no headers object → falls through to source check');

// ── Integration: stub fires only for tunnel/public ─────────────────
(async () => {
  console.log('\n=== live gate (tunnel exposed) ===');
  const rs = new RemoteServer();
  rs._serverVersion = 'test';
  rs.start(17350, null, { requireToken: true, tunnelExposed: true });
  await sleep(500);
  const port = rs._port;

  const get = (extraHeaders) => new Promise((resolve) => {
    const req = https.request({
      host: '127.0.0.1', port, path: '/', method: 'GET',
      headers: extraHeaders || {}, rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', () => resolve({ status: -1, body: '' }));
    req.end();
  });
  const isStub = (r) => r.status === 503 && /accepts connections from paired/.test(r.body);

  // Direct LAN/local browser (loopback source, no CF headers): real UI.
  const direct = await get();
  check(!isStub(direct), 'direct request (loopback, no CF headers) does NOT get the stub');
  check(direct.status === 200, 'direct request is served the web UI (200)');

  // The injected __authMode must match what the WS will demand.
  // requireToken=true → 'token' even for the LAN browser.
  check(/window\.__authMode="token"/.test(direct.body),
    'requireToken: injected __authMode is "token" for the LAN browser');

  // Same connection but carrying Cloudflare edge headers = via tunnel.
  // Since ECHOCAT Web, an anonymous GET / over the tunnel is the connect
  // page (200) rather than the 503 stub — but it must be just as blind.
  const tunneled = await get({ 'cf-ray': '8a1b2c3d4e5f-EWR', 'cf-connecting-ip': '203.0.113.42' });
  check(!isStub(tunneled) && tunneled.status === 200 && /Sign in with POTACAT Cloud/.test(tunneled.body),
    'request with Cloudflare edge headers gets the connect page (not the SPA)');
  check(!/__authMode/.test(tunneled.body), 'connect page carries no injected __authMode');

  // /health stays open over the tunnel (whitelist intact).
  const health = await new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port, path: '/health', method: 'GET',
      headers: { 'cf-ray': 'x-EWR' }, rejectUnauthorized: false }, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', () => resolve({ status: -1 })); req.end();
  });
  check(health.status === 200 && /ok/.test(health.body), '/health still open over the tunnel');

  rs.stop();
  await sleep(100);

  // ── Regression: tunnel ON, NO token required (the dead-shell bug) ──
  // 2026-06-13: with the Cloud Tunnel running 24/7 and no shared token,
  // the HTML injected __authMode="none" (pre-hiding the connect screen
  // and showing the main UI) while the WS sent auth-mode="token" and
  // withheld auth-ok — a live VFO shell with no spots/freq and no
  // reachable token entry. The three gates (HTTP stub, injected
  // __authMode, WS auth-mode) must agree, keyed on _isTunnelOrPublicRequest.
  console.log('\n=== tunnel exposed, no token (LAN free path must auto-auth) ===');
  const rs2 = new RemoteServer();
  rs2._serverVersion = 'test';
  rs2.start(17351, null, { requireToken: false, tunnelExposed: true });
  await sleep(500);
  const port2 = rs2._port;

  const get2 = (extraHeaders) => new Promise((resolve) => {
    const req = https.request({
      host: '127.0.0.1', port: port2, path: '/', method: 'GET',
      headers: extraHeaders || {}, rejectUnauthorized: false,
    }, (res) => {
      let data = ''; res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', () => resolve({ status: -1, body: '' }));
    req.end();
  });

  // LAN browser: real UI, and injected __authMode="none" so the
  // renderer auto-authenticates instead of stranding a dead shell.
  const lan = await get2();
  check(lan.status === 200 && !/accepts connections from paired/.test(lan.body),
    'LAN browser gets the real UI (not the stub) with tunnel on + no token');
  check(/window\.__authMode="none"/.test(lan.body),
    'LAN browser: injected __authMode is "none" (renderer auto-auths)');

  // The WS layer must agree: a loopback/LAN WS connection auto-auths,
  // a tunnel (cf-ray) WS connection is forced into token mode.
  const wsAuthMode = (extraHeaders) => new Promise((resolve) => {
    const seen = [];
    let mode = null;
    const ws = new WebSocket(`wss://127.0.0.1:${port2}/`, {
      rejectUnauthorized: false, headers: extraHeaders || {},
    });
    const done = (v) => { try { ws.close(); } catch {} resolve(v); };
    const t = setTimeout(() => done({ mode, seen }), 2500);
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      seen.push(m.type);
      if (m.type === 'auth-mode') mode = m.mode;
      if (m.type === 'auth-ok') { clearTimeout(t); done({ mode, seen }); }
    });
    ws.on('error', () => { clearTimeout(t); done({ mode, seen, error: true }); });
  });

  const lanWs = await wsAuthMode();
  check(lanWs.mode === 'none', 'LAN WS: auth-mode is "none" (tunnel on, no token)');
  check(lanWs.seen.includes('auth-ok'), 'LAN WS: auto-authenticated (received auth-ok)');

  const tunnelWs = await wsAuthMode({ 'cf-ray': '9z9z-EWR', 'cf-connecting-ip': '203.0.113.7' });
  check(tunnelWs.mode === 'token', 'tunnel WS (cf-ray): auth-mode is "token" (must authenticate)');
  check(!tunnelWs.seen.includes('auth-ok'), 'tunnel WS (cf-ray): NOT auto-authenticated');

  rs2.stop();
  await sleep(100);

  // ── ECHOCAT Web over POTACAT Cloud: cookie sign-in end to end ──────
  console.log('\n=== ECHOCAT Web: connect page, cookies, WS pre-auth ===');
  const WebGate = require('../lib/echocat-web-gate');
  const rs3 = new RemoteServer();
  rs3._serverVersion = 'test-version-7.7.7';
  rs3.setAltHosts({ cloudHost: 'k3sbp.potacat.com' });
  rs3.setRemoteSettings({ myCallsign: 'K3SBP' });
  rs3.start(17352, null, { requireToken: false, tunnelExposed: true });
  await sleep(500);
  const port3 = rs3._port;
  const CF = { 'cf-ray': '7c7c-EWR', 'cf-connecting-ip': '203.0.113.42' };
  const STATION = 'k3sbp.potacat.com';

  // Generic request helper: returns status, headers, body.
  const call = (opts) => new Promise((resolve) => {
    const body = opts.body == null ? null : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    const headers = Object.assign({}, opts.headers || {});
    if (body != null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
    const req = https.request({
      host: '127.0.0.1', port: port3, path: opts.path || '/', method: opts.method || 'GET',
      headers, rejectUnauthorized: false,
    }, (res) => {
      let data = ''; res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', () => resolve({ status: -1, headers: {}, body: '' }));
    if (body != null) req.write(body);
    req.end();
  });
  const setCookies = (r) => [].concat(r.headers['set-cookie'] || []);
  const isConnectPage = (r) => r.status === 200 && /Sign in with POTACAT Cloud/.test(r.body);
  const isSpaCookie = (r) => r.status === 200 && /window\.__authMode="cookie"/.test(r.body);
  const isStub3 = (r) => r.status === 503 && /accepts connections from paired/.test(r.body);

  // 1. Anonymous tunnel visitor: connect page, leak-free, hardened headers.
  const anon = await call({ headers: Object.assign({ host: STATION }, CF) });
  check(isConnectPage(anon), 'anonymous tunnel GET / → connect page');
  check(!/__authMode/.test(anon.body), 'connect page: no __authMode');
  check(!/test-version-7\.7\.7/.test(anon.body), 'connect page: no server version');
  check(!/K3SBP/.test(anon.body), 'connect page: no operator callsign');
  check(/noindex/.test(anon.headers['x-robots-tag'] || ''), 'connect page: X-Robots-Tag noindex');
  check(/no-store/.test(anon.headers['cache-control'] || ''), 'connect page: Cache-Control no-store');
  check((anon.headers['x-frame-options'] || '').toUpperCase() === 'DENY', 'connect page: X-Frame-Options DENY');
  check(setCookies(anon).length === 0, 'connect page: no Set-Cookie when the visitor sent none');

  // 2. Every other anonymous tunnel path stays the stub.
  const anonJs = await call({ path: '/remote.js', headers: CF });
  check(isStub3(anonJs), 'anonymous tunnel GET /remote.js → still the 503 stub');
  const anonPtt = await call({ path: '/api/ptt/on', headers: CF });
  check(isStub3(anonPtt), 'anonymous tunnel GET /api/ptt/on → 503 stub');

  // 3. A bogus device cookie is cleared, not honoured.
  const bogus = await call({ headers: Object.assign({ cookie: `${WebGate.COOKIE_DEVICE}=deadbeef` }, CF) });
  check(isConnectPage(bogus), 'unknown device cookie → connect page');
  check(setCookies(bogus).some(c => c.startsWith(WebGate.COOKIE_DEVICE + '=') && /Max-Age=0/.test(c)),
    'unknown device cookie → Set-Cookie clears it');

  // 4. A live web device cookie serves the SPA in cookie mode — SPA paths only.
  const dev = rs3.mintPairedDevice({ deviceName: 'Browser on Chrome (Windows)', devicePlatform: 'web', accountLinked: true, expiresAt: null });
  const devCookie = `${WebGate.COOKIE_DEVICE}=${dev.token}`;
  const spa = await call({ headers: Object.assign({ cookie: devCookie }, CF) });
  check(isSpaCookie(spa), 'live device cookie → SPA with __authMode="cookie"');
  const spaJs = await call({ path: '/remote.js', headers: Object.assign({ cookie: devCookie }, CF) });
  check(spaJs.status === 200 && !isStub3(spaJs), 'live device cookie → /remote.js served');
  const pttCookie = await call({ path: '/api/ptt/on', headers: Object.assign({ cookie: devCookie }, CF) });
  check(isStub3(pttCookie), 'live device cookie → /api/ptt/* STILL the stub (never reachable from the internet)');
  // The LAN path must not have changed: no cookie, no CF headers → __authMode none.
  const lan3 = await call({});
  check(lan3.status === 200 && /window\.__authMode="none"/.test(lan3.body), 'LAN GET / unchanged (__authMode="none")');

  // 5. WS upgrade with the cookie pre-authenticates — Origin must be us.
  const wsProbe = (headers) => new Promise((resolve) => {
    const seen = []; let mode = null; let authOk = null;
    const ws = new WebSocket(`wss://127.0.0.1:${port3}/`, { rejectUnauthorized: false, headers });
    const done = (v) => { try { ws.close(); } catch {} resolve(v); };
    const t = setTimeout(() => done({ mode, seen, authOk }), 2500);
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      seen.push(m.type);
      if (m.type === 'auth-mode') mode = m.mode;
      if (m.type === 'auth-ok') { authOk = m; clearTimeout(t); setTimeout(() => done({ mode, seen, authOk }), 150); }
    });
    ws.on('error', () => { clearTimeout(t); done({ mode, seen, authOk, error: true }); });
  });
  const wsOk = await wsProbe(Object.assign({ cookie: devCookie, origin: `https://${STATION}`, host: STATION }, CF));
  check(wsOk.mode === 'cookie', 'WS + device cookie + our Origin → auth-mode "cookie"');
  check(!!wsOk.authOk, 'WS + device cookie → auth-ok without any auth message');
  check(wsOk.authOk && wsOk.authOk.accountLinked === true, 'WS cookie auth-ok carries accountLinked=true');
  check(rs3.listPairedDevices().find(d => d.id === dev.id).lastSeen != null, 'cookie auth stamps the device lastSeen');
  const wsEvil = await wsProbe(Object.assign({ cookie: devCookie, origin: 'https://evil.example', host: STATION }, CF));
  check(wsEvil.mode === 'token' && !wsEvil.authOk, 'WS + device cookie + foreign Origin → token mode, no auth-ok (cross-site WS refused)');
  const wsNoOrigin = await wsProbe(Object.assign({ cookie: devCookie, host: STATION }, CF));
  check(wsNoOrigin.mode === 'token' && !wsNoOrigin.authOk, 'WS + device cookie + NO Origin → token mode, no auth-ok');
  const wsNoCookie = await wsProbe(Object.assign({ origin: `https://${STATION}`, host: STATION }, CF));
  check(wsNoCookie.mode === 'token' && !wsNoCookie.authOk, 'WS tunnel without cookie → token mode (unchanged)');

  // 6. Revoke from the desktop → the browser lands on the connect page.
  rs3.revokeDevice(dev.id);
  const afterRevoke = await call({ headers: Object.assign({ cookie: devCookie }, CF) });
  check(isConnectPage(afterRevoke), 'revoked device cookie → connect page');
  check(setCookies(afterRevoke).some(c => c.startsWith(WebGate.COOKIE_DEVICE + '=') && /Max-Age=0/.test(c)),
    'revoked device cookie → cleared');

  // 7. /api/pair-account {web:true}: cookie in the header, token NOT in the body.
  rs3.on('verify-pair-token', (r) => {
    rs3.emit('verify-pair-token-result', { pairToken: r.pairToken, ok: r.pairToken.startsWith('good'), error: 'token_used' });
  });
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
  const pairWeb = await call({ method: 'POST', path: '/api/pair-account',
    headers: Object.assign({ origin: `https://${STATION}`, host: STATION, 'user-agent': UA }, CF),
    body: { pairToken: 'good-' + 'a'.repeat(59), web: true } });
  check(pairWeb.status === 200, 'pair-account {web:true} → 200');
  const pairWebJson = (() => { try { return JSON.parse(pairWeb.body); } catch { return {}; } })();
  check(pairWebJson.ok === true && !('deviceToken' in pairWebJson), 'pair-account {web:true} body has ok:true and NO deviceToken');
  const pairWebCookie = setCookies(pairWeb).find(c => c.startsWith(WebGate.COOKIE_DEVICE + '='));
  check(!!pairWebCookie && /HttpOnly/.test(pairWebCookie) && /Secure/.test(pairWebCookie) && /SameSite=Strict/.test(pairWebCookie),
    'pair-account {web:true} sets the HttpOnly/Secure/SameSite=Strict device cookie');
  const webDev = rs3.listPairedDevices().find(d => d.id === pairWebJson.deviceId);
  check(!!webDev && webDev.platform === 'web', 'web pairing is a platform "web" device row');
  check(!!webDev && webDev.name === 'Browser on Safari (Mac)', `web device named from the UA (got ${webDev && webDev.name})`);
  const pairWebNoOrigin = await call({ method: 'POST', path: '/api/pair-account', headers: Object.assign({ host: STATION }, CF),
    body: { pairToken: 'good-' + 'b'.repeat(59), web: true } });
  check(pairWebNoOrigin.status === 403, 'pair-account {web:true} without Origin → 403');
  const pairWebBad = await call({ method: 'POST', path: '/api/pair-account',
    headers: Object.assign({ origin: `https://${STATION}`, host: STATION }, CF),
    body: { pairToken: 'bad-' + 'c'.repeat(60), web: true } });
  check(pairWebBad.status === 401 && /token_used/.test(pairWebBad.body), 'pair-account {web:true} with a rejected token → 401 typed error');
  // Regression: the mobile app's call still gets the token in the body.
  const pairNative = await call({ method: 'POST', path: '/api/pair-account', headers: CF,
    body: { pairToken: 'good-' + 'd'.repeat(59), deviceName: 'iPhone', devicePlatform: 'ios' } });
  const pairNativeJson = (() => { try { return JSON.parse(pairNative.body); } catch { return {}; } })();
  check(pairNative.status === 200 && typeof pairNativeJson.deviceToken === 'string' && setCookies(pairNative).length === 0,
    'pair-account without web:true → deviceToken in body, no cookie (mobile app unchanged)');

  // 8. The cookie it set signs the browser in; /api/web-signout ends it and revokes the row.
  const tokenFromCookie = decodeURIComponent(pairWebCookie.split(';')[0].slice(WebGate.COOKIE_DEVICE.length + 1));
  const webDevCookie = `${WebGate.COOKIE_DEVICE}=${tokenFromCookie}`;
  check(isSpaCookie(await call({ headers: Object.assign({ cookie: webDevCookie }, CF) })), 'the pair-account cookie serves the SPA');
  const signoutNoOrigin = await call({ method: 'POST', path: '/api/web-signout', headers: Object.assign({ cookie: webDevCookie }, CF) });
  check(signoutNoOrigin.status === 403, '/api/web-signout without Origin → 403');
  const signout = await call({ method: 'POST', path: '/api/web-signout',
    headers: Object.assign({ cookie: webDevCookie, origin: `https://${STATION}`, host: STATION }, CF) });
  check(signout.status === 200, '/api/web-signout → 200');
  check(setCookies(signout).filter(c => /Max-Age=0/.test(c)).length === 2, '/api/web-signout clears both cookies');
  check(!rs3.listPairedDevices().find(d => d.id === pairWebJson.deviceId), '/api/web-signout revokes the web device row');
  check(isConnectPage(await call({ headers: Object.assign({ cookie: webDevCookie }, CF) })), 'signed-out cookie → connect page');

  // 9. Guest Pass: /api/pass-gate → pass cookie → SPA → WS pass auth; pass-ended purges it.
  const PASS = 'apple-banana-cherry';
  const SID = 'e'.repeat(64);
  let passLive = true;
  let validatorCalls = 0;
  rs3.setPassValidator(async (code, sessionId) => {
    validatorCalls++;
    if (!passLive || code !== PASS || sessionId !== SID) return null;
    return { code: PASS, owner_callsign: 'K3SBP', expires_at: new Date(Date.now() + 3600e3).toISOString(),
      privilege_class: 'general', max_power_w: 100, allowed_modes: ['SSB'] };
  });
  const gateNoOrigin = await call({ method: 'POST', path: '/api/pass-gate', headers: CF, body: { passCode: PASS, sessionId: SID } });
  check(gateNoOrigin.status === 403, '/api/pass-gate without Origin → 403');
  const gateBadShape = await call({ method: 'POST', path: '/api/pass-gate',
    headers: Object.assign({ origin: `https://${STATION}`, host: STATION }, CF), body: { passCode: 'nope', sessionId: 'x' } });
  check(gateBadShape.status === 400, '/api/pass-gate malformed credential → 400 (validator not consulted)');
  const gate = await call({ method: 'POST', path: '/api/pass-gate',
    headers: Object.assign({ origin: `https://${STATION}`, host: STATION }, CF), body: { passCode: PASS.toUpperCase(), sessionId: SID } });
  check(gate.status === 200 && /"ok":true/.test(gate.body), '/api/pass-gate valid → 200 ok');
  const passCookieHdr = setCookies(gate).find(c => c.startsWith(WebGate.COOKIE_PASS + '='));
  check(!!passCookieHdr && /HttpOnly/.test(passCookieHdr), '/api/pass-gate sets the HttpOnly pass cookie');
  const passCookie = passCookieHdr.split(';')[0];
  check(isSpaCookie(await call({ headers: Object.assign({ cookie: passCookie }, CF) })), 'pass cookie → SPA with __authMode="cookie"');
  const wsPass = await wsProbe(Object.assign({ cookie: passCookie, origin: `https://${STATION}`, host: STATION }, CF));
  check(wsPass.mode === 'cookie', 'WS + pass cookie → auth-mode "cookie"');
  check(!!wsPass.authOk && !!wsPass.authOk.passSession && wsPass.authOk.passSession.ownerCallsign === 'K3SBP',
    'WS + pass cookie → auth-ok with passSession (via _authenticatePass)');
  // Desktop restart = empty session map: the cookie is re-validated with the cloud, once.
  rs3._passGateSessions.clear();
  const before = validatorCalls;
  check(isSpaCookie(await call({ headers: Object.assign({ cookie: passCookie }, CF) })), 'pass cookie after a restart → re-validated → SPA');
  check(validatorCalls === before + 1, 'restart re-validation consulted the cloud validator exactly once');
  check(isSpaCookie(await call({ headers: Object.assign({ cookie: passCookie }, CF) })) && validatorCalls === before + 1,
    'the re-validated session is cached (second load: no cloud call)');
  // Pass ends: the browser's next load is the connect page.
  passLive = false;
  rs3.broadcastPassEnded('revoked', PASS);
  const afterEnd = await call({ headers: Object.assign({ cookie: passCookie }, CF) });
  check(isConnectPage(afterEnd), 'after pass-ended the pass cookie → connect page');
  check(setCookies(afterEnd).some(c => c.startsWith(WebGate.COOKIE_PASS + '=') && /Max-Age=0/.test(c)), 'ended pass cookie is cleared');
  const deniedCalls = validatorCalls;
  await call({ headers: Object.assign({ cookie: passCookie }, CF) });
  check(validatorCalls === deniedCalls, 'a denied pass cookie is not re-checked with the cloud on every load (negative cache)');

  // 10. Brute force on tunnel POSTs: a scanner's IP gets 429 after 10 failures.
  const SCANNER = { 'cf-ray': '7c7d-EWR', 'cf-connecting-ip': '198.51.100.9' };
  let last = null;
  for (let i = 0; i < 10; i++) {
    last = await call({ method: 'POST', path: '/api/pass-gate',
      headers: Object.assign({ origin: `https://${STATION}`, host: STATION }, SCANNER),
      body: { passCode: 'wrong-guess-here', sessionId: 'f'.repeat(64) } });
  }
  check(last.status === 404, 'wrong pass → 404 (10th failure still answered)');
  const throttled = await call({ method: 'POST', path: '/api/pass-gate',
    headers: Object.assign({ origin: `https://${STATION}`, host: STATION }, SCANNER),
    body: { passCode: 'wrong-guess-here', sessionId: 'f'.repeat(64) } });
  check(throttled.status === 429 && !!throttled.headers['retry-after'], '11th failure from the same IP → 429 + Retry-After');
  const pairThrottled = await call({ method: 'POST', path: '/api/pair', headers: SCANNER, body: { code: '000000' } });
  check(pairThrottled.status === 429, 'the cooldown covers /api/pair from that IP too');
  // ...but a LAN caller is never throttled, and other IPs are unaffected.
  const otherIp = await call({ method: 'POST', path: '/api/pass-gate',
    headers: Object.assign({ origin: `https://${STATION}`, host: STATION }, { 'cf-ray': 'x', 'cf-connecting-ip': '198.51.100.10' }),
    body: { passCode: 'wrong-guess-here', sessionId: 'f'.repeat(64) } });
  check(otherIp.status === 404, 'a different visitor IP is not throttled');

  rs3.stop();
  await sleep(100);

  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
