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

  let markerIdx = -1;
  if (o.marker) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (String(lines[i]).includes(o.marker)) { markerIdx = i; break; }
    }
  }

  let tailStart = markerIdx >= 0 ? markerIdx : Math.max(0, lines.length - tailCount);
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

module.exports = { BUG_REPORT_MARKER, selectReportLines, maskHomeDir };
