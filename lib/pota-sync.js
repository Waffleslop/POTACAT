// POTA.app Sync — profile display only.
//
// History: this used to download a Parks Worked CSV from
// /user/stats/parks/csv and feed it into POTACAT's worked-parks list.
// That endpoint turned out to be IAM-authorized via AWS SigV4 — POTACAT's
// Cognito User Pool JWT can't authenticate against it, period. Multiple
// users (KD2TJU, WD4DAN, K3SBP) saw the same SigV4 error in the body
// after every connect. Implementing SigV4 client-side is doable but a
// real bear, and we don't actually need the CSV anymore: the
// worked-parks list is now harvested from the user's own QSO log
// (commit 689ef06), which is more accurate and faster anyway.
//
// So this module is now reduced to: sign in to pota.app, capture the
// callsign from the Cognito ID token, fetch the public profile-stats
// endpoint at /stats/user/<call> (no auth required at all), and
// display the resulting counts (parks hunted / activated, QSOs,
// awards, endorsements) in the Cloud settings panel. No scheduler,
// no auto-pull on QSO save, no CSV.
//
// The connect flow's webRequest hook + cookie capture is kept verbatim
// from the old design because it still gives us the JWT we need to
// extract the callsign label. We just stop trying to USE the JWT
// against any IAM-authorized endpoint.

const { net, session, BrowserWindow } = require('electron');
const { EventEmitter } = require('events');

const PARTITION = 'persist:pota-app';
const LOGIN_URL = 'https://pota.app/#/user/login';
// Public profile-stats endpoint. Returns a small JSON blob with hunter /
// activator counts. No Authorization header required — pota.app serves
// this with access-control-allow-origin:* so any client can hit it.
const PROFILE_URL_PREFIX = 'https://api.pota.app/stats/user/';

class PotaSync extends EventEmitter {
  constructor({ settings, onSettingsChange, logger }) {
    super();
    this._settings = settings;
    this._saveSettings = onSettingsChange || (() => {});
    this._log = logger || ((msg) => console.log('[pota-sync]', msg));
    this._syncing = false;
    this._lastError = null;
  }

  // --- State helpers ---------------------------------------------------------
  _state() {
    if (!this._settings.potaSync) this._settings.potaSync = {};
    return this._settings.potaSync;
  }

  status() {
    const s = this._state();
    return {
      connected: !!s.connectedAt,
      connectedAs: s.connectedAs || null,
      profile: s.profile || null,
      lastRefreshAt: s.lastPullAt || 0,
      lastError: this._lastError,
      syncing: this._syncing,
    };
  }

  _emitStatus() { this.emit('status', this.status()); }

  // --- Connect / disconnect --------------------------------------------------
  async connect() {
    return new Promise((resolve) => {
      let win;
      try {
        this._log('opening auth window → ' + LOGIN_URL);
        win = new BrowserWindow({
          width: 960, height: 760,
          title: 'Connect POTA.app',
          autoHideMenuBar: true,
          show: true,
          webPreferences: {
            partition: PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
      } catch (err) {
        this._log('BrowserWindow creation failed: ' + err.message);
        resolve({ ok: false, error: 'Could not open sign-in window: ' + err.message });
        return;
      }
      win.once('ready-to-show', () => win.show());
      win.webContents.once('did-fail-load', (_e, code, desc) => {
        this._log(`auth page did-fail-load ${code} ${desc}`);
      });

      // Intercept outgoing requests to api.pota.app and capture the Bearer
      // token from the Authorization header. This works regardless of where
      // pota.app's SPA stores the JWT internally — Amplify v6 defaults to
      // memory-only storage, so localStorage/sessionStorage scans miss it
      // entirely. Capturing the actual API call's auth header is bulletproof.
      // First captured token wins for the session; we just check the closure
      // when the window closes.
      try {
        const reqSession = win.webContents.session;
        // Widened from api.pota.app/* to all pota.app subdomains + Cognito +
        // AWS API Gateway hosts. KD2TJU's log showed the api.pota.app filter
        // never firing — likely because the SPA uses a different host (or
        // pota.app/api/* on its own origin) for profile data on first login.
        // We also log every URL we see Authorization on, so a missing capture
        // tells us exactly which host we need to add to the filter next time.
        const _seenAuthUrls = new Set();
        reqSession.webRequest.onBeforeSendHeaders(
          { urls: [
            // Electron's webRequest only allows '*' as a leading host
            // wildcard — anything more rigid (e.g. *.execute-api.*.aws...)
            // throws "Invalid host wildcard" and tanks the whole filter
            // registration. Keep these strictly subdomain-or-exact form.
            '*://*.pota.app/*',
            '*://pota.app/*',
            '*://*.amazoncognito.com/*',
            '*://*.amazonaws.com/*',
          ] },
          (details, callback) => {
            try {
              const headers = details.requestHeaders || {};
              const auth = headers.Authorization || headers.authorization;
              // pota.app's SPA sends the JWT in the Authorization header
              // WITHOUT a "Bearer " prefix (WD4DAN log) — match either form.
              const m = auth && auth.match(/^(?:Bearer\s+)?(eyJ[\w-]+\.[\w-]+\.[\w-]+)$/i);
              if (m) {
                if (!this._liveHarvest) {
                  const hadBearer = /^Bearer\s/i.test(auth);
                  this._liveHarvest = {
                    token: m[1],
                    source: 'webRequest header on ' + (details.url.split('?')[0] || details.url),
                    sendBearerPrefix: hadBearer, // mirror what the SPA sent
                  };
                  this._log(`captured ${hadBearer ? 'Bearer' : 'raw'} JWT from ${details.url.split('?')[0]}`);
                }
              } else if (auth) {
                const host = details.url.split('/').slice(0, 3).join('/');
                if (!_seenAuthUrls.has(host)) {
                  _seenAuthUrls.add(host);
                  this._log(`saw auth-scheme "${auth.split(' ')[0]}" on ${host} — not JWT, skipping`);
                }
              }
            } catch {}
            callback({ requestHeaders: details.requestHeaders });
          }
        );
      } catch (err) {
        this._log('webRequest hook failed: ' + err.message);
      }

      win.loadURL(LOGIN_URL).catch((err) => {
        this._log('loadURL rejected: ' + err.message);
      });
      // Auto-close once pota.app navigates away from the login route. Without
      // this the user signs in, sees their dashboard in the popup, and POTACAT
      // sits in "Signing in…" forever because connect() is awaiting the
      // window's 'closed' event. The 1.5s delay lets the SPA finish writing
      // the JWT into localStorage before we tear the window down.
      //
      // pota.app uses AWS Cognito for SSO, so after the user clicks "Sign in"
      // the browser redirects to parksontheair.auth.us-east-2.amazoncognito.com
      // with a redirect_uri query param that contains "pota.app" URL-encoded.
      // An earlier substring match on /pota\.app/ matched that query param and
      // closed the window before the user could even type their password
      // (KD2TJU report). Now we parse the URL and look at HOSTNAME and HASH
      // explicitly — auto-close only fires when we're actually back on
      // pota.app at a route that isn't /user/login.
      let loginDetected = false;
      const maybeAutoClose = () => {
        if (loginDetected) return;
        try {
          if (!win || win.isDestroyed()) return;
          const url = (win.webContents && win.webContents.getURL()) || '';
          let parsed;
          try { parsed = new URL(url); } catch { return; }
          if (parsed.hostname.toLowerCase() !== 'pota.app') return; // SSO provider, leave alone
          // pota.app is a hash-routed SPA: /#/user/login. The "logged in"
          // state is anything else under pota.app.
          if (/\/user\/login/i.test(parsed.hash)) return;
          // OAuth callback in progress — pota.app/?code=xxx means the SPA
          // hasn't yet exchanged the authorization code for tokens. WD4DAN
          // hit this: we triggered loginDetected on the callback URL, ran
          // the harvest 2.5s later, found nothing because the SPA was
          // still mid-exchange. Wait for the SPA's own redirect to its
          // post-login route (typically /#/profile/<call>) before firing.
          if (/[?&]code=/.test(url)) return;
          loginDetected = true;
          // Harvest tokens from the LIVE login window before closing. We
          // can't do this from a fresh hidden window post-close because:
          //  - sessionStorage doesn't persist to a new window (per-tab),
          //    and Cognito SDKs sometimes default to it instead of LS.
          //  - SPAs that bootstrap auth lazily may not re-run the token
          //    exchange when a fresh tab opens without the ?code= param.
          // Hence: scan THIS window's storage now, stash on `this`, and
          // _probeSession picks it up. The hidden-window fallback in
          // _harvestToken stays for the case where this code path didn't
          // run (e.g., user closed the window manually).
          this._log(`login complete — URL is ${url}; harvesting tokens then closing in 4s`);
          // Trigger an authenticated API call from the SPA's own JS context
          // RIGHT AWAY. If pota.app's Amplify setup attaches a Bearer header
          // to outbound fetches via interceptors (the typical pattern even
          // with memory-only storage), our webRequest hook on api.pota.app
          // will capture the header on the way out — without ever needing
          // to read the token from any storage. Fire-and-forget; the
          // response body doesn't matter, only the request headers.
          setTimeout(() => {
            try {
              if (win && !win.isDestroyed()) {
                win.webContents.executeJavaScript(
                  `fetch('https://api.pota.app/user/stats/parks/csv', { credentials: 'include' }).catch(() => {})`
                ).catch(() => {});
              }
            } catch {}
          }, 800);
          setTimeout(async () => {
            try {
              if (!win || win.isDestroyed()) return;
              // Scan localStorage / sessionStorage (Web Storage), AND look
              // for tokens in any IndexedDB databases (Amplify v6 sometimes
              // uses these), AND ask Amplify directly via fetchAuthSession
              // if its globals are exposed. KD2TJU's storage scan came back
              // with only `cookie:accepted` in localStorage — no JWT
              // anywhere — so we want every avenue covered. Truncated
              // values get logged so we can see what's actually in storage
              // even when nothing JWT-shaped is found.
              const raw = await win.webContents.executeJavaScript(`
                (async () => {
                  const out = { ls: {}, ss: {}, idb: {}, amplify: null, error: null };
                  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out.ls[k] = localStorage.getItem(k); } } catch (e) { out.error = 'ls: ' + e.message; }
                  try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); out.ss[k] = sessionStorage.getItem(k); } } catch (e) { out.error = (out.error || '') + ' ss: ' + e.message; }
                  // IndexedDB scan — best-effort, walks every database / object store and
                  // dumps string-shaped values up to 4000 chars each.
                  try {
                    if (typeof indexedDB.databases === 'function') {
                      const dbs = await indexedDB.databases();
                      for (const dbInfo of dbs) {
                        if (!dbInfo.name) continue;
                        try {
                          const db = await new Promise((res, rej) => {
                            const r = indexedDB.open(dbInfo.name);
                            r.onsuccess = () => res(r.result);
                            r.onerror = () => rej(r.error);
                          });
                          for (const storeName of Array.from(db.objectStoreNames)) {
                            try {
                              const tx = db.transaction(storeName, 'readonly');
                              const store = tx.objectStore(storeName);
                              const all = await new Promise((res, rej) => {
                                const r = store.getAll();
                                r.onsuccess = () => res(r.result);
                                r.onerror = () => rej(r.error);
                              });
                              const flat = JSON.stringify(all).slice(0, 4000);
                              out.idb[dbInfo.name + '/' + storeName] = flat;
                            } catch (e) {}
                          }
                          db.close();
                        } catch (e) {}
                      }
                    }
                  } catch (e) {}
                  // Try Amplify v6 (fetchAuthSession) and v5 (Auth.currentSession)
                  // if pota.app exposes them globally.
                  try {
                    if (typeof window.fetchAuthSession === 'function') {
                      const s = await window.fetchAuthSession();
                      out.amplify = (s && s.tokens && (s.tokens.idToken && s.tokens.idToken.toString())) || null;
                    } else if (window.Auth && typeof window.Auth.currentSession === 'function') {
                      const s = await window.Auth.currentSession();
                      out.amplify = s && s.getIdToken && s.getIdToken().getJwtToken() || null;
                    }
                  } catch (e) {}
                  return JSON.stringify(out);
                })()
              `);
              const stores = JSON.parse(raw || '{}');
              const lsKeys = Object.keys(stores.ls || {});
              const ssKeys = Object.keys(stores.ss || {});
              const idbKeys = Object.keys(stores.idb || {});
              this._log(`live-window storage scan: localStorage=${lsKeys.length} [${lsKeys.join(', ')}], sessionStorage=${ssKeys.length} [${ssKeys.join(', ')}], indexedDB stores=${idbKeys.length} [${idbKeys.join(', ')}]${stores.amplify ? ', amplify=yes' : ''}`);
              // Diagnostic: log first 80 chars of every storage value so we
              // can see what pota.app is actually putting where.
              for (const [k, v] of Object.entries(stores.ls || {})) this._log(`  ls["${k}"] = ${String(v).slice(0, 80)}${String(v).length > 80 ? '…' : ''}`);
              for (const [k, v] of Object.entries(stores.ss || {})) this._log(`  ss["${k}"] = ${String(v).slice(0, 80)}${String(v).length > 80 ? '…' : ''}`);
              for (const [k, v] of Object.entries(stores.idb || {})) this._log(`  idb["${k}"] = ${String(v).slice(0, 200)}${String(v).length > 200 ? '…' : ''}`);
              // First match wins: amplify direct → ls → ss → idb.
              let found = stores.amplify && /^eyJ/.test(stores.amplify) ? { token: stores.amplify, key: 'fetchAuthSession()' } : {};
              let sourceLabel = 'Amplify';
              if (!found.token) { found = this._findJwt(stores.ls || {}); sourceLabel = 'localStorage'; }
              if (!found.token) { found = this._findJwt(stores.ss || {}); sourceLabel = 'sessionStorage'; }
              if (!found.token) { found = this._findJwt(stores.idb || {}); sourceLabel = 'indexedDB'; }
              if (found.token) {
                this._liveHarvest = { token: found.token, source: `${sourceLabel}["${found.key}"]` };
                this._log(`live-window harvest captured token from ${sourceLabel}["${found.key}"]`);
              } else {
                this._log('live-window harvest: no JWT in localStorage / sessionStorage / IndexedDB / Amplify globals');
              }
              // Cookie scan — pota.app is configured with amazon-cognito-
              // identity-js's CookieStorage, so the JWTs land here as plain
              // (not HttpOnly) cookies named like
              //   CognitoIdentityServiceProvider.<clientId>.<userId>.idToken
              // We can read them straight from the partition session and
              // skip every other harvest path entirely.
              try {
                const ses = session.fromPartition(PARTITION);
                const cookies = await ses.cookies.get({ domain: 'pota.app' });
                const names = (cookies || []).map(c => c.name);
                this._log(`pota.app cookies: ${names.length} [${names.join(', ')}]`);
                if (!this._liveHarvest) {
                  // Prefer idToken (carries username/callsign claims), then
                  // accessToken as a fallback. Cognito client ID + user UUID
                  // vary so we match by suffix.
                  const idTokenCookie = (cookies || []).find(c => /^CognitoIdentityServiceProvider\..+\..+\.idToken$/.test(c.name));
                  const accessTokenCookie = (cookies || []).find(c => /^CognitoIdentityServiceProvider\..+\..+\.accessToken$/.test(c.name));
                  const cookieToken = (idTokenCookie && idTokenCookie.value) || (accessTokenCookie && accessTokenCookie.value);
                  if (cookieToken && /^eyJ[\w-]+\.[\w-]+\.[\w-]+/.test(cookieToken)) {
                    const which = idTokenCookie ? 'idToken' : 'accessToken';
                    this._liveHarvest = { token: cookieToken, source: `cookie ${which}` };
                    this._log(`captured bearer token from Cognito ${which} cookie`);
                  }
                }
              } catch {}
            } catch (err) {
              this._log(`live-window harvest failed: ${err.message}`);
            }
            try { if (win && !win.isDestroyed()) win.close(); } catch {}
          }, 4000);
        } catch {}
      };
      win.webContents.on('did-navigate', maybeAutoClose);
      win.webContents.on('did-navigate-in-page', maybeAutoClose);
      let resolved = false;
      win.on('closed', async () => {
        if (resolved) return;
        resolved = true;
        const probe = await this._probeSession();
        if (!probe.ok) { resolve({ ok: false, error: probe.error }); return; }
        const s = this._state();
        s.connectedAt = Date.now();
        s.connectedAs = probe.callsign || 'POTA.app user';
        await this._saveSettings();
        this._emitStatus();
        this._log(`connected as ${s.connectedAs}`);
        const pull = await this.pull();
        resolve({ ok: true, pullOk: pull.ok, pullError: pull.error, count: pull.count });
      });
    });
  }

  async disconnect() {
    try {
      const ses = session.fromPartition(PARTITION);
      // Clear every storage type so Cognito's SSO state on
      // auth.<region>.amazoncognito.com is wiped too — otherwise the next
      // Connect bounces straight through SSO and re-issues from the same
      // Cognito session, which can re-mint a token tied to whatever stale
      // state we were trying to escape.
      await ses.clearStorageData({
        storages: ['cookies', 'localstorage', 'sessionstorage', 'indexdb', 'cachestorage'],
      });
      const remaining = await ses.cookies.get({});
      this._log(`disconnect: partition cleared; ${remaining.length} cookies remain`);
    } catch (err) {
      this._log('disconnect clear-cookies failed: ' + err.message);
    }
    const s = this._state();
    delete s.connectedAt;
    delete s.connectedAs;
    delete s.profile;
    delete s.lastPullAt;
    // Legacy fields from previous designs — no longer written, but
    // deleted on disconnect to scrub from upgrading users' disk state.
    delete s.bearerToken;
    delete s.bearerTokenSource;
    delete s.bearerSendPrefix;
    delete s.lastPullCount;
    delete s.enabled;
    delete s.intervalMin;
    delete s.csvUrl;
    s.enabled = false;
    this.stop();
    await this._saveSettings();
    this._lastError = null;
    this._emitStatus();
  }

  async _probeSession() {
    // The partition cookies are now the single source of truth for the API
    // token. Earlier versions snapshotted the JWT into settings.bearerToken
    // at connect time and replayed it forever — which is why pulls 403'd
    // an hour later when the JWT expired. Now we just verify the cookies
    // exist; every subsequent _fetchText reads them fresh and refreshes
    // via the Cognito refresh-token flow when the id token nears expiry.
    this._liveHarvest = null; // diagnostic-only, no longer load-bearing
    try {
      const cookies = await this._readCognitoCookies();
      if (!cookies || !cookies.idToken) {
        return {
          ok: false,
          error: 'Signed into POTA.app, but POTACAT could not read the API token from your session cookies. Please try Connect again — if it keeps failing, the pota.app login flow may have changed.'
        };
      }
      const exp = this._jwtExp(cookies.idToken);
      const ttl = exp ? exp - Math.floor(Date.now() / 1000) : 0;
      const cidShort = (cookies.clientId || '').slice(0, 6);
      this._log(`probe: idToken ttl=${ttl}s, hasRefresh=${!!cookies.refreshToken}, clientId=${cidShort}…`);
      if (!cookies.refreshToken) {
        this._log('probe warning: no refreshToken cookie — token cannot be auto-refreshed, will need manual Reconnect at expiry');
      }
      const label = this._decodeJwtLabel(cookies.idToken);
      return { ok: true, callsign: label || null };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // Scan localStorage for a JWT-shaped value (direct string, or nested one
  // level inside a JSON blob like {"token":"eyJ..."} or {"accessToken":"eyJ..."}).
  _findJwt(store) {
    const isJwt = (v) => typeof v === 'string' && /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v);
    for (const [k, v] of Object.entries(store)) {
      if (isJwt(v)) return { token: v, key: k };
      try {
        const parsed = JSON.parse(v);
        if (parsed && typeof parsed === 'object') {
          for (const field of ['token', 'accessToken', 'idToken', 'jwt', 'authToken']) {
            if (isJwt(parsed[field])) return { token: parsed[field], key: `${k}.${field}` };
          }
        }
      } catch {}
    }
    return {};
  }

  _decodeJwtLabel(token) {
    const claims = this._decodeJwtClaims(token);
    // pota.app's id token includes "pota:callsign" and "pota:fullname" as
    // custom Cognito attributes — prefer those over cognito:username
    // (which is just the user UUID). WD4DAN saw "Signed in as
    // be2176c0-606d-491e-93f3-adfd699a04b3" instead of "WD4DAN" because
    // the prior decoder fell through to the UUID.
    return claims['pota:callsign'] ||
           claims.callsign ||
           claims['pota:fullname'] ||
           claims.username ||
           claims.email ||
           claims['cognito:username'] ||
           null;
  }

  _decodeJwtClaims(token) {
    try {
      const part = (token || '').split('.')[1] || '';
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    } catch { return {}; }
  }

  _jwtExp(token) {
    const exp = this._decodeJwtClaims(token).exp;
    return typeof exp === 'number' ? exp : 0;
  }

  // 60s skew so we refresh before AWS API Gateway can reject as expired.
  _isExpiringSoon(token, skewSec = 60) {
    const exp = this._jwtExp(token);
    if (!exp) return true;
    return Math.floor(Date.now() / 1000) + skewSec >= exp;
  }

  // Cognito issuer claim looks like
  //   https://cognito-idp.us-east-2.amazonaws.com/<userPoolId>
  // Extracting the region from there avoids hardcoding pota.app's region —
  // if AWS ever moves the user pool, we'll follow without a code change.
  _regionFromIssuer(token) {
    const m = (this._decodeJwtClaims(token).iss || '').match(/cognito-idp\.([\w-]+)\.amazonaws\.com/);
    return m ? m[1] : 'us-east-2';
  }

  // Read the current Cognito token cookies from the partition. pota.app is
  // configured with amazon-cognito-identity-js's CookieStorage, so the JWTs
  // and refresh token live at well-known cookie names of the form
  //   CognitoIdentityServiceProvider.<clientId>.<userId>.{idToken,refreshToken}
  // The clientId/userId are baked into the cookie name, so we parse them
  // out for the refresh-token API call.
  async _readCognitoCookies() {
    const ses = session.fromPartition(PARTITION);
    const cookies = await ses.cookies.get({});
    const idCookie = (cookies || []).find(c => /^CognitoIdentityServiceProvider\.[^.]+\.[^.]+\.idToken$/.test(c.name));
    if (!idCookie) return null;
    const parts = idCookie.name.split('.');
    const clientId = parts[1];
    const userId = parts[2];
    const refreshCookie = (cookies || []).find(c => c.name === `CognitoIdentityServiceProvider.${clientId}.${userId}.refreshToken`);
    return {
      idToken: idCookie.value,
      refreshToken: refreshCookie ? refreshCookie.value : null,
      clientId, userId,
      idCookie, refreshCookie,
    };
  }

  // POST to Cognito's InitiateAuth with REFRESH_TOKEN_AUTH. On success returns
  // a fresh IdToken (and AccessToken); the refresh token itself does NOT
  // rotate in this flow, so we can keep using the same one until the user
  // signs out or Cognito invalidates it (typically 30 days idle).
  async _refreshIdToken({ refreshToken, clientId, region }) {
    return new Promise((resolve, reject) => {
      const req = net.request({
        method: 'POST',
        url: `https://cognito-idp.${region}.amazonaws.com/`,
      });
      req.setHeader('Content-Type', 'application/x-amz-json-1.1');
      req.setHeader('X-Amz-Target', 'AWSCognitoIdentityProviderService.InitiateAuth');
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Cognito refresh HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          }
          try {
            const json = JSON.parse(body);
            const auth = json.AuthenticationResult || {};
            if (!auth.IdToken) return reject(new Error('Cognito refresh: no IdToken in response'));
            resolve({
              idToken: auth.IdToken,
              accessToken: auth.AccessToken || null,
              expiresIn: auth.ExpiresIn || 3600,
            });
          } catch (e) {
            reject(new Error('Cognito refresh: malformed response: ' + e.message));
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.write(JSON.stringify({
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: clientId,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
      }));
      req.end();
    });
  }

  // Write a refreshed id token back to its cookie so the SPA also picks up
  // the rotation if the user re-opens the login window. Preserves the
  // original cookie's domain/path/secure/httpOnly attributes.
  async _writeIdTokenCookie(existingCookie, newValue, expiresIn) {
    try {
      const ses = session.fromPartition(PARTITION);
      const domain = (existingCookie.domain || '').replace(/^\./, '');
      const proto = existingCookie.secure ? 'https://' : 'http://';
      const url = proto + domain + (existingCookie.path || '/');
      const setOpts = {
        url,
        name: existingCookie.name,
        value: newValue,
        path: existingCookie.path || '/',
        secure: !!existingCookie.secure,
        httpOnly: !!existingCookie.httpOnly,
      };
      if (existingCookie.domain) setOpts.domain = existingCookie.domain;
      if (!existingCookie.session) {
        setOpts.expirationDate = Math.floor(Date.now() / 1000) + (expiresIn || 3600);
      }
      if (existingCookie.sameSite) setOpts.sameSite = existingCookie.sameSite;
      await ses.cookies.set(setOpts);
    } catch (err) {
      this._log('cookie write-back failed: ' + err.message);
    }
  }

  // Returns a fresh id token usable for an API call. Reads the current id
  // token from cookies; if it's within 60s of expiry (or forceRefresh is
  // set), exchanges the refresh token for a new one and writes it back to
  // the cookie. The returned token always reflects what was used.
  async _getActiveToken({ forceRefresh = false } = {}) {
    const cookies = await this._readCognitoCookies();
    if (!cookies || !cookies.idToken) {
      throw new Error('No POTA.app session token in cookies. Reconnect to sign in again.');
    }
    let idToken = cookies.idToken;
    let source = 'cookie';
    const expiring = forceRefresh || this._isExpiringSoon(idToken);
    if (expiring) {
      if (!cookies.refreshToken) {
        this._log('token expiring but no refresh-token cookie — sending stale token, expect 401/403');
      } else {
        const region = this._regionFromIssuer(idToken);
        const cidShort = (cookies.clientId || '').slice(0, 6);
        this._log(`refreshing id token (region=${region}, clientId=${cidShort}…, forced=${forceRefresh})`);
        try {
          const r = await this._refreshIdToken({
            refreshToken: cookies.refreshToken,
            clientId: cookies.clientId,
            region,
          });
          idToken = r.idToken;
          await this._writeIdTokenCookie(cookies.idCookie, idToken, r.expiresIn);
          source = forceRefresh ? 'refreshed-forced' : 'refreshed';
        } catch (err) {
          this._log('refresh failed: ' + err.message);
          // Fall through with the (likely-expired) token; the API call will
          // 403 and the caller can decide to surface "please reconnect".
          source = 'stale';
        }
      }
    }
    const exp = this._jwtExp(idToken);
    const ttl = exp ? exp - Math.floor(Date.now() / 1000) : 0;
    const expIso = exp ? new Date(exp * 1000).toISOString() : 'unknown';
    this._log(`active token: source=${source}, exp=${expIso}, ttl=${ttl}s`);
    return { token: idToken, source, ttl };
  }

  // --- Profile fetch ---------------------------------------------------------
  // Fetch the public profile-stats JSON for the connected callsign.
  // No auth header — pota.app serves this with access-control-allow-origin:*
  // and no Cognito gating (verified against /stats/user/K3SBP and
  // /stats/user/K0BUF, returns the same shape for either as an
  // anonymous fetch). Therefore we don't need the JWT, the cookies,
  // the Cognito refresh-token dance, or any of the auth machinery
  // that the CSV endpoint required. Sign-in is still useful — it's
  // how we get the callsign to substitute into the URL — but the
  // network call itself is plain HTTPS GET.
  //
  // pull() name retained for IPC compatibility (renderer + main both
  // call it). Internally it's a profile refresh, not a CSV download.
  async pull() {
    if (this._syncing) return { ok: false, error: 'Profile refresh already in progress' };
    const s = this._state();
    if (!s.connectedAt) return { ok: false, error: 'Not connected to POTA.app' };
    const callsign = (s.connectedAs || '').toUpperCase().trim();
    if (!callsign || !/^[A-Z0-9/]+$/.test(callsign)) {
      return { ok: false, error: 'Could not read your callsign from the POTA.app sign-in. Disconnect and reconnect.' };
    }
    this._syncing = true;
    this._emitStatus();
    try {
      const url = PROFILE_URL_PREFIX + encodeURIComponent(callsign);
      this._log('refreshing profile: ' + url);
      const body = await this._fetchText(url);
      let profile;
      try { profile = JSON.parse(body); }
      catch { throw new Error('POTA.app profile response was not JSON.'); }
      s.profile = profile;
      s.lastPullAt = Date.now();
      this._lastError = null;
      await this._saveSettings();
      const h = profile && profile.hunter || {};
      const a = profile && profile.activator || {};
      this._log(`profile: hunter parks=${h.parks ?? '?'} qsos=${h.qsos ?? '?'}, activator parks=${a.parks ?? '?'} qsos=${a.qsos ?? '?'}`);
      return { ok: true, profile };
    } catch (err) {
      this._lastError = err.message || String(err);
      this._log('refresh failed: ' + this._lastError);
      return { ok: false, error: this._lastError };
    } finally {
      this._syncing = false;
      this._emitStatus();
    }
  }

  // Plain HTTPS GET — no auth, no cookies, no token dance. Public endpoint.
  _fetchText(url) {
    return new Promise((resolve, reject) => {
      const req = net.request({ method: 'GET', url });
      req.setHeader('Accept', 'application/json');
      req.setHeader('Referer', 'https://pota.app/');
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const snippet = Buffer.concat(chunks).toString('utf8').slice(0, 200).replace(/\s+/g, ' ').trim();
            if (snippet) this._log(`response body: ${snippet}`);
            // Don't tell users to "reconnect" — this is a public endpoint
            // and reconnecting won't change a 4xx/5xx outcome. Just say
            // it's unavailable; the local QSO log already handles
            // worked-parks detection regardless.
            reject(new Error(`POTA.app profile unavailable (HTTP ${res.statusCode}). POTACAT is still tracking worked parks from your local log.`));
            return;
          }
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  }

  // --- Compatibility shims ---------------------------------------------------
  // Old API surface kept as no-ops so nothing else has to change. Auto-sync
  // is gone (the old data path was the CSV download, which we no longer
  // attempt — the local QSO log is the authoritative worked-parks source).
  // start/stop/noteQsoLogged/setEnabled/setIntervalMin are all retained
  // so existing IPC and lifecycle hooks keep working without renaming.
  start() { /* scheduler removed — no auto-pull */ }
  stop() { /* nothing to clean up */ }
  noteQsoLogged() { /* worked-parks now comes from local log; no API trigger needed */ }
  async shutdown() { /* nothing to flush */ }
  async setEnabled() { /* deprecated — no-op kept for IPC compatibility */ }
  async setIntervalMin() { /* deprecated — no-op kept for IPC compatibility */ }
}

module.exports = { PotaSync, PARTITION, LOGIN_URL };
