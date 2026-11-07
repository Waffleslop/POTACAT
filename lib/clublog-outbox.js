'use strict';
/**
 * Realtime Club Log uploads, queued (#142).
 *
 * Until 1.14.0 saveQsoRecord awaited the upload: up to 10 s for the
 * application key and 60 s for realtime.php, with Save blocked the whole
 * time, and always with the ACTIVE operator's login, even for a contact
 * logged for someone else ("Log as"). A refused login (403) was retried with
 * the same bad password on every following QSO.
 *
 * Now saveQsoRecord queues the contact here with the credentials of the
 * operator it was logged for and returns at once. Delivery rules:
 *   - every contact is queued on disk first, then sent; a restart or an
 *     outage loses nothing;
 *   - 200, and 400 "Dupe" (already at Club Log), mean delivered;
 *   - any other 400 is a record Club Log will never take: given up, logged once;
 *   - 403 is a refused login: that account (email + callsign) is PAUSED and
 *     its queue held, logged once, until its credentials change (the operator
 *     saves a different Application Password: updateCredentials, or a new
 *     contact arrives with different ones) or a bulk upload with them succeeds;
 *   - anything else (no connection, no application key, 5xx) is retried on
 *     the BACKOFF_MS ladder, for at most MAX_AGE_MS from when it was queued.
 *
 * The queue file holds Application Passwords in plaintext, as the operator's
 * profile settings file does. It lives in userData and is never exported.
 * Pure: the POST and the application key are injected (main.js wires them
 * to postToClublog and getClublogApiKey).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { CLUBLOG_REALTIME_URL, buildRealtimeForm, mapClublogResponse, credentialKey } = require('./clublog');

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const BACKOFF_MS = [5000, 30000, 60000, 120000, 300000, 900000, 1800000];

const norm = (c) => ({
  email: String((c && c.email) || '').trim(),
  password: String((c && c.password) || ''),
  callsign: String((c && c.callsign) || '').trim().toUpperCase(),
});
const accountOf = (c) => norm(c).email.toLowerCase() + '|' + norm(c).callsign;
const plural = (n) => `${n} contact${n === 1 ? '' : 's'}`;

class ClublogOutbox extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.file - where the queue is kept (JSON)
   * @param {(url: string, contentType: string, body: string) => Promise<{status: number, body: string}>} opts.post
   * @param {() => Promise<string>} opts.getApiKey - POTACAT's Club Log application key ('' = unavailable)
   * @param {(msg: string) => void} [opts.log]
   * @param {() => number} [opts.now]
   * @param {number[]} [opts.backoffMs]
   * @param {number} [opts.maxAgeMs]
   */
  constructor(opts = {}) {
    super();
    this._file = opts.file;
    this._post = opts.post;
    this._getApiKey = opts.getApiKey || (async () => '');
    this._log = opts.log || (() => {});
    this._now = opts.now || Date.now;
    this._backoff = opts.backoffMs || BACKOFF_MS;
    this._maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : MAX_AGE_MS;
    this._queue = [];    // { uuid, email, password, callsign, call, adif, queuedAt, attempts, nextAt }
    this._paused = {};   // account -> { key: credentialKey, callsign }
    this._timer = null;
    this._flushing = null;
    this._load();
  }

  /** Contacts not yet at Club Log. */
  pending() { return this._queue.length; }

  isPaused(creds) { return !!this._paused[accountOf(creds)]; }

  /**
   * Queue one contact for the given Club Log account. Returns at once.
   * @param {{creds: {email: string, password: string, callsign: string}, adif: string, uuid?: string, call?: string}} item
   * @returns {string|null} the entry's uuid, or null if refused
   */
  add({ creds, adif, uuid, call } = {}) {
    const c = norm(creds);
    if (!c.email || !c.password || !c.callsign || !adif) return null;
    this.updateCredentials(c, { quiet: true });
    const now = this._now();
    const id = uuid || crypto.randomUUID();
    this._queue.push({ uuid: id, ...c, call: String(call || ''), adif: String(adif), queuedAt: now, attempts: 0, nextAt: now });
    this._save();
    this.flushSoon(0);
    return id;
  }

  /**
   * The operator's current Club Log login (Settings saved, or a new contact).
   * Credentials that differ from a paused account's clear the pause, and the
   * account's queued contacts are sent with the new ones.
   */
  updateCredentials(creds, { quiet = false } = {}) {
    const c = norm(creds);
    if (!c.email || !c.password || !c.callsign) return;
    const acct = accountOf(c);
    const key = credentialKey(c);
    const pause = this._paused[acct];
    let changed = false;
    if (pause && pause.key !== key) { delete this._paused[acct]; changed = true; }
    const now = this._now();
    const held = this._queue.filter((e) => accountOf(e) === acct);
    for (const e of held) {
      if (e.password !== c.password) { e.password = c.password; e.nextAt = now; changed = true; }
    }
    if (!changed) return;
    if (pause && !this._paused[acct] && held.length && !quiet) {
      this._log(`[ClubLog] login changed for ${c.callsign}: sending ${plural(held.length)} held`);
    }
    this._save();
    this.flushSoon(0);
  }

  /** A bulk upload (putlogs.php) tells us about the same login. */
  noteBulkResult(creds, r) {
    const c = norm(creds);
    if (!c.email || !c.callsign || !r) return;
    const acct = accountOf(c);
    if (r.auth) {
      this._paused[acct] = { key: credentialKey(c), callsign: c.callsign };
      this._save();
    } else if (r.ok) {
      if (this._paused[acct]) delete this._paused[acct];
      const now = this._now();
      for (const e of this._queue) if (accountOf(e) === acct) { e.password = c.password; e.nextAt = now; }
      this._save();
      this.flushSoon(0);
    }
  }

  /** Resume a queue left by the last run. */
  start() { if (this._queue.length) this.flushSoon(0); }
  stop() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }

  flushSoon(ms) {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; this.flush().catch(() => {}); }, Math.max(0, ms));
    if (this._timer.unref) this._timer.unref();
  }

  /** Send everything that is due, account by account, one QSO per request. */
  async flush() {
    if (this._flushing) return this._flushing;
    this._flushing = (async () => {
      // Yield first: a pass with nothing due would otherwise run its finally
      // (clearing _flushing) before _flushing is assigned, and every later
      // flush() would return that settled promise and send nothing.
      await null;
      try {
        this._expireOld();
        const now = this._now();
        const due = this._queue.filter((e) => e.nextAt <= now && !this._paused[accountOf(e)]);
        if (!due.length) return;
        let api = '';
        try { api = await this._getApiKey(); } catch { api = ''; }
        if (!api) return this._retry(due, 'application API key unavailable');
        const groups = new Map();
        for (const e of due) {
          const k = accountOf(e);
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(e);
        }
        for (const entries of groups.values()) await this._sendAccount(entries, api);
      } finally {
        this._flushing = null;
        this._save();
        this._scheduleNext();
      }
    })();
    return this._flushing;
  }

  async _sendAccount(entries, api) {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      let res;
      try {
        res = await this._post(CLUBLOG_REALTIME_URL, 'application/x-www-form-urlencoded',
          buildRealtimeForm({ email: e.email, password: e.password, callsign: e.callsign, api, adif: e.adif }));
      } catch (err) {
        res = { status: 0, body: (err && err.message) || String(err) };
      }
      const status = (res && res.status) || 0;
      const r = mapClublogResponse(status, res && res.body, 'realtime');
      if (r.ok) {
        this._remove([e]);
        this._log(`[ClubLog] ${r.dupe ? 'Dupe (already there)' : 'QSO sent'}: ${e.call || '?'} — ${r.message}`);
        continue;
      }
      if (r.auth) {
        const acct = accountOf(e);
        if (!this._paused[acct]) {
          this._paused[acct] = { key: credentialKey(e), callsign: e.callsign };
          this._log(`[ClubLog] paused for ${e.callsign}: login refused, fix email/Application Password in Settings`);
        }
        return;   // the rest of this account's queue is held with it
      }
      if (status === 400) {
        this._giveUp([e], r.message);
        continue;
      }
      return this._retry(entries.slice(i), status ? `HTTP ${status}` : `no connection (${(res && res.body) || 'error'})`);
    }
  }

  _retry(batch, why) {
    const now = this._now();
    for (const e of batch) {
      e.attempts++;
      e.nextAt = now + this._backoff[Math.min(e.attempts - 1, this._backoff.length - 1)];
    }
    const a = batch[0].attempts;
    if (a === 1 || a % 5 === 0) this._log(`[ClubLog] ${plural(batch.length)} queued (${why}); retrying`);
  }

  _expireOld() {
    const now = this._now();
    const old = this._queue.filter((e) => now - e.queuedAt > this._maxAgeMs);
    if (old.length) this._giveUp(old, 'not delivered within a week');
  }

  _giveUp(entries, why) {
    this._remove(entries);
    for (const e of entries) this._log(`[ClubLog] FAILED: ${e.call || '?'} — ${why}`);
  }

  _remove(entries) {
    if (!entries.length) return;
    const gone = new Set(entries);
    this._queue = this._queue.filter((e) => !gone.has(e));
  }

  _scheduleNext() {
    const waiting = this._queue.filter((e) => !this._paused[accountOf(e)]);
    if (!waiting.length) return;
    const next = Math.min(...waiting.map((e) => e.nextAt));
    this.flushSoon(Math.max(1000, next - this._now()));
  }

  _load() {
    if (!this._file) return;
    try {
      const data = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      if (Array.isArray(data && data.queue)) this._queue = data.queue.filter((e) => e && e.uuid && e.email && e.password && e.callsign && e.adif);
      if (data && data.paused && typeof data.paused === 'object') this._paused = data.paused;
    } catch { /* none yet */ }
  }

  _save() {
    if (!this._file) return;
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      const tmp = this._file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ queue: this._queue, paused: this._paused }));
      fs.renameSync(tmp, this._file);
    } catch (err) {
      this._log(`[ClubLog] could not save the upload queue: ${(err && err.message) || err}`);
    }
  }
}

module.exports = { ClublogOutbox, MAX_AGE_MS, BACKOFF_MS };
