'use strict';
// FreeDV status for ECHOCAT (FDV1, agreed with ECHOCAT 2026-11-16).
//
// One S2C message, `freedv-status`, is the phone's single source for its
// FreeDV strip and its honest "not available" states:
//   { state: 'off'|'starting'|'running'|'unavailable', mode, modes, rx, tx,
//     sync, snr, reason, reasonCode, callsign, callsignAt }
// `reason` is one plain sentence the phone shows as is; `reasonCode` is for
// placement and tests only. `tx` is false and `callsign` null until FreeDV
// transmit and callsign decode exist (FDV2).
//
// Sent after every auth-ok and on every change. Sync/SNR changes are
// throttled: at most 4 per second, and an SNR change counts only at 1 dB.

const FREEDV_MODES = ['RADEV1', '700E', '700D', '700C', '1600'];

const REASONS = {
  disabled: 'FreeDV is turned off in POTACAT on the shack computer.',
  'no-decoder': 'POTACAT on the shack computer has no FreeDV decoder in this build. Update POTACAT, or send a bug report from it.',
  'no-rade': 'This build of POTACAT has no RADE decoder. The older FreeDV modes still work.',
};

const THROTTLE_MS = 250;
const SNR_STEP_DB = 1;

function isRade(mode) { return /RADE/i.test(String(mode || '')); }

// decoders: { classic: bool, rade: bool } (which native addons this machine has)
function buildFreedvStatus({ enabled, decoders, running, mode, sync, snr, error } = {}) {
  const dec = decoders || { classic: false, rade: false };
  const modes = FREEDV_MODES.filter((m) => (isRade(m) ? dec.rade : dec.classic));
  const base = {
    mode: mode || null,
    modes,
    rx: modes.length > 0,
    tx: false,
    sync: false,
    snr: null,
    reason: null,
    reasonCode: null,
    callsign: null,
    callsignAt: null,
  };
  if (!enabled) return { ...base, state: 'off', reason: REASONS.disabled, reasonCode: 'disabled' };
  if (!modes.length) return { ...base, state: 'unavailable', reason: REASONS['no-decoder'], reasonCode: 'no-decoder' };
  if (running && mode && isRade(mode) && !dec.rade) {
    return { ...base, state: 'unavailable', reason: REASONS['no-rade'], reasonCode: 'no-decoder' };
  }
  if (running && error) {
    return { ...base, state: 'unavailable', reason: String(error), reasonCode: 'no-decoder' };
  }
  if (!running) return { ...base, state: 'off' };
  const snrNum = Number(snr);
  return {
    ...base,
    state: 'running',
    sync: !!sync,
    snr: Number.isFinite(snrNum) ? Math.round(snrNum * 10) / 10 : null,
  };
}

// Decide whether `next` goes out, given the last one sent. Anything other
// than sync/SNR sends at once; sync flips and 1 dB SNR moves send at most
// every 250 ms. Returns true (send now), false (nothing new) or 'later'.
function shouldSendStatus(prev, next, now, lastSentAt) {
  if (!prev) return true;
  for (const k of ['state', 'mode', 'reason', 'reasonCode', 'rx', 'tx', 'callsign']) {
    if (prev[k] !== next[k]) return true;
  }
  if ((prev.modes || []).join(',') !== (next.modes || []).join(',')) return true;
  const syncFlip = prev.sync !== next.sync;
  const snrMove = (prev.snr == null) !== (next.snr == null)
    || (prev.snr != null && next.snr != null && Math.abs(prev.snr - next.snr) >= SNR_STEP_DB);
  if (!syncFlip && !snrMove) return false;
  // Throttled: 'later' tells the caller to send it once the 250 ms are up,
  // so the last sync/SNR state is never lost.
  return (now - (lastSentAt || 0)) >= THROTTLE_MS ? true : 'later';
}

module.exports = { buildFreedvStatus, shouldSendStatus, FREEDV_MODES, REASONS, THROTTLE_MS };
