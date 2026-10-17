// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// LoTW Phase 1.5 — per-QSO sent flags (docs/tqsl-lotw-plan.md). After a
// successful tqsl batch upload, every QSO that was in the uploaded file
// gets LOTW_QSL_SENT=Y + LOTW_QSLSDATE, EXCEPT the ones tqsl's stderr
// named as skipped (wrong operator, grid mismatch, missing band...).
// tqsl revalidates non-compliant QSOs on every run, so skipped ones are
// re-announced each time and stay unstamped until the operator fixes
// them; already-at-LoTW duplicates are NOT listed (uploaded.db skips
// them silently), which is correct — a dupe IS sent, and deserves the
// flag on the first post-1.5 run.
'use strict';

/** CALL|DATE|HHMM — time truncated to minutes because ADIF TIME_ON may
 *  be 4 or 6 digits depending on which logger wrote the record. */
function lotwKey(call, qsoDate, timeOn) {
  const t = String(timeOn || '').replace(/[^0-9]/g, '').slice(0, 4).padEnd(4, '0');
  return `${String(call || '').toUpperCase()}|${String(qsoDate || '')}|${t}`;
}

/**
 * Parse tqsl's stderr complaint stream into the set of skipped QSOs.
 * Each complaint block ends with KEY: value lines echoing the record:
 *
 *   Station Location does not match QSO details
 *   The Station Location 'Gridsquare' has value 'FN20JB' while QSO has ...
 *   CALL: N0AD
 *   FREQ: 14.025000
 *   MODE: CW
 *   QSO_DATE: 20260228
 *   TIME_ON: 164929
 *   ...
 *
 * A block without CALL (e.g. "QSO does not specify a Callsign") can't be
 * matched to a record — it is ignored, which is safe: such records also
 * can't collide with a real QSO's key.
 */
function parseTqslSkips(stderrText) {
  const skips = [];
  let cur = null;
  // The lines just above a block say WHY: a headline ("Station Location does
  // not match QSO details") and TQSL's specifics ("... 'Gridsquare' has value
  // 'FN20JB' while QSO has 'FN20JC' on line 40"). They were dropped, so the
  // operator got "N skipped (see log)" and no log said why (GitHub #92).
  let pre = [];
  for (const raw of String(stderrText || '').split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Z_]+):\s*(.*)$/);
    if (m) {
      if (!cur) cur = { reason: pre[0] || '', detail: pre.length > 1 ? pre[pre.length - 1] : '' };
      cur[m[1]] = m[2].trim();
      continue;
    }
    // Non KEY: line ends a block.
    if (cur) {
      if (cur.CALL && cur.QSO_DATE) skips.push(cur);
      cur = null;
      pre = [];
    }
    const line = raw.trim();
    if (!line) pre = [];
    else pre.push(line);
  }
  if (cur && cur.CALL && cur.QSO_DATE) skips.push(cur);
  return skips;
}

/**
 * Stamp LOTW_QSL_SENT/LOTW_QSLSDATE onto `qsos` (parseAllRawQsos array,
 * mutated in place). Only records that were IN the uploaded snapshot are
 * candidates (QSOs logged mid-upload were not sent); tqsl-skipped ones
 * and already-stamped ones are left alone. Returns counts.
 */
function stampLotwSent(qsos, snapshotQsos, skips, dateYYYYMMDD) {
  const inSnapshot = new Set(snapshotQsos.map((q) => lotwKey(q.CALL, q.QSO_DATE, q.TIME_ON)));
  const skipped = new Set(skips.map((s) => lotwKey(s.CALL, s.QSO_DATE, s.TIME_ON)));
  let stamped = 0;
  let alreadyStamped = 0;
  for (const q of qsos) {
    if (!q || !q.CALL) continue;
    const key = lotwKey(q.CALL, q.QSO_DATE, q.TIME_ON);
    if (!inSnapshot.has(key) || skipped.has(key)) continue;
    if (String(q.LOTW_QSL_SENT || '').toUpperCase() === 'Y') { alreadyStamped++; continue; }
    q.LOTW_QSL_SENT = 'Y';
    q.LOTW_QSLSDATE = dateYYYYMMDD;
    stamped++;
  }
  return { stamped, alreadyStamped, skipped: skipped.size };
}

/**
 * TQSL reports "Previously Signed QSO detected" PER QSO on some builds. That
 * QSO is already at LoTW, so it is not a failure: stamp it as sent and do not
 * list it. Treating it as a skip left every previously uploaded QSO unmarked,
 * re-sent on every upload and listed one line each (K3SBP 2026-10-17: 673
 * "skipped", ~500 of them duplicates, in one unreadable sentence).
 */
function isAlreadyAtLotw(skip) {
  return /previously signed qso/i.test(String((skip && skip.reason) || ''));
}

/** A reason without its per-QSO line number, so like skips group together. */
function stripLine(text) {
  return String(text || '').replace(/\s*on line \d+/gi, '').replace(/\(\s*/g, '(').replace(/\s*\)/g, ')').trim();
}

/**
 * Split TQSL skips into "already at LoTW" and real problems, and group the
 * real ones by reason and detail with line numbers removed.
 * @returns {{ dupes: object[], real: object[], groups: {text: string, n: number}[] }}
 */
function summarizeSkips(skips) {
  const dupes = [];
  const real = [];
  for (const sk of skips || []) (isAlreadyAtLotw(sk) ? dupes : real).push(sk);
  const by = new Map();
  for (const sk of real) {
    const reason = stripLine(sk.reason) || 'no reason given';
    const detail = stripLine(sk.detail).replace(/^\((.*)\)$/, '$1');
    const text = detail && detail !== reason ? `${reason}: ${detail}` : reason;
    by.set(text, (by.get(text) || 0) + 1);
  }
  const groups = [...by].map(([text, n]) => ({ text, n })).sort((x, y) => y.n - x.n);
  return { dupes, real, groups };
}

module.exports = { lotwKey, parseTqslSkips, stampLotwSent, isAlreadyAtLotw, summarizeSkips };
