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
   * @param {string|null} owner - account id; null means "not signed in"
   */
  forOwner(owner) {
    const journal = this;
    // Signed out (owner null) owns nothing — a legacy entry's owner is null
    // too, and strict equality would have handed it to nobody's push.
    const mine = () => (owner ? journal._entries.filter((e) => e.owner === owner || !e.owner) : []);
    return {
      get hasPending() { return mine().length > 0; },
      get length() { return mine().length; },
      getAll() {
        const list = mine();
        let adopted = 0;
        for (const e of list) { if (!e.owner) { e.owner = owner; adopted++; } }
        if (adopted) journal._save();
        return list;
      },
      removeEntries(entries) { journal.removeEntries(entries); },
      removeWhere(pred) { journal.removeWhere((e) => (e.owner === owner || !e.owner) && pred(e)); },
    };
  }

  /**
   * Entries waiting for OTHER accounts than `owner`: they stay in the journal
   * until their account signs in, and the UI says so.
   * @returns {{ count: number, owners: string[] }}
   */
  pendingForOthers(owner) {
    const owners = new Map();
    for (const e of this._entries) {
      if (!e.owner || e.owner === owner) continue;
      owners.set(e.owner, (owners.get(e.owner) || 0) + 1);
    }
    let count = 0;
    for (const n of owners.values()) count += n;
    return { count, owners: [...owners.keys()] };
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

module.exports = SyncJournal;
