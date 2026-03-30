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
    // If we have a fresh access token, trust it for 14 minutes
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
      // Access tokens expire in 15 min, refresh 30 seconds early
      this._tokenExpiry = Date.now() + (364 * 24 * 60 * 60 * 1000);

      if (this._onTokenRefresh) {
        this._onTokenRefresh(this._accessToken, this._refreshToken);
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
          try {
            const result = JSON.parse(data);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(result);
            } else if (res.statusCode === 401 && !skipAuth) {
              reject(new Error('AUTH_EXPIRED'));
            } else {
              reject(new Error(result.error || `HTTP ${res.statusCode}`));
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
      req.setTimeout(30000, () => {
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
   * Push local changes to the server.
   * @param {Array} changes - Array of journal entries [{ uuid, adifFields, version, isDeleted }]
   * @returns {object} { accepted: [uuid], conflicts: [...] }
   */
  async push(changes) {
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

      allAccepted.push(...(result.accepted || []));
      allConflicts.push(...(result.conflicts || []));

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

  /**
   * Bulk upload QSOs for initial onboarding.
   * @param {Array} qsos - Array of { uuid, adifFields }
   * @param {function} onProgress - Progress callback (imported, total)
   * @returns {object} { imported, duplicates }
   */
  async bulkUpload(qsos, onProgress) {
    let totalImported = 0;
    let totalDuplicates = 0;
    const chunkSize = 200;
    const totalChunks = Math.ceil(qsos.length / chunkSize);

    for (let i = 0; i < qsos.length; i += chunkSize) {
      const chunk = qsos.slice(i, i + chunkSize);
      const result = await this._authedRequest('POST', '/v1/sync/bulk-upload', {
        qsos: chunk,
      });

      totalImported += result.imported || 0;
      totalDuplicates += result.duplicates || 0;

      const chunkNum = Math.floor(i / chunkSize) + 1;
      this.emit('progress', 'upload', chunkNum, totalChunks);
      if (onProgress) onProgress(totalImported, qsos.length);
    }

    return { imported: totalImported, duplicates: totalDuplicates };
  }

  /**
   * Full sync cycle: push local changes, then pull remote changes.
   * @param {object} journal - SyncJournal instance
   * @param {object} callbacks - { onPulled(qsos), onConflicts(conflicts) }
   */
  async sync(journal, callbacks = {}) {
    if (this._syncing) return { pushed: 0, pulled: 0 };
    this._syncing = true;
    this.emit('status', 'syncing');

    try {
      // Phase 1: Push local changes
      let pushed = 0;
      if (journal.hasPending) {
        const entries = journal.getAll();
        const result = await this.push(entries);

        // Remove accepted entries from journal
        if (result.accepted.length > 0) {
          journal.removeAccepted(result.accepted);
          pushed = result.accepted.length;
        }

        // Handle conflicts: accept server version
        if (result.conflicts.length > 0 && callbacks.onConflicts) {
          callbacks.onConflicts(result.conflicts);
        }
      }

      // Phase 2: Pull remote changes
      const pulledQsos = await this.pull();

      if (pulledQsos.length > 0 && callbacks.onPulled) {
        callbacks.onPulled(pulledQsos);
      }

      this.emit('status', 'synced');
      return { pushed, pulled: pulledQsos.length };
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
   * @param {string} destPath - Local file path to save the ADIF
   */
  downloadAdif(destPath) {
    return new Promise(async (resolve, reject) => {
      try {
        await this._ensureAuth();
      } catch (err) {
        return reject(err);
      }

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
          res.on('end', () => reject(new Error(`Export failed: HTTP ${res.statusCode}`)));
          return;
        }

        const ws = fs.createWriteStream(destPath);
        res.pipe(ws);
        ws.on('finish', () => resolve(destPath));
        ws.on('error', reject);
      });

      req.on('error', reject);
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
