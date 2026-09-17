'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');

/**
 * CloudSyncClient - Handles bidirectional sync between POTACAT and the cloud.
 *
 * Follows the same patterns as lib/sota.js (EventEmitter, _ensureAuth, token refresh)
 * and lib/qrz.js (raw https.request).
 *
 * Events:
 *   'status'  (status: 'idle'|'syncing'|'synced'|'error', detail?: string)
 *   'progress' (phase: 'push'|'pull'|'upload', current: number, total: number)
 */
class CloudSyncClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this._apiBase = options.apiBase || 'https://api.potacat.com';
    this._accessToken = options.accessToken || null;
    this._refreshToken = options.refreshToken || null;
    // Trust a provided access token indefinitely — expiry is handled
    // REACTIVELY: server 401s surface as AUTH_EXPIRED and the callers
    // (_authedRequest, downloadAdif) refresh + retry once. _tokenExpiry
    // only goes short (1 min) as a backoff after a FAILED refresh.
    this._tokenExpiry = options.accessToken ? Date.now() + (364 * 24 * 60 * 60 * 1000) : 0;
    this._deviceId = options.deviceId || null;
    this._lastSyncTimestamp = options.lastSyncTimestamp || null;
    this._syncing = false;
    this._syncTimer = null;
    this._onTokenRefresh = options.onTokenRefresh || null; // callback to persist new tokens
  }

  // ── Configuration ────────────────────────────────────────────────

  configure(opts) {
    if (opts.apiBase) this._apiBase = opts.apiBase;
    if (opts.accessToken) {
      this._accessToken = opts.accessToken;
      this._tokenExpiry = Date.now() + (364 * 24 * 60 * 60 * 1000);
    }
    if (opts.refreshToken) this._refreshToken = opts.refreshToken;
    if (opts.deviceId) this._deviceId = opts.deviceId;
    if (opts.lastSyncTimestamp !== undefined) this._lastSyncTimestamp = opts.lastSyncTimestamp;
    if (opts.onTokenRefresh) this._onTokenRefresh = opts.onTokenRefresh;
  }

  // ── Auth ──────────────────────────────────────────────────────────

  async _ensureAuth() {
    if (!this._accessToken && !this._refreshToken) throw new Error('Not authenticated');

    // If we have an access token and it hasn't expired, we're good
    if (this._accessToken && this._tokenExpiry > 0 && Date.now() < this._tokenExpiry) return;

    // If in backoff period (after a failed refresh), don't spam
    if (!this._accessToken && this._tokenExpiry > 0 && Date.now() < this._tokenExpiry) {
      throw new Error('Not authenticated');
    }

    // Otherwise try to refresh
    if (this._refreshToken) {
      await this._refreshTokens();
      return;
    }

    throw new Error('Not authenticated');
  }

  async _refreshTokens() {
    try {
      const result = await this._post('/v1/auth/refresh', {
        refreshToken: this._refreshToken,
        deviceId: this._deviceId,
      }, true); // skipAuth = true

      this._accessToken = result.accessToken;
      this._refreshToken = result.refreshToken;
      // Trust the fresh token until the next 401 (reactive refresh —
      // see the _tokenExpiry note in the constructor).
      this._tokenExpiry = Date.now() + (364 * 24 * 60 * 60 * 1000);

      // The refresh response carries a fresh `user` too — hand it over so
      // the cached profile (callsign, trial dates) doesn't stay frozen at
      // whatever it was at sign-in.
      if (this._onTokenRefresh) {
        this._onTokenRefresh(this._accessToken, this._refreshToken, result.user || null);
      }
    } catch (err) {
      // Don't wipe tokens on refresh failure -- keep refresh token so we can retry later.
      // Just clear the access token and set a backoff so we don't spam.
      this._accessToken = null;
      this._tokenExpiry = Date.now() + 60000; // back off 1 minute before retrying
      throw new Error('Token refresh failed: ' + err.message);
    }
  }

  // ── HTTP helpers (matching lib/qrz.js pattern) ────────────────────

  _request(method, path, body, skipAuth = false) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(this._apiBase + path);
      const transport = parsed.protocol === 'https:' ? https : http;
      const headers = { Accept: 'application/json' };

      if (!skipAuth && this._accessToken) {
        headers['Authorization'] = `Bearer ${this._accessToken}`;
      }

      let bodyStr;
      if (body != null) {
        bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers,
      };

      const req = transport.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          // 5xx handling. Two sources: (a) the gateway (nginx 502/503/504)
          // when the API is down — body is HTML, not JSON; (b) the API
          // route itself catching its own error and returning JSON like
          // `{ error: 'provision_failed', message: '<actual reason>' }`.
          // (b) is the more useful case for diagnosing intermittent
          // provision/sync failures, so we try JSON first and only fall
          // back to the generic copy when the body is not JSON.
          if (res.statusCode >= 500 && res.statusCode < 600) {
            const gatewayLabel = res.statusCode === 503 ? 'temporarily unavailable'
                       : res.statusCode === 502 ? 'gateway error'
                       : res.statusCode === 504 ? 'gateway timeout'
                       : 'error';
            try {
              const parsed = JSON.parse(data);
              const detail = parsed && (parsed.message || parsed.error);
              if (detail) {
                reject(new Error(`POTACAT cloud error (HTTP ${res.statusCode}): ${detail}`));
                return;
              }
            } catch {}
            reject(new Error(`POTACAT cloud is ${gatewayLabel} (HTTP ${res.statusCode}). Please try again in a few minutes — if it keeps happening, email casey@potacat.com.`));
            return;
          }
          try {
            const result = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(result);
            } else if (res.statusCode === 401 && !skipAuth) {
              reject(new Error('AUTH_EXPIRED'));
            } else {
              // Server errors are `{ error: <code>, message?: <human text> }`.
              // The message is what the user should read (no_callsign →
              // "Add it in Settings › Cloud"); the code rides on err.code for
              // callers that branch on it. Only the bare code used to survive.
              const body = (result && typeof result === 'object') ? result : {};
              const err = new Error(body.message || body.error || `HTTP ${res.statusCode}`);
              if (body.error) err.code = body.error;
              err.status = res.statusCode;
              err.body = body;
              reject(err);
            }
          } catch {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(data);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            }
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(60000, () => {
        req.destroy(new Error('Request timeout'));
      });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async _get(path, skipAuth = false) {
    return this._request('GET', path, null, skipAuth);
  }

  async _post(path, body, skipAuth = false) {
    return this._request('POST', path, body, skipAuth);
  }

  async _put(path, body, skipAuth = false) {
    return this._request('PUT', path, body, skipAuth);
  }

  /**
   * Make an authenticated request with auto-retry on token expiration.
   */
  async _authedRequest(method, path, body) {
    await this._ensureAuth();
    try {
      return await this._request(method, path, body);
    } catch (err) {
      if (err.message === 'AUTH_EXPIRED' && this._refreshToken) {
        await this._refreshTokens();
        return this._request(method, path, body);
      }
      throw err;
    }
  }

  // ── Sync operations ───────────────────────────────────────────────

  /**
   * Push local changes to the server, 200 per request.
   *
   * The server resolves EVERY change it is sent (each lands in exactly one of
   * accepted/conflicts, routes/sync.js) and commits each request as its own
   * transaction. So once a batch returns, all of its entries are done with:
   * `onBatch(batch, result)` lets the caller retire them right then, and a
   * failure on batch 3 no longer re-sends batches 1 and 2.
   *
   * @param {Array} changes - journal entries [{ uuid, action, adifFields, version }]
   * @param {(batch: Array, result: {accepted, conflicts}) => void} [onBatch]
   * @returns {object} { accepted: [uuid], conflicts: [...] }
   */
  async push(changes, onBatch) {
    if (!changes || changes.length === 0) return { accepted: [], conflicts: [] };

    const batches = [];
    for (let i = 0; i < changes.length; i += 200) {
      batches.push(changes.slice(i, i + 200));
    }

    const allAccepted = [];
    const allConflicts = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i].map((c) => ({
        uuid: c.uuid,
        adifFields: c.adifFields,
        version: c.version,
        isDeleted: c.action === 'delete',
      }));

      const result = await this._authedRequest('POST', '/v1/sync/push', {
        deviceId: this._deviceId,
        changes: batch,
      });

      const accepted = result.accepted || [];
      const conflicts = result.conflicts || [];
      allAccepted.push(...accepted);
      allConflicts.push(...conflicts);
      if (onBatch) onBatch(batches[i], { accepted, conflicts });

      this.emit('progress', 'push', i + 1, batches.length);
    }

    return { accepted: allAccepted, conflicts: allConflicts };
  }

  /**
   * Pull remote changes from the server.
   * @returns {Array} Array of { uuid, adifFields, version, isDeleted, updatedAt }
   */
  async pull() {
    const allQsos = [];
    let cursor = null;
    let page = 0;

    do {
      let path = `/v1/sync/pull?limit=500&deviceId=${encodeURIComponent(this._deviceId || '')}`;
      if (this._lastSyncTimestamp) {
        path += `&since=${encodeURIComponent(this._lastSyncTimestamp)}`;
      }
      if (cursor) {
        path += `&cursor=${encodeURIComponent(cursor)}`;
      }

      const result = await this._authedRequest('GET', path);
      allQsos.push(...(result.qsos || []));
      cursor = result.cursor;
      page++;

      this.emit('progress', 'pull', allQsos.length, allQsos.length + (result.hasMore ? 500 : 0));

      if (!result.hasMore) break;
    } while (cursor);

    // Update lastSyncTimestamp from the last pulled record
    if (allQsos.length > 0) {
      this._lastSyncTimestamp = allQsos[allQsos.length - 1].updatedAt;
    }

    return allQsos;
  }

  // ── Device registry (desktop-to-desktop initiative, v1.9) ──────────
  //
  // Backs the Cloud-attested pairing flow. The shack registers itself
  // here so signed-in laptops on the same account can find it without
  // QR scans. The laptop registers itself too — so the shack can
  // verify pairToken redemption is account-attested. See
  // potacat-cloudlog/routes/devices.js + docs/remote-desktop-plan.md.

  async registerDevice(payload) {
    await this._ensureAuth();
    return this._request('POST', '/v1/devices', payload);
  }

  async listDevices(type) {
    await this._ensureAuth();
    const qs = type ? ('?type=' + encodeURIComponent(type)) : '';
    return this._request('GET', '/v1/devices' + qs);
  }

  async authorizePair(shackId, payload) {
    await this._ensureAuth();
    return this._request('POST', '/v1/devices/' + encodeURIComponent(shackId) + '/authorize', payload);
  }

  async verifyPairToken(token, shackDeviceId) {
    await this._ensureAuth();
    return this._request('POST', '/v1/devices/pair-tokens/verify', { token, shackDeviceId });
  }

  async heartbeatDevice(deviceId) {
    await this._ensureAuth();
    return this._request('POST', '/v1/devices/' + encodeURIComponent(deviceId) + '/heartbeat', {});
  }

  async revokeDevice(deviceId) {
    await this._ensureAuth();
    return this._request('DELETE', '/v1/devices/' + encodeURIComponent(deviceId));
  }

  /**
   * Bulk upload QSOs for initial onboarding.
   * @param {Array} qsos - Array of { uuid, adifFields }
   * @param {function} onProgress - Progress callback (imported, total)
   * @returns {object} { imported, duplicates }
   */
  async bulkUpload(qsos, onProgress) {
    let totalImported = 0;
    let totalDuplicates = 0;
    // 250 / chunk (down from 500) — KK4DF reported ECONNRESET / SSL
    // bad_record_mac on a 12,933-QSO upload, classic large-payload-flaky-
    // mid-stream symptom. Smaller chunks reduce per-request time and the
    // odds of any one chunk hitting a stale keep-alive / middlebox idle
    // timeout. Retry below covers the rest.
    const chunkSize = 250;
    const totalChunks = Math.ceil(qsos.length / chunkSize);

    for (let i = 0; i < qsos.length; i += chunkSize) {
      const chunk = qsos.slice(i, i + chunkSize);
      const chunkNum = Math.floor(i / chunkSize) + 1;

      // Retry transport-level failures up to 3 times with exponential
      // backoff. Don't retry on auth errors (token won't get less expired)
      // or on 4xx (the chunk itself is rejected — retrying just hits the
      // same wall and burns time on a 12k-QSO upload). Server outages
      // (5xx) and network blips (ECONNRESET, SSL alerts, timeouts) are
      // exactly the cases where retry succeeds.
      let result = null;
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          result = await this._authedRequest('POST', '/v1/sync/bulk-upload', {
            qsos: chunk,
          });
          break;
        } catch (err) {
          lastErr = err;
          const msg = err && err.message ? err.message : String(err);
          if (msg === 'AUTH_EXPIRED') throw err;
          if (/^HTTP 4\d\d/.test(msg)) throw err;
          // Transport / 5xx — back off and retry
          const wait = 1000 * Math.pow(3, attempt); // 1s, 3s, 9s
          this.emit('progress', 'upload-retry', chunkNum, totalChunks);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
      if (!result) {
        const msg = lastErr && lastErr.message ? lastErr.message : 'unknown error';
        throw new Error(`Upload stopped at chunk ${chunkNum} of ${totalChunks} (${totalImported} of ${qsos.length} QSOs uploaded so far). ${msg}. Click Initial Upload again — already-uploaded QSOs will be detected as duplicates and skipped, so progress is not lost.`);
      }

      totalImported += result.imported || 0;
      totalDuplicates += result.duplicates || 0;

      this.emit('progress', 'upload', chunkNum, totalChunks);
      if (onProgress) onProgress(totalImported, qsos.length);
    }

    return { imported: totalImported, duplicates: totalDuplicates };
  }

  /**
   * Full sync cycle: push local changes, then pull remote changes.
   * @param {object} journal - SyncJournal instance
   * @param {object} callbacks - { onPulled(qsos), onConflicts(conflicts), onSynced(summary) }
   * @returns {object} { pushed, pulled, conflicts }
   */
  async sync(journal, callbacks = {}) {
    if (this._syncing) return { pushed: 0, pulled: 0, conflicts: 0, skipped: true };
    this._syncing = true;
    this.emit('status', 'syncing');

    try {
      // Phase 1: Push local changes
      let pushed = 0;
      let conflicts = 0;
      if (journal.hasPending) {
        await this.push(journal.getAll(), (batch, result) => {
          pushed += result.accepted.length;
          conflicts += result.conflicts.length;
          // The server's copy wins a conflict; merge it BEFORE retiring the
          // entries, so a failed merge leaves them to be pushed again.
          if (result.conflicts.length > 0 && callbacks.onConflicts) {
            callbacks.onConflicts(result.conflicts);
          }
          journal.removeEntries(batch);
        });
      }

      // Phase 2: Pull remote changes
      const pulledQsos = await this.pull();

      if (pulledQsos.length > 0 && callbacks.onPulled) {
        callbacks.onPulled(pulledQsos);
      }

      this.emit('status', 'synced');
      const summary = { pushed, pulled: pulledQsos.length, conflicts };
      if (callbacks.onSynced) callbacks.onSynced(summary);
      return summary;
    } catch (err) {
      this.emit('status', 'error', err.message);
      throw err;
    } finally {
      this._syncing = false;
    }
  }

  // ── Sync status ───────────────────────────────────────────────────

  async getStatus() {
    return this._authedRequest('GET', `/v1/sync/status?deviceId=${encodeURIComponent(this._deviceId || '')}`);
  }

  // ── Subscription ──────────────────────────────────────────────────

  async getSubscriptionStatus() {
    return this._authedRequest('GET', '/v1/subscription/status');
  }

  async verifySubscription() {
    return this._authedRequest('POST', '/v1/subscription/verify');
  }

  // ── Account ───────────────────────────────────────────────────────

  async getMe() {
    return this._authedRequest('GET', '/v1/auth/me');
  }

  /**
   * Set or change the callsign on the Cloud account. The server enforces
   * uniqueness (409 callsign_taken) and one change per 30 days (429
   * callsign_change_limited). Resolves { user, trialGranted }.
   */
  async setCallsign(callsign) {
    return this._authedRequest('PUT', '/v1/auth/callsign', { callsign });
  }

  // ── Settings sync ─────────────────────────────────────────────────

  async getSettings() {
    return this._authedRequest('GET', '/v1/settings');
  }

  async putSettings(settings, encryptedSecrets, version) {
    return this._authedRequest('PUT', '/v1/settings', {
      settings,
      encryptedSecrets,
      version,
    });
  }

  // ── Export ─────────────────────────────────────────────────────────

  /**
   * Download the user's entire cloud log as an ADIF file.
   *
   * Auth note: the export endpoint is deliberately auth-only on the
   * server (data portability — works with a lapsed subscription), so a
   * 401 here only ever means an expired/invalid access token. Like
   * _authedRequest, we refresh + retry once. The download streams to
   * `<destPath>.download` and renames into place on success — ADIF has
   * no footer, so a mid-stream disconnect would otherwise leave a
   * silently truncated log at the user's chosen path.
   *
   * @param {string} destPath - Local file path to save the ADIF
   */
  async downloadAdif(destPath) {
    await this._ensureAuth();
    try {
      return await this._downloadAdifOnce(destPath);
    } catch (err) {
      if (err.message === 'AUTH_EXPIRED' && this._refreshToken) {
        await this._refreshTokens();
        return this._downloadAdifOnce(destPath);
      }
      throw err;
    }
  }

  _downloadAdifOnce(destPath) {
    return new Promise((resolve, reject) => {
      const tmpPath = destPath + '.download';
      const cleanup = () => { try { fs.unlinkSync(tmpPath); } catch { /* already gone */ } };

      const parsed = new URL(this._apiBase + '/v1/sync/export/adif');
      const transport = parsed.protocol === 'https:' ? https : http;

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname,
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this._accessToken}`,
        },
      };

      const req = transport.request(options, (res) => {
        if (res.statusCode !== 200) {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          // 404 = account deleted server-side (doc: "User not found") —
          // distinguishable so the UI can prompt a re-sign-in instead of
          // showing a generic failure.
          res.on('end', () => reject(new Error(
            res.statusCode === 401 ? 'AUTH_EXPIRED'
              : res.statusCode === 404 ? 'ACCOUNT_NOT_FOUND'
                : `Export failed: HTTP ${res.statusCode}`)));
          return;
        }

        const ws = fs.createWriteStream(tmpPath);
        let failed = false;
        const fail = (err) => {
          if (failed) return;
          failed = true;
          try { ws.destroy(); } catch { /* ignore */ }
          cleanup();
          reject(err);
        };
        res.pipe(ws);
        // 'aborted' fires when the server drops mid-stream WITHOUT a
        // proper close frame — pipe() alone would leave a truncated file
        // and our 'finish' may still fire on some Node versions.
        res.on('aborted', () => fail(new Error('Export interrupted — connection lost mid-download')));
        res.on('error', fail);
        ws.on('error', fail);
        ws.on('finish', () => {
          if (failed) return;
          try {
            fs.renameSync(tmpPath, destPath);
            resolve(destPath);
          } catch (err) {
            fail(err);
          }
        });
      });

      req.on('error', (err) => { cleanup(); reject(err); });
      req.setTimeout(120000, () => {
        req.destroy(new Error('Export timeout'));
      });
      req.end();
    });
  }

  // ── Background sync timer ─────────────────────────────────────────

  startInterval(seconds, journal, callbacks) {
    this.stopInterval();
    this._syncTimer = setInterval(async () => {
      try {
        await this.sync(journal, callbacks);
      } catch (err) {
        console.error('Cloud sync interval error:', err.message);
      }
    }, seconds * 1000);
  }

  stopInterval() {
    if (this._syncTimer) {
      clearInterval(this._syncTimer);
      this._syncTimer = null;
    }
  }

  get isSyncing() {
    return this._syncing;
  }

  get lastSyncTimestamp() {
    return this._lastSyncTimestamp;
  }
}

module.exports = CloudSyncClient;
