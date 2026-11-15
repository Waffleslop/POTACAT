'use strict';
// Did the previous POTACAT run exit cleanly?
//
// A marker file ('clean-exit' in userData) is written as the last step of a
// graceful shutdown and removed at the next startup, so its ABSENCE at boot
// means the last run died (crash, OOM kill, power loss) rather than quit.
//
// Only the GUI session owns the marker and startup.log. Side modes that run
// the same executable in the same userData folder -- the Remote Launcher
// (`--launcher`, started at login and left running) and the one-shot
// `--print-cert-fingerprint` -- must never consume the marker or rotate the
// GUI's log. Before #550 the Launcher did both on its first log line, so a
// clean quit followed by a Launcher start made the next GUI start report a
// crash that never happened.
//
// Side modes get a log file of their own (rotated per run, like the GUI's)
// rather than appending to startup.log: the GUI log stays one session's
// record, a Launcher that starts at login cannot interleave lines into a
// running GUI's log, and the Launcher's own startup trouble stays findable.

const path = require('path');

const MARKER_NAME = 'clean-exit';
const GUI_LOG_NAME = 'startup.log';
const SIDE_MODE_LOGS = {
  '--launcher': 'launcher-startup.log',
  '--print-cert-fingerprint': 'cli-startup.log',
};

// The side-mode flag this process runs as, or null for the GUI session
// (including --headless, which is the full app without a window).
function sideMode(argv) {
  const args = Array.isArray(argv) ? argv : [];
  for (const flag of Object.keys(SIDE_MODE_LOGS)) {
    if (args.includes(flag)) return flag;
  }
  return null;
}

function ownsSession(argv) {
  return sideMode(argv) === null;
}

function startupLogName(argv) {
  const mode = sideMode(argv);
  return mode ? SIDE_MODE_LOGS[mode] : GUI_LOG_NAME;
}

// Run ONCE per launch, before the first line is written. Keeps the previous
// run's copy of this process's log as <log>.old and, for the GUI session
// only, consumes the clean-exit marker.
// Returns { logPath, markerPath, prevRunUnclean }. markerPath is null for a
// side mode, so a side mode can neither read nor stamp the marker.
function prepareStartupLog({ dir, argv, fs }) {
  const logPath = path.join(dir, startupLogName(argv));
  try { if (fs.existsSync(logPath)) fs.copyFileSync(logPath, logPath + '.old'); } catch {}
  if (!ownsSession(argv)) return { logPath, markerPath: null, prevRunUnclean: false };
  const markerPath = path.join(dir, MARKER_NAME);
  let prevRunUnclean = false;
  try {
    if (fs.existsSync(markerPath)) {
      fs.unlinkSync(markerPath); // absent for the whole run
    } else {
      prevRunUnclean = true;
    }
  } catch { /* the marker is diagnostic only: never block startup */ }
  return { logPath, markerPath, prevRunUnclean };
}

// The last step of a graceful shutdown. A null path (side mode) does nothing.
function stampCleanExit(markerPath, fs, now = new Date()) {
  if (!markerPath) return false;
  try {
    fs.writeFileSync(markerPath, now.toISOString());
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  MARKER_NAME,
  GUI_LOG_NAME,
  SIDE_MODE_LOGS,
  sideMode,
  ownsSession,
  startupLogName,
  prepareStartupLog,
  stampCleanExit,
};
