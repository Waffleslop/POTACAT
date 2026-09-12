'use strict';
// ECHOCAT Web over POTACAT Cloud — the ONE HTTP/WS auth-mode decision.
//
// A browser away from the LAN reaches the desktop through the Cloud Tunnel
// (<callsign>.potacat.com → cloudflared → HTTPS :7300). Until 2026-09-11
// every tunnel-sourced HTTP request outside a short whitelist got the
// static 503 stub (commit e696ad5: the SPA leaked the app version, the
// operator's callsign, the renderer source and the existence of the API
// endpoints to anonymous visitors), so only the ECHOCAT mobile app — which
// authenticates its WebSocket with a paired-device token — could use the
// tunnel. This module lets a BROWSER through the same gate on the strength
// of an HttpOnly cookie minted by the desktop itself:
//
//   __Host-echocat_device = <paired-device token>   (owner; never expires,
//                            Revoke in Settings > ECHOCAT is the off switch)
//   __Host-echocat_pass   = <pass code>.<session id> (Guest Pass holder)
//
// The HTTP layer (which page to serve, which __authMode to inject) and the
// WS layer (which auth-mode to demand) MUST agree — the 2026-06-13
// dead-shell regression was exactly that drift (HTML said 'none', WS said
// 'token', the operator got a live VFO shell with no spots and no token
// box). decideHttpGate() and wsAuthModeFor() therefore share one policy
// and the tests assert they return the same string for every matrix row.
//
// Nothing here touches the network, the filesystem or a RemoteServer —
// remote-server.js passes in lookups (findDevice / findPassSession) and
// executes the returned decision. Pure and unit-tested:
// test/echocat-web-gate-test.js.

// `__Host-` prefix: the browser refuses to store the cookie unless it is
// Secure, Path=/ and carries NO Domain attribute — so a hostile sibling
// station on evil.potacat.com cannot toss a Domain=potacat.com cookie
// into k3sbp.potacat.com's jar. Every station shares the parent domain.
const COOKIE_DEVICE = '__Host-echocat_device';
const COOKIE_PASS = '__Host-echocat_pass';

// Device tokens never expire (accountLinked → expiresAt:null); one year
// is the practical browser ceiling (Chrome caps Max-Age at 400 days).
const DEVICE_COOKIE_MAX_AGE_SEC = 365 * 24 * 3600;
// A pass cookie never outlives the pass and never exceeds a week.
const PASS_COOKIE_MAX_AGE_SEC = 7 * 24 * 3600;

// ?notice= values the connect page will render static copy for. Anything
// else is ignored — the page is a constant string, so an unknown notice
// can never echo attacker text.
const CONNECT_NOTICES = ['pass-ended', 'revoked', 'signed-out', 'link-expired'];

// Paths the SPA needs once a cookie has been honoured. Everything else
// over the tunnel stays behind the stub even WITH a valid cookie —
// /api/ptt/* in particular is a LAN-only local-trust shortcut and must
// never become reachable from the internet by way of a browser cookie.
const SPA_PATHS = new Set(['/', '/remote.html', '/remote.js', '/remote.css', '/cq-target.js', '/jtcat-parser.js']);

// Tunnel-open paths: reachable anonymously over the tunnel because each
// handler enforces its own credential (see the comment block above
// tunnelOpenPaths in remote-server.js for the history of every entry).
function isTunnelOpenPath(method, pathname) {
  const m = String(method || 'GET').toUpperCase();
  if (pathname === '/health') return true;
  if (m !== 'POST') return false;
  return pathname === '/api/pair'
    || pathname === '/api/pair-account'
    || pathname === '/api/pair-request'
    || pathname === '/api/pass-gate'
    || pathname === '/api/web-signout';
}

/** Parse a Cookie request header into {name: value}. First occurrence
 *  wins (browsers order the most specific cookie first). Values are
 *  percent-decoded when that succeeds and left alone otherwise. */
function parseCookieHeader(str) {
  const out = Object.create(null);
  if (typeof str !== 'string' || !str) return out;
  for (const part of str.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') value = value.slice(1, -1);
    try { value = decodeURIComponent(value); } catch { /* keep raw */ }
    out[name] = value;
  }
  return out;
}

/** Set-Cookie header value for a __Host- cookie. Value must be cookie-safe
 *  (device tokens are hex, pass cookies are `words-with-dashes.hex`). */
function buildSetCookie(name, value, opts = {}) {
  const maxAge = Math.max(0, Math.floor(Number(opts.maxAgeSec) || 0));
  const safe = encodeURIComponent(String(value == null ? '' : value));
  return `${name}=${safe}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

/** Set-Cookie header value that deletes the cookie. */
function buildClearCookie(name) {
  return `${name}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}

/** A paired device the WS token branch would accept right now. Mirrors
 *  the inline expiry check in _handleMessage: expiresAt null = never. */
function deviceIsLive(device, now) {
  if (!device || typeof device !== 'object' || !device.token) return false;
  if (device.expiresAt == null) return true;
  const t = Number(device.expiresAt);
  if (!Number.isFinite(t)) return true;
  return (typeof now === 'number' ? now : Date.now()) <= t;
}

/** Split a pass cookie value back into {code, sessionId}. The code is
 *  dash-joined lowercase words and never contains a dot; the session id
 *  is the 64-hex session_token from /redeem. null on any other shape. */
function parsePassCookie(value) {
  if (typeof value !== 'string') return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const code = value.slice(0, dot).toLowerCase();
  const sessionId = value.slice(dot + 1).toLowerCase();
  if (!/^[a-z]+(?:-[a-z]+){2,3}$/.test(code)) return null;
  if (!/^[a-f0-9]{64}$/.test(sessionId)) return null;
  return { code, sessionId };
}

/**
 * The HTTP decision.
 *
 * Returns one of:
 *   {action:'open'}                       — tunnel-open path; handler enforces its own credential
 *   {action:'serve', authMode, device?, pass?}
 *                                         — serve normally; inject authMode into the SPA
 *   {action:'connect-page', clearCookies} — anonymous tunnel GET / → the static sign-in page
 *   {action:'stub'}                       — every other anonymous tunnel path → 503 stub
 *
 * Non-tunnel requests (LAN / Tailscale / loopback) are byte-for-byte the
 * pre-cookie behaviour: serve, with requireToken ? 'token' : 'none'.
 */
function decideHttpGate(input) {
  const o = input || {};
  const method = String(o.method || 'GET').toUpperCase();
  const pathname = String(o.pathname || '/');
  const gated = !!(o.tunnelExposed && o.fromTunnel);

  if (isTunnelOpenPath(method, pathname)) return { action: 'open' };
  if (!gated) return { action: 'serve', authMode: o.requireToken ? 'token' : 'none' };

  const cookies = o.cookies || {};
  const now = typeof o.now === 'number' ? o.now : Date.now();
  const clearCookies = [];

  const devTok = cookies[COOKIE_DEVICE];
  if (devTok) {
    const device = typeof o.findDevice === 'function' ? o.findDevice(devTok) : null;
    if (deviceIsLive(device, now)) {
      if (!SPA_PATHS.has(pathname)) return { action: 'stub' };
      return { action: 'serve', authMode: 'cookie', device };
    }
    clearCookies.push(COOKIE_DEVICE);
  }

  const passVal = cookies[COOKIE_PASS];
  if (passVal) {
    const parsed = parsePassCookie(passVal);
    const session = parsed && typeof o.findPassSession === 'function' ? o.findPassSession(parsed.sessionId) : null;
    const live = parsed && session && session.code === parsed.code
      && (session.expiresAt == null || Number(session.expiresAt) > now);
    if (live) {
      if (!SPA_PATHS.has(pathname)) return { action: 'stub' };
      return { action: 'serve', authMode: 'cookie', pass: { code: parsed.code, sessionId: parsed.sessionId } };
    }
    clearCookies.push(COOKIE_PASS);
  }

  const isPage = (method === 'GET' || method === 'HEAD') && (pathname === '/' || pathname === '/remote.html');
  if (isPage) return { action: 'connect-page', clearCookies };
  return { action: 'stub' };
}

/** The WS decision — the same string decideHttpGate injects for the page
 *  the socket came from. `cookieAuth` = the upgrade carried a cookie that
 *  the server has ALREADY validated (device live, or pass session known). */
function wsAuthModeFor(input) {
  const o = input || {};
  const gated = !!(o.tunnelExposed && o.fromTunnel);
  if (gated) return o.cookieAuth ? 'cookie' : 'token';
  return o.requireToken ? 'token' : 'none';
}

/**
 * Cross-site check for cookie-authenticated requests. A browser attaches
 * the cookie to any WebSocket upgrade it opens — including one started by
 * a hostile page — so cookie auth is only honoured when the Origin is us.
 * No Origin at all is allowed (native clients and curl send none and
 * never carry a cookie either); `null` (sandboxed/opaque origin) and any
 * host mismatch are refused. cloudflared preserves the original Host
 * header (routes/cloud-tunnel.js ingress sets no httpHostHeader), so the
 * Host header is a trustworthy statement of which name we were dialled by.
 */
function originAllowed(originHeader, hostHeader, cloudHost) {
  if (originHeader == null || originHeader === '') return true;
  const origin = String(originHeader).trim();
  if (!origin || origin === 'null') return false;
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  const oHost = parsed.host.toLowerCase();
  if (!oHost) return false;
  const h = String(hostHeader || '').trim().toLowerCase();
  if (h && oHost === h) return true;
  const c = String(cloudHost || '').trim().toLowerCase();
  if (c && oHost === c) return true;
  return false;
}

/** "Browser on Chrome (Windows)" — the paired-device name for a browser
 *  sign-in, ≤60 chars (the renameDevice cap). Good enough to tell two
 *  browsers apart in Settings > ECHOCAT > My devices; never precise. */
function browserDeviceName(userAgent) {
  const ua = String(userAgent || '');
  let browser = 'Browser';
  if (/Edg(?:e|A|iOS)?\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/Firefox\/|FxiOS\//.test(ua)) browser = 'Firefox';
  else if (/CriOS\//.test(ua)) browser = 'Chrome';
  else if (/Chrome\/|Chromium\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  let os = '';
  if (/iPhone/.test(ua)) os = 'iPhone';
  else if (/iPad/.test(ua)) os = 'iPad';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/CrOS/.test(ua)) os = 'ChromeOS';
  else if (/Mac OS X|Macintosh/.test(ua)) os = 'Mac';
  else if (/Linux/.test(ua)) os = 'Linux';
  const name = `Browser on ${browser}` + (os ? ` (${os})` : '');
  return name.slice(0, 60);
}

/** The `#pair=<token>` / `#pass=<code>.<sessionId>` fragment login.potacat.com
 *  (or guest-pass.html) sends the browser back with. Fragments never reach
 *  the server or Cloudflare's logs; the connect page reads this and POSTs
 *  the credential itself. null for anything malformed. */
function parseStationFragment(hash) {
  let h = String(hash || '');
  if (h.startsWith('#')) h = h.slice(1);
  if (!h) return null;
  const eq = h.indexOf('=');
  if (eq <= 0) return null;
  const key = h.slice(0, eq);
  let val = h.slice(eq + 1);
  try { val = decodeURIComponent(val); } catch { return null; }
  if (key === 'pair') {
    const tok = val.toLowerCase();
    return /^[a-f0-9]{64}$/.test(tok) ? { pair: tok } : null;
  }
  if (key === 'pass') {
    const p = parsePassCookie(val);
    return p ? { pass: p } : null;
  }
  return null;
}

/**
 * Failure-tracked rate limiter for the tunnel-open POSTs. Mirrors the
 * cloud's rateLimitPasses (potacat-cloudlog routes/passes.js): burst cap
 * on raw activity, then escalating cooldowns keyed on FAILED responses
 * only, so a legitimate guest who fat-fingers is never locked out while a
 * scanner walking pass codes is. The cloud cannot do this for us — the
 * validate-session call it sees comes from the DESKTOP's IP, not the
 * visitor's — so the desktop keys on cf-connecting-ip itself.
 */
const RATE_WINDOW_MS = 3_600_000;
const BURST_PER_MIN = 30;
const TIERS = [
  { threshold: 100, cooldownMs: 86_400_000 },
  { threshold: 30, cooldownMs: 3_600_000 },
  { threshold: 10, cooldownMs: 300_000 },
];
const FAILURE_STATUSES = new Set([400, 401, 403, 404, 410, 429]);
const RATE_MAP_CAP = 10_000;

class FailureRateLimiter {
  constructor(opts = {}) {
    this._map = new Map();
    this._cap = opts.cap || RATE_MAP_CAP;
  }

  static keyFor(headers, remoteAddress) {
    const h = headers || {};
    const cf = h['cf-connecting-ip'];
    if (cf) return String(cf).split(',')[0].trim();
    return String(remoteAddress || 'unknown');
  }

  _state(key, now) {
    let s = this._map.get(key);
    if (!s) {
      if (this._map.size >= this._cap) this._evict(now);
      s = { hits: [], failures: [], cooldownUntil: 0, tierApplied: 0, lastSeen: now };
      this._map.set(key, s);
    }
    s.lastSeen = now;
    const cutoff = now - RATE_WINDOW_MS;
    while (s.failures.length && s.failures[0] < cutoff) s.failures.shift();
    const minAgo = now - 60_000;
    while (s.hits.length && s.hits[0] < minAgo) s.hits.shift();
    return s;
  }

  _evict(now) {
    // Drop the stalest entries first; a scanner cannot use this to shed
    // its own cooldown because cooling-down keys are evicted last.
    const entries = [...this._map.entries()]
      .sort((a, b) => (a[1].cooldownUntil > now) - (b[1].cooldownUntil > now) || a[1].lastSeen - b[1].lastSeen);
    const drop = Math.max(1, Math.floor(entries.length / 10));
    for (let i = 0; i < drop; i++) this._map.delete(entries[i][0]);
  }

  /** {allowed:true} or {allowed:false, retryAfterSec}. Counts the hit. */
  check(key, now = Date.now()) {
    const s = this._state(key, now);
    if (s.cooldownUntil > now) {
      return { allowed: false, retryAfterSec: Math.ceil((s.cooldownUntil - now) / 1000) };
    }
    if (s.hits.length >= BURST_PER_MIN) return { allowed: false, retryAfterSec: 60 };
    s.hits.push(now);
    return { allowed: true };
  }

  /** Record the response status for a checked request. Returns the
   *  cooldown applied (ms) or 0. */
  record(key, statusCode, now = Date.now()) {
    const s = this._state(key, now);
    const code = Number(statusCode);
    if (FAILURE_STATUSES.has(code)) {
      s.failures.push(now);
      const n = s.failures.length;
      for (const tier of TIERS) {
        if (n < tier.threshold) continue;
        // Escalate to a higher tier mid-cooldown; never re-apply the same one.
        if (s.cooldownUntil > now && s.tierApplied >= tier.threshold) return 0;
        s.cooldownUntil = now + tier.cooldownMs;
        s.tierApplied = tier.threshold;
        return tier.cooldownMs;
      }
      return 0;
    }
    if (code >= 200 && code < 300 && s.failures.length) {
      s.failures = s.failures.slice(Math.ceil(s.failures.length / 2));
    }
    return 0;
  }

  get size() { return this._map.size; }
}

/**
 * The anonymous connect page served for a tunnel GET / with no valid
 * cookie. ONE CONSTANT STRING — no template inputs, no concatenation, so
 * it cannot echo anything about this install (e696ad5's rule). The sign-in
 * and guest-pass links are built client-side from location.host; the
 * ?notice= query is matched against CONNECT_NOTICES for static copy; the
 * #pair= / #pass= fragment is stripped from history before the credential
 * is POSTed, and location.replace keeps it out of the back stack.
 */
function buildConnectPageHtml() {
  return CONNECT_PAGE_HTML;
}

const CONNECT_PAGE_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<meta name="robots" content="noindex, nofollow">',
  '<meta name="referrer" content="no-referrer">',
  '<title>ECHOCAT</title>',
  '<style>',
  '*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}',
  'html,body{height:100%}',
  "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#1a1a2e;color:#e2e8f0;display:flex;align-items:center;justify-content:center;padding:1.5rem;line-height:1.5;-webkit-font-smoothing:antialiased}",
  'main{width:100%;max-width:380px;background:#16213e;border:1px solid #2a2a4a;border-radius:12px;padding:1.75rem 1.5rem;text-align:center}',
  'h1{font-size:1.1rem;letter-spacing:.18em;color:#4fc3f7;font-weight:600;margin-bottom:.35rem}',
  '.sub{font-size:.8rem;color:#94a3b8;margin-bottom:1.5rem}',
  '.btn{display:block;width:100%;padding:.8rem 1rem;border-radius:8px;border:0;font-size:.95rem;font-weight:600;text-decoration:none;cursor:pointer;margin-bottom:.75rem}',
  '.btn-primary{background:#e94560;color:#fff}',
  '.btn-primary:hover{background:#d13a54}',
  '.btn-secondary{background:transparent;color:#4fc3f7;border:1px solid #2a2a4a}',
  '.btn-secondary:hover{border-color:#4fc3f7}',
  '.notice{font-size:.85rem;color:#fbbf24;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.3);border-radius:8px;padding:.6rem .8rem;margin-bottom:1rem}',
  '.error{font-size:.85rem;color:#f87171;background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.3);border-radius:8px;padding:.6rem .8rem;margin-bottom:1rem}',
  '.busy{font-size:.9rem;color:#94a3b8;padding:1rem 0}',
  '.foot{margin-top:1.25rem;font-size:.7rem;color:#64748b}',
  '.foot a{color:#64748b}',
  '[hidden]{display:none!important}',
  '</style>',
  '</head>',
  '<body>',
  '<main>',
  '<h1>ECHOCAT</h1>',
  '<p class="sub">Remote control for this POTACAT station</p>',
  '<div id="notice" class="notice" hidden></div>',
  '<div id="error" class="error" hidden></div>',
  '<div id="busy" class="busy" hidden>Signing you in&hellip;</div>',
  '<div id="actions">',
  '<a id="signin" class="btn btn-primary" href="#">Sign in with POTACAT Cloud</a>',
  '<a id="guest" class="btn btn-secondary" href="#">Have a Guest Pass?</a>',
  '</div>',
  '<p class="foot">Access is limited to the station owner and Guest Pass holders. <a href="https://potacat.com" rel="noreferrer">potacat.com</a></p>',
  '</main>',
  '<script>',
  '(function () {',
  "  'use strict';",
  '  var NOTICES = {',
  "    'pass-ended': 'Your Guest Pass session has ended.',",
  "    'revoked': 'This browser\\'s access was revoked by the station owner. Sign in again to continue.',",
  "    'signed-out': 'You were signed out of this station.',",
  "    'link-expired': 'That sign-in link expired. Sign in again to get a new one.'",
  '  };',
  '  var ERRORS = {',
  "    'token_expired': 'That sign-in link expired. Go back and try again.',",
  "    'token_used': 'That sign-in link was already used. Go back and try again.',",
  "    'account_mismatch': 'That station belongs to a different POTACAT Cloud account.',",
  "    'shack_mismatch': 'That sign-in link was issued for a different station.',",
  "    'owner_station_offline': 'The station is offline right now. Try again later.',",
  "    'pass_invalid': 'That Guest Pass is not valid for this station, has expired, or was revoked.',",
  "    'rate_limited': 'Too many attempts. Wait a minute and try again.'",
  '  };',
  '  var host = location.host;',
  '  var el = function (id) { return document.getElementById(id); };',
  "  el('signin').href = 'https://login.potacat.com/?station=' + encodeURIComponent(host);",
  "  el('guest').href = 'https://login.potacat.com/?guest=1&station=' + encodeURIComponent(host);",
  '',
  '  var params = new URLSearchParams(location.search);',
  "  var notice = params.get('notice');",
  '  if (notice && Object.prototype.hasOwnProperty.call(NOTICES, notice)) {',
  "    el('notice').textContent = NOTICES[notice];",
  "    el('notice').hidden = false;",
  '  }',
  '',
  '  function showError(code) {',
  "    el('busy').hidden = true;",
  "    el('actions').hidden = false;",
  "    el('error').textContent = Object.prototype.hasOwnProperty.call(ERRORS, code) ? ERRORS[code] : 'Sign-in failed. Go back and try again.';",
  "    el('error').hidden = false;",
  '  }',
  '',
  '  function redeem(path, body) {',
  "    el('actions').hidden = true;",
  "    el('notice').hidden = true;",
  "    el('busy').hidden = false;",
  '    fetch(path, {',
  "      method: 'POST',",
  "      credentials: 'same-origin',",
  "      headers: { 'Content-Type': 'application/json' },",
  '      body: JSON.stringify(body)',
  '    }).then(function (r) {',
  '      return r.json().catch(function () { return {}; }).then(function (j) {',
  "        if (r.ok && j && j.ok !== false) { location.replace('/'); return; }",
  "        showError((j && j.error) || (r.status === 429 ? 'rate_limited' : 'failed'));",
  '      });',
  "    }).catch(function () { showError('network'); });",
  '  }',
  '',
  "  var hash = location.hash || '';",
  '  if (hash.length > 1) {',
  '    // Strip the credential from the URL bar and history FIRST.',
  "    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}",
  "    var eq = hash.indexOf('=');",
  "    var key = eq > 1 ? hash.slice(1, eq) : '';",
  "    var val = eq > 1 ? decodeURIComponent(hash.slice(eq + 1)) : '';",
  "    if (key === 'pair' && /^[a-f0-9]{64}$/i.test(val)) {",
  "      redeem('/api/pair-account', { pairToken: val.toLowerCase(), web: true });",
  "    } else if (key === 'pass') {",
  "      var dot = val.lastIndexOf('.');",
  "      var code = dot > 0 ? val.slice(0, dot) : '';",
  "      var sid = dot > 0 ? val.slice(dot + 1) : '';",
  "      if (code && /^[a-f0-9]{64}$/i.test(sid)) redeem('/api/pass-gate', { passCode: code.toLowerCase(), sessionId: sid.toLowerCase() });",
  "      else showError('pass_invalid');",
  '    } else {',
  "      showError('link_invalid');",
  '    }',
  '  }',
  '})();',
  '</script>',
  '</body>',
  '</html>',
  '',
].join('\n');

module.exports = {
  COOKIE_DEVICE,
  COOKIE_PASS,
  DEVICE_COOKIE_MAX_AGE_SEC,
  PASS_COOKIE_MAX_AGE_SEC,
  CONNECT_NOTICES,
  SPA_PATHS,
  isTunnelOpenPath,
  parseCookieHeader,
  buildSetCookie,
  buildClearCookie,
  deviceIsLive,
  parsePassCookie,
  decideHttpGate,
  wsAuthModeFor,
  originAllowed,
  browserDeviceName,
  parseStationFragment,
  FailureRateLimiter,
  buildConnectPageHtml,
};
