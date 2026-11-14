'use strict';
/**
 * Why POTACAT is not talking to the radio, said where the operator looks (#407).
 *
 * An FTDX10 behind a Win4Yaesu virtual COM port never connected at startup,
 * the log held no connect attempt at all, and a spot click said "tune refused -
 * no radio connected. Check Settings -> My Rigs", the one place that was
 * already right. Test Connection in the rig editor then connected at once.
 * Two causes produce exactly that, and both were silent:
 *   1. WSJT-X Mode is on: startup leaves the radio to WSJT-X and said nothing,
 *      while the reconnect after Test Connection ignored the setting.
 *   2. Windows lists neither in serialport's list nor in SERIALCOMM a virtual
 *      port that opens fine; startup waited for a port it could not see while
 *      Test Connection simply opened it.
 *
 * Pure decisions and wording; main does the opening, the logging and the IPC.
 */

/** Where the operator turns WSJT-X Mode off: the CAT menu (CAT in the top bar) or Settings. */
const WSJTX_MODE_WHERE = 'untick WSJT-X Mode (click CAT in the top bar; it is also WSJT-X Integration in Settings)';

/** Does WSJT-X Mode hold the radio? Then POTACAT opens no CAT link of its own. */
function wsjtxHoldsRadio(settings) {
  return !!(settings && settings.enableWsjtx);
}

/** The one line startup (and every declined reconnect) logs when WSJT-X Mode holds the radio. */
function wsjtxDeclineLine() {
  return '[CAT] Not connecting to the radio: WSJT-X Mode is on, so POTACAT leaves the radio to WSJT-X. '
    + 'For POTACAT to control the radio, ' + WSJTX_MODE_WHERE + '.';
}

/**
 * After Test Connection: reconnect the saved rig, or leave the radio to WSJT-X.
 * The test itself always runs (it only proves the cable and settings); what it
 * must not do is take the radio for the rest of the session behind WSJT-X
 * Mode, which every other connect path honours. Returns 'reconnect' | 'wsjtx' | 'none'.
 */
function afterCatTest(settings) {
  const s = settings || {};
  const hasRig = !!(s.catTarget || (s.rigs || []).some((r) => r && r.catTarget));
  if (!hasRig) return 'none';
  return wsjtxHoldsRadio(s) ? 'wsjtx' : 'reconnect';
}

/** Appended to a passing test's result while WSJT-X Mode is on. */
function wsjtxTestNote() {
  return 'WSJT-X Mode is on, so POTACAT has left the radio to WSJT-X. For POTACAT to control it, ' + WSJTX_MODE_WHERE + '.';
}

/**
 * A spot click with no radio link: the log line and the toast, naming the real
 * cause and the place to fix it. With none of the known causes the wording is
 * exactly what it always was.
 *   verb: 'refused' (the tune IPC) or 'ignored' (tuneRadio)
 *   wsjtxMode: WSJT-X Mode is on
 *   waitingPort: the serial port POTACAT is waiting to appear, or ''
 *   catNone: the operator chose None for the radio
 */
function tuneRefusal({ verb = 'refused', wsjtxMode = false, waitingPort = '', catNone = false } = {}) {
  if (wsjtxMode) {
    return {
      log: `tune ${verb} — WSJT-X Mode is on, so POTACAT leaves the radio to WSJT-X. For POTACAT to tune it, ${WSJTX_MODE_WHERE}.`,
      toast: 'WSJT-X Mode is on: WSJT-X has the radio. Untick WSJT-X Mode (click CAT in the top bar) for POTACAT to tune it',
    };
  }
  if (catNone) {
    return {
      log: `tune ${verb} — no radio is selected (None). Pick a rig in Settings > My Rigs or the CAT menu.`,
      toast: 'No radio selected — pick one in the CAT menu or Settings > My Rigs',
    };
  }
  if (waitingPort) {
    return {
      log: `tune ${verb} — ${waitingPort} is not there (radio unplugged or switched off?). POTACAT connects when it appears.`,
      toast: `Radio not connected — ${waitingPort} is not there (unplugged or switched off?)`,
    };
  }
  return {
    log: `tune ${verb} — no radio connected. Check Settings -> My Rigs.`,
    toast: 'Radio not connected — check the USB/serial link (Settings > My Rigs)',
  };
}

/**
 * A port in neither of Windows' lists is opened once to find out (#407).
 * The open's error says whether the device exists:
 *   'opened' - it opened (a virtual port such as Win4Yaesu, or a port sharer)
 *   'busy'   - it exists but another program holds it; the connect reports that itself
 *   'absent' - Windows has no such device (unplugged, switched off, wrong number)
 * serialport's Windows binding names ERROR_FILE_NOT_FOUND "File not found";
 * ERROR_PATH_NOT_FOUND arrives as "Unknown error code 3".
 */
function classifyOpenResult(err) {
  if (!err) return 'opened';
  const msg = String((err && err.message) || err || '');
  if (/file not found|path not found|no such file|cannot find|ENOENT|unknown error code [23]\b/i.test(msg)) return 'absent';
  return 'busy';
}

/** The line logged (once per port) when a port Windows does not list is used anyway. */
function unlistedPortLine(port, how) {
  return how === 'busy'
    ? `[CAT] ${port} is not in Windows' lists of serial ports, but it exists (another program may hold it). Connecting to it anyway.`
    : `[CAT] ${port} is not in Windows' lists of serial ports, but it opens (a virtual port such as Win4Yaesu or a port sharer?). Connecting to it anyway.`;
}

module.exports = {
  WSJTX_MODE_WHERE,
  wsjtxHoldsRadio,
  wsjtxDeclineLine,
  afterCatTest,
  wsjtxTestNote,
  tuneRefusal,
  classifyOpenResult,
  unlistedPortLine,
};
