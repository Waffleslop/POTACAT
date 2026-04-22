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
      win.loadURL(LOGIN_URL).catch((err) => {
        this._log('loadURL rejected: ' + err.message);
      });
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
      // Harvest the JWT from localStorage on pota.app. Their Vue frontend sets
      // it after login and the api.pota.app endpoints expect it as a Bearer
      // token — cookies alone return HTTP 403.
      const harvest = await this._harvestToken();
      if (harvest.token) {
        const s = this._state();
        s.bearerToken = harvest.token;
        s.bearerTokenSource = harvest.key; // which localStorage key we read it from
        this._log(`captured bearer token from localStorage["${harvest.key}"]`);
        // Try to decode the callsign out of the JWT for a friendlier label.
        const label = this._decodeJwtLabel(harvest.token);
        if (label) return { ok: true, callsign: label };
      } else if (harvest.error) {
        this._log('token harvest: ' + harvest.error);
      }
      return { ok: true };
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
