'use strict';

const { ipcMain, dialog, shell } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
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
const CloudPullForward = require('./cloud-pull-forward');
const { createSyncLogger, shouldRepullHistory, repullLine } = require('./cloud-sync-log');
const CloudRevoked = require('./cloud-revoked');
const CloudDeleteGuard = require('./cloud-delete-guard');

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
 *   ctx.getActiveProfile - () => the active operator profile's callsign (optional)
 *   ctx.listProfiles  - () => [{ call, owner }] every operator profile on this
 *                       PC and the cloud account it is signed in to (owner
 *                       null when signed out). Optional; absent = one profile.
 *   ctx.forwardPulledQso - async (adifFields, { only }) => forwardToLoggers'
 *                       result: send one pulled QSO to the external loggers
 *                       (GitHub #267); `only` names the destinations of a
 *                       retry (#838). Optional; absent = the pull forwards
 *                       nothing.
 *   ctx.hasPairedDevice - () => boolean: this profile has a paired ECHOCAT
 *                       device. Absent = false (only the any-device setting,
 *                       #838, can then forward).
 *   ctx.deviceRevokedSteps - { stopDevice, stopTunnel, stopOther, notify }:
 *                       main.js's part of the sign-out when Cloud answers
 *                       device_revoked (lib/cloud-revoked.js). Optional.
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
  // Session-log lines for sync: a cycle that changed something, an error
  // (once until a cycle succeeds), and why background sync is not running.
  const syncLog = createSyncLogger(log);
  const signedInNow = () => !!(ctx.getSettings() || {}).cloudAccessToken;

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
  /**
   * The active operator profile's callsign (upper-case), or null when the
   * host does not say. GitHub #245: two profiles on one PC can share one
   * cloud account, and the journal and the pull must keep them apart.
   */
  function activeProfileCall() {
    let p = '';
    try { p = typeof ctx.getActiveProfile === 'function' ? ctx.getActiveProfile() : (ctx.getSettings() || {}).activeProfile; } catch {}
    return SyncJournal.normProfile(p);
  }
  /**
   * The OTHER profiles on this PC: `all` = every one (the duplicate guard
   * must never touch their records), `sameAccount` = those signed in to the
   * account now syncing (their QSOs reach them through their own pull, so
   * this profile leaves them out). Empty when the active profile is unknown
   * — never guess which profile this is.
   */
  function otherProfiles() {
    const all = new Set();
    const sameAccount = new Set();
    const active = activeProfileCall();
    if (!active || typeof ctx.listProfiles !== 'function') return { all, sameAccount };
    let list = [];
    try { list = ctx.listProfiles() || []; } catch {}
    const owner = currentOwnerId();
    for (const p of list) {
      const call = SyncJournal.normProfile(p && typeof p === 'object' ? p.call : p);
      if (!call || call === active) continue;
      all.add(call);
      if (owner && p && typeof p === 'object' && p.owner && String(p.owner) === owner) sameAccount.add(call);
    }
    return { all, sameAccount };
  }

  // One-time migration (#245): a journal written before profile stamps
  // becomes the active profile's. Silent; the pull cursor is untouched.
  {
    const claimed = journal.claimUnstamped(activeProfileCall());
    if (claimed) log(`[Cloud] sync journal: ${claimed} pending change(s) now belong to profile ${activeProfileCall()}`);
  }

  /**
   * This account's view of the journal — the only thing the sync cycle sees.
   * PUSHES stay account-wide (#245 review): the server holds one flat QSO
   * set per account, so any profile signed in to the account pushes every
   * pending entry for it, whichever profile stamped it ("Log as" a
   * same-account profile reaches the cloud at once). The profile stamp
   * records whose change it is; it never holds a push back.
   */
  const myJournal = () => journal.forOwner(currentOwnerId());

  // --- Delete guard (#245, lib/cloud-delete-guard.js) ----------------------
  // What the sync cycle pushes: myJournal() less the deletes the guard holds
  // (another profile's QSOs, or more than DELETE_LIMIT in an hour) until the
  // operator answers one dialog. Held deletes stay in the journal.
  const deleteGuardPath = path.join(userDataPath, 'cloud-delete-guard.json');
  function readSentTimes() {
    try { const j = JSON.parse(fs.readFileSync(deleteGuardPath, 'utf-8')); return Array.isArray(j.sent) ? j.sent : []; } catch { return []; }
  }
  function noteDeletesSent(n) {
    if (!n) return;
    const now = Date.now();
    const sent = CloudDeleteGuard.pruneSent(readSentTimes(), now).concat(Array(n).fill(now));
    try { fs.writeFileSync(deleteGuardPath, JSON.stringify({ sent }), 'utf-8'); } catch {}
  }
  let lastHeldLine = '';
  let deleteDialogOpen = false;
  /** Ask once about these held deletes; mark them; push at once on "delete". */
  async function askAboutHeldDeletes(ask) {
    if (deleteDialogOpen || !ask.length) return;
    deleteDialogOpen = true;
    try {
      const others = otherProfiles().all;
      const t = CloudDeleteGuard.dialogText(ask, { otherProfiles: others });
      let choice = t.keepIndex;
      try {
        if (typeof ctx.confirmCloudDeletes === 'function') {
          choice = (await ctx.confirmCloudDeletes(t)) ? t.deleteIndex : t.keepIndex;
        } else if (dialog && typeof dialog.showMessageBox === 'function') {
          const parent = typeof ctx.win === 'function' ? ctx.win() : ctx.win;
          const opts = { type: 'warning', title: t.title, message: t.message, detail: t.detail, buttons: t.buttons, defaultId: t.keepIndex, cancelId: t.keepIndex, noLink: true };
          const r = parent && !parent.isDestroyed?.() ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
          choice = r && Number.isInteger(r.response) ? r.response : t.keepIndex;
        } else {
          return; // no way to ask: they stay held, unanswered
        }
      } catch (err) {
        log('[Cloud] sync: could not ask about held deletions: ' + (err && err.message ? err.message : err));
        return;
      }
      if (choice === t.deleteIndex) {
        journal.markDeleteGuard(ask, CloudDeleteGuard.CONFIRMED);
        log(`[Cloud] sync: operator confirmed ${ask.length} QSO deletion(s) for the Cloud`);
        lastHeldLine = '';
        // Send them now; the cycle that asked may still be running.
        const sendNow = (tries) => {
          const c = cloudSync;
          if (c && c._syncing && tries > 0) { const t = setTimeout(() => sendNow(tries - 1), 250); if (t.unref) t.unref(); return; }
          syncNow().catch(() => {});
        };
        sendNow(40);
      } else {
        journal.markDeleteGuard(ask, CloudDeleteGuard.DECLINED);
        log(`[Cloud] sync: operator kept ${ask.length} QSO(s) in the Cloud — the deletions stay on this computer only`);
      }
    } finally {
      deleteDialogOpen = false;
    }
  }
  /** The journal view the sync cycle pushes from. */
  function pushJournal() {
    const view = myJournal();
    const plan = () => CloudDeleteGuard.planPush(view.getAll(), {
      now: Date.now(), sentTimes: readSentTimes(), otherProfiles: otherProfiles().all,
    });
    return {
      get hasPending() { const p = plan(); return p.send.length > 0 || p.ask.length > 0; },
      get length() { return view.length; },
      getAll() {
        const p = plan();
        if (p.held.length) {
          const line = CloudDeleteGuard.heldLine(p.held);
          if (line !== lastHeldLine) { lastHeldLine = line; log(line); }
        }
        if (p.ask.length) askAboutHeldDeletes(p.ask).catch(() => {});
        return p.send;
      },
      removeEntries(entries) {
        view.removeEntries(entries);
        noteDeletesSent(entries.filter((e) => e && e.action === 'delete').length);
      },
      removeWhere(pred) { view.removeWhere(pred); },
    };
  }
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
        if (status === 'error') syncLog.failed(detail, { signedIn: signedInNow() });
      });

      cloudSync.on('progress', (phase, current, total) => {
        ctx.sendToRenderer('cloud-upload-progress', { phase, current, total });
      });

      // This computer was removed from the account. Only the CURRENT client
      // signs the app out: a call still in flight on a client dropped by a
      // session change must not sign out the account signed in since.
      const client = cloudSync;
      client.on('device-revoked', (err) => {
        if (cloudSync !== client) return;
        signOutRevoked(err);
      });
    }
    return cloudSync;
  }

  // --- Removed from the account (device_revoked) -----------------------
  // The steps run once, in the order lib/cloud-revoked.js gives, until the
  // next sign-in resets the handler (cloudSessionChanged).
  const extraSteps = ctx.deviceRevokedSteps || {};
  const revokedHandler = CloudRevoked.createDeviceRevokedHandler({
    clearTokens: (text) => {
      // The fields Sign Out clears, plus the reason the Cloud card shows.
      const settings = ctx.getSettings();
      settings.cloudAccessToken = null;
      settings.cloudRefreshToken = null;
      settings.cloudUser = null;
      settings.cloudLastSyncTimestamp = null;
      settings.cloudLastSyncAt = null;
      settings.cloudSignedOutNotice = text;
      ctx.saveSettings(settings);
    },
    stopSync: () => {
      stopCheckoutWatch();
      // Drops the client (its sync timer with it); background sync does not
      // restart without a token; main.js tears down the device heartbeat.
      cloudSessionChanged('revoked');
    },
    stopDevice: extraSteps.stopDevice,
    stopTunnel: extraSteps.stopTunnel,
    stopOther: extraSteps.stopOther,
    notify: (text) => {
      try { ctx.sendToRenderer('cloud-signed-out', { reason: CloudRevoked.DEVICE_REVOKED, message: text }); } catch {}
      if (typeof extraSteps.notify === 'function') extraSteps.notify(text);
    },
  }, log);

  /**
   * Cloud answered device_revoked (from a CloudSyncClient call, or from a
   * request main.js made itself, e.g. the Guest Pass redeem): sign out.
   * @param {Error|object|string} source - the error, the response body, or the text
   * @returns {boolean} true when this call signed out (false: already did)
   */
  function signOutRevoked(source) {
    return revokedHandler.handle(source);
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
   * Several profiles on one PC (GitHub #245): the account's QSO set is
   * flat, so a NEW QSO whose STATION_CALLSIGN is another profile here,
   * signed in to the same account, is left out of this profile's log — that
   * profile pulls it into its own. Only that: a QSO for any other station
   * call (a single profile logging /P or /M) or with no STATION_CALLSIGN
   * arrives as before. Updates and deletes of records already in this log
   * are applied as before.
   *
   * GitHub #267: a NEW record that is this station's own, logged on a paired
   * phone off-grid, is also forwarded to the external loggers once the log
   * is written (forwardPulled; the rule is lib/cloud-pull-forward.js).
   *
   * @param {boolean} [opts.serverWins] - conflict resolution: the server's
   *   copy replaces the local record even at an EQUAL version (the local
   *   record carries the version this device just pushed and lost with).
   *   Never forwards.
   * @param {boolean} [opts.backfill] - this pull started with no cursor (the
   *   account's history): nothing is forwarded.
   * @returns {Promise<object>|undefined} the forwarding's outcome (tests)
   */
  function mergePulledQsos(pulledQsos, { serverWins = false, backfill = false } = {}) {
    if (!pulledQsos || pulledQsos.length === 0) return;
    const logPath = ctx.getLogPath();
    const activeProfile = activeProfileCall();
    const others = otherProfiles();
    const stationOf = (f) => SyncJournal.normProfile(f && f.STATION_CALLSIGN);
    const skipped = new Map(); // station call -> count left out for another profile
    let keptApart = 0; // look-alikes the duplicate guard left alone (another profile's)
    const localQsos = readLog(logPath);
    const contacts = new ContactIndex(localQsos);

    // Build UUID index. Absorbed-duplicate aliases (APP_POTACAT_MERGED_UUIDS,
    // see the sameContact branch below) resolve to the surviving record so
    // later ops on a dead uuid don't re-append it.
    // Keys are lower-cased: the Cloud's uuid column answers in lower case,
    // and a log written by another program can hold the same uuid in upper
    // case. A case miss here used to make the pull treat the operator's own
    // QSO as a stranger's look-alike (#245).
    const uuidKey = (u) => String(u || '').toLowerCase();
    const uuidIndex = new Map();
    const reindex = () => {
      uuidIndex.clear();
      for (let i = 0; i < localQsos.length; i++) {
        const uuid = localQsos[i].APP_POTACAT_UUID;
        if (uuid) uuidIndex.set(uuidKey(uuid), i);
        const aliases = localQsos[i].APP_POTACAT_MERGED_UUIDS;
        if (aliases) for (const a of aliases.split(',')) { if (a) uuidIndex.set(uuidKey(a), i); }
      }
    };
    reindex();

    let needsRewrite = false;
    const toAppend = [];
    // #267: records this pull adds, uuid -> { raw cloud fields, log fields }.
    const candidates = new Map();

    for (const pulled of pulledQsos) {
      // Rows stored before the server's 2026-09-17 normalizer can still
      // arrive with pseudo field names (CALLSIGN, QSODATE, ...).
      const remote = { ...pulled, adifFields: normalizeAdifFields(pulled.adifFields || {}) };
      const localIdx = uuidIndex.get(uuidKey(remote.uuid));

      if (remote.isDeleted) {
        // Only delete when the uuid is the record's PRIMARY identity. An
        // alias hit here is our own absorbed-duplicate tombstone echoing
        // back from the cloud — deleting on it would kill the real QSO.
        if (localIdx !== undefined && uuidKey(localQsos[localIdx].APP_POTACAT_UUID) === uuidKey(remote.uuid)) {
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
        // Another profile's QSO on this account (#245): it is theirs to pull.
        const station = stationOf(fields);
        if (station && others.sameAccount.has(station)) {
          skipped.set(station, (skipped.get(station) || 0) + 1);
          continue;
        }
        // Cross-device double-report guard (see sameContact above): if this
        // is content-identical to a QSO we already hold under another uuid,
        // absorb it — keep the (richer) local record and remember the alias.
        // It is NEVER deleted in the Cloud (#245): the pulled row is a live
        // QSO of this account, and the "duplicate" can be the only copy the
        // Cloud has. Two logs holding one contact under two uuids each
        // tombstoned the OTHER's, and both copies died — thousands of QSOs
        // in one pull. Removing a real double report from the
        // Cloud is the operator's call, through Find Duplicates.
        const dup = contacts.findMatch(fields);
        const dupIdx = dup ? localQsos.indexOf(dup) : -1;
        // Never absorb or tombstone a record of another profile on this PC
        // (#245: the guard tombstoned 39,816 of LZ3AW's records from the /P
        // profile, and the LZ3AW profile then deleted its own log).
        // Nor one logged under a different station callsign (#245, accounts
        // with several callsigns): K0ABC and K0ABC/P working the same
        // station a minute apart are two QSOs, not one reported twice.
        const dupStation = dupIdx !== -1 ? stationOf(dup) : null;
        const crossStation = dupIdx !== -1 && !!station && !!dupStation && station !== dupStation;
        const crossProfile = dupIdx !== -1 && (crossStation || others.all.has(station) || others.all.has(dupStation));
        if (crossProfile) keptApart++;
        if (dupIdx !== -1 && !crossProfile) {
          const local = localQsos[dupIdx];
          // #267: a phone copy this batch just added, matched now by a
          // DESKTOP's record of the same contact: another PC logged it live
          // (and forwarded it there). Not ours to forward.
          if (candidates.has(local.APP_POTACAT_UUID) && CloudPullForward.isDesktopRecord(pulled.adifFields)) {
            candidates.delete(local.APP_POTACAT_UUID);
          }
          const aliases = (local.APP_POTACAT_MERGED_UUIDS || '').split(',').filter(Boolean);
          if (!aliases.some((a) => uuidKey(a) === uuidKey(remote.uuid))) aliases.push(remote.uuid);
          local.APP_POTACAT_MERGED_UUIDS = aliases.join(',');
          uuidIndex.set(uuidKey(remote.uuid), dupIdx);
          needsRewrite = true;
          console.log(`[Cloud] Absorbed cross-device duplicate of ${fields.CALL} ${fields.QSO_DATE} ${fields.TIME_ON} (uuid ${remote.uuid} → ${local.APP_POTACAT_UUID})`);
          continue;
        }
        // Mirror into localQsos too so a second copy of the same contact
        // later in THIS batch hits the sameContact guard (fresh-device full
        // pull is exactly where existing cross-device dupes arrive together).
        toAppend.push(fields);
        if (!serverWins) candidates.set(remote.uuid, { raw: pulled.adifFields || {}, fields });
        localQsos.push(fields);
        contacts.add(fields);
        uuidIndex.set(uuidKey(remote.uuid), localQsos.length - 1);
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

    if (skipped.size) {
      const parts = [...skipped].map(([call, n], i) => (i === 0 ? `${n} QSO(s) for ${call}` : `${n} for ${call}`));
      const many = skipped.size > 1;
      log(`[Cloud] pull: ${parts.join(', ')} belong to ${many ? 'other profiles' : 'another profile'} on this PC — left out of ${activeProfile}'s log`);
    }
    if (keptApart) {
      log(`[Cloud] pull: ${keptApart} QSO(s) look like another profile's record in ${activeProfile}'s log — kept apart, not merged`);
    }
    if (serverWins) return undefined;
    return forwardPulled([...candidates.values()], { backfill });
  }

  // --- GitHub #267 / #838: this station's QSOs that arrive by pull, to the external loggers ---
  let forwardStore = null;
  const getForwardStore = () => forwardStore
    || (forwardStore = new CloudPullForward.ForwardedStore(path.join(userDataPath, 'cloud-pull-forwarded.json')));
  // #838: Settings > Logbook "Send QSOs from my other devices", on unless
  // turned off. On: this station's QSOs logged on ANY device that is not a
  // desktop (a guest device, a phone never paired here) are forwarded, and a
  // refused send is retried. Off: nothing that arrives by pull is forwarded.
  const anyDeviceOn = () => (ctx.getSettings() || {}).forwardSyncedQsos !== false;

  /**
   * Start forwarding for the signed-in account the first time this PC syncs
   * it with this rule: only QSOs logged from now on can be forwarded, so an
   * account's history never reaches the loggers. Returns false when it was
   * not started before this call. The any-device setting (#838) has its own
   * start, the first time it is on here: an upgrade sends nothing already
   * logged on a device this PC was not paired with.
   */
  function armPullForwarding() {
    if (typeof ctx.forwardPulledQso !== 'function') return false;
    const owner = currentOwnerId();
    if (!owner) return false;
    const store = getForwardStore();
    if (anyDeviceOn() && !Number.isFinite(store.sinceAnyFor(owner))) {
      store.startAnyFor(owner);
      log('[Cloud] pull: QSOs of this station logged on any of your devices will reach the external loggers from now on (earlier ones are not sent)');
    }
    if (Number.isFinite(store.sinceFor(owner))) return true;
    store.startFor(owner);
    log('[Cloud] pull: phone QSOs logged off-line will reach the external loggers from now on (earlier ones are not sent)');
    return false;
  }

  /**
   * Forward the records a pull added that are this station's own, logged on a
   * paired phone or (#838) on any other device that is not a desktop
   * (lib/cloud-pull-forward.js), each at most once. A destination
   * that refuses one is owed a retry (#838: drainForwardRetries).
   */
  async function forwardPulled(candidates, { backfill = false } = {}) {
    const out = { forwarded: 0, uuids: [], retrying: 0 };
    if (typeof ctx.forwardPulledQso !== 'function') return out;
    const owner = currentOwnerId();
    if (!owner) return out;
    if (!armPullForwarding()) return out; // first sync with this rule: start the clock, send nothing
    if (backfill || !candidates.length) return out;
    if (!anyDeviceOn()) return out; // the operator turned it off
    let paired = false;
    try { paired = typeof ctx.hasPairedDevice === 'function' && !!ctx.hasPairedDevice(); } catch {}
    const anyDevice = true;
    const s = ctx.getSettings() || {};
    const myCalls = [s.myCallsign, activeProfileCall()].filter(Boolean);
    const store = getForwardStore();
    const sinceMs = store.sinceFor(owner);
    const sinceAnyMs = store.sinceAnyFor(owner);
    const go = [];
    for (const c of candidates) {
      const uuid = c.fields.APP_POTACAT_UUID;
      if (!uuid || store.has(uuid)) continue;
      if (CloudPullForward.judgePulledQso(c.raw, c.fields, { myCalls, sinceMs, paired, anyDevice, sinceAnyMs }).forward) go.push(c);
    }
    if (!go.length) return out;
    // Recorded BEFORE the send: a crash mid-send may lose one, never repeat one.
    store.add(go.map((c) => c.fields.APP_POTACAT_UUID));
    log(`[Cloud] pull: ${go.length} QSO(s) of ${myCalls[0] || 'this station'} logged on another device — forwarding to the external loggers`);
    const profile = activeProfileCall() || '';
    for (const c of go) {
      const uuid = c.fields.APP_POTACAT_UUID;
      let failed = [];
      try {
        failed = CloudPullForward.failedDestinations(await ctx.forwardPulledQso(c.fields, {}));
        out.forwarded++;
        out.uuids.push(uuid);
      } catch (err) {
        log(`[Cloud] pull: forwarding ${c.fields.CALL || '?'} to the external loggers failed: ${err.message}`);
        failed = CloudPullForward.enabledDestinations(ctx.getSettings());
      }
      const next = CloudPullForward.afterAttempt({ owner, profile }, failed);
      if (next.entry) {
        store.setPending(uuid, next.entry);
        out.retrying++;
        log(`[Cloud] pull: ${c.fields.CALL || '?'} did not reach ${next.entry.left.join(', ')}; POTACAT will try again`);
      }
    }
    scheduleForwardRetries();
    return out;
  }

  /**
   * #838: try again the destinations that refused a pulled QSO (the logger was
   * not running, Wavelog or QRZ did not answer). Only the active profile's own
   * retries for the signed-in account; the record is read from this profile's
   * log now, so an edit goes out as edited and a deleted QSO is dropped.
   * `force` tries every one owed now, not only those due (after a pull).
   */
  let draining = false;
  async function drainForwardRetries({ force = false, now = Date.now() } = {}) {
    const out = { sent: 0, waiting: 0, dropped: 0 };
    if (draining || typeof ctx.forwardPulledQso !== 'function' || !anyDeviceOn()) return out;
    const owner = currentOwnerId();
    if (!owner) return out;
    const store = getForwardStore();
    const owed = store.pendingFor(owner, activeProfileCall() || '');
    if (!owed.length) return out;
    draining = true;
    try {
      let byUuid = null;
      for (const e of owed) {
        if (!force && Number.isFinite(e.nextAt) && e.nextAt > now) { out.waiting++; continue; }
        const { uuid, ...entry } = e;
        const targets = CloudPullForward.retryTargets(entry, ctx.getSettings());
        if (!byUuid) {
          byUuid = new Map();
          for (const r of readLog(ctx.getLogPath())) if (r.APP_POTACAT_UUID) byUuid.set(r.APP_POTACAT_UUID, r);
        }
        const fields = byUuid.get(uuid);
        if (!fields || !targets.length) { store.setPending(uuid, null); out.dropped++; continue; }
        let failed = [];
        try {
          failed = CloudPullForward.failedDestinations(await ctx.forwardPulledQso(fields, { only: targets }));
        } catch (err) {
          failed = targets;
        }
        const next = CloudPullForward.afterAttempt(entry, failed, now);
        store.setPending(uuid, next.entry);
        if (next.entry) out.waiting++;
        else if (next.gaveUp) log(`[Cloud] ${fields.CALL || '?'} ${fields.QSO_DATE || ''} still did not reach ${next.left.join(', ')} after 3 days; POTACAT stopped trying. Use Resend to Logbook in the Logbook to send it.`);
        else { out.sent++; log(`[Cloud] ${fields.CALL || '?'} ${fields.QSO_DATE || ''} reached ${targets.join(', ')} on a later try`); }
      }
    } finally {
      draining = false;
    }
    scheduleForwardRetries(now);
    return out;
  }

  // One timer, set to the soonest retry owed; none while nothing is owed.
  let retryTimer = null;
  function scheduleForwardRetries(now = Date.now()) {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (typeof ctx.forwardPulledQso !== 'function') return;
    const at = getForwardStore().nextDue();
    if (!Number.isFinite(at)) return;
    const wait = Math.min(Math.max(at - now, 5000), 3600 * 1000);
    retryTimer = setTimeout(() => { retryTimer = null; drainForwardRetries().catch(() => {}); }, wait);
    if (retryTimer.unref) retryTimer.unref(); // never the thing that keeps the process alive
  }
  // Retries a previous run still owed.
  try { scheduleForwardRetries(); } catch {}

  function getSyncCallbacks() {
    return {
      // The saved cursor is only updated by onSynced, after this: none = this
      // pull is the account's history on this PC (#267: never forwarded).
      onPulled: async (qsos) => {
        const out = await mergePulledQsos(qsos, { backfill: !(ctx.getSettings() || {}).cloudLastSyncTimestamp });
        // #838: each sync also retries what a logger refused earlier, when due.
        await drainForwardRetries().catch(() => {});
        return out;
      },
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
      onSynced: (summary) => {
        syncLog.synced(summary, { signedIn: signedInNow() });
        const settings = ctx.getSettings();
        const since = cloudSync && cloudSync.lastSyncTimestamp;
        if (since) settings.cloudLastSyncTimestamp = since;
        settings.cloudLastSyncAt = new Date().toISOString();
        ctx.saveSettings(settings);
        armPullForwarding(); // #267: the first cycle starts the forwarding clock
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

  // Cheap, no network: signed in or not, and why not when Cloud signed this
  // computer out (Share My Rig's warning line, the Cloud card).
  ipcMain.handle('cloud-session-get', () => {
    const s = ctx.getSettings() || {};
    const loggedIn = !!s.cloudAccessToken;
    return {
      loggedIn,
      signedOutNotice: loggedIn ? null : (s.cloudSignedOutNotice || null),
      guestPassNotice: loggedIn ? null : CloudRevoked.GUEST_PASS_SIGNED_OUT_TEXT,
    };
  });

  ipcMain.handle('cloud-get-status', async () => {
    try {
      const settings = ctx.getSettings();
      if (!settings.cloudAccessToken) {
        return { loggedIn: false, signedOutNotice: settings.cloudSignedOutNotice || null };
      }

      const sync = getCloudSync();
      const [syncStatus, subStatus, me] = await Promise.all([
        sync.getStatus().catch(() => null),
        sync.getSubscriptionStatus().catch(() => null),
        sync.getMe().catch(() => null),
      ]);
      // One of those answered device_revoked: signed out while we asked.
      if (!ctx.getSettings().cloudAccessToken) {
        return { loggedIn: false, signedOutNotice: ctx.getSettings().cloudSignedOutNotice || null };
      }

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

  // ── Guest Pass — desktop-side issue/list/revoke (#46c) ──────────────
  // The mobile app has the same form (Phase 2 #45a). Adding it on
  // desktop because owners often have the desktop in front of them
  // when they want to hand the rig to a friend.

  ipcMain.handle('passes-issue', async (_e, body) => {
    try {
      const sync = getCloudSync();
      // shackDeviceId: with a Cloud address per shack (lib/cloud-shacks.js) the
      // pass leads to THIS shack's address; an older server ignores it.
      const dev = ctx.getSettings().cloudDeviceId;
      return await sync._authedRequest('POST', '/v1/passes', dev ? { ...(body || {}), shackDeviceId: dev } : body);
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
  /**
   * The same, labelled for a named account — "Log as" another operator —
   * and for that operator's profile (default: the active one).
   */
  function recordLogChangesFor(owner, changes, profile = activeProfileCall()) {
    if (!owner) return;
    const entries = [];
    for (const { action, fields } of changes) {
      const uuid = uuidOf(fields); // never a malformed id — it would 500 every push
      if (!uuid) continue;
      const version = versionOf(fields) + (action === 'delete' ? 1 : 0);
      entries.push({ uuid, action, adifFields: normalizeAdifFields({ ...fields }), version, owner, profile });
    }
    journal.appendMany(entries);
  }

  /**
   * Before a Sync Now: if this log holds fewer QSOs than the Cloud while a
   * pull cursor is saved, forget the cursor so the pull brings the whole
   * history again (lib/cloud-sync-log.js shouldRepullHistory). Clearing the
   * saved cursor too makes the merge treat it as a backfill: nothing pulled
   * this way is forwarded to the external loggers (#267). A failed count
   * check changes nothing.
   */
  async function repullIfHistoryMissing(sync) {
    const settings = ctx.getSettings() || {};
    const hasCursor = !!(settings.cloudLastSyncTimestamp || sync.lastSyncTimestamp);
    if (!hasCursor) return false;
    // Another profile here shares this account (#245): this log holds only
    // this profile's QSOs and the Cloud's count is the whole account's, so
    // the log is always "short". Comparing them re-pulled the whole history
    // on every Sync Now and every sign-in catch-up.
    if (otherProfiles().sameAccount.size) return false;
    let cloudCount = null;
    try {
      const st = await sync.getStatus();
      cloudCount = st && Number.isFinite(st.totalQsos) ? st.totalQsos : null;
    } catch { return false; }
    const localCount = localQsoCount();
    if (!shouldRepullHistory({ cloudCount, localCount, hasCursor })) return false;
    log(repullLine({ cloudCount, localCount }));
    sync.resetPullCursor();
    settings.cloudLastSyncTimestamp = null;
    ctx.saveSettings(settings);
    return true;
  }

  /** Push everything pending for THIS account, pull everything new. */
  async function syncNow() {
    const view = pushJournal();
    const sync = getCloudSync();
    await repullIfHistoryMissing(sync);
    const result = await sync.sync(view, getSyncCallbacks());
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
        if (q) entries.push({ uuid: q.APP_POTACAT_UUID, action: 'create', adifFields: normalizeAdifFields({ ...q }), version: versionOf(q), owner, profile: activeProfileCall() });
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
    syncLog.background({ signedIn: !!settings.cloudAccessToken, syncEnabled: !!settings.cloudSyncEnabled });
    if (!settings.cloudSyncEnabled || !settings.cloudAccessToken) return;

    const sync = getCloudSync();
    const interval = settings.cloudSyncInterval || 60;
    // The view is bound to the account signed in NOW; cloudSessionChanged
    // restarts the interval on a new view when that changes.
    sync.startInterval(interval, pushJournal(), getSyncCallbacks());
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
    if (reason !== 'revoked') {
      // A sign-in, or a Sign Out the operator chose: the removed-computer
      // notice has done its job, and the next device_revoked acts again.
      revokedHandler.reset();
      const s = ctx.getSettings();
      if (s && s.cloudSignedOutNotice) { s.cloudSignedOutNotice = null; ctx.saveSettings(s); }
    }
    startBackgroundSync();
    if (typeof ctx.onCloudSessionChanged === 'function') {
      try { ctx.onCloudSessionChanged(reason); } catch {}
    }
    if (!isSignOutReason(reason)) {
      // Whatever was logged while nobody (or someone else) was signed in.
      const t = setTimeout(() => { reconcileWithCloud(reason).catch(() => {}); }, 1500);
      if (t && t.unref) t.unref(); // never the thing that keeps the process alive
    }
  }

  return {
    journal,
    signOutRevoked,
    signedOutNotice: () => (ctx.getSettings() || {}).cloudSignedOutNotice || null,
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
    drainForwardRetries, // #838: retry pulled QSOs a logger refused (main.js after a Settings save; tests)
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

/** A session change that leaves this computer signed out. */
function isSignOutReason(reason) {
  return reason === 'signout' || reason === 'revoked';
}

module.exports = { registerCloudIpc, ownerIdFor, isSignOutReason };
