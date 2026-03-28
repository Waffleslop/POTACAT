'use strict';

const fs = require('fs');
const path = require('path');

/**
 * SyncJournal - Append-only change journal for offline-first cloud sync.
 *
 * Tracks local QSO changes (create, update, delete) since the last
 * successful sync. Entries are removed only after the server confirms
 * acceptance.
 *
 * File format: JSON array in {userData}/sync-journal.json
 */
class SyncJournal {
  constructor(userDataPath) {
    this._filePath = path.join(userDataPath, 'sync-journal.json');
    this._entries = [];
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this._filePath)) {
        const raw = fs.readFileSync(this._filePath, 'utf-8');
        this._entries = JSON.parse(raw);
        if (!Array.isArray(this._entries)) this._entries = [];
      }
    } catch {
      this._entries = [];
    }
  }

  _save() {
    const tmp = this._filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this._entries), 'utf-8');
    fs.renameSync(tmp, this._filePath);
  }

  /**
   * Append a change entry to the journal.
   * @param {object} entry - { uuid, action: 'create'|'update'|'delete', adifFields, version }
   */
  append(entry) {
    this._entries.push({
      uuid: entry.uuid,
      action: entry.action,
      adifFields: entry.adifFields || null,
      version: entry.version || 1,
      timestamp: new Date().toISOString(),
    });
    this._save();
  }

  /**
   * Get all pending entries.
   * @returns {Array} Journal entries
   */
  getAll() {
    return this._entries.slice();
  }

  /**
   * Get a batch of entries for pushing.
   * @param {number} limit - Max entries to return (default 200)
   * @returns {Array}
   */
  getBatch(limit = 200) {
    return this._entries.slice(0, limit);
  }

  /**
   * Remove accepted entries by UUID set.
   * @param {Set<string>|Array<string>} acceptedUuids - UUIDs that were accepted by the server
   */
  removeAccepted(acceptedUuids) {
    const uuidSet = acceptedUuids instanceof Set ? acceptedUuids : new Set(acceptedUuids);
    // For each accepted UUID, remove only the first matching entry (in case of duplicates)
    const removed = new Set();
    this._entries = this._entries.filter((entry) => {
      if (uuidSet.has(entry.uuid) && !removed.has(entry.uuid)) {
        removed.add(entry.uuid);
        return false;
      }
      return true;
    });
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
