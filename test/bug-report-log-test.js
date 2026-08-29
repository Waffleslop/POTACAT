// Report a Bug — complete-from-launch log selection (lib/bug-report-log.js).
// Locks the head/tail/skip math the get-bug-report-log IPC relies on: the
// paste must always contain the full startup head, the full repro tail (from
// the recording-started marker), and an honest omission count between them.
//
// Run: node test/bug-report-log-test.js

'use strict';

const { BUG_REPORT_MARKER, selectReportLines, maskHomeDir } = require('../lib/bug-report-log');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
function eq(actual, expected, label) {
  check(JSON.stringify(actual) === JSON.stringify(expected),
    `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function mkLines(n, prefix) {
  return Array.from({ length: n }, (_, i) => `${prefix || 'line'} ${i}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('=== marker found: tail starts at the marker ===');
{
  const lines = [...mkLines(500, 'startup'), BUG_REPORT_MARKER, ...mkLines(50, 'repro')];
  const sel = selectReportLines(lines, { marker: BUG_REPORT_MARKER, headCount: 150, tailCount: 400 });
  eq(sel.markerFound, true, 'markerFound');
  eq(sel.head.length, 150, 'head is the first 150 lines');
  eq(sel.head[0], 'startup 0', 'head starts at line 0');
  eq(sel.tail[0], BUG_REPORT_MARKER, 'tail starts at the marker');
  eq(sel.tail.length, 51, 'tail = marker + 50 repro lines');
  eq(sel.skipped, 350, 'skipped = lines between head and marker');
  eq(sel.tailTruncated, 0, 'no tail truncation');
  eq(sel.head.length + sel.skipped + sel.tail.length, lines.length, 'head + skipped + tail covers the file');
}

console.log('=== repeated flows: LAST marker wins ===');
{
  const lines = [...mkLines(200), BUG_REPORT_MARKER, ...mkLines(200, 'mid'), BUG_REPORT_MARKER, 'repro A', 'repro B'];
  const sel = selectReportLines(lines, { marker: BUG_REPORT_MARKER, headCount: 150, tailCount: 400 });
  eq(sel.tail, [BUG_REPORT_MARKER, 'repro A', 'repro B'], 'tail is the most recent repro');
}

console.log('=== no marker: tail is the last tailCount lines ===');
{
  const lines = mkLines(1000);
  const sel = selectReportLines(lines, { marker: BUG_REPORT_MARKER, headCount: 150, tailCount: 400 });
  eq(sel.markerFound, false, 'markerFound false');
  eq(sel.head.length, 150, 'head 150');
  eq(sel.tail.length, 400, 'tail 400');
  eq(sel.tail[0], 'line 600', 'tail starts at len-400');
  eq(sel.skipped, 450, 'skipped middle');
}

console.log('=== short session: no gap, nothing dropped ===');
{
  const lines = mkLines(100);
  const sel = selectReportLines(lines, { marker: BUG_REPORT_MARKER, headCount: 150, tailCount: 400 });
  eq(sel.skipped, 0, 'no skip');
  eq(sel.head.concat(sel.tail), lines, 'head+tail is the whole file, in order');
}
{
  // head and tail regions touch exactly (500 = 150 head + 350 tail-window overlap)
  const lines = mkLines(500);
  const sel = selectReportLines(lines, { marker: null, headCount: 150, tailCount: 400 });
  eq(sel.skipped, 0, 'no skip when regions overlap');
  eq(sel.head.concat(sel.tail), lines, 'whole file survives, no duplication');
}

console.log('=== marathon repro: tail keeps its END and reports the overflow ===');
{
  const lines = [...mkLines(200, 'startup'), BUG_REPORT_MARKER, ...mkLines(1000, 'repro')];
  const sel = selectReportLines(lines, { marker: BUG_REPORT_MARKER, headCount: 150, tailCount: 400 });
  eq(sel.markerFound, true, 'marker still reported found');
  eq(sel.tail.length, 400, 'tail capped at 400');
  eq(sel.tail[sel.tail.length - 1], 'repro 999', 'latest repro line kept');
  eq(sel.tailTruncated, 601, 'overflow counted (marker + first 600 repro lines dropped)');
}

console.log('=== degenerate inputs ===');
{
  eq(selectReportLines(null).head, [], 'null lines → empty head');
  eq(selectReportLines([]).tail, [], 'empty file → empty tail');
  const one = selectReportLines(['only'], { marker: BUG_REPORT_MARKER });
  eq(one.head.concat(one.tail), ['only'], 'single line survives');
  // marker line itself in a tiny file
  const tiny = selectReportLines([BUG_REPORT_MARKER], { marker: BUG_REPORT_MARKER });
  eq(tiny.markerFound, true, 'marker found in 1-line file');
  eq(tiny.head.concat(tiny.tail), [BUG_REPORT_MARKER], '1-line marker file survives');
}

console.log('=== maskHomeDir: usernames never reach the paste ===');
{
  const lines = [
    'argv=["C:\\Users\\cssta\\AppData\\Local\\POTACAT\\app.exe","--headless"]',
    '[CAT 14:11:45.918] loaded c:\\users\\CSSTA\\Documents\\log.adi', // mixed case
    '[CAT 14:11:46.000] no path here',
  ];
  const out = maskHomeDir(lines, 'C:\\Users\\cssta');
  eq(out[0], 'argv=["~\\AppData\\Local\\POTACAT\\app.exe","--headless"]', 'home dir masked in argv line');
  eq(out[1], '[CAT 14:11:45.918] loaded ~\\Documents\\log.adi', 'case-insensitive match');
  eq(out[2], lines[2], 'pathless line untouched');
}
{
  const out = maskHomeDir(['/home/casey/.config/POTACAT/settings.json'], '/home/casey');
  eq(out[0], '~/.config/POTACAT/settings.json', 'unix home dir masked');
}
{
  eq(maskHomeDir(['C:\\x'], ''), ['C:\\x'], 'empty homeDir → unchanged');
  eq(maskHomeDir(['C:\\x'], 'C:\\'), ['C:\\x'], 'degenerate short homeDir never masks');
  eq(maskHomeDir(null, '/home/casey'), [], 'null lines → empty array');
}

// ── Crash carry-over (KE8WFF 2026-08-29) ─────────────────────────────────
// A crash makes the CURRENT session useless as evidence: the user relaunched
// in order to file the report, so this session began AFTER the failure. The
// dead run survives as session.log.old / startup.log.old, which the report
// never read — so the first report after a crash arrived describing a
// perfectly healthy launch. main.js now detects an unclean exit via a
// clean-exit marker and carries the dead run's tail into the paste.
{
  const fs = require('fs');
  const path = require('path');
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const APP = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

  // The marker must be REMOVED at startup: its absence is what a crash
  // leaves behind. A marker that lived across the run would prove nothing.
  check(/fsx\.unlinkSync\(_cleanExitMarkerPath\)/.test(MAIN),
    'startup clears the clean-exit marker');
  check(/_prevRunUnclean = true;/.test(MAIN),
    'a missing marker at boot means the previous run died');

  // ...and WRITTEN only on a graceful shutdown.
  const gc = MAIN.indexOf('function gracefulCleanup()');
  check(gc !== -1, 'gracefulCleanup still exists');
  const gcBody = MAIN.slice(gc, gc + 3000);
  check(/writeFileSync\(_cleanExitMarkerPath/.test(gcBody),
    'graceful shutdown stamps the marker');

  // The report must carry the dead run, and must REDACT it like everything
  // else — a crash tail is still the user's log, pasted in public.
  check(/prevRunUnclean: _prevRunUnclean/.test(MAIN),
    'bug report reports whether the last run crashed');
  check(/_sessionLogPath \+ '\.old'/.test(MAIN),
    'bug report reads the crashed session log');
  check(/session: clean\(prevCrash\.session\)/.test(MAIN),
    'crashed-run lines are redacted before leaving main');

  // And it must be FIRST in the paste — the reason the report exists.
  const crashIdx = APP.indexOf('Previous session ended unexpectedly');
  const startupIdx = APP.indexOf('### Startup log');
  check(crashIdx !== -1, 'renderer prints a crashed-run section');
  check(crashIdx !== -1 && startupIdx !== -1 && crashIdx < startupIdx,
    'the crashed run is printed before the current launch');
  check(/no log survived from that run/.test(APP),
    'says so plainly when the dead run left nothing');
}
// ───────────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
