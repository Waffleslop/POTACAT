/**
 * WSJT-X Mode, said so the operator cannot miss it (#547) — SHARED between
 * main, the main window and ECHOCAT Web.
 *
 * With WSJT-X Mode on (settings.enableWsjtx) POTACAT leaves the radio to
 * WSJT-X: no CAT link, spot clicks do not tune, POTACAT's own FT8 does not
 * key. The CAT pill used to turn green ("Radio controlled by WSJT-X") even
 * when WSJT-X was not running, so operators thought all was well. This module
 * decides whether WSJT-X has been heard and holds every sentence the status
 * chip, the panel, the start notice, the bug report and ECHOCAT Web show, so
 * they all say the same thing.
 *
 * "Heard" = a WSJT-X Heartbeat or Status packet arrived on the UDP port in
 * the last 60 s (lib/wsjtx.js stamps lastHeardAt on both).
 *
 * Dual-mode: Node `require()` gets `module.exports`; the browser (plain
 * <script> tag) gets `window.WsjtxModeNotice`. No DOM or Node dependencies.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WsjtxModeNotice = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HEARD_WINDOW_MS = 60 * 1000;   // a packet within this long = WSJT-X is talking to us
  var START_NOTICE_DELAY_MS = 30 * 1000; // the start notice waits this long for WSJT-X

  /** Was WSJT-X heard (Heartbeat or Status) within the last 60 s? */
  function isHeard(lastHeardAt, now) {
    var t = Number(lastHeardAt) || 0;
    if (t <= 0) return false;
    var n = Number(now);
    if (!isFinite(n)) n = Date.now();
    return n - t >= 0 && n - t <= HEARD_WINDOW_MS;
  }

  function portOf(port) {
    var p = parseInt(port, 10);
    return p > 0 ? p : 2237;
  }

  /** Text and tooltip of the status-bar chip while the mode is on. */
  function chip() {
    return { label: 'WSJT-X Mode', title: 'WSJT-X Mode is on: WSJT-X has the radio. Click for details.' };
  }

  /** The CAT pill while the mode is on: neutral, never green. */
  function catPill() {
    return { label: 'CAT: off', title: "WSJT-X Mode is on: WSJT-X has the radio" };
  }

  /**
   * The panel opened from the chip or the CAT pill.
   * Returns { title, line, state, hint, primary } where primary is 'off' when
   * WSJT-X was not heard (Turn off is the main button) and 'keep' otherwise.
   */
  function panel(opts) {
    var o = opts || {};
    var heard = !!o.heard;
    return {
      title: 'WSJT-X Mode is on',
      line: "POTACAT leaves the radio to WSJT-X. While it's on, clicking a spot doesn't tune the radio and POTACAT's own FT8 doesn't transmit.",
      state: heard ? 'WSJT-X is talking to POTACAT' : 'WSJT-X not heard on port ' + portOf(o.port),
      hint: heard ? '' : "If you're not using WSJT-X, turn this off and POTACAT connects to your radio.",
      turnOffLabel: 'Turn off WSJT-X Mode',
      keepLabel: 'Keep it on',
      primary: heard ? 'keep' : 'off',
    };
  }

  /**
   * The main-window notice 30 s after start. null = do not show: the mode is
   * off, WSJT-X was heard, or the operator chose Keep it on this run.
   */
  function startNotice(opts) {
    var o = opts || {};
    if (!o.mode || o.heard || o.everHeard || o.kept) return null;
    return {
      title: "WSJT-X Mode is on, and WSJT-X isn't running",
      line: "POTACAT isn't connected to your radio. Turn the mode off to use the radio from POTACAT.",
      turnOffLabel: 'Turn off WSJT-X Mode',
      keepLabel: 'Keep it on',
    };
  }

  /** Station Setup's top line while the mode is on. */
  function stationSetupNotice() {
    return {
      text: 'WSJT-X Mode is on, so the radio checks are skipped.',
      action: { id: 'wsjtx-mode-off', label: 'Turn off WSJT-X Mode' },
    };
  }

  /** The first line of a bug report's header, or '' when the mode is off. */
  function reportLine(opts) {
    var o = opts || {};
    if (!o.mode) return '';
    return '**WSJT-X Mode:** ON (POTACAT releases the radio to WSJT-X); WSJT-X '
      + (o.heard ? 'heard' : 'NOT heard') + ' on UDP port ' + portOf(o.port) + ' in the last 60 s';
  }

  /** ECHOCAT Web's explain-only note (no remote turn-off). */
  function remoteNote() {
    return 'The shack is in WSJT-X Mode. WSJT-X has the radio, so tuning and transmitting from here are off. '
      + "Turn it off at the shack: click CAT in POTACAT's top bar and untick WSJT-X Mode.";
  }

  return {
    HEARD_WINDOW_MS: HEARD_WINDOW_MS,
    START_NOTICE_DELAY_MS: START_NOTICE_DELAY_MS,
    isHeard: isHeard,
    chip: chip,
    catPill: catPill,
    panel: panel,
    startNotice: startNotice,
    stationSetupNotice: stationSetupNotice,
    reportLine: reportLine,
    remoteNote: remoteNote,
  };
});
