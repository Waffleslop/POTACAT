// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// The Winlink session summary lines, kept across a restart (#425).
//
// Each radio session ends with one "session summary:" line: the gateway, the
// dial, how long it ran, what moved, which side ended the link. The last 8
// radio sessions (and the last 2 internet ones) go into Report a Bug. They
// were kept in memory only, so an operator who restarted POTACAT after a
// dropped link, which is the natural thing to do, sent a report with the
// evidence gone.
//
// They now live in one small file in the profile's Winlink folder, beside
// Pat's own log: session-summaries.json. Written when a session ends, read
// when POTACAT next needs them.
//
// What is in the file: the lines as they were logged, with their times.
// Nothing else. The Winlink password is never in a summary line; a caller may
// still pass secrets to be struck out, as a second lock.
//
// Bounded: at most 8 radio + 2 internet lines (lib/winlink-outcome.js
// keepSummary), each cut at MAX_LINE characters, so the file stays under
// about 25 kB whatever happens.

'use strict';

const fs = require('fs');
const path = require('path');
const { keepSummary } = require('./winlink-outcome');

const FILE_NAME = 'session-summaries.json';
const VERSION = 1;
const MAX_LINE = 2400;
const CAPS = Object.freeze({ radio: 8, internet: 2 });

function fileIn(dir) {
  return path.join(String(dir || ''), FILE_NAME);
}

/**
 * A list as it may be kept: entries that are whole, oldest first, within the
 * caps, each line one line and no longer than MAX_LINE, secrets struck out.
 * Anything else in `raw` is dropped, never repaired.
 */
function clean(raw, { secrets = [] } = {}) {
  const strike = (secrets || []).map((s) => String(s || '')).filter((s) => s.length >= 4);
  const out = [];
  for (const e of Array.isArray(raw) ? raw : []) {
    if (!e || typeof e !== 'object') continue;
    const at = Number(e.at);
    if (!Number.isFinite(at) || at <= 0) continue;
    let line = typeof e.line === 'string' ? e.line.replace(/[\r\n\t]+/g, ' ').trim() : '';
    if (!line) continue;
    for (const s of strike) line = line.split(s).join('***');
    if (line.length > MAX_LINE) line = line.slice(0, MAX_LINE - 1) + '…';
    out.push({ at, radio: !!e.radio, line });
  }
  out.sort((a, b) => a.at - b.at);
  const kept = [];
  for (const e of out) keepSummary(kept, e, CAPS);
  return kept;
}

/** The lines kept in `file`, oldest first. [] when there is no file, or it cannot be read as one. */
function load(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object' || j.v !== VERSION) return [];
    return clean(j.sessions);
  } catch { return []; }
}

/**
 * Write `list` to `file`, whole or not at all (a temporary file, then a
 * rename), so a crash mid-write never leaves half a file.
 * @returns {boolean} written
 */
function save(file, list, { secrets = [] } = {}) {
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ v: VERSION, sessions: clean(list, { secrets }) }, null, 1));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

module.exports = { FILE_NAME, VERSION, MAX_LINE, CAPS, fileIn, clean, load, save };
