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
   * Merge pulled QSOs into the local ADIF file.
   */
  function mergePulledQsos(pulledQsos) {
    if (!pulledQsos || pulledQsos.length === 0) return;
    const logPath = ctx.getLogPath();
    const localQsos = parseAllRawQsos(logPath);

    // Build UUID index
    const uuidIndex = new Map();
    for (let i = 0; i < localQsos.length; i++) {
      const uuid = localQsos[i].APP_POTACAT_UUID;
      if (uuid) uuidIndex.set(uuid, i);
    }

    let needsRewrite = false;
    const toAppend = [];

    for (const remote of pulledQsos) {
      const localIdx = uuidIndex.get(remote.uuid);

      if (remote.isDeleted) {
        if (localIdx !== undefined) {
          localQsos.splice(localIdx, 1);
          // Re-index after splice
          uuidIndex.clear();
          for (let i = 0; i < localQsos.length; i++) {
            const uuid = localQsos[i].APP_POTACAT_UUID;
            if (uuid) uuidIndex.set(uuid, i);
          }
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
        toAppend.push(fields);
      }
    }

    if (needsRewrite) {
      rewriteAdifFile(logPath, localQsos);
    }

    // Append new QSOs (avoids full rewrite for common case)
    for (const fields of toAppend) {
      appendRawQso(logPath, fields);
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
      const result = await dialog.showSaveDialog({
        title: 'Download Cloud Log',
        defaultPath: 'potacat_cloud_export.adi',
        filters: [{ name: 'ADIF Files', extensions: ['adi', 'adif'] }],
      });
      if (result.canceled) return { canceled: true };

      const sync = getCloudSync();
      await sync.downloadAdif(result.filePath);
      return { success: true, filePath: result.filePath };
    } catch (err) {
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
  };
}

module.exports = { registerCloudIpc };
