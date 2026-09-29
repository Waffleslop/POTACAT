'use strict';
// Whether the desktop SSTV decoder is running, and what an ECHOCAT sstv-stop
// should do about it (potacat-meta work/open/sstv-decoder-state-desktop.md).
//
// The mobile app keeps its own "RX is on" belief, and it goes stale when the
// operator closes the SSTV window at the desk or the desktop restarts. So the
// desktop reports the truth as S2C `sstv-decoder-state`. It is deliberately
// NOT part of `activity-state`: that answers "should I wait before taking the
// radio", and a decoder listening on a quiet band must not make the radio
// look busy.
//
// sstv-stop arrives in two forms:
//   { reason: 'user' } — the app's explicit Stop RX button (potacat-app d84e920)
//   bare               — older apps, sent on every SSTV tab switch
// The bare form must keep e6326b3a's behaviour (ignored while the SSTV window
// is open), or every tab switch on an old app kills the desk's decoder.

/**
 * @param {object} o
 * @param {string} [o.reason]      sstv-stop's reason ('user' = explicit Stop RX)
 * @param {boolean} o.windowOpen   the desktop SSTV window is open
 * @param {'app'|'desktop'|null} o.openedBy  who opened that window
 * @param {boolean} o.running      the decoder is running
 * @returns {{action: 'stop-and-close'|'stop'|'keep-desktop'|'keep-window'|'none', log: string|null}}
 */
function decideSstvStop(o) {
  const explicit = o.reason === 'user';
  if (!o.windowOpen) {
    if (!o.running) return { action: 'none', log: null };
    return {
      action: 'stop',
      log: explicit ? '[SSTV] Decoder stopped by the ECHOCAT app (Stop RX)' : '[SSTV] Decoder stopped by the ECHOCAT app',
    };
  }
  if (explicit && o.openedBy === 'app') {
    return { action: 'stop-and-close', log: '[SSTV] Decoder stopped by the ECHOCAT app (Stop RX)' };
  }
  if (explicit) {
    return {
      action: 'keep-desktop',
      log: '[SSTV] The ECHOCAT app pressed Stop RX; the decoder keeps running because the SSTV window was opened here at the desk',
    };
  }
  return {
    action: 'keep-window',
    log: '[SSTV] The ECHOCAT app closed SSTV; the decoder keeps running because the SSTV window is open here',
  };
}

/** The S2C payload. openedBy is null whenever no window is open. */
function sstvDecoderState({ running, windowOpen, openedBy }) {
  const open = !!windowOpen;
  return {
    running: !!running,
    windowOpen: open,
    openedBy: open && (openedBy === 'app' || openedBy === 'desktop') ? openedBy : null,
  };
}

module.exports = { decideSstvStop, sstvDecoderState };
