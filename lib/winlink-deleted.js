// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// The Deleted folder (#475): kept by POTACAT, inside Pat's own mailbox
// directory, beside in/out/sent/archive.
//
// Pat (v1.0.0) lists only its four folders, but it MOVES a message to any
// folder in its mailbox directory (POST /api/mailbox/<target> with
// X-Pat-SourcePath: os.Rename of <mbox>/<src>/<mid>.b2f to
// <mbox>/<target>/<mid>.b2f; the target directory must exist). So Delete is a
// Pat move into deleted/, and Restore a Pat move back. Pat cannot list or read
// deleted/, so before the move POTACAT saves the message as Pat gave it
// (body included) to deleted/<mid>.json with where it came from and when:
// the folder is listed and read from those copies, with or without Pat.
//
//   <mbox>/<MYCALL>/deleted/<mid>.b2f    Pat's file, moved there by Pat
//   <mbox>/<MYCALL>/deleted/<mid>.json   {v, mid, fromBox, deletedAt, message}
//
// The purge (removed for good after N days) and every path are decided here;
// a message id that could leave the folder is refused before any file is touched.

'use strict';

const fs = require('fs');
const path = require('path');
const { PAT_BOXES, DELETED } = require('./winlink-mail-actions');

const DAY_MS = 86400000;
// Winlink message ids are 12 letters and digits; Pat writes <mid>.b2f.
const MID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function validMid(mid) {
  return typeof mid === 'string' && MID_RE.test(mid);
}

/**
 * Pat's mailbox directory for this station: --mbox joined with the callsign
 * in upper case (pat v1.0.0 app.go: filepath.Join(MailboxPath, MyCall), MyCall
 * upper-cased). null when there is no callsign or it would leave the root.
 */
function mailboxDir(mboxRoot, mycall) {
  const call = String(mycall || '').trim().toUpperCase();
  if (!mboxRoot || !call || call.split(/[\\/]/).some((p) => p === '..' || p === '.')) return null;
  const root = path.resolve(String(mboxRoot));
  const dir = path.resolve(root, call);
  return dir.startsWith(root + path.sep) ? dir : null;
}

/** The Deleted folder's files for one message, or null for an id that is not a message id. */
function paths(mbDir, mid) {
  if (!mbDir || !validMid(mid)) return null;
  const dir = path.join(mbDir, DELETED);
  const b2f = path.join(dir, mid + '.b2f');
  const json = path.join(dir, mid + '.json');
  if (path.dirname(b2f) !== dir || path.dirname(json) !== dir) return null;
  return { dir, b2f, json };
}

/** The copy saved beside a deleted message. `message` is Pat's message with its body. */
function makeRecord(message, fromBox, nowMs) {
  const m = message || {};
  return {
    v: 1,
    mid: String(m.mid || ''),
    fromBox: PAT_BOXES.includes(fromBox) ? fromBox : 'in',
    deletedAt: new Date(nowMs).toISOString(),
    message: { ...m, box: DELETED },
  };
}

/** A saved copy, checked; null when it is not one. */
function parseRecord(text) {
  let r;
  try { r = JSON.parse(String(text)); } catch { return null; }
  if (!r || typeof r !== 'object' || !validMid(r.mid) || !r.message || typeof r.message !== 'object') return null;
  if (isNaN(new Date(r.deletedAt).getTime())) return null;
  return { ...r, fromBox: PAT_BOXES.includes(r.fromBox) ? r.fromBox : 'in' };
}

/** One row of the Deleted list: the message as Pat lists it (no body), with where it came from and when. */
function listEntry(rec) {
  const m = rec.message || {};
  const { body, ...rest } = m; // eslint-disable-line no-unused-vars
  return {
    ...rest,
    mid: rec.mid,
    box: DELETED,
    read: true,
    to: Array.isArray(m.to) ? m.to : [],
    cc: Array.isArray(m.cc) ? m.cc : [],
    attachments: Array.isArray(m.attachments) ? m.attachments : [],
    fromBox: rec.fromBox,
    deletedAt: rec.deletedAt,
  };
}

/** The message as the reader shows it: body included, plus fromBox and deletedAt. */
function readEntry(rec) {
  return { ...listEntry(rec), body: typeof (rec.message || {}).body === 'string' ? rec.message.body : '' };
}

/** Newest deleted first. */
function sortRecords(records) {
  return records.slice().sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
}

/** The ids due to be removed for good: deleted more than `days` days ago. days 0 = never. */
function purgeSelect(records, days, nowMs) {
  const d = Number(days) || 0;
  if (d <= 0) return [];
  const cutoff = nowMs - d * DAY_MS;
  return (records || []).filter((r) => r && validMid(r.mid) && new Date(r.deletedAt).getTime() <= cutoff).map((r) => r.mid);
}

// ── files ────────────────────────────────────────────────────────────────

/** Every saved copy in the folder, newest deleted first. A missing folder is an empty one. */
async function readAll(mbDir) {
  if (!mbDir) return [];
  const dir = path.join(mbDir, DELETED);
  let names;
  try { names = await fs.promises.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    let text;
    try { text = await fs.promises.readFile(path.join(dir, n), 'utf8'); } catch { continue; }
    const r = parseRecord(text);
    if (r && r.mid + '.json' === n) out.push(r);
  }
  return sortRecords(out);
}

async function readOne(mbDir, mid) {
  const p = paths(mbDir, mid);
  if (!p) return null;
  try { return parseRecord(await fs.promises.readFile(p.json, 'utf8')); } catch { return null; }
}

/** Make the folder (Pat's move needs it) and write the copy. */
async function save(mbDir, rec) {
  const p = paths(mbDir, rec && rec.mid);
  if (!p) throw new Error('That is not a message id');
  await fs.promises.mkdir(p.dir, { recursive: true });
  await fs.promises.writeFile(p.json, JSON.stringify(rec, null, 2));
  return p;
}

async function _unlink(f) {
  try { await fs.promises.unlink(f); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

/** The copy only (after a restore: Pat has the message back). */
async function forget(mbDir, mid) {
  const p = paths(mbDir, mid);
  if (!p) return false;
  return _unlink(p.json);
}

/** The message and its copy, for good. */
async function removeForGood(mbDir, mid) {
  const p = paths(mbDir, mid);
  if (!p) throw new Error('That is not a message id');
  const a = await _unlink(p.b2f);
  const b = await _unlink(p.json);
  return a || b;
}

/**
 * Put a deleted Outbox message back in the queue. Pat's API cannot do this
 * one (POST /api/mailbox/out is "queue a new message", never a move), so it
 * is the same rename Pat does, done here: deleted/<mid>.b2f to out/<mid>.b2f.
 * Pat reads the folder afresh each time it lists or sends.
 */
async function restoreToOutbox(mbDir, mid) {
  const p = paths(mbDir, mid);
  if (!p) throw new Error('That is not a message id');
  const outDir = path.join(mbDir, 'out');
  await fs.promises.mkdir(outDir, { recursive: true });
  await fs.promises.rename(p.b2f, path.join(outDir, mid + '.b2f'));
}

/** Remove for good everything deleted more than `days` days ago. Returns the ids removed. */
async function purge(mbDir, days, nowMs) {
  const due = purgeSelect(await readAll(mbDir), days, nowMs);
  const done = [];
  for (const mid of due) {
    try { await removeForGood(mbDir, mid); done.push(mid); } catch { /* the next pass tries again */ }
  }
  return done;
}

module.exports = {
  DELETED, validMid, mailboxDir, paths, makeRecord, parseRecord, listEntry, readEntry,
  sortRecords, purgeSelect, readAll, readOne, save, forget, removeForGood, restoreToOutbox, purge,
};
