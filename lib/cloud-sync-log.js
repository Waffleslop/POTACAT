'use strict';
/**
 * Session-log lines for Cloud QSO sync.
 *
 * A pull that brought nothing and a sync that never ran used to leave the
 * same empty log: the background timer reported errors only to the console,
 * and a successful pull wrote nothing. A report from a second computer whose
 * logbook stayed empty could not say which (B10, 2026-11-15).
 *
 * Quiet by rule: one line for a cycle that changed something, one line for
 * an error (repeats of the same error are not written again until a cycle
 * succeeds), one line when background sync does not start. The account is
 * named only as present or absent, never by its email.
 */

function accountWord(signedIn) {
  return signedIn ? 'account signed in' : 'no account signed in';
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** The line for a finished cycle, or null when it changed nothing. */
function syncSummaryLine(summary, { signedIn = true } = {}) {
  const s = summary || {};
  if (s.skipped) return null;
  const pulled = s.pulled | 0;
  const pushed = s.pushed | 0;
  const conflicts = s.conflicts | 0;
  if (!pulled && !pushed && !conflicts) return null;
  const parts = [`pulled ${plural(pulled, 'QSO', 'QSOs')}`, `pushed ${pushed}`];
  if (conflicts) parts.push(plural(conflicts, 'conflict (the Cloud copy kept)', 'conflicts (the Cloud copy kept)'));
  return `[Cloud] sync: ${parts.join(', ')} (${accountWord(signedIn)})`;
}

/** The line for a failed cycle. */
function syncErrorLine(message, { signedIn = true } = {}) {
  const text = String(message || 'unknown error').replace(/\s+/g, ' ').trim().slice(0, 300);
  return `[Cloud] sync failed: ${text} (${accountWord(signedIn)})`;
}

/** Why background sync is not running, or null when it is. */
function backgroundSyncLine({ signedIn, syncEnabled }) {
  if (!signedIn) return '[Cloud] background sync not started: no account signed in';
  if (!syncEnabled) return '[Cloud] background sync not started: "Enable QSO Cloud Sync" is off in Settings > Cloud (account signed in)';
  return null;
}

/**
 * A small stateful writer: log(line) is called only for lines worth
 * writing. Repeated identical errors are written once until a cycle
 * succeeds; the "not started" reason is written once until it changes.
 */
function createSyncLogger(log) {
  let lastError = null;
  let lastNotStarted = null;
  return {
    synced(summary, opts) {
      lastError = null;
      const line = syncSummaryLine(summary, opts);
      if (line) log(line);
      return line;
    },
    failed(message, opts) {
      const line = syncErrorLine(message, opts);
      if (line === lastError) return null;
      lastError = line;
      log(line);
      return line;
    },
    background(state) {
      const line = backgroundSyncLine(state);
      if (line === lastNotStarted) return null;
      lastNotStarted = line;
      if (line) log(line);
      return line;
    },
  };
}

/**
 * Sync Now on a log that is missing the account's history (B10, 2026-11-15):
 * a Mac signed in with sync on held 2 QSOs while the Cloud held 360, and
 * every Sync Now reported "received 0" because the pull starts from the
 * saved cursor, which was already past them. When this log holds fewer QSOs
 * than the Cloud and a cursor is set, pull the whole history again. The
 * merge is keyed by uuid (and the duplicate guard), so records already here
 * are not added twice. Unknown counts never trigger it.
 */
function shouldRepullHistory({ cloudCount, localCount, hasCursor }) {
  if (!hasCursor) return false; // the next pull is already the whole history
  if (!Number.isFinite(cloudCount) || !Number.isFinite(localCount)) return false;
  return cloudCount > localCount;
}

function repullLine({ cloudCount, localCount }) {
  return `[Cloud] Sync Now: this log holds ${localCount} QSO${localCount === 1 ? '' : 's'} and the Cloud ${cloudCount}: pulling the account's whole history again`;
}

module.exports = { syncSummaryLine, syncErrorLine, backgroundSyncLine, createSyncLogger, shouldRepullHistory, repullLine };
