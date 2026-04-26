// POTA.app Sync — bidirectional sync (phase 1: parks-worked CSV pull only).
//
// Auth is an Electron session partition (`persist:pota-app`). The user signs
// into pota.app once in a child BrowserWindow we open; from then on, cookies
// in that partition are reused by `net.request({ session, useSessionCookies })`
// so we can download their Parks Worked CSV without ever handling credentials.
//
// The URL that serves the CSV is captured in DEFAULT_CSV_URL below. If pota.app
// moves it, the user can override via `settings.potaSync.csvUrl` without code
// changes. When pota.app eventually ships OAuth/SSO, the only thing that needs
// to change is the connect flow — the fetcher already goes through a standard
// session so swapping in `Authorization: Bearer …` would be a couple of lines.

const { net, session, BrowserWindow, app } = require('electron');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { parsePotaParksCSV } = require('./pota-parks');

const PARTITION = 'persist:pota-app';
const LOGIN_URL = 'https://pota.app/#/user/login';
// Best-known endpoint for the "My Stats → Parks Worked" CSV export. Pinned as
// a default so it can be overridden by `settings.potaSync.csvUrl` if pota.app
// changes paths.
const DEFAULT_CSV_URL = 'https://api.pota.app/user/stats/parks/csv';
// Debounce after a QSO save before a sync is triggered — collapses activation
// bursts into one fetch.
const QSO_DEBOUNCE_MS = 90_000;

class PotaSync extends EventEmitter {
  constructor({ settings, onSettingsChange, onParksUpdated, logger }) {
    super();
    this._settings = settings;
    this._saveSettings = onSettingsChange || (() => {});
    this._onParksUpdated = onParksUpdated || (() => {});
    this._log = logger || ((msg) => console.log('[pota-sync]', msg));
    this._timer = null;
    this._qsoTimer = null;
    this._qsoPending = false;
    this._syncing = false;
    this._lastError = null;
    this._lastCount = 0;
  }

  // --- State helpers ---------------------------------------------------------
  _state() {
    if (!this._settings.potaSync) this._settings.potaSync = {};
    return this._settings.potaSync;
  }

  status() {
    const s = this._state();
    return {
      enabled: !!s.enabled,
      connected: !!s.connectedAt,
      connectedAs: s.connectedAs || null,
      intervalMin: s.intervalMin || 60,
      lastPullAt: s.lastPullAt || 0,
      lastCount: s.lastPullCount || this._lastCount || 0,
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
            '*://*.pota.app/*',
            '*://pota.app/*',
            '*://*.amazoncognito.com/*',
            '*://*.amazonaws.com/*',
            '*://*.execute-api.*.amazonaws.com/*',
          ] },
          (details, callback) => {
            try {
              const headers = details.requestHeaders || {};
              const auth = headers.Authorization || headers.authorization;
              if (auth && /^Bearer eyJ[\w-]+\.[\w-]+\.[\w-]+/i.test(auth)) {
                if (!this._liveHarvest) {
                  this._liveHarvest = {
                    token: auth.replace(/^Bearer /i, ''),
                    source: 'webRequest header on ' + (details.url.split('?')[0] || details.url),
                  };
                  this._log(`captured bearer token from ${details.url.split('?')[0]}`);
                }
              } else if (auth) {
                // Some non-Bearer auth scheme — log it once so we know the
                // SPA is making auth'd requests and we just don't recognize
                // the format yet.
                const host = details.url.split('/').slice(0, 3).join('/');
                if (!_seenAuthUrls.has(host)) {
                  _seenAuthUrls.add(host);
                  this._log(`saw auth-scheme "${auth.split(' ')[0]}" on ${host} — not Bearer JWT, skipping`);
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
          this._log(`login complete — URL is ${url}; harvesting tokens then closing in 2.5s`);
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
              // Also list any cookies on pota.app — diagnostic only, since
              // cognito tokens are usually HttpOnly so we won't read them
              // here, but seeing the cookie names helps narrow the auth path.
              try {
                const ses = session.fromPartition(PARTITION);
                const cookies = await ses.cookies.get({ domain: 'pota.app' });
                const names = (cookies || []).map(c => c.name);
                this._log(`pota.app cookies: ${names.length} [${names.join(', ')}]`);
              } catch {}
            } catch (err) {
              this._log(`live-window harvest failed: ${err.message}`);
            }
            try { if (win && !win.isDestroyed()) win.close(); } catch {}
          }, 2500);
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
      await ses.clearStorageData({ storages: ['cookies'] });
    } catch (err) {
      this._log('disconnect clear-cookies failed: ' + err.message);
    }
    const s = this._state();
    delete s.connectedAt;
    delete s.connectedAs;
    delete s.bearerToken;
    delete s.bearerTokenSource;
    s.enabled = false;
    this.stop();
    await this._saveSettings();
    this._lastError = null;
    this._emitStatus();
  }

  async _probeSession() {
    try {
      const ses = session.fromPartition(PARTITION);
      const cookies = await ses.cookies.get({ domain: 'pota.app' });
      if (!cookies || cookies.length === 0) {
        return { ok: false, error: 'No POTA.app session cookies captured — did you finish signing in?' };
      }
      // Prefer the token harvested from the live login window (set by the
      // auto-close path in connect()). It can see sessionStorage and runs
      // before the SPA tab is destroyed — both critical when pota.app's
      // Cognito-driven auth doesn't put tokens in localStorage.
      const liveHarvest = this._liveHarvest;
      this._liveHarvest = null;
      let harvest;
      if (liveHarvest && liveHarvest.token) {
        harvest = { token: liveHarvest.token, key: liveHarvest.source };
      } else {
        // Fallback: spin up a hidden window and scan that partition's
        // localStorage. Works when the SPA stores in localStorage and the
        // user closed the visible login window before the live harvest
        // could run.
        harvest = await this._harvestToken();
      }
      if (!harvest.token) {
        // Without the bearer token any pull is going to 403. Treat the connect
        // as failed instead of marking the user "connected" and then erroring
        // out the first sync — the prior behavior left users stuck looking at
        // a 403 telling them to Reconnect, which they had just done.
        if (harvest.error) this._log('token harvest: ' + harvest.error);
        const why = harvest.error ? ' (' + harvest.error + ')' : '';
        return {
          ok: false,
          error: 'Signed into POTA.app, but POTACAT could not read the API token from your session' + why +
                 '. Please try Connect again. If it keeps failing, the pota.app login flow may have changed — please report it.'
        };
      }
      const s = this._state();
      s.bearerToken = harvest.token;
      s.bearerTokenSource = harvest.key; // where (storage[key]) we read it from
      this._log(`captured bearer token from ${harvest.key}`);
      // Try to decode the callsign out of the JWT for a friendlier label.
      const label = this._decodeJwtLabel(harvest.token);
      return { ok: true, callsign: label || null };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // Spins up a hidden BrowserWindow on the same persistent partition, loads
  // pota.app so its frontend hydrates localStorage, reads every key, and looks
  // for a JWT-shaped value. Returns { token, key } on success.
  async _harvestToken() {
    return new Promise((resolve) => {
      let win;
      try {
        win = new BrowserWindow({
          show: false,
          width: 10, height: 10,
          webPreferences: {
            partition: PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
      } catch (err) {
        resolve({ error: 'harvest window creation failed: ' + err.message });
        return;
      }
      const cleanup = (result) => {
        try { win.destroy(); } catch {}
        resolve(result);
      };
      let done = false;
      const safety = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup({ error: 'harvest timed out' });
      }, 15_000);
      win.webContents.once('did-finish-load', async () => {
        // Give their SPA a moment to hydrate localStorage from the session.
        await new Promise(r => setTimeout(r, 1500));
        try {
          const raw = await win.webContents.executeJavaScript(
            '(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return JSON.stringify(o); })()'
          );
          const store = JSON.parse(raw || '{}');
          const found = this._findJwt(store);
          if (done) return;
          done = true;
          clearTimeout(safety);
          cleanup(found.token ? found : { error: 'No JWT found in pota.app localStorage' });
        } catch (err) {
          if (done) return;
          done = true;
          clearTimeout(safety);
          cleanup({ error: 'executeJavaScript failed: ' + err.message });
        }
      });
      win.loadURL('https://pota.app/').catch((err) => {
        if (done) return;
        done = true;
        clearTimeout(safety);
        cleanup({ error: 'harvest loadURL failed: ' + err.message });
      });
    });
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
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
      return payload.callsign || payload.username || payload.email || null;
    } catch { return null; }
  }

  // --- Fetch + parse ---------------------------------------------------------
  async pull() {
    if (this._syncing) return { ok: false, error: 'Sync already in progress' };
    const s = this._state();
    if (!s.connectedAt) return { ok: false, error: 'Not connected to POTA.app' };
    this._syncing = true;
    this._emitStatus();
    try {
      const url = s.csvUrl || DEFAULT_CSV_URL;
      this._log('pulling ' + url);
      const body = await this._fetchText(url);
      if (!body || body.length < 20) throw new Error('Empty response');
      const firstLine = body.split(/\r?\n/)[0] || '';
      if (!/reference/i.test(firstLine)) {
        throw new Error('Response did not look like the Parks Worked CSV. Either the URL has changed or the session has expired — try reconnecting.');
      }
      const csvPath = path.join(app.getPath('userData'), 'pota-parks-synced.csv');
      fs.writeFileSync(csvPath, body, 'utf8');
      const parks = parsePotaParksCSV(csvPath);
      this._onParksUpdated(parks, csvPath);
      s.lastPullAt = Date.now();
      s.lastPullCount = parks.size;
      this._lastCount = parks.size;
      this._lastError = null;
      await this._saveSettings();
      this._log(`pulled ${parks.size} parks`);
      return { ok: true, count: parks.size };
    } catch (err) {
      this._lastError = err.message || String(err);
      this._log('pull failed: ' + this._lastError);
      return { ok: false, error: this._lastError };
    } finally {
      this._syncing = false;
      this._emitStatus();
    }
  }

  _fetchText(url) {
    return new Promise((resolve, reject) => {
      const ses = session.fromPartition(PARTITION);
      const req = net.request({ method: 'GET', url, session: ses, useSessionCookies: true });
      req.setHeader('Accept', 'text/csv,application/json,*/*');
      // POTA.app's api endpoints require Authorization: Bearer <jwt> from their
      // Vue frontend's localStorage. Cookies alone return HTTP 403.
      const token = this._state().bearerToken;
      if (token) req.setHeader('Authorization', 'Bearer ' + token);
      req.on('response', (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg = res.statusCode === 401 || res.statusCode === 403
            ? `HTTP ${res.statusCode} — POTA.app rejected the request. Reconnect to capture a fresh token.`
            : `HTTP ${res.statusCode}`;
          return reject(new Error(msg));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  }

  // --- Scheduler -------------------------------------------------------------
  start() {
    const s = this._state();
    if (!s.enabled || !s.connectedAt) return;
    this.stop();
    const minutes = Math.max(15, s.intervalMin || 60);
    const intervalMs = minutes * 60_000;
    // Catch-up pull if we've been asleep longer than an interval, OR if a QSO
    // was logged since we last synced (handled by _qsoPending).
    const stale = Date.now() - (s.lastPullAt || 0) > intervalMs;
    if (stale || this._qsoPending) {
      this.pull();
      this._qsoPending = false;
    }
    this._timer = setInterval(() => this._tick(), intervalMs);
    this._log('scheduler started @ ' + minutes + ' min');
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._qsoTimer) { clearTimeout(this._qsoTimer); this._qsoTimer = null; }
  }

  _tick() {
    const s = this._state();
    if (!s.enabled || !s.connectedAt) { this.stop(); return; }
    // Worked-parks list only changes when we work a new park (or pota.app edits
    // history). Skip scheduled pulls that would just re-download the same thing
    // — but force one a day so out-of-band edits on pota.app eventually land.
    const sinceLast = Date.now() - (s.lastPullAt || 0);
    const forceDaily = sinceLast > 20 * 60 * 60_000;
    if (this._qsoPending || forceDaily) {
      this._qsoPending = false;
      this.pull();
    }
  }

  // Hook called from the QSO-save path. Debounced so a 40-QSO activation batch
  // results in one pull after the activity quiets down.
  noteQsoLogged() {
    const s = this._state();
    if (!s.enabled || !s.connectedAt) return;
    this._qsoPending = true;
    if (this._qsoTimer) clearTimeout(this._qsoTimer);
    this._qsoTimer = setTimeout(() => {
      this._qsoTimer = null;
      if (this._state().enabled && this._state().connectedAt) {
        this._qsoPending = false;
        this.pull();
      }
    }, QSO_DEBOUNCE_MS);
  }

  // Best-effort final sync on app exit if we owe one.
  async shutdown(timeoutMs = 8_000) {
    const s = this._state();
    if (!s.enabled || !s.connectedAt) return;
    if (!this._qsoPending) return;
    try {
      await Promise.race([
        this.pull(),
        new Promise((_, r) => setTimeout(() => r(new Error('shutdown timeout')), timeoutMs)),
      ]);
    } catch (err) {
      this._log('shutdown pull aborted: ' + err.message);
    }
  }

  // --- Setters ---------------------------------------------------------------
  async setEnabled(enabled) {
    const s = this._state();
    s.enabled = !!enabled;
    await this._saveSettings();
    if (s.enabled && s.connectedAt) this.start(); else this.stop();
    this._emitStatus();
  }

  async setIntervalMin(minutes) {
    const s = this._state();
    s.intervalMin = Math.max(15, Number(minutes) || 60);
    await this._saveSettings();
    if (this._timer && s.enabled && s.connectedAt) this.start(); // restart w/ new interval
    this._emitStatus();
  }
}

module.exports = { PotaSync, PARTITION, LOGIN_URL, DEFAULT_CSV_URL };
