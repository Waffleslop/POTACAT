'use strict';

const fs = require('fs');
const path = require('path');

/**
 * SyncJournal - Append-only change journal for offline-first cloud sync.
 *
 * Tracks local QSO changes (create, update, delete) since the last
 * successful sync. An entry leaves the journal only once the server has
 * RESOLVED it — accepted it, or answered with a conflict that the caller
 * has merged. Entries are removed by identity (the exact objects that were
 * pushed), never by uuid: an edit made while a push is in flight shares the
 * uuid of the entry being pushed and must survive it.
 *
 * Every entry is stamped with the ACCOUNT that was signed in when it was
 * written (`owner`). A push only ever carries the signed-in account's
 * entries — see forOwner(). Until 2026-09-18 the journal had no notion of
 * an owner, so on a shared shack PC whoever signed in next pushed the
 * previous operator's QSOs into their own cloud logbook, correctly
 * authenticated as themselves, with nothing on either screen to say so.
 *
 * Entries are also stamped with the operator PROFILE that wrote them
 * (`profile`, the profile's callsign, GitHub #245). Two profiles on one PC
 * can be signed in to the same account (LZ3AW and LZ3AW/P). The sync cycle
 * still pushes account-wide — the server holds one flat QSO set per account,
 * so any profile of that account may push any of its entries — and the stamp
 * records whose change it is. forOwner(owner, profile) can narrow a view to
 * one profile where a caller needs that; the push does not.
 *
 * File format: JSON array in {userData}/sync-journal.json
 */
class SyncJournal {
  constructor(userDataPath, { log = console.warn } = {}) {
    this._filePath = path.join(userDataPath, 'sync-journal.json');
    this._log = log;
    this._entries = [];
    this._load();
  }

  _load() {
    if (!fs.existsSync(this._filePath)) return;
    let raw = '';
    try {
      raw = fs.readFileSync(this._filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('not a JSON array');
      this._entries = parsed;
    } catch (err) {
      // Never let the next save silently overwrite unsynced changes: set the
      // unreadable file aside where a person (or a bug report) can find it.
      const aside = `${this._filePath}.corrupt-${Date.now()}`;
      try { fs.renameSync(this._filePath, aside); } catch {}
      this._log(`[Cloud] sync journal unreadable (${err.message}); moved to ${path.basename(aside)} and starting empty`);
      this._entries = [];
    }
  }

  _save() {
    const tmp = this._filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this._entries), 'utf-8');
    fs.renameSync(tmp, this._filePath);
  }

  _entry(e) {
    return {
      uuid: e.uuid,
      action: e.action,
      adifFields: e.adifFields || null,
      version: e.version || 1,
      owner: e.owner || null,
      profile: normProfile(e.profile),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Append a change entry to the journal.
   * @param {object} entry - { uuid, action: 'create'|'update'|'delete', adifFields, version, owner }
   */
  append(entry) {
    this.appendMany([entry]);
  }

  /** Append several entries with one write (an import can be thousands). */
  appendMany(entries) {
    if (!entries.length) return;
    for (const e of entries) this._entries.push(this._entry(e));
    this._save();
  }

  /**
   * Get all pending entries, every owner's. The returned objects ARE the
   * journal's entries; pass them back to removeEntries() once resolved.
   * Sync code must use forOwner() instead.
   * @returns {Array} Journal entries
   */
  getAll() {
    return this._entries.slice();
  }

  /**
   * The signed-in account's view of the journal — the object the sync cycle
   * is handed. It sees only entries this account owns.
   *
   * Entries with NO owner predate the stamp. Their author is unknowable, so
   * they are adopted by the first account to push after the upgrade and
   * stamped then — the one transition where the old behaviour is kept, and
   * it can happen only once per entry.
   *
   * The view is also scoped to the operator `profile` (#245). An entry with
   * no profile stamp is visible to every profile — claimUnstamped() gives
   * the existing ones to the active profile at startup, so in practice only
   * a host that names no profile writes unstamped entries.
   *
   * @param {string|null} owner - account id; null means "not signed in"
   * @param {string|null} [profile] - the active profile's callsign; omitted
   *   or null = no profile known, account scoping only (the old behaviour)
   */
  forOwner(owner, profile = null) {
    const journal = this;
    const prof = normProfile(profile);
    // Signed out (owner null) owns nothing — a legacy entry's owner is null
    // too, and strict equality would have handed it to nobody's push.
    const isMine = (e) => !!owner && (e.owner === owner || !e.owner) && profileMatches(e, prof);
    const mine = () => journal._entries.filter(isMine);
    return {
      get hasPending() { return mine().length > 0; },
      get length() { return mine().length; },
      getAll() {
        const list = mine();
        let adopted = 0;
        for (const e of list) {
          if (!e.owner) { e.owner = owner; adopted++; }
          if (prof && !e.profile) { e.profile = prof; adopted++; }
        }
        if (adopted) journal._save();
        return list;
      },
      removeEntries(entries) { journal.removeEntries(entries); },
      removeWhere(pred) { journal.removeWhere((e) => isMine(e) && pred(e)); },
    };
  }

  /**
   * One-time migration (#245): every entry written before profile stamps
   * existed becomes `profile`'s — the profile active at the first launch
   * after the upgrade. For a single-profile PC that is exactly its journal.
   * Idempotent: stamped entries are left alone.
   * @returns {number} how many entries were stamped
   */
  claimUnstamped(profile) {
    const prof = normProfile(profile);
    if (!prof) return 0;
    let n = 0;
    for (const e of this._entries) { if (!e.profile) { e.profile = prof; n++; } }
    if (n) this._save();
    return n;
  }

  /**
   * Entries waiting for OTHER accounts than `owner` — or, with `profile`,
   * for another profile on this PC: they stay in the journal until their
   * account / profile is active, and the UI says so. `profiles` is present
   * only when some entry waits for another profile of this same account.
   * @returns {{ count: number, owners: string[], profiles?: string[] }}
   */
  pendingForOthers(owner, profile = null) {
    const prof = normProfile(profile);
    const owners = new Map();
    const profiles = new Map();
    let count = 0;
    for (const e of this._entries) {
      const ownerMatches = !e.owner || e.owner === owner;
      if (ownerMatches) {
        if (!owner || profileMatches(e, prof)) continue;
        profiles.set(e.profile, (profiles.get(e.profile) || 0) + 1);
      } else {
        owners.set(e.owner, (owners.get(e.owner) || 0) + 1);
      }
      count++;
    }
    const out = { count, owners: [...owners.keys()] };
    if (profiles.size) out.profiles = [...profiles.keys()];
    return out;
  }

  /** Remove exactly these entry objects (as returned by getAll). */
  removeEntries(entries) {
    const drop = new Set(entries);
    const next = this._entries.filter((e) => !drop.has(e));
    if (next.length === this._entries.length) return;
    this._entries = next;
    this._save();
  }

  /** Remove every entry matching `pred`. */
  removeWhere(pred) {
    const next = this._entries.filter((e) => !pred(e));
    if (next.length === this._entries.length) return;
    this._entries = next;
    this._save();
  }

  /**
   * Clear all entries, every owner's (after a full sync reset).
   */
  clear() {
    this._entries = [];
    this._save();
  }

  /**
   * Number of pending entries, every owner's.
   */
  get length() {
    return this._entries.length;
  }

  /**
   * Whether there are pending changes to sync, any owner's.
   */
  get hasPending() {
    return this._entries.length > 0;
  }
}

/** A profile key: the callsign upper-cased; null when none. */
function normProfile(p) {
  const s = String(p == null ? '' : p).trim().toUpperCase();
  return s || null;
}

/** No profile known (prof null) or an unstamped entry matches every profile. */
function profileMatches(e, prof) {
  return !prof || !e.profile || e.profile === prof;
}

module.exports = SyncJournal;
module.exports.normProfile = normProfile;
