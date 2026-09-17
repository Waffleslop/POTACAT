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
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Append a change entry to the journal.
   * @param {object} entry - { uuid, action: 'create'|'update'|'delete', adifFields, version }
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
   * Get all pending entries. The returned objects ARE the journal's entries;
   * pass them back to removeEntries() once the server has resolved them.
   * @returns {Array} Journal entries
   */
  getAll() {
    return this._entries.slice();
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
   * Clear all entries (after a full sync reset).
   */
  clear() {
    this._entries = [];
    this._save();
  }

  /**
   * Number of pending entries.
   */
  get length() {
    return this._entries.length;
  }

  /**
   * Whether there are pending changes to sync.
   */
  get hasPending() {
    return this._entries.length > 0;
  }
}

module.exports = SyncJournal;
