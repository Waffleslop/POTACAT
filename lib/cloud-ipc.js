'use strict';

const { ipcMain, dialog, shell } = require('electron');
const crypto = require('crypto');
const path = require('path');
const CloudSyncClient = require('./cloud-sync');
const CloudAuth = require('./cloud-auth');
const SyncJournal = require('./sync-journal');
const { rewriteAdifFile, appendRawQso } = require('./adif-writer');
const { parseAllRawQsos } = require('./adif');

/**
 * Register all POTACAT Cloud IPC handlers.
 *
 * Call this once from main.js after app.whenReady().
 *
 * @param {object} ctx - Context from main.js:
 *   ctx.app           - Electron app instance
 *   ctx.win           - Main BrowserWindow (getter or ref)
 *   ctx.getSettings   - () => settings object
 *   ctx.saveSettings  - (settings) => void
 *   ctx.getLogPath    - () => current ADIF log file path
 *   ctx.loadWorkedQsos - () => void (reloads worked QSOs map)
 *   ctx.sendToRenderer - (channel, data) => void
 */
function registerCloudIpc(ctx) {
  const userDataPath = ctx.app.getPath('userData');

  // --- Sync Journal (always initialized, even if cloud not enabled) ---
  const journal = new SyncJournal(userDataPath);

  // --- Cloud Sync Client ---
  let cloudSync = null;
  let cloudAuth = null;

  function getCloudSync() {
    if (!cloudSync) {
      const settings = ctx.getSettings();
      cloudSync = new CloudSyncClient({
        apiBase: settings.cloudApiBase || 'https://api.potacat.com',
        accessToken: settings.cloudAccessToken || null,
        refreshToken: settings.cloudRefreshToken || null,
        deviceId: settings.cloudDeviceId || null,
        lastSyncTimestamp: settings.cloudLastSyncTimestamp || null,
        onTokenRefresh: (accessToken, refreshToken) => {
          const s = ctx.getSettings();
          s.cloudAccessToken = accessToken;
          s.cloudRefreshToken = refreshToken;
          ctx.saveSettings(s);
        },
      });

      cloudSync.on('status', (status, detail) => {
        ctx.sendToRenderer('cloud-sync-status', { status, detail });
      });

      cloudSync.on('progress', (phase, current, total) => {
        ctx.sendToRenderer('cloud-upload-progress', { phase, current, total });
      });
    }
    return cloudSync;
  }

  function ensureDeviceId() {
    const settings = ctx.getSettings();
    if (!settings.cloudDeviceId) {
      settings.cloudDeviceId = crypto.randomUUID();
      ctx.saveSettings(settings);
    }
    return settings.cloudDeviceId;
  }

  /**
   * UTC millis of a raw QSO record, or null if undated.
   */
  function qsoUtcMillis(f) {
    const d = f.QSO_DATE || '';
    if (d.length !== 8) return null;
    const t = ((f.TIME_ON || '') + '000000').slice(0, 6);
    return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8),
      +t.slice(0, 2) || 0, +t.slice(2, 4) || 0, +t.slice(4, 6) || 0);
  }

  /**
   * Same physical contact reported under two different UUIDs? Happens when
   * the phone logs through a connected desktop: the desktop writes (and
   * journals) its enriched copy under a fresh UUID while the phone journals
   * its own local copy under another — UUID-only matching then duplicates
   * the QSO on every device (K3SBP, 2 CW QSOs, 2026-07-08). Same call +
   * mode + frequency (or band when either side lacks FREQ) within a tight
   * time window = one contact. Window is 3 min: the observed double-report
   * deltas were 23–32 s; a deliberate re-work of the same station on the
   * same band is essentially never that fast.
   */
  function sameContact(a, b) {
    if (!a.CALL || !b.CALL || a.CALL.toUpperCase() !== b.CALL.toUpperCase()) return false;
    if ((a.MODE || '').toUpperCase() !== (b.MODE || '').toUpperCase()) return false;
    const fa = parseFloat(a.FREQ), fb = parseFloat(b.FREQ);
    if (Number.isFinite(fa) && Number.isFinite(fb)) {
      if (Math.abs(fa - fb) > 0.005) return false; // MHz — same 5 kHz, tolerates format drift
    } else if ((a.BAND || '').toUpperCase() !== (b.BAND || '').toUpperCase()) {
      return false;
    }
    const ta = qsoUtcMillis(a), tb = qsoUtcMillis(b);
    if (ta == null || tb == null) return false;
    return Math.abs(ta - tb) <= 3 * 60 * 1000;
  }

  /**
   * Merge pulled QSOs into the local ADIF file.
   */
  function mergePulledQsos(pulledQsos) {
    if (!pulledQsos || pulledQsos.length === 0) return;
    const logPath = ctx.getLogPath();
    const localQsos = parseAllRawQsos(logPath);

    // Build UUID index. Absorbed-duplicate aliases (APP_POTACAT_MERGED_UUIDS,
    // see the sameContact branch below) resolve to the surviving record so
    // later ops on a dead uuid don't re-append it.
    const uuidIndex = new Map();
    const reindex = () => {
      uuidIndex.clear();
      for (let i = 0; i < localQsos.length; i++) {
        const uuid = localQsos[i].APP_POTACAT_UUID;
        if (uuid) uuidIndex.set(uuid, i);
        const aliases = localQsos[i].APP_POTACAT_MERGED_UUIDS;
        if (aliases) for (const a of aliases.split(',')) { if (a) uuidIndex.set(a, i); }
      }
    };
    reindex();

    let needsRewrite = false;
    const toAppend = [];

    for (const remote of pulledQsos) {
      const localIdx = uuidIndex.get(remote.uuid);

      if (remote.isDeleted) {
        // Only delete when the uuid is the record's PRIMARY identity. An
        // alias hit here is our own absorbed-duplicate tombstone echoing
        // back from the cloud — deleting on it would kill the real QSO.
        if (localIdx !== undefined && localQsos[localIdx].APP_POTACAT_UUID === remote.uuid) {
          localQsos.splice(localIdx, 1);
          reindex();
          needsRewrite = true;
        }
      } else if (localIdx !== undefined) {
        // Update existing
        const existing = localQsos[localIdx];
        const remoteVersion = remote.version || 1;
        const localVersion = parseInt(existing.APP_POTACAT_VERSION || '1', 10);
        if (remoteVersion > localVersion) {
          // Replace local with remote fields, preserve UUID
          const newFields = { ...remote.adifFields };
          newFields.APP_POTACAT_UUID = remote.uuid;
          newFields.APP_POTACAT_VERSION = String(remoteVersion);
          localQsos[localIdx] = newFields;
          needsRewrite = true;
        }
      } else {
        // New QSO from another device
        const fields = { ...remote.adifFields };
        fields.APP_POTACAT_UUID = remote.uuid;
        fields.APP_POTACAT_VERSION = String(remote.version || 1);
        // Cross-device double-report guard (see sameContact above): if this
        // is content-identical to a QSO we already hold under another uuid,
        // absorb it — keep the (richer) local record, remember the alias,
        // and tombstone the duplicate in the cloud so the device that minted
        // it converges to one record too.
        const dupIdx = localQsos.findIndex((q) => sameContact(q, fields));
        if (dupIdx !== -1) {
          const local = localQsos[dupIdx];
          const aliases = (local.APP_POTACAT_MERGED_UUIDS || '').split(',').filter(Boolean);
          if (!aliases.includes(remote.uuid)) aliases.push(remote.uuid);
          local.APP_POTACAT_MERGED_UUIDS = aliases.join(',');
          uuidIndex.set(remote.uuid, dupIdx);
          needsRewrite = true;
          journal.append({
            uuid: remote.uuid,
            action: 'delete',
            adifFields: fields,
            version: (remote.version || 1) + 1,
          });
          console.log(`[Cloud] Absorbed cross-device duplicate of ${fields.CALL} ${fields.QSO_DATE} ${fields.TIME_ON} (uuid ${remote.uuid} → ${local.APP_POTACAT_UUID})`);
          continue;
        }
        // Mirror into localQsos too so a second copy of the same contact
        // later in THIS batch hits the sameContact guard (fresh-device full
        // pull is exactly where existing cross-device dupes arrive together).
        toAppend.push(fields);
        localQsos.push(fields);
        uuidIndex.set(remote.uuid, localQsos.length - 1);
      }
    }

    if (needsRewrite) {
      // localQsos already contains the appended records — one rewrite
      // covers everything (appending them again would duplicate).
      rewriteAdifFile(logPath, localQsos);
    } else {
      // Append new QSOs (avoids full rewrite for common case)
      for (const fields of toAppend) {
        appendRawQso(logPath, fields);
      }
    }

    if (needsRewrite || toAppend.length > 0) {
      ctx.loadWorkedQsos();
    }
  }

  function getSyncCallbacks() {
    return {
      onPulled: (qsos) => mergePulledQsos(qsos),
      onConflicts: (conflicts) => {
        // Accept server version for all conflicts
        const qsos = conflicts.map((c) => ({
          uuid: c.uuid,
          adifFields: c.serverFields,
          version: c.serverVersion,
          isDeleted: c.serverIsDeleted,
        }));
        mergePulledQsos(qsos);
      },
    };
  }

  // ── IPC Handlers ──────────────────────────────────────────────────

  ipcMain.handle('cloud-google-signin', async () => {
    try {
      const settings = ctx.getSettings();
      const googleClientId = settings.cloudGoogleClientId || process.env.GOOGLE_CLIENT_ID || '';
      if (!googleClientId) return { error: 'Google Client ID not configured' };

      if (!cloudAuth) cloudAuth = new CloudAuth(googleClientId);
      const code = await cloudAuth.googleSignIn();

      const deviceId = ensureDeviceId();
      const apiBase = settings.cloudApiBase || 'https://api.potacat.com';
      const result = await cloudAuth.exchangeCodeForTokens(apiBase, code, deviceId);

      // Save tokens
      settings.cloudAccessToken = result.accessToken;
      settings.cloudRefreshToken = result.refreshToken;
      settings.cloudUser = result.user;
      ctx.saveSettings(settings);

      // Reinitialize sync client with new tokens
      cloudSync = null;

      return { success: true, user: result.user };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('cloud-login', async (_e, email, password) => {
    try {
      const settings = ctx.getSettings();
      const deviceId = ensureDeviceId();
      const sync = getCloudSync();

      const result = await sync._post('/v1/auth/login', {
        email, password, deviceId,
      }, true);

      settings.cloudAccessToken = result.accessToken;
      settings.cloudRefreshToken = result.refreshToken;
      settings.cloudUser = result.user;
      ctx.saveSettings(settings);

      cloudSync = null; // Reinitialize with new tokens

      return { success: true, user: result.user };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('cloud-forgot-password', async (_e, email) => {
    // Public endpoint; surface HTTP status + structured error code to the
    // renderer so the UI can show different copy for 404 (no account)
    // and 409 (account exists but uses Apple/Google sign-in only).
    // Skip CloudSyncClient._post — its error envelope flattens to a
    // single message string that loses the status code.
    const settings = ctx.getSettings();
    const apiBase = settings.cloudApiBase || 'https://api.potacat.com';
    try {
      const res = await fetch(`${apiBase}/v1/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: String(email || '').trim() }),
      });
      let data = {};
      try { data = await res.json(); } catch { /* body may be empty */ }
      if (res.ok) return { success: true, message: data.message };
      return {
        error: data.error || `http_${res.status}`,
        message: data.message,
        provider: data.provider,
        status: res.status,
      };
    } catch (err) {
      return { error: 'network', message: err.message };
    }
  });

  ipcMain.handle('cloud-register', async (_e, email, password, callsign) => {
    try {
      const settings = ctx.getSettings();
      const deviceId = ensureDeviceId();
      const sync = getCloudSync();

      const result = await sync._post('/v1/auth/register', {
        email, password, callsign, displayName: callsign, deviceId,
      }, true);

      settings.cloudAccessToken = result.accessToken;
      settings.cloudRefreshToken = result.refreshToken;
      settings.cloudUser = result.user;
      ctx.saveSettings(settings);

      cloudSync = null;

      return { success: true, user: result.user };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('cloud-logout', async () => {
    try {
      const sync = getCloudSync();
      const settings = ctx.getSettings();

      try {
        await sync._post('/v1/auth/logout', {
          refreshToken: settings.cloudRefreshToken,
        }, true);
      } catch { /* ignore logout errors */ }

      sync.stopInterval();

      settings.cloudAccessToken = null;
      settings.cloudRefreshToken = null;
      settings.cloudUser = null;
      settings.cloudLastSyncTimestamp = null;
      ctx.saveSettings(settings);

      cloudSync = null;

      return { success: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('cloud-get-status', async () => {
    try {
      const settings = ctx.getSettings();
      if (!settings.cloudAccessToken) {
        return { loggedIn: false };
      }

      const sync = getCloudSync();
      const [syncStatus, subStatus] = await Promise.all([
        sync.getStatus().catch(() => null),
        sync.getSubscriptionStatus().catch(() => null),
      ]);

      // Keep cached user in sync with live subscription status
      if (subStatus && settings.cloudUser) {
        settings.cloudUser.subscriptionStatus = subStatus.status;
        ctx.saveSettings(settings);
      }

      return {
        loggedIn: true,
        user: settings.cloudUser,
        sync: syncStatus,
        subscription: subStatus,
        lastSyncTimestamp: settings.cloudLastSyncTimestamp,
        lastSyncAt: settings.cloudLastSyncAt,
        pendingChanges: journal.length,
      };
    } catch (err) {
      return { loggedIn: false, error: err.message };
    }
  });

  ipcMain.handle('cloud-sync-now', async () => {
    try {
      const sync = getCloudSync();
      const result = await sync.sync(journal, getSyncCallbacks());

      // Persist last sync timestamp
      const settings = ctx.getSettings();
      if (sync.lastSyncTimestamp) settings.cloudLastSyncTimestamp = sync.lastSyncTimestamp;
      settings.cloudLastSyncAt = new Date().toISOString();
      ctx.saveSettings(settings);

      return { success: true, pushed: result.pushed, pulled: result.pulled };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('cloud-bulk-prepare', async () => {
    try {
      const logPath = ctx.getLogPath();
      const allQsos = parseAllRawQsos(logPath);
      const chunks = Math.ceil(allQsos.length / 200);
      const estimatedSeconds = Math.max(chunks * 3, 5); // ~3 sec per chunk
      const minutes = Math.ceil(estimatedSeconds / 60);
      return {
        qsoCount: allQsos.length,
        chunks,
        estimatedTime: allQsos.length <= 200 ? 'a few seconds'
          : minutes <= 1 ? 'about a minute'
          : `about ${minutes} minutes`,
        logPath,
      };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('cloud-bulk-upload', async () => {
    try {
      const logPath = ctx.getLogPath();
      const allQsos = parseAllRawQsos(logPath);

      // Ensure all QSOs have UUIDs
      let needsRewrite = false;
      for (const qso of allQsos) {
        if (!qso.APP_POTACAT_UUID) {
          qso.APP_POTACAT_UUID = crypto.randomUUID();
          qso.APP_POTACAT_VERSION = '1';
          needsRewrite = true;
        }
      }
      if (needsRewrite) {
        rewriteAdifFile(logPath, allQsos);
      }

      // Prepare for upload
      const uploadData = allQsos.map((fields) => ({
        uuid: fields.APP_POTACAT_UUID,
        adifFields: fields,
      }));

      const sync = getCloudSync();
      const result = await sync.bulkUpload(uploadData, (imported, total) => {
        ctx.sendToRenderer('cloud-upload-progress', {
          phase: 'upload',
          current: imported,
          total,
        });
      });

      // Clear journal after full upload
      journal.clear();

      // Save sync timestamp
      const settings = ctx.getSettings();
      settings.cloudLastSyncTimestamp = new Date().toISOString();
      ctx.saveSettings(settings);

      return { success: true, imported: result.imported, duplicates: result.duplicates };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('cloud-download-adif', async () => {
    try {
      const s = ctx.getSettings() || {};
      const fs = require('fs');
      let startDir = s.lastAdifExportDir;
      try {
        if (!startDir || !fs.existsSync(startDir) || !fs.statSync(startDir).isDirectory()) {
          startDir = ctx.app.getPath('documents');
        }
      } catch { startDir = ctx.app.getPath('documents'); }
      // Dated default filename so repeated backups don't overwrite each
      // other (local date, per the cloud handoff doc).
      const d = new Date();
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const result = await dialog.showSaveDialog({
        title: 'Download Cloud Backup',
        defaultPath: path.join(startDir, `potacat_cloud_backup_${ymd}.adi`),
        filters: [{ name: 'ADIF Files', extensions: ['adi', 'adif'] }],
      });
      if (result.canceled) return { canceled: true };

      const sync = getCloudSync();
      await sync.downloadAdif(result.filePath);
      // Remember folder for the next ADIF export
      const dir = path.dirname(result.filePath);
      if (dir && dir !== s.lastAdifExportDir) {
        ctx.saveSettings(Object.assign({}, s, { lastAdifExportDir: dir }));
      }
      return { success: true, filePath: result.filePath };
    } catch (err) {
      // Credential-shaped failures get a friendly message + a flag so the
      // renderer can drop back to the sign-in form (handoff doc: 404 and
      // unrecoverable 401s should prompt re-sign-in, not a dead alert).
      if (err.message === 'ACCOUNT_NOT_FOUND') {
        return { error: 'Your cloud account was not found — it may have been deleted. Please sign in again.', needsSignIn: true };
      }
      if (err.message === 'AUTH_EXPIRED' || err.message.startsWith('Token refresh failed')) {
        return { error: 'Your cloud session has expired. Please sign in again.', needsSignIn: true };
      }
      return { error: err.message };
    }
  });

  ipcMain.handle('cloud-verify-subscription', async () => {
    try {
      const sync = getCloudSync();
      return await sync.verifySubscription();
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('cloud-save-bmac-email', async (_e, bmacEmail) => {
    try {
      // Save locally
      const settings = ctx.getSettings();
      settings.cloudBmacEmail = bmacEmail;
      ctx.saveSettings(settings);

      // Send to server to update bmac_payer_email and verify
      const sync = getCloudSync();
      return await sync._authedRequest('POST', '/v1/subscription/set-bmac-email', { bmacEmail });
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('cloud-open-subscribe', async () => {
    const settings = ctx.getSettings();
    const bmacUrl = settings.cloudBmacUrl || 'https://buymeacoffee.com/potacat/membership';
    shell.openExternal(bmacUrl);
    return { success: true };
  });

  ipcMain.handle('cloud-open-manage', async () => {
    const settings = ctx.getSettings();
    const bmacUrl = settings.cloudBmacUrl || 'https://buymeacoffee.com/potacat/membership';
    shell.openExternal(bmacUrl);
    return { success: true };
  });

  ipcMain.handle('cloud-get-settings', async () => {
    try {
      const sync = getCloudSync();
      return await sync.getSettings();
    } catch (err) {
      return { error: err.message };
    }
  });

  // ── Guest Pass — desktop-side issue/list/revoke (#46c) ──────────────
  // The mobile app has the same form (Phase 2 #45a). Adding it on
  // desktop because owners often have the desktop in front of them
  // when they want to hand the rig to a friend.

  ipcMain.handle('passes-issue', async (_e, body) => {
    try {
      const sync = getCloudSync();
      return await sync._authedRequest('POST', '/v1/passes', body);
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('passes-list', async () => {
    try {
      const sync = getCloudSync();
      return await sync._authedRequest('GET', '/v1/passes');
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('passes-revoke', async (_e, code) => {
    try {
      const sync = getCloudSync();
      return await sync._authedRequest('DELETE', `/v1/passes/${encodeURIComponent(code)}`);
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('passes-qr-png', async (_e, text) => {
    try {
      const QRCode = require('qrcode');
      return await QRCode.toDataURL(String(text || ''), { errorCorrectionLevel: 'M', margin: 1, scale: 6 });
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('cloud-put-settings', async (_e, data) => {
    try {
      const sync = getCloudSync();
      return await sync.putSettings(data.settings, data.encryptedSecrets, data.version);
    } catch (err) {
      return { error: err.message };
    }
  });

  // ── Sync Journal hooks (called from main.js) ─────────────────────

  /**
   * Record a new QSO in the sync journal.
   * Call after appendQso() in saveQsoRecord().
   */
  function journalCreate(qsoData) {
    const settings = ctx.getSettings();
    if (!settings.cloudSyncEnabled || !settings.cloudAccessToken) return;

    const uuid = qsoData.uuid || qsoData.APP_POTACAT_UUID;
    if (!uuid) return;

    // Build ADIF fields object from qsoData
    const adifFields = {};
    for (const [key, value] of Object.entries(qsoData)) {
      if (value != null && value !== '') {
        adifFields[key.toUpperCase()] = String(value);
      }
    }
    adifFields.APP_POTACAT_UUID = uuid;

    journal.append({
      uuid,
      action: 'create',
      adifFields,
      version: 1,
    });
  }

  /**
   * Record a QSO update in the sync journal.
   * Call after rewriteAdifFile() in update-qso handler.
   * @param {object} updatedQso - The updated raw QSO fields object
   */
  function journalUpdate(updatedQso) {
    const settings = ctx.getSettings();
    if (!settings.cloudSyncEnabled || !settings.cloudAccessToken) return;

    const uuid = updatedQso.APP_POTACAT_UUID;
    if (!uuid) return;

    const version = parseInt(updatedQso.APP_POTACAT_VERSION || '1', 10) + 1;
    updatedQso.APP_POTACAT_VERSION = String(version);

    journal.append({
      uuid,
      action: 'update',
      adifFields: updatedQso,
      version,
    });
  }

  /**
   * Record a QSO deletion in the sync journal.
   * Call after rewriteAdifFile() in delete-qso handler.
   * @param {object} deletedQso - The deleted raw QSO fields object
   */
  function journalDelete(deletedQso) {
    const settings = ctx.getSettings();
    if (!settings.cloudSyncEnabled || !settings.cloudAccessToken) return;

    const uuid = deletedQso.APP_POTACAT_UUID;
    if (!uuid) return;

    const version = parseInt(deletedQso.APP_POTACAT_VERSION || '1', 10) + 1;

    journal.append({
      uuid,
      action: 'delete',
      adifFields: deletedQso,
      version,
    });
  }

  /**
   * Start background sync interval if cloud is enabled.
   */
  function startBackgroundSync() {
    const settings = ctx.getSettings();
    if (!settings.cloudSyncEnabled || !settings.cloudAccessToken) return;

    const sync = getCloudSync();
    const interval = settings.cloudSyncInterval || 60;
    sync.startInterval(interval, journal, getSyncCallbacks());
  }

  /**
   * Stop background sync.
   */
  function stopBackgroundSync() {
    if (cloudSync) cloudSync.stopInterval();
  }

  return {
    journal,
    journalCreate,
    journalUpdate,
    journalDelete,
    startBackgroundSync,
    stopBackgroundSync,
    getCloudSync,
    getSyncCallbacks, // exposed for tests (cross-device dupe merge)
  };
}

module.exports = { registerCloudIpc };
