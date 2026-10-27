'use strict';

const { ipcMain, dialog, shell } = require('electron');
const crypto = require('crypto');
const path = require('path');
const CloudSyncClient = require('./cloud-sync');
const CloudAuth = require('./cloud-auth');
const SyncJournal = require('./sync-journal');
const CloudBillingUi = require('./cloud-billing-ui');
const { rewriteAdifFile, appendRawQsos } = require('./adif-writer');
const { normalizeAdifFields } = require('./adif-normalize');
const { ContactIndex } = require('./qso-match');
const QsoLog = require('./qso-log');
const { readLog, uuidOf, versionOf } = QsoLog;

// Where a desktop sign-up started (POST /v1/auth/register `signup.entry`).
// cloud-prompt = the 50-QSO card; settings = Settings > Cloud by hand;
// summary = the Summary card; pairing = the ECHOCAT pairing panel;
// notice = the billing/share notice link; share-rig = Share My Rig's wall;
// tunnel = the Cloud Tunnel's wall. Add a value here before using it.
const SIGNUP_ENTRIES = ['cloud-prompt', 'settings', 'summary', 'pairing', 'notice', 'share-rig', 'tunnel'];

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

/**
 * The cloud user id a settings object belongs to: the cached user's id, else
 * the access token's `sub` claim (the same id; decoding needs no verification
 * just to LABEL local entries), else the email; null when signed out. Pure so
 * "Log as" can label a QSO for ANOTHER operator's profile settings
 * (lib/log-as.js) — that entry parks in the journal until they sign in.
 */
function ownerIdFor(s) {
  if (!s || !s.cloudAccessToken) return null;
  const u = s.cloudUser;
  if (u && u.id) return String(u.id);
  try {
    const payload = JSON.parse(Buffer.from(String(s.cloudAccessToken).split('.')[1], 'base64url').toString('utf8'));
    if (payload && payload.sub) return String(payload.sub);
  } catch {}
  return (u && u.email) ? String(u.email).toLowerCase() : null;
}

function registerCloudIpc(ctx) {
  const userDataPath = ctx.app.getPath('userData');

  const log = (msg) => { if (typeof ctx.log === 'function') ctx.log(msg); else console.log(msg); };

  // --- Sync Journal (always initialized, even if cloud not enabled) ---
  const journal = new SyncJournal(userDataPath, { log });

  /**
   * The signed-in account, as the label every journal entry carries. The
   * server's user id (routes/auth.js userResponse) — read from the cached
   * user, else from the access token's `sub` claim (the same id; decoding
   * needs no verification just to LABEL local entries), else the email.
   * null when signed out. See sync-journal.js forOwner() for why.
   */
  function currentOwnerId() {
    return ownerIdFor(ctx.getSettings());
  }
  /** This account's view of the journal — the only thing the sync cycle sees. */
  const myJournal = () => journal.forOwner(currentOwnerId());
  /** For the status displays: mine, and how much is parked for other accounts. */
  function pendingStatus() {
    const owner = currentOwnerId();
    return { pendingChanges: journal.forOwner(owner).length, pendingForOthers: journal.pendingForOthers(owner) };
  }

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
        onTokenRefresh: (accessToken, refreshToken, user) => {
          const s = ctx.getSettings();
          s.cloudAccessToken = accessToken;
          s.cloudRefreshToken = refreshToken;
          if (user) s.cloudUser = user;
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
   *
   * The same physical contact can arrive under a second UUID: when the phone
   * logs through a connected desktop, the desktop journals its enriched copy
   * under a fresh UUID while the phone journals its own under another, and
   * UUID-only matching duplicated the QSO on every device (K3SBP, 2 CW QSOs,
   * 2026-07-08). Those are absorbed by the qso-match.js rule, which import
   * and Find Duplicates share.
   *
   * @param {boolean} [opts.serverWins] - conflict resolution: the server's
   *   copy replaces the local record even at an EQUAL version (the local
   *   record carries the version this device just pushed and lost with).
   */
  function mergePulledQsos(pulledQsos, { serverWins = false } = {}) {
    if (!pulledQsos || pulledQsos.length === 0) return;
    const logPath = ctx.getLogPath();
    const localQsos = readLog(logPath);
    const contacts = new ContactIndex(localQsos);

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

    for (const pulled of pulledQsos) {
      // Rows stored before the server's 2026-09-17 normalizer can still
      // arrive with pseudo field names (CALLSIGN, QSODATE, ...).
      const remote = { ...pulled, adifFields: normalizeAdifFields(pulled.adifFields || {}) };
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
        if (remoteVersion > localVersion || (serverWins && remoteVersion >= localVersion)) {
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
        const dup = contacts.findMatch(fields);
        const dupIdx = dup ? localQsos.indexOf(dup) : -1;
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
            owner: currentOwnerId(),
          });
          console.log(`[Cloud] Absorbed cross-device duplicate of ${fields.CALL} ${fields.QSO_DATE} ${fields.TIME_ON} (uuid ${remote.uuid} → ${local.APP_POTACAT_UUID})`);
          continue;
        }
        // Mirror into localQsos too so a second copy of the same contact
        // later in THIS batch hits the sameContact guard (fresh-device full
        // pull is exactly where existing cross-device dupes arrive together).
        toAppend.push(fields);
        localQsos.push(fields);
        contacts.add(fields);
        uuidIndex.set(remote.uuid, localQsos.length - 1);
      }
    }

    if (needsRewrite) {
      // localQsos already contains the appended records — one rewrite
      // covers everything (appending them again would duplicate).
      rewriteAdifFile(logPath, localQsos);
    } else {
      // Append new QSOs (avoids full rewrite for common case)
      appendRawQsos(logPath, toAppend);
    }

    if (needsRewrite || toAppend.length > 0) {
      ctx.loadWorkedQsos();
    }
  }

  function getSyncCallbacks() {
    return {
      onPulled: (qsos) => mergePulledQsos(qsos),
      onConflicts: (conflicts) => {
        // The server's copy wins every conflict.
        const qsos = conflicts.map((c) => ({
          uuid: c.uuid,
          adifFields: c.serverFields,
          version: c.serverVersion,
          isDeleted: c.serverIsDeleted,
        }));
        mergePulledQsos(qsos, { serverWins: true });
      },
      // Persist the pull cursor after EVERY cycle, background ones included —
      // it used to be saved only by a manual Sync Now, so each launch
      // re-pulled everything since the last button press.
      onSynced: () => {
        const settings = ctx.getSettings();
        const since = cloudSync && cloudSync.lastSyncTimestamp;
        if (since) settings.cloudLastSyncTimestamp = since;
        settings.cloudLastSyncAt = new Date().toISOString();
        ctx.saveSettings(settings);
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

      cloudSessionChanged('oauth');

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
      // First sign-in on this PC (the toggle never decided): sync on. A
      // deliberate OFF (false) is kept.
      if (settings.cloudSyncEnabled === undefined) settings.cloudSyncEnabled = true;
      ctx.saveSettings(settings);

      cloudSessionChanged('signin');

      return { success: true, user: result.user };
    } catch (err) {
      // `code` rides along so the renderer can branch (no_account → "try
      // your callsign"); `error` stays the human message.
      return { error: err.message, code: err.code || undefined };
    }
  });

  ipcMain.handle('cloud-forgot-password', async (_e, email) => {
    // Public endpoint; surface HTTP status + structured error code to the
    // renderer so the UI can show different copy for 404 (no account).
    // (The old 409 for Apple/Google-only accounts is gone since 2026-08-14:
    // they get the link too, and completing it sets a first password.)
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

  /** { client: 'desktop', entry } — entry is one of SIGNUP_ENTRIES. */
  function signupSource(entry) {
    return { client: 'desktop', entry: SIGNUP_ENTRIES.includes(entry) ? entry : 'settings' };
  }

  ipcMain.handle('cloud-register', async (_e, email, password, callsign, opts = {}) => {
    try {
      const settings = ctx.getSettings();
      const deviceId = ensureDeviceId();
      const sync = getCloudSync();

      const result = await sync._post('/v1/auth/register', {
        email, password, callsign, displayName: callsign, deviceId,
        // Where the sign-up started, so the cloud can tell what brings people
        // in (Casey 2026-10-27). Only the place in the app, never anything
        // about the operator or the log.
        signup: signupSource(opts && opts.entry),
      }, true);

      settings.cloudAccessToken = result.accessToken;
      settings.cloudRefreshToken = result.refreshToken;
      settings.cloudUser = result.user;
      // A new account syncs from the first contact. The toggle used to
      // default OFF, so a trialist who uploaded once and never found
      // "Enable QSO Cloud Sync" had a backup that stopped the same day —
      // and the emails promise "every new contact backs itself up".
      settings.cloudSyncEnabled = true;
      ctx.saveSettings(settings);

      cloudSessionChanged('register');

      return { success: true, user: result.user };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('cloud-set-callsign', async (_e, callsign) => {
    try {
      const sync = getCloudSync();
      const result = await sync.setCallsign(String(callsign || '').trim().toUpperCase());
      if (result && result.user) {
        const settings = ctx.getSettings();
        settings.cloudUser = result.user;
        ctx.saveSettings(settings);
      }
      return { success: true, user: result && result.user, trialGranted: !!(result && result.trialGranted) };
    } catch (err) {
      // err.message is the server's human text (CloudSyncClient._request);
      // code lets the UI tell "taken" from "rate-limited".
      return {
        error: err.message,
        code: err.code || null,
        nextAllowedAt: (err.body && err.body.nextAllowedAt) || null,
      };
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

      settings.cloudAccessToken = null;
      settings.cloudRefreshToken = null;
      settings.cloudUser = null;
      settings.cloudLastSyncTimestamp = null;
      ctx.saveSettings(settings);

      cloudSessionChanged('signout');

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
      const [syncStatus, subStatus, me] = await Promise.all([
        sync.getStatus().catch(() => null),
        sync.getSubscriptionStatus().catch(() => null),
        sync.getMe().catch(() => null),
      ]);

      // Re-read the account on every Cloud-tab view. cloudUser used to be
      // cached at sign-in and never refreshed, so a callsign added later
      // (admin, ECHOCAT, or the editor here) only showed up after signing
      // out and back in.
      if (me && me.user) settings.cloudUser = me.user;
      // Keep cached user in sync with live subscription status
      if (subStatus && settings.cloudUser) {
        settings.cloudUser.subscriptionStatus = subStatus.status;
      }
      if ((me && me.user) || (subStatus && settings.cloudUser)) ctx.saveSettings(settings);
      // The billing strip/banner render from this — cache it so the card
      // paints before the fetch returns, and tell the main window now.
      const subscription = subStatus ? noteSubscription(subStatus, 'status') : cachedSubscription();

      return {
        loggedIn: true,
        user: settings.cloudUser,
        sync: syncStatus,
        subscription,
        localQsos: localQsoCount(),
        lastSyncTimestamp: settings.cloudLastSyncTimestamp,
        lastSyncAt: settings.cloudLastSyncAt,
        ...pendingStatus(),
      };
    } catch (err) {
      return { loggedIn: false, error: err.message };
    }
  });

  ipcMain.handle('cloud-sync-now', async () => {
    try {
      return await syncNow();
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('cloud-bulk-prepare', async () => {
    try {
      const logPath = ctx.getLogPath();
      const allQsos = readLog(logPath);
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
      return await uploadFullLog((imported, total) => {
        ctx.sendToRenderer('cloud-upload-progress', { phase: 'upload', current: imported, total });
      });
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

  // ── Billing: Stripe checkout / portal, the billing strip's action, and
  //    the checkout watch (2026-10-14; cloud handoff BILLING_UX) ─────────
  //
  // Every Stripe URL is opened HERE with shell.openExternal. The renderer's
  // open-external IPC runs an allow-list that has no Stripe host on it and
  // fails closed without a word — a checkout button wired through it would
  // do nothing. BMAC, the App Store, Play and the signed api.potacat.com
  // portal link are on that list, so the strip may open `action.url` itself.

  function localQsoCount() {
    try { return typeof ctx.getLocalQsoCount === 'function' ? ctx.getLocalQsoCount() : null; } catch { return null; }
  }

  /** Cache the live status so the strip paints at launch, and tell every window. */
  function noteSubscription(sub, reason) {
    const settings = ctx.getSettings();
    settings.cloudSubscriptionCache = sub;
    settings.cloudSubscriptionAt = Date.now();
    ctx.saveSettings(settings);
    const payload = { subscription: sub, reason: reason || 'status', localQsos: localQsoCount() };
    try { ctx.sendToRenderer('cloud-billing-state', payload); } catch {}
    if (typeof ctx.onBillingState === 'function') { try { ctx.onBillingState(payload); } catch {} }
    return sub;
  }

  function cachedSubscription() {
    const settings = ctx.getSettings();
    const sub = settings.cloudSubscriptionCache;
    return sub && typeof sub === 'object' ? { ...sub, stale: true } : null;
  }

  /** Live status (cached copy on failure). Used by the web bridge and the launch check. */
  async function refreshSubscription(reason) {
    const settings = ctx.getSettings();
    if (!settings.cloudAccessToken) return null;
    try {
      const sub = await getCloudSync().getSubscriptionStatus();
      return noteSubscription(sub, reason || 'refresh');
    } catch (err) {
      log(`[Cloud] Subscription status: ${err.message}`);
      return cachedSubscription();
    }
  }

  /**
   * At launch: a dated grant changes state at midnight UTC and a billing
   * issue arrives by webhook, so a status older than 12 h is refreshed.
   * Guarantees one `cloud-billing-state` either way, so the main-window
   * banner has something to render.
   */
  async function refreshBillingIfStale() {
    const settings = ctx.getSettings();
    if (!settings.cloudAccessToken) return null;
    if (!CloudBillingUi.isStale(settings.cloudSubscriptionAt)) {
      const sub = cachedSubscription();
      if (sub) {
        const payload = { subscription: sub, reason: 'launch-cache', localQsos: localQsoCount() };
        try { ctx.sendToRenderer('cloud-billing-state', payload); } catch {}
        if (typeof ctx.onBillingState === 'function') { try { ctx.onBillingState(payload); } catch {} }
      }
      return sub;
    }
    return refreshSubscription('launch');
  }

  let _stripeConfigured = true;   // false after a 503 stripe_not_configured
  let _checkoutWatch = null;      // { startedAt, plan, sessionId, timer, origin }

  function checkoutState() {
    if (!_checkoutWatch) return { phase: 'idle', stripeConfigured: _stripeConfigured };
    return { phase: 'waiting', plan: _checkoutWatch.plan, startedAt: _checkoutWatch.startedAt, stripeConfigured: _stripeConfigured };
  }

  function sendCheckoutState(extra) {
    const payload = { ...checkoutState(), ...(extra || {}) };
    try { ctx.sendToRenderer('cloud-checkout-state', payload); } catch {}
    if (typeof ctx.onCheckoutState === 'function') { try { ctx.onCheckoutState(payload); } catch {} }
  }

  function stopCheckoutWatch() {
    if (_checkoutWatch && _checkoutWatch.timer) clearTimeout(_checkoutWatch.timer);
    _checkoutWatch = null;
  }

  /**
   * After a checkout opens: poll status every 5 s for up to 3 minutes. The
   * watch lives in MAIN, not the Settings dialog, so a member who closes
   * Settings while paying still gets the "active" moment: a toast, a log
   * line, the banner cleared, and sync + tunnel told the account changed.
   */
  function startCheckoutWatch(plan, sessionId, origin) {
    stopCheckoutWatch();
    _checkoutWatch = { startedAt: Date.now(), plan, sessionId, timer: null, origin: origin || 'desktop' };
    sendCheckoutState();
    const tick = async () => {
      if (!_checkoutWatch) return;
      let sub = null;
      try { sub = await getCloudSync().getSubscriptionStatus(); } catch {}
      if (!_checkoutWatch) return;
      const d = CloudBillingUi.decideCheckoutPoll(_checkoutWatch.startedAt, Date.now(), sub);
      if (d.done) {
        const watched = _checkoutWatch;
        stopCheckoutWatch();
        if (d.result === 'active') {
          noteSubscription(sub, 'checkout');
          const plan = CloudBillingUi.PLANS[watched.plan] ? CloudBillingUi.PLANS[watched.plan].price : watched.plan;
          log(`[Cloud] Subscription active (Stripe, ${plan}) ${Math.round(d.elapsed / 1000)} s after checkout opened`);
          try { ctx.sendToRenderer('app-notice', { message: 'POTACAT Cloud is active. Thank you for subscribing.', duration: 8000 }); } catch {}
          try { cloudSessionChanged('subscription'); } catch {}
          sendCheckoutState({ phase: 'active', plan: watched.plan });
        } else {
          log('[Cloud] Checkout watch ended with no payment seen after 3 minutes (Refresh in Settings > Cloud picks it up later)');
          sendCheckoutState({ phase: 'timeout', plan: watched.plan });
        }
        return;
      }
      _checkoutWatch.timer = setTimeout(tick, d.nextInMs);
      if (_checkoutWatch.timer.unref) _checkoutWatch.timer.unref();
    };
    _checkoutWatch.timer = setTimeout(tick, CloudBillingUi.CHECKOUT_POLL_MS);
    if (_checkoutWatch.timer.unref) _checkoutWatch.timer.unref();
  }

  /**
   * POST /v1/stripe/checkout → the Stripe-hosted page. Returns {url} so a
   * web client can open it in its own tab; the desktop opens it here.
   */
  async function startCheckout(plan, origin, opts) {
    const settings = ctx.getSettings();
    if (!settings.cloudAccessToken) return { error: 'auth-required' };
    const p = plan === 'yearly' ? 'yearly' : 'monthly';
    try {
      const res = await getCloudSync()._authedRequest('POST', '/v1/stripe/checkout', { plan: p });
      if (!res || !res.url) return { error: 'checkout_failed' };
      _stripeConfigured = true;
      log(`[Cloud] Checkout opened (Stripe, ${CloudBillingUi.PLANS[p].price}) from ${origin || 'desktop'}`);
      if (!(opts && opts.noOpen)) shell.openExternal(res.url);
      startCheckoutWatch(p, res.sessionId || null, origin);
      return { ok: true, url: res.url, sessionId: res.sessionId || null, plan: p };
    } catch (err) {
      if (err.code === 'stripe_not_configured' || err.status === 503) {
        _stripeConfigured = false;
        log('[Cloud] Stripe checkout is not configured on the server; offering Buy Me a Coffee instead');
        return { error: 'stripe_not_configured' };
      }
      log(`[Cloud] Checkout failed: ${err.message}`);
      return { error: err.code || 'checkout_failed', message: err.message };
    }
  }

  /** POST /v1/stripe/portal → {url}. 404 no_stripe_customer = not a Stripe member. */
  async function portalUrl() {
    const settings = ctx.getSettings();
    if (!settings.cloudAccessToken) return { error: 'auth-required' };
    try {
      const res = await getCloudSync()._authedRequest('POST', '/v1/stripe/portal', {});
      if (!res || !res.url) return { error: 'portal_failed' };
      return { ok: true, url: res.url };
    } catch (err) {
      return { error: err.code || 'portal_failed', message: err.message };
    }
  }

  /** The billing strip's button: the server's url, else the Stripe portal, else BMAC. */
  async function openBillingAction(billing, origin) {
    const b = billing || {};
    if (b.action && b.action.url) {
      shell.openExternal(b.action.url);
      return { ok: true, opened: 'action' };
    }
    if (b.provider === 'stripe') {
      const r = await portalUrl();
      if (r.ok) { shell.openExternal(r.url); return { ok: true, opened: 'portal' }; }
      if (r.error !== 'no_stripe_customer') return r;
    }
    const settings = ctx.getSettings();
    shell.openExternal(settings.cloudBmacUrl || CloudBillingUi.BMAC_MEMBERSHIP_URL);
    return { ok: true, opened: 'bmac' };
  }

  /**
   * Manage subscription, by provider: Stripe → Customer Portal; BMAC → the
   * membership page; Apple/Google → the store. Reads the live status first
   * so the button always goes where this member actually pays.
   */
  async function openManage(origin) {
    const sub = (await refreshSubscription('manage')) || cachedSubscription();
    const m = CloudBillingUi.manageFor(sub);
    if (m && m.kind === 'portal') {
      if (m.url) { shell.openExternal(m.url); return { ok: true, opened: 'portal-link', provider: 'stripe' }; }
      const r = await portalUrl();
      if (r.ok) { shell.openExternal(r.url); return { ok: true, opened: 'portal', provider: 'stripe' }; }
      return r;
    }
    if (m && m.url) { shell.openExternal(m.url); return { ok: true, opened: 'url', provider: m.provider }; }
    // Donation / admin grant, trial, or no access: nothing to manage — the
    // subscribe section is the control. Fall back to the membership page so
    // an older server (no billing object) keeps its one working button.
    const settings = ctx.getSettings();
    shell.openExternal(settings.cloudBmacUrl || CloudBillingUi.BMAC_MEMBERSHIP_URL);
    return { ok: true, opened: 'bmac', provider: (sub && sub.billing && sub.billing.provider) || null };
  }

  // Subscribe: a plan → Stripe checkout. No plan (or {bmac:true}) → the
  // BuyMeACoffee membership page, the "prefer Buy Me a Coffee?" path.
  ipcMain.handle('cloud-open-subscribe', async (_e, arg) => {
    const plan = typeof arg === 'string' ? arg : (arg && arg.plan);
    const wantBmac = !plan || (arg && arg.bmac === true);
    if (wantBmac) {
      const settings = ctx.getSettings();
      shell.openExternal(settings.cloudBmacUrl || CloudBillingUi.BMAC_MEMBERSHIP_URL);
      log('[Cloud] Opened the Buy Me a Coffee membership page');
      return { success: true, opened: 'bmac' };
    }
    return startCheckout(plan, 'desktop');
  });

  ipcMain.handle('cloud-open-manage', async () => openManage('desktop'));
  ipcMain.handle('cloud-open-billing-action', async (_e, billing) => openBillingAction(billing, 'desktop'));
  ipcMain.handle('cloud-checkout-state', async () => checkoutState());
  ipcMain.handle('cloud-refresh-subscription', async () => refreshSubscription('refresh'));

  // The potacat.com join page, prefilled, for the signed-OUT card ("would
  // rather pay than trial"). A signed-in member never goes here: in-app
  // checkout carries their user id and needs no email matching.
  ipcMain.handle('cloud-open-join-page', async (_e, arg) => {
    const settings = ctx.getSettings();
    const url = CloudBillingUi.joinPageUrl({
      callsign: settings.myCallsign || '',
      plan: arg && arg.plan,
    });
    shell.openExternal(url);
    log('[Cloud] Opened the potacat.com join page');
    return { ok: true, url };
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
      // The share-rig dialog maps codes (subscription_required,
      // unauthorized) to its own copy — keep the code in `error` now that
      // err.message carries the server's human text. A 403 carries the
      // billing object (why access is off + the fix); pass it through.
      return { error: err.code || err.message, message: err.message, billing: (err.body && err.body.billing) || null };
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
      const result = await sync._authedRequest('DELETE', `/v1/passes/${encodeURIComponent(code)}`);
      // The cloud flips the row and closes the guest's sessions, but
      // nothing tells THIS shack: the dialog promised "kicked from the rig
      // immediately" and, until 2026-09-12, a connected guest kept the rig
      // until the pass's natural expiry. main.js ends the live session.
      if (result && result.revoked && typeof ctx.onPassRevoked === 'function') {
        try { ctx.onPassRevoked(String(code || '').trim().toLowerCase()); } catch {}
      }
      return result;
    } catch (err) {
      return { error: err.message };
    }
  });

  // Public API keys (Settings > Cloud > API keys). The API envelope's error
  // object rides back as {error: code, message, status} so the card can say
  // "set your callsign first" (422 callsign_required), "revoke one" (422
  // too_many_keys), or "the API is not available yet" (404 before the cloud
  // deploys it) instead of a generic failure.
  const apiKeyError = (err) => {
    const body = err && err.body;
    const e = body && body.error && typeof body.error === 'object' ? body.error : null;
    return {
      error: (e && e.code) || err.code || err.message || 'error',
      message: (e && e.message) || err.message || '',
      status: err.status || 0,
      hint: (e && e.hint) || '',
    };
  };
  ipcMain.handle('api-keys-list', async () => {
    try { const sync = getCloudSync(); return await sync.listApiKeys(); }
    catch (err) { return apiKeyError(err); }
  });
  ipcMain.handle('api-keys-create', async (_e, body) => {
    try { const sync = getCloudSync(); return await sync.createApiKey(body || {}); }
    catch (err) { return apiKeyError(err); }
  });
  ipcMain.handle('api-keys-revoke', async (_e, id) => {
    try { const sync = getCloudSync(); return await sync.revokeApiKey(String(id || '')); }
    catch (err) { return apiKeyError(err); }
  });
  ipcMain.handle('embed-settings-get', async () => {
    try { const sync = getCloudSync(); return await sync.getEmbedSettings(); }
    catch (err) { return apiKeyError(err); }
  });
  ipcMain.handle('embed-settings-put', async (_e, isPublic) => {
    try { const sync = getCloudSync(); return await sync.putEmbedSettings(!!isPublic); }
    catch (err) { return apiKeyError(err); }
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
   * The QSO log's change sink: qso-log.js (mutateLog / appendRecords) calls it
   * after every write. Everything is journaled while signed in, whether or
   * not background auto-sync is on. Gating on the auto-sync checkbox (off by
   * default) used to drop every change silently, and a later Sync Now then
   * pushed an empty journal and reported success.
   *
   * @param {Array<{action: 'create'|'update'|'delete', fields: object}>} changes
   */
  function recordLogChanges(changes) {
    recordLogChangesFor(currentOwnerId(), changes);
  }
  /** The same, labelled for a named account — "Log as" another operator. */
  function recordLogChangesFor(owner, changes) {
    if (!owner) return;
    const entries = [];
    for (const { action, fields } of changes) {
      const uuid = uuidOf(fields); // never a malformed id — it would 500 every push
      if (!uuid) continue;
      const version = versionOf(fields) + (action === 'delete' ? 1 : 0);
      entries.push({ uuid, action, adifFields: normalizeAdifFields({ ...fields }), version, owner });
    }
    journal.appendMany(entries);
  }

  /** Push everything pending for THIS account, pull everything new. */
  async function syncNow() {
    const view = myJournal();
    const result = await getCloudSync().sync(view, getSyncCallbacks());
    return { success: true, ...result, pending: view.length, ...(() => { const o = pendingStatus().pendingForOthers; return o.count ? { pendingForOthers: o } : {}; })() };
  }

  /**
   * Sign-in catch-up (cloud handoff 2026-09-18, POST /v1/sync/missing).
   * QSOs logged while signed out were never journaled, and nothing later
   * noticed. Now, at sign-in and once at boot: give every local record a
   * usable identity, ask the cloud which of them it does not hold, journal
   * those as creates for this account, and push. A tombstone counts as held,
   * so a QSO deleted on another device is not resurrected. Records already
   * queued as creates are not asked about — they are about to go anyway.
   */
  let _reconcileRunning = false;
  async function reconcileWithCloud(reason) {
    const owner = currentOwnerId();
    if (!owner || _reconcileRunning) return null;
    _reconcileRunning = true;
    try {
      const logPath = ctx.getLogPath();
      const identities = QsoLog.ensureIdentities(logPath, { sink: recordLogChanges });
      const queued = new Set(myJournal().getAll().filter((e) => e.action === 'create').map((e) => String(e.uuid).toLowerCase()));
      const byUuid = new Map();
      for (const q of readLog(logPath)) {
        const u = uuidOf(q);
        if (u && !queued.has(u.toLowerCase())) byUuid.set(u.toLowerCase(), q);
      }
      const missing = byUuid.size ? await getCloudSync().checkMissing([...byUuid.keys()]) : new Set();
      const entries = [];
      for (const u of missing) {
        const q = byUuid.get(u);
        if (q) entries.push({ uuid: q.APP_POTACAT_UUID, action: 'create', adifFields: normalizeAdifFields({ ...q }), version: versionOf(q), owner });
      }
      journal.appendMany(entries);
      const total = byUuid.size + queued.size;
      const notYet = entries.length + queued.size; // queued creates are, by definition, not there yet
      log(entries.length
        ? `[Cloud] Catch-up (${reason}): ${notYet} of ${total} local QSOs are not in the cloud yet — queued for upload` + (identities.length ? ` (${identities.length} given an identity first)` : '')
        : `[Cloud] Catch-up (${reason}): all ${total} local QSOs are in the cloud` + (queued.size ? ` or already queued (${queued.size})` : ''));
      let pushed = null;
      if (entries.length) {
        try { pushed = await syncNow(); } catch (err) { log('[Cloud] Catch-up push failed (will retry on the next sync): ' + err.message); }
      }
      return { checked: byUuid.size, missing: entries.length, identities: identities.length, pushed };
    } catch (err) {
      log('[Cloud] Catch-up check failed: ' + (err && err.message ? err.message : err));
      return null;
    } finally {
      _reconcileRunning = false;
    }
  }

  /**
   * Upload the whole local log. The server ignores uuids it already holds,
   * so this is also the recovery path for QSOs that never reached the cloud.
   *
   * Only the journal's CREATE entries for uploaded records are retired: the
   * upload never changes a row the server already holds, so pending edits and
   * deletions must still be pushed. (This used to clear the whole journal,
   * silently discarding them.) The pull cursor is left alone so the next sync
   * still fetches what other devices logged.
   */
  async function uploadFullLog(onProgress) {
    const logPath = ctx.getLogPath();
    const qsos = readLog(logPath);
    let assigned = false;
    for (const qso of qsos) {
      if (qso.APP_POTACAT_UUID) continue;
      qso.APP_POTACAT_UUID = crypto.randomUUID();
      qso.APP_POTACAT_VERSION = '1';
      assigned = true;
    }
    if (assigned) rewriteAdifFile(logPath, qsos);

    const result = await getCloudSync().bulkUpload(
      qsos.map((fields) => ({ uuid: fields.APP_POTACAT_UUID, adifFields: fields })),
      onProgress,
    );
    const uploaded = new Set(qsos.map((q) => q.APP_POTACAT_UUID));
    myJournal().removeWhere((e) => e.action === 'create' && uploaded.has(e.uuid));

    const settings = ctx.getSettings();
    settings.cloudLastSyncAt = new Date().toISOString();
    ctx.saveSettings(settings);
    return { success: true, imported: result.imported, duplicates: result.duplicates, total: qsos.length };
  }

  /**
   * Start background sync interval if cloud is enabled.
   */
  function startBackgroundSync() {
    const settings = ctx.getSettings();
    if (!settings.cloudSyncEnabled || !settings.cloudAccessToken) return;

    const sync = getCloudSync();
    const interval = settings.cloudSyncInterval || 60;
    // The view is bound to the account signed in NOW; cloudSessionChanged
    // restarts the interval on a new view when that changes.
    sync.startInterval(interval, myJournal(), getSyncCallbacks());
  }

  /**
   * Stop background sync.
   */
  function stopBackgroundSync() {
    if (cloudSync) cloudSync.stopInterval();
  }

  /**
   * The signed-in account changed — Settings-tab sign-in/register/sign-out,
   * the OAuth exchange, or the ECHOCAT bridge's own login paths in main.js
   * all end here. Drop the cached client (stopping ITS sync timer) so the
   * next getCloudSync() reads the tokens now in settings, restart
   * background sync against them (a no-op when signed out or sync is off),
   * then let main.js re-bind whatever else captured a client — the
   * cloud_devices heartbeat holds one for its lifetime. Until 2026-09-12
   * the Settings-tab paths only nulled the reference: the previous
   * account's sync timer kept firing with its tokens, and the heartbeat
   * kept ticking on the old client while its "already registered" early
   * return meant the new account never got a device row.
   */
  function cloudSessionChanged(reason) {
    if (cloudSync) cloudSync.stopInterval();
    cloudSync = null;
    startBackgroundSync();
    if (typeof ctx.onCloudSessionChanged === 'function') {
      try { ctx.onCloudSessionChanged(reason); } catch {}
    }
    if (reason !== 'signout') {
      // Whatever was logged while nobody (or someone else) was signed in.
      const t = setTimeout(() => { reconcileWithCloud(reason).catch(() => {}); }, 1500);
      if (t && t.unref) t.unref(); // never the thing that keeps the process alive
    }
  }

  return {
    journal,
    recordLogChanges,
    recordLogChangesFor,
    ownerIdFor,
    syncNow,
    uploadFullLog,
    reconcileWithCloud,
    pendingStatus,
    currentOwnerId,
    startBackgroundSync,
    stopBackgroundSync,
    cloudSessionChanged,
    getCloudSync,
    getSyncCallbacks, // exposed for tests (cross-device dupe merge)
    // Billing (Stripe checkout/portal, strip action, launch check) — shared
    // with the ECHOCAT web bridge in main.js.
    refreshSubscription,
    refreshBillingIfStale,
    cachedSubscription,
    startCheckout,
    portalUrl,
    openBillingAction,
    openManage,
    checkoutState,
    localQsoCount,
  };
}

module.exports = { registerCloudIpc, ownerIdFor };
