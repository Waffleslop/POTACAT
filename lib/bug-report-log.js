'use strict';
//
// Report a Bug — complete-from-launch log selection.
//
// The bug report inlines the persistent session log (every sendCatLog line
// since process start) into a clipboard paste bound for Discord, so it can't
// ship the whole file: the per-second FA;/MD; CAT poll lines make an hour-long
// session tens of thousands of lines. Instead the paste carries the HEAD
// (startup — the part the old ring-buffer report always lost) plus the TAIL
// (the repro, from the "recording started" marker the renderer drops when the
// flow begins), with an explicit omission count between them so nobody
// mistakes the gap for "nothing happened".
//
// Pure JS, no I/O — main.js reads the file and passes lines in.
//

// Marker line sendCatLog'd when the user starts the Report a Bug flow. The
// selection below splits the session log on the LAST occurrence, so repeated
// flows in one session report the most recent repro.
const BUG_REPORT_MARKER = '=== bug report recording started ===';

/**
 * Pick the head + tail of a session log for inlining into a bug report.
 *
 * @param {string[]} lines  full session log, oldest first
 * @param {object} [opts]
 *   marker     — tail starts at the LAST line containing this substring;
 *                absent/not found → tail is the last `tailCount` lines
 *   headCount  — max lines kept from the start (default 150)
 *   beforeMarker — lines kept BEFORE the marker (default 0). A report is
 *                usually filed after the fact — the radio keyed, THEN the
 *                operator pressed Report a Bug — so the evidence sits just
 *                above the marker, in what used to be "N lines omitted"
 *                (KF0U's FT-710 keyed at 0 W, 2026-10-19/20: two reports,
 *                neither contained the keying).
 *   tailCount  — max lines kept in the tail (default 400); a repro longer
 *                than this keeps its END (latest lines) and reports the
 *                overflow in `tailTruncated`
 * @returns {{head: string[], tail: string[], skipped: number,
 *            markerFound: boolean, tailTruncated: number}}
 *   head + tail never overlap; `skipped` is the count of omitted middle lines.
 */
function selectReportLines(lines, opts) {
  lines = Array.isArray(lines) ? lines : [];
  const o = opts || {};
  const headCount = Number.isInteger(o.headCount) && o.headCount >= 0 ? o.headCount : 150;
  const tailCount = Number.isInteger(o.tailCount) && o.tailCount > 0 ? o.tailCount : 400;
  const beforeMarker = Number.isInteger(o.beforeMarker) && o.beforeMarker > 0 ? o.beforeMarker : 0;

  let markerIdx = -1;
  if (o.marker) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (String(lines[i]).includes(o.marker)) { markerIdx = i; break; }
    }
  }

  let tailStart = markerIdx >= 0 ? Math.max(0, markerIdx - beforeMarker) : Math.max(0, lines.length - tailCount);
  let tailTruncated = 0;
  if (lines.length - tailStart > tailCount) {
    tailTruncated = (lines.length - tailStart) - tailCount;
    tailStart = lines.length - tailCount;
  }

  if (tailStart <= headCount) {
    // Short session — head and tail meet; ship everything, no gap.
    return {
      head: lines.slice(0, tailStart),
      tail: lines.slice(tailStart),
      skipped: 0,
      markerFound: markerIdx >= 0,
      tailTruncated,
    };
  }

  return {
    head: lines.slice(0, headCount),
    tail: lines.slice(tailStart),
    skipped: tailStart - headCount,
    markerFound: markerIdx >= 0,
    tailTruncated,
  };
}

/**
 * Mask the user's home directory in log lines — startup.log's argv= header
 * and any path-bearing line would otherwise paste `C:\Users\<name>` into a
 * public Discord report. The token redaction in lib/diagnostic-snapshot.js
 * doesn't cover paths, so this runs alongside it. Case-insensitive (Windows
 * paths log in mixed case); literal match only.
 *
 * @param {string[]} lines
 * @param {string} homeDir  e.g. os.homedir(); falsy/too-short → unchanged
 * @returns {string[]}
 */
function maskHomeDir(lines, homeDir) {
  if (!Array.isArray(lines)) return [];
  const dir = String(homeDir || '');
  if (dir.length < 4) return lines.slice(); // never mask on '/', 'C:\', etc.
  const esc = dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(esc, 'gi');
  return lines.map((l) => String(l).replace(re, '~'));
}

/**
 * The file moves that keep the last `generations` runs of a session log:
 * session.log → .old → .old2 → .old3, oldest dropped. ONE previous run was
 * not enough: KF0U restarted POTACAT to collect the overnight log and the
 * updater restarted it again a minute later, and the run that held the
 * evidence was gone (2026-10-20). Pure — main.js performs the unlink and
 * the renames in the order returned (oldest first, so nothing is clobbered).
 *
 * @param {string} base  the live log path, e.g. <userData>/session.log
 * @param {number} [generations=3]
 * @returns {{unlink: string, moves: Array<{from: string, to: string}>}}
 */
function sessionLogRotationMoves(base, generations) {
  const n = Number.isInteger(generations) && generations > 0 ? generations : 3;
  const gen = (i) => base + '.old' + (i === 1 ? '' : String(i));
  const moves = [];
  for (let i = n - 1; i >= 1; i--) moves.push({ from: gen(i), to: gen(i + 1) });
  moves.push({ from: base, to: gen(1) });
  return { unlink: gen(n), moves };
}

module.exports = { BUG_REPORT_MARKER, selectReportLines, maskHomeDir, sessionLogRotationMoves };
