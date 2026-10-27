'use strict';
/**
 * A Guest Pass guest's contacts go into the GUEST's cloud logbook, sent by the
 * shack (docs/share-my-rig-lease-plan.md, phase D; Casey 2026-10-27: "log QSOs
 * into his logbook"). Until now the shack only forwarded each contact to the
 * guest's device and the phone pushed it; a browser guest had no logbook and
 * every one of their contacts was dropped.
 *
 * The route is the pass session's own (cloud reply 2026-10-27):
 *   POST /v1/passes/:code/sessions/:session_token/qsos  { changes: [...] }
 *   → 200 { accepted, conflicts, rejected, pass_session_id }
 * The code + session token are the authority; no account token is involved,
 * so an anonymous guest's contacts land in their synthetic account and the
 * guest-pass page offers them as an ADIF download.
 *
 * Delivery rules:
 *   - every contact is queued on disk first, then sent; a restart, a dropped
 *     link or the cloud being down loses nothing;
 *   - accepted, conflicts (the cloud already has that version: a resend after
 *     a lost reply) and rejected not_this_session (the guest's device pushed
 *     it first) all mean the contact is in the guest's logbook;
 *   - 410 (the session closed more than 24 h ago) and 400 (a batch the cloud
 *     will never take) cannot be retried: those contacts are handed back as
 *     'undelivered' and main writes them to a file for the owner to pass on;
 *   - anything else (no network, 404 before the route is deployed, 429, 5xx)
 *     is retried with backoff, for at most MAX_AGE_MS from when it was queued.
 * The owner's own logbook is never written.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const API_BASE = 'https://api.potacat.com';
const BATCH_MAX = 200;                       // the route's limit
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;     // give up and hand back after a week
const BACKOFF_MS = [5000, 30000, 60000, 120000, 300000, 900000, 1800000];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function routeFor(base, code, token) {
  return `${base}/v1/passes/${encodeURIComponent(code)}/sessions/${encodeURIComponent(token)}/qsos`;
}

class PassQsoOutbox extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.file - where the queue is kept (JSON)
   * @param {Function} [opts.fetch] - fetch implementation (tests)
   * @param {string} [opts.baseUrl]
   * @param {(msg: string) => void} [opts.log]
   * @param {() => number} [opts.now]
   * @param {number[]} [opts.backoffMs]
   */
  constructor(opts = {}) {
    super();
    this._file = opts.file;
    this._fetch = opts.fetch || ((...a) => fetch(...a));
    this._base = opts.baseUrl || API_BASE;
    this._log = opts.log || (() => {});
    this._now = opts.now || Date.now;
    this._backoff = opts.backoffMs || BACKOFF_MS;
    this._maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : MAX_AGE_MS;
    this._queue = [];      // { uuid, code, token, call, fields, version, queuedAt, attempts, nextAt }
    this._timer = null;
    this._flushing = null;
    this._load();
  }

  /** Contacts not yet in a guest's logbook. */
  pending() { return this._queue.length; }

  /**
   * Queue one contact for the guest's logbook and send it.
   * @param {{code: string, token: string, call?: string, fields: object}} item
   * @returns {string|null} the contact's uuid (APP_POTACAT_UUID), or null if refused
   */
  add({ code, token, call, fields }) {
    if (!code || !token || !fields || typeof fields !== 'object') return null;
    const uuid = UUID_RE.test(fields.APP_POTACAT_UUID || '') ? fields.APP_POTACAT_UUID : crypto.randomUUID();
    const now = this._now();
    this._queue.push({
      uuid, code: String(code), token: String(token), call: call || '',
      fields: { ...fields, APP_POTACAT_UUID: uuid }, version: 1,
      queuedAt: now, attempts: 0, nextAt: now,
    });
    this._save();
    this.flushSoon(0);
    return uuid;
  }

  /** Resume a queue left by the last run. */
  start() { if (this._queue.length) this.flushSoon(0); }
  stop() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }

  flushSoon(ms) {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; this.flush().catch(() => {}); }, Math.max(0, ms));
    if (this._timer.unref) this._timer.unref();
  }

  /** Send everything that is due, one batch per pass session. */
  async flush() {
    if (this._flushing) return this._flushing;
    this._flushing = (async () => {
      try {
        this._expireOld();
        const now = this._now();
        const due = this._queue.filter((e) => e.nextAt <= now);
        const groups = new Map();
        for (const e of due) {
          const k = e.code + '|' + e.token;
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(e);
        }
        for (const entries of groups.values()) {
          for (let i = 0; i < entries.length; i += BATCH_MAX) {
            await this._send(entries.slice(i, i + BATCH_MAX));
          }
        }
      } finally {
        this._flushing = null;
        this._save();
        this._scheduleNext();
      }
    })();
    return this._flushing;
  }

  async _send(batch) {
    const { code, token } = batch[0];
    const body = { changes: batch.map((e) => ({ uuid: e.uuid, adifFields: e.fields, version: e.version })) };
    let res, json = null;
    try {
      res = await this._fetch(routeFor(this._base, code, token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      try { json = await res.json(); } catch { json = null; }
    } catch (err) {
      return this._retry(batch, `no connection (${err && err.message || err})`);
    }
    if (res.ok && json) {
      const done = new Set();
      for (const u of json.accepted || []) done.add(typeof u === 'string' ? u : u && u.uuid);
      for (const c of json.conflicts || []) done.add(c && c.uuid);
      for (const r of json.rejected || []) {
        if (r && r.reason === 'not_this_session') done.add(r.uuid);   // the guest's device sent it first
      }
      const left = batch.filter((e) => !done.has(e.uuid));
      this._remove(batch.filter((e) => done.has(e.uuid)));
      const n = batch.length - left.length;
      if (n) this._log(`[pass] ${n} contact${n === 1 ? '' : 's'} delivered to ${batch[0].call || 'the guest'}'s logbook`);
      if (left.length) this._giveUp(left, 'the cloud refused ' + left.map((e) => e.uuid.slice(0, 8)).join(', '));
      return;
    }
    if (res.status === 410 || res.status === 400) {
      return this._giveUp(batch, res.status === 410 ? 'the pass session closed more than a day ago' : `the cloud refused the batch (${(json && json.error) || 400})`);
    }
    return this._retry(batch, `HTTP ${res.status}${json && json.error ? ' ' + json.error : ''}`);
  }

  _retry(batch, why) {
    const now = this._now();
    for (const e of batch) {
      e.attempts++;
      e.nextAt = now + this._backoff[Math.min(e.attempts - 1, this._backoff.length - 1)];
    }
    if (batch[0].attempts === 1 || batch[0].attempts % 5 === 0) {
      this._log(`[pass] ${batch.length} guest contact${batch.length === 1 ? '' : 's'} not delivered yet (${why}); retrying`);
    }
  }

  _expireOld() {
    const now = this._now();
    const old = this._queue.filter((e) => now - e.queuedAt > this._maxAgeMs);
    if (old.length) this._giveUp(old, 'not delivered within a week');
  }

  _giveUp(entries, why) {
    this._remove(entries);
    this._log(`[pass] ${entries.length} guest contact${entries.length === 1 ? '' : 's'} could not reach the guest's logbook: ${why}`);
    this.emit('undelivered', { entries: entries.map((e) => ({ code: e.code, call: e.call, uuid: e.uuid, fields: e.fields })), reason: why });
  }

  _remove(entries) {
    if (!entries.length) return;
    const gone = new Set(entries);
    this._queue = this._queue.filter((e) => !gone.has(e));
  }

  _scheduleNext() {
    if (!this._queue.length) return;
    const next = Math.min(...this._queue.map((e) => e.nextAt));
    this.flushSoon(Math.max(1000, next - this._now()));
  }

  _load() {
    if (!this._file) return;
    try {
      const data = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      if (Array.isArray(data && data.queue)) this._queue = data.queue.filter((e) => e && e.uuid && e.code && e.token && e.fields);
    } catch { /* none yet */ }
  }

  _save() {
    if (!this._file) return;
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      const tmp = this._file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ queue: this._queue }));
      fs.renameSync(tmp, this._file);
    } catch (err) {
      this._log(`[pass] could not save the guest contact queue: ${err && err.message || err}`);
    }
  }
}

module.exports = { PassQsoOutbox, routeFor, BATCH_MAX, MAX_AGE_MS };
