// lib/settings-file.js — reading and writing settings.json (and each
// operator's profile file) so a settings file can no longer be wiped.
//
// Two operators lost all their settings (lloyd_ko4l on a Windows upgrade,
// n8jms on a Mac during heavy testing, 2026-10). The write was a plain
// fs.writeFileSync over the live file: a POTACAT closed mid-write (the
// installer closes it on upgrade; a force quit) leaves a truncated file, the
// next launch reads it as no settings at all (a fresh install), and the next
// save replaces everything. So:
//   - writes go to <file>.tmp and are renamed over the file (a reader sees
//     the old file or the new one, never half of one);
//   - the last good file is kept as <file>.bak, refreshed at most once an
//     hour, and only from a file that parses;
//   - a file that exists but does not parse is kept as
//     <file>.corrupt-<stamp> and the .bak is used, and the reason is returned
//     so main can say it in the log. Nothing is ever replaced silently.
'use strict';

const nodeFs = require('fs');
const nodePath = require('path');

const BACKUP_EVERY_MS = 60 * 60 * 1000;
const _lastBackup = new Map(); // path -> ms

function stamp(now) {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

/**
 * Read a settings file.
 * @returns {{data: object|null, status: 'ok'|'missing'|'restored'|'unreadable', reason?: string, backupAt?: number, keptAs?: string}}
 *   data null = no settings (a fresh install only when status is 'missing').
 */
function readSettingsFile(p, opts = {}) {
  const fs = opts.fs || nodeFs;
  const now = opts.now || Date.now();
  let raw;
  try { raw = fs.readFileSync(p, 'utf-8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') {
      // No file. A .bak with no file means the file was lost, not new.
      const bak = tryParse(fs, p + '.bak');
      if (bak.ok) return { data: bak.data, status: 'restored', reason: 'the file was missing', backupAt: bak.mtime };
      return { data: null, status: 'missing' };
    }
    return { data: null, status: 'unreadable', reason: (e && e.message) || String(e) };
  }
  try {
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') return { data, status: 'ok' };
    throw new Error('not a settings object');
  } catch (e) {
    const reason = raw.trim() ? `it does not parse (${(e && e.message) || e})` : 'it is empty';
    let keptAs = '';
    if (opts.keepCorrupt !== false) {
      try { keptAs = p + '.corrupt-' + stamp(now); fs.copyFileSync(p, keptAs); } catch { keptAs = ''; }
    }
    const bak = tryParse(fs, p + '.bak');
    if (bak.ok) return { data: bak.data, status: 'restored', reason, backupAt: bak.mtime, keptAs };
    return { data: null, status: 'unreadable', reason, keptAs };
  }
}

function tryParse(fs, p) {
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (!data || typeof data !== 'object') return { ok: false };
    let mtime = 0;
    try { mtime = fs.statSync(p).mtimeMs; } catch { /* no stat */ }
    return { ok: true, data, mtime };
  } catch { return { ok: false }; }
}

/**
 * Write a settings file: back up the current one (hourly, only if it
 * parses), write <p>.tmp, rename it over <p>. Throws like writeFileSync did.
 */
function writeSettingsFile(p, obj, opts = {}) {
  const fs = opts.fs || nodeFs;
  const now = opts.now || Date.now();
  try { fs.mkdirSync(nodePath.dirname(p), { recursive: true }); } catch { /* exists */ }
  // The first write of a session backs up at once; after that, hourly.
  if (!_lastBackup.has(p) || now - _lastBackup.get(p) >= BACKUP_EVERY_MS) {
    const cur = tryParse(fs, p);
    if (cur.ok) {
      try { fs.copyFileSync(p, p + '.bak'); _lastBackup.set(p, now); } catch { /* backup is best effort */ }
    }
  }
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  try {
    fs.renameSync(tmp, p);
  } catch (e) {
    // Windows can refuse a rename over a file another process has open
    // (antivirus scanning it): fall back to the old direct write.
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
  }
}

/** One log line for a read that was not plain 'ok' / 'missing'. */
function describeRead(name, r) {
  if (!r || r.status === 'ok' || r.status === 'missing') return '';
  const kept = r.keptAs ? ` The unreadable file is kept as ${nodePath.basename(r.keptAs)}.` : '';
  if (r.status === 'restored') {
    const when = r.backupAt ? ` (backup from ${new Date(r.backupAt).toISOString().slice(0, 16).replace('T', ' ')} UTC)` : '';
    return `[Settings] ${name} could not be used: ${r.reason}. Restored it from ${name}.bak${when}.${kept}`;
  }
  return `[Settings] ${name} could not be read: ${r.reason}, and there is no backup to restore from. POTACAT starts with default settings.${kept}`;
}

function _resetForTests() { _lastBackup.clear(); }

module.exports = { readSettingsFile, writeSettingsFile, describeRead, BACKUP_EVERY_MS, _resetForTests };
