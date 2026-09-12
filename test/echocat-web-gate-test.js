'use strict';
// ECHOCAT Web over POTACAT Cloud — lib/echocat-web-gate.js.
//
// Pins the ONE auth-mode decision the HTTP layer and the WS layer share.
// The 2026-06-13 dead-shell regression was the two disagreeing (HTML said
// 'none', WS said 'token'); every decideHttpGate row below is also run
// through wsAuthModeFor and the strings must match. Also guards e696ad5's
// rule: the anonymous tunnel page is a constant and leaks nothing.

const assert = require('assert');
const G = require('../lib/echocat-web-gate');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

const NOW = 1_800_000_000_000;
const HEX64 = 'a'.repeat(64);
const DEV = { id: 'd1', token: 'tok-live', expiresAt: null, accountLinked: true };
const DEV_EXPIRED = { id: 'd2', token: 'tok-dead', expiresAt: NOW - 1 };
const findDevice = (tok) => (tok === DEV.token ? DEV : tok === DEV_EXPIRED.token ? DEV_EXPIRED : null);
const PASS_CODE = 'alpha-bravo-charlie-delta';
const passSessions = new Map([[HEX64, { code: PASS_CODE, expiresAt: NOW + 3_600_000 }]]);
const findPassSession = (sid) => passSessions.get(sid) || null;

console.log('parseCookieHeader');
t('empty / non-string → empty object', () => {
  assert.deepStrictEqual({ ...G.parseCookieHeader('') }, {});
  assert.deepStrictEqual({ ...G.parseCookieHeader(undefined) }, {});
  assert.deepStrictEqual({ ...G.parseCookieHeader(null) }, {});
});
t('splits on ; and trims, first occurrence wins', () => {
  const c = G.parseCookieHeader('a=1; b=2 ;a=3; =x; novalue');
  assert.strictEqual(c.a, '1');
  assert.strictEqual(c.b, '2');
  assert.strictEqual(c[''], undefined);
  assert.strictEqual(c.novalue, undefined);
});
t('percent-decodes and strips quotes; leaves undecodable raw', () => {
  const c = G.parseCookieHeader('q="hello"; e=a%2Eb; bad=%E0%A4%A');
  assert.strictEqual(c.q, 'hello');
  assert.strictEqual(c.e, 'a.b');
  assert.strictEqual(c.bad, '%E0%A4%A');
});
t('prototype names cannot poison the map', () => {
  const c = G.parseCookieHeader('__proto__=x; constructor=y');
  assert.strictEqual(Object.getPrototypeOf(c), null);
  assert.strictEqual(c.__proto__, 'x');
});

console.log('Set-Cookie strings');
t('device cookie carries __Host-, HttpOnly, Secure, SameSite=Strict, Path=/ and NO Domain', () => {
  const s = G.buildSetCookie(G.COOKIE_DEVICE, 'abc', { maxAgeSec: G.DEVICE_COOKIE_MAX_AGE_SEC });
  assert.ok(s.startsWith('__Host-echocat_device=abc;'));
  assert.ok(/; HttpOnly/.test(s) && /; Secure/.test(s) && /; SameSite=Strict/.test(s) && /; Path=\//.test(s));
  assert.ok(!/Domain=/.test(s));
  assert.ok(s.endsWith('Max-Age=' + (365 * 24 * 3600)));
});
t('values are percent-encoded so a pass code with a dot survives and a ; cannot break out', () => {
  const s = G.buildSetCookie(G.COOKIE_PASS, PASS_CODE + '.' + HEX64, { maxAgeSec: 60 });
  assert.ok(s.includes(PASS_CODE + '.' + HEX64));
  assert.ok(!G.buildSetCookie('x', 'a;b', { maxAgeSec: 1 }).includes('a;b'));
});
t('clear cookie is Max-Age=0 with the same attributes', () => {
  const s = G.buildClearCookie(G.COOKIE_DEVICE);
  assert.strictEqual(s, '__Host-echocat_device=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
});
t('negative / garbage Max-Age clamps to 0', () => {
  assert.ok(G.buildSetCookie('x', 'y', { maxAgeSec: -5 }).endsWith('Max-Age=0'));
  assert.ok(G.buildSetCookie('x', 'y', { maxAgeSec: 'nope' }).endsWith('Max-Age=0'));
});

console.log('deviceIsLive');
t('null expiry = never expires; future ok; past dead; missing token dead', () => {
  assert.strictEqual(G.deviceIsLive(DEV, NOW), true);
  assert.strictEqual(G.deviceIsLive({ token: 'x', expiresAt: NOW + 1 }, NOW), true);
  assert.strictEqual(G.deviceIsLive(DEV_EXPIRED, NOW), false);
  assert.strictEqual(G.deviceIsLive({ id: 'x', expiresAt: null }, NOW), false);
  assert.strictEqual(G.deviceIsLive(null, NOW), false);
});

console.log('parsePassCookie');
t('code.sessionId round-trips, case-normalised', () => {
  assert.deepStrictEqual(G.parsePassCookie(PASS_CODE.toUpperCase() + '.' + HEX64.toUpperCase()), { code: PASS_CODE, sessionId: HEX64 });
  assert.deepStrictEqual(G.parsePassCookie('one-two-three.' + HEX64), { code: 'one-two-three', sessionId: HEX64 });
});
t('rejects wrong word counts, short ids, missing dot, non-strings', () => {
  assert.strictEqual(G.parsePassCookie('one-two.' + HEX64), null);
  assert.strictEqual(G.parsePassCookie(PASS_CODE + '.' + HEX64.slice(1)), null);
  assert.strictEqual(G.parsePassCookie(PASS_CODE), null);
  assert.strictEqual(G.parsePassCookie(PASS_CODE + '.zz' + HEX64.slice(2)), null);
  assert.strictEqual(G.parsePassCookie(42), null);
});

console.log('decideHttpGate + wsAuthModeFor (must agree on every row)');
function gate(over) {
  return G.decideHttpGate({ tunnelExposed: true, fromTunnel: true, requireToken: true, method: 'GET', pathname: '/', cookies: {}, findDevice, findPassSession, now: NOW, ...over });
}
function agree(over, expectedMode, cookieAuth) {
  const d = gate(over);
  assert.strictEqual(d.action, 'serve', 'expected serve, got ' + d.action);
  assert.strictEqual(d.authMode, expectedMode);
  const ws = G.wsAuthModeFor({ requireToken: over.requireToken !== undefined ? over.requireToken : true, tunnelExposed: over.tunnelExposed !== undefined ? over.tunnelExposed : true, fromTunnel: over.fromTunnel !== undefined ? over.fromTunnel : true, cookieAuth: !!cookieAuth });
  assert.strictEqual(ws, expectedMode, 'WS mode ' + ws + ' != HTTP mode ' + expectedMode);
}
t('LAN, no token required → serve/none (unchanged)', () => agree({ fromTunnel: false, requireToken: false }, 'none'));
t('LAN, token required → serve/token (unchanged)', () => agree({ fromTunnel: false, requireToken: true }, 'token'));
t('tunnel exposed but request from LAN → LAN rules', () => agree({ fromTunnel: false, requireToken: false }, 'none'));
t('public IP but not tunnel-exposed → LAN rules (pre-existing behaviour)', () => agree({ tunnelExposed: false, requireToken: true }, 'token'));
t('anonymous tunnel GET / → connect page, nothing to clear', () => {
  assert.deepStrictEqual(gate({}), { action: 'connect-page', clearCookies: [] });
  assert.deepStrictEqual(gate({ pathname: '/remote.html', method: 'HEAD' }), { action: 'connect-page', clearCookies: [] });
});
t('anonymous tunnel: every other path stays the stub', () => {
  for (const p of ['/remote.js', '/remote.css', '/cq-target.js', '/api/ptt/on', '/api/spots', '/settings.json', '/../main.js']) {
    assert.strictEqual(gate({ pathname: p }).action, 'stub', p);
  }
  assert.strictEqual(gate({ method: 'POST' }).action, 'stub', 'POST / is not a page');
});
t('valid device cookie on the SPA paths → serve/cookie with the device, and WS agrees', () => {
  for (const p of [...G.SPA_PATHS]) {
    const d = gate({ pathname: p, cookies: { [G.COOKIE_DEVICE]: DEV.token } });
    assert.strictEqual(d.action, 'serve', p);
    assert.strictEqual(d.authMode, 'cookie', p);
    assert.strictEqual(d.device, DEV);
  }
  agree({ cookies: { [G.COOKIE_DEVICE]: DEV.token } }, 'cookie', true);
});
t('valid device cookie on /api/ptt/* (and any non-SPA path) → STUB, never served', () => {
  for (const p of ['/api/ptt/on', '/api/ptt/off', '/api/spots', '/api/pair-request']) {
    assert.strictEqual(gate({ pathname: p, cookies: { [G.COOKIE_DEVICE]: DEV.token } }).action, 'stub', p);
  }
});
t('expired device cookie → connect page and the cookie is cleared', () => {
  assert.deepStrictEqual(gate({ cookies: { [G.COOKIE_DEVICE]: DEV_EXPIRED.token } }), { action: 'connect-page', clearCookies: [G.COOKIE_DEVICE] });
});
t('revoked (unknown) device cookie → connect page + clear; on a sub-path → stub', () => {
  assert.deepStrictEqual(gate({ cookies: { [G.COOKIE_DEVICE]: 'gone' } }), { action: 'connect-page', clearCookies: [G.COOKIE_DEVICE] });
  assert.strictEqual(gate({ pathname: '/remote.js', cookies: { [G.COOKIE_DEVICE]: 'gone' } }).action, 'stub');
});
t('known pass cookie → serve/cookie with {code, sessionId}', () => {
  const d = gate({ cookies: { [G.COOKIE_PASS]: PASS_CODE + '.' + HEX64 } });
  assert.strictEqual(d.action, 'serve');
  assert.strictEqual(d.authMode, 'cookie');
  assert.deepStrictEqual(d.pass, { code: PASS_CODE, sessionId: HEX64 });
  assert.strictEqual(d.device, undefined);
});
t('pass cookie whose session is unknown, mismatched or expired → connect page + clear', () => {
  assert.deepStrictEqual(gate({ cookies: { [G.COOKIE_PASS]: PASS_CODE + '.' + 'b'.repeat(64) } }), { action: 'connect-page', clearCookies: [G.COOKIE_PASS] });
  assert.deepStrictEqual(gate({ cookies: { [G.COOKIE_PASS]: 'echo-foxtrot-golf.' + HEX64 } }), { action: 'connect-page', clearCookies: [G.COOKIE_PASS] });
  const expired = new Map([[HEX64, { code: PASS_CODE, expiresAt: NOW - 1 }]]);
  assert.deepStrictEqual(gate({ cookies: { [G.COOKIE_PASS]: PASS_CODE + '.' + HEX64 }, findPassSession: (s) => expired.get(s) }), { action: 'connect-page', clearCookies: [G.COOKIE_PASS] });
});
t('malformed pass cookie → cleared, not consulted', () => {
  let asked = false;
  const d = gate({ cookies: { [G.COOKIE_PASS]: 'garbage' }, findPassSession: () => { asked = true; return null; } });
  assert.deepStrictEqual(d, { action: 'connect-page', clearCookies: [G.COOKIE_PASS] });
  assert.strictEqual(asked, false);
});
t('both cookies stale → both cleared in one response', () => {
  assert.deepStrictEqual(gate({ cookies: { [G.COOKIE_DEVICE]: 'gone', [G.COOKIE_PASS]: 'garbage' } }).clearCookies, [G.COOKIE_DEVICE, G.COOKIE_PASS]);
});
t('a live device cookie wins over a stale pass cookie (owner on their own station)', () => {
  const d = gate({ cookies: { [G.COOKIE_DEVICE]: DEV.token, [G.COOKIE_PASS]: 'garbage' } });
  assert.strictEqual(d.authMode, 'cookie');
  assert.strictEqual(d.device, DEV);
});
t('cookies are IGNORED off the tunnel — LAN behaviour never changes', () => {
  const d = gate({ fromTunnel: false, requireToken: false, cookies: { [G.COOKIE_DEVICE]: DEV.token } });
  assert.deepStrictEqual(d, { action: 'serve', authMode: 'none' });
});
t('tunnel-open paths bypass the gate, cookie or not', () => {
  assert.deepStrictEqual(gate({ pathname: '/health' }), { action: 'open' });
  for (const p of ['/api/pair', '/api/pair-account', '/api/pair-request', '/api/pass-gate', '/api/web-signout']) {
    assert.deepStrictEqual(gate({ method: 'POST', pathname: p }), { action: 'open' }, p);
    assert.strictEqual(gate({ method: 'GET', pathname: p }).action, 'stub', 'GET ' + p);
  }
});
t('isTunnelOpenPath is case-insensitive on the method only', () => {
  assert.strictEqual(G.isTunnelOpenPath('post', '/api/pass-gate'), true);
  assert.strictEqual(G.isTunnelOpenPath('POST', '/API/PASS-GATE'), false);
  assert.strictEqual(G.isTunnelOpenPath(undefined, '/health'), true);
});
t('wsAuthModeFor: cookieAuth only matters on the tunnel', () => {
  assert.strictEqual(G.wsAuthModeFor({ requireToken: false, tunnelExposed: true, fromTunnel: false, cookieAuth: true }), 'none');
  assert.strictEqual(G.wsAuthModeFor({ requireToken: true, tunnelExposed: true, fromTunnel: true, cookieAuth: false }), 'token');
  assert.strictEqual(G.wsAuthModeFor({ requireToken: false, tunnelExposed: true, fromTunnel: true, cookieAuth: false }), 'token');
  assert.strictEqual(G.wsAuthModeFor({ requireToken: false, tunnelExposed: true, fromTunnel: true, cookieAuth: true }), 'cookie');
});

console.log('originAllowed');
t('absent Origin → allowed (native clients, curl)', () => {
  assert.strictEqual(G.originAllowed(undefined, 'k3sbp.potacat.com', ''), true);
  assert.strictEqual(G.originAllowed('', 'k3sbp.potacat.com', ''), true);
});
t('"null" origin → refused', () => assert.strictEqual(G.originAllowed('null', 'k3sbp.potacat.com', ''), false));
t('same host → allowed, case-insensitive; port must match', () => {
  assert.strictEqual(G.originAllowed('https://K3SBP.potacat.com', 'k3sbp.potacat.com', ''), true);
  assert.strictEqual(G.originAllowed('https://192.168.1.5:7300', '192.168.1.5:7300', ''), true);
  assert.strictEqual(G.originAllowed('https://192.168.1.5:7301', '192.168.1.5:7300', ''), false);
});
t('cloudHost matches even when the Host header is something else', () => {
  assert.strictEqual(G.originAllowed('https://k3sbp.potacat.com', 'localhost:7300', 'k3sbp.potacat.com'), true);
});
t('other origins, sibling stations, garbage and non-http schemes → refused', () => {
  assert.strictEqual(G.originAllowed('https://evil.example', 'k3sbp.potacat.com', 'k3sbp.potacat.com'), false);
  assert.strictEqual(G.originAllowed('https://w1aw.potacat.com', 'k3sbp.potacat.com', 'k3sbp.potacat.com'), false);
  assert.strictEqual(G.originAllowed('not a url', 'k3sbp.potacat.com', ''), false);
  assert.strictEqual(G.originAllowed('file://', 'k3sbp.potacat.com', ''), false);
  assert.strictEqual(G.originAllowed('chrome-extension://abc', 'k3sbp.potacat.com', ''), false);
});

console.log('browserDeviceName');
t('common UAs', () => {
  assert.strictEqual(G.browserDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'), 'Browser on Chrome (Windows)');
  assert.strictEqual(G.browserDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0'), 'Browser on Edge (Windows)');
  assert.strictEqual(G.browserDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'), 'Browser on Safari (iPhone)');
  assert.strictEqual(G.browserDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0 Mobile/15E148 Safari/604.1'), 'Browser on Chrome (iPhone)');
  assert.strictEqual(G.browserDeviceName('Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0'), 'Browser on Firefox (Linux)');
  assert.strictEqual(G.browserDeviceName('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36'), 'Browser on Chrome (Android)');
  assert.strictEqual(G.browserDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'), 'Browser on Safari (Mac)');
});
t('unknown / empty UA degrades gracefully and never exceeds 60 chars', () => {
  assert.strictEqual(G.browserDeviceName(''), 'Browser on Browser');
  assert.strictEqual(G.browserDeviceName(undefined), 'Browser on Browser');
  assert.ok(G.browserDeviceName('x'.repeat(500)).length <= 60);
});

console.log('parseStationFragment');
t('#pair=<64hex> and #pass=<code>.<sid>', () => {
  assert.deepStrictEqual(G.parseStationFragment('#pair=' + HEX64.toUpperCase()), { pair: HEX64 });
  assert.deepStrictEqual(G.parseStationFragment('pair=' + HEX64), { pair: HEX64 });
  assert.deepStrictEqual(G.parseStationFragment('#pass=' + PASS_CODE + '.' + HEX64), { pass: { code: PASS_CODE, sessionId: HEX64 } });
  assert.deepStrictEqual(G.parseStationFragment('#pass=' + encodeURIComponent(PASS_CODE + '.' + HEX64)), { pass: { code: PASS_CODE, sessionId: HEX64 } });
});
t('anything else → null', () => {
  for (const h of ['', '#', '#pair=', '#pair=abc', '#pass=' + PASS_CODE, '#token=' + HEX64, '#pair=%E0%A4%A', null, '=x']) {
    assert.strictEqual(G.parseStationFragment(h), null, JSON.stringify(h));
  }
});

console.log('FailureRateLimiter');
t('keyFor prefers cf-connecting-ip (first value) over the socket address', () => {
  assert.strictEqual(G.FailureRateLimiter.keyFor({ 'cf-connecting-ip': '203.0.113.9, 10.0.0.1' }, '127.0.0.1'), '203.0.113.9');
  assert.strictEqual(G.FailureRateLimiter.keyFor({}, '::ffff:192.168.1.7'), '::ffff:192.168.1.7');
  assert.strictEqual(G.FailureRateLimiter.keyFor(undefined, undefined), 'unknown');
});
t('10 failures → 5 min cooldown; a success halves the failure count', () => {
  const L = new G.FailureRateLimiter();
  let now = NOW;
  for (let i = 0; i < 9; i++) { assert.strictEqual(L.check('k', now).allowed, true); assert.strictEqual(L.record('k', 404, now), 0); now += 1000; }
  assert.strictEqual(L.check('k', now).allowed, true);
  assert.strictEqual(L.record('k', 404, now), 300_000);
  const blocked = L.check('k', now + 1000);
  assert.strictEqual(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec > 290 && blocked.retryAfterSec <= 300);
  assert.strictEqual(L.check('k', now + 300_001).allowed, true);
  L.record('k', 200, now + 300_001);
  assert.strictEqual(L._map.get('k').failures.length, 5);
});
t('30 failures → 1 h; 100 → 24 h (highest tier wins once reached)', () => {
  const L = new G.FailureRateLimiter();
  let now = NOW, cd = 0;
  for (let i = 0; i < 30; i++) { cd = L.record('k', 401, now); now += 10; }
  assert.strictEqual(cd, 3_600_000);
  for (let i = 0; i < 70; i++) { cd = L.record('k', 401, now); now += 10; }
  assert.strictEqual(cd, 86_400_000);
});
t('a tier is not re-applied while its cooldown is still running', () => {
  const L = new G.FailureRateLimiter();
  let now = NOW;
  for (let i = 0; i < 10; i++) L.record('k', 404, now);
  assert.strictEqual(L.record('k', 404, now + 1), 0, 'already cooling');
});
t('burst: 30 hits in a minute → 31st refused with Retry-After 60, failures or not', () => {
  const L = new G.FailureRateLimiter();
  for (let i = 0; i < 30; i++) assert.strictEqual(L.check('k', NOW + i).allowed, true);
  assert.deepStrictEqual(L.check('k', NOW + 31), { allowed: false, retryAfterSec: 60 });
  assert.strictEqual(L.check('k', NOW + 61_000).allowed, true, 'window slides');
});
t('failures age out after an hour; non-failure statuses never count', () => {
  const L = new G.FailureRateLimiter();
  for (let i = 0; i < 9; i++) L.record('k', 404, NOW);
  L.record('k', 500, NOW);
  L.record('k', 503, NOW);
  assert.strictEqual(L._map.get('k').failures.length, 9);
  assert.strictEqual(L.record('k', 404, NOW + 3_600_001), 0, 'old failures pruned before counting');
  assert.strictEqual(L._map.get('k').failures.length, 1);
});
t('keys are independent and the map is capped, evicting the stalest non-cooling keys first', () => {
  const L = new G.FailureRateLimiter({ cap: 20 });
  for (let i = 0; i < 10; i++) L.record('hot', 404, NOW);
  for (let i = 0; i < 19; i++) L.check('k' + i, NOW + i);
  assert.strictEqual(L.size, 20);
  L.check('new', NOW + 100);
  assert.ok(L.size <= 20);
  assert.ok(L._map.has('hot'), 'the cooling-down scanner is kept');
  assert.ok(L._map.has('new'));
  assert.strictEqual(L.check('hot', NOW + 101).allowed, false);
  assert.strictEqual(L.check('k18', NOW + 101).allowed, true);
});

console.log('connect page (e696ad5: a constant, and it leaks nothing)');
t('same string every call, no template holes', () => {
  const a = G.buildConnectPageHtml();
  assert.strictEqual(a, G.buildConnectPageHtml());
  assert.ok(!/\$\{/.test(a));
  assert.ok(!/__authMode/.test(a));
  assert.ok(!/serverVersion|POTACAT\/\d|K3SBP/.test(a));
});
t('has the two entry points, robots/referrer meta and the fragment redeem paths', () => {
  const a = G.buildConnectPageHtml();
  assert.ok(a.includes('Sign in with POTACAT Cloud'));
  assert.ok(a.includes('Have a Guest Pass?'));
  assert.ok(a.includes('https://login.potacat.com/?station='));
  assert.ok(a.includes('https://login.potacat.com/?guest=1&station='));
  assert.ok(a.includes('name="robots" content="noindex, nofollow"'));
  assert.ok(a.includes('name="referrer" content="no-referrer"'));
  assert.ok(a.includes("'/api/pair-account'") && a.includes("'/api/pass-gate'"));
  assert.ok(a.indexOf('history.replaceState') < a.indexOf("redeem('/api/pair-account'"), 'the fragment is stripped BEFORE the credential is posted');
  for (const n of G.CONNECT_NOTICES) assert.ok(a.includes("'" + n + "'"), 'notice copy for ' + n);
});
t('no emojis in the copy', () => {
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(G.buildConnectPageHtml()));
});

console.log(`\nECHOCAT web gate: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
