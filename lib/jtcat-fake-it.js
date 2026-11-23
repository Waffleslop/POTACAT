'use strict';
// Split operation, "Fake It" (WSJT-X Settings > Radio > Split Operation).
//
// A radio's SSB/DATA filter passes roughly 300-2700 Hz, and its TX audio
// chain is cleanest in the middle. An FT8 reply at 400 Hz or 2900 Hz can be
// cut, weak, or carry harmonics the filter does not remove (level_death,
// 2026-11-04). Fake It moves the radio's dial for the length of each
// transmission so the audio tone always sits between 1500 and 1999 Hz, and
// the signal still lands on the same RF frequency:
//
//   RF = dial + txAudio = (dial + shift) + (txAudio - shift)
//
// The shift is WSJT-X's own rule (mainwindow.cpp setXIT):
//   m_XIT = (n / 500) * 500 - 1500          (integer division)
// so the played tone is n - shift, in [1500, 2000).
//
// Pure: the engine renders the tone at audioHz, main moves the dial by
// shiftHz before the key-down and puts it back after the key-up.

const FAKE_IT_MODES = ['FT8', 'FT4', 'FT2'];

function fakeItShiftHz(txAudioHz) {
  const n = Math.round(Number(txAudioHz));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n / 500) * 500 - 1500;
}

function fakeItApplies(mode) {
  return FAKE_IT_MODES.includes(String(mode || '').toUpperCase());
}

// The shift the engine renders this transmission with: 0 whenever Fake It is
// off or the mode is not one it covers.
function shiftFor({ enabled, mode, txAudioHz } = {}) {
  if (!enabled || !fakeItApplies(mode)) return 0;
  return fakeItShiftHz(txAudioHz);
}

// A transmission's dial plan. null = leave the dial alone.
function planShift({ shiftHz, dialHz } = {}) {
  const s = Math.round(Number(shiftHz) || 0);
  const d = Math.round(Number(dialHz) || 0);
  if (!s || !(d > 100000)) return null;
  return { dialHz: d, txDialHz: d + s, shiftHz: s };
}

// While the dial is shifted, and after it is put back until the radio reports
// some other frequency, a frequency read at the shifted dial is ours, not the
// operator's: it must never reach the displays, the log, the JTCAT band
// anchor or the wrong-band guard. There is no time limit (GitHub #681): a
// FTDX10 on a Mac read the shifted dial after the old 3 s window, that read
// became the dial, and the next transmission shifted again from there, 500 Hz
// further every cycle. The first read of any other frequency (the restored
// dial, or the operator's knob) ends it; `settled` marks that.
const ECHO_TOLERANCE_HZ = 10;
function isShiftEcho(hz, state) {
  if (!state || !(state.txDialHz > 0)) return false;
  if (state.active) return true;
  if (state.settled) return false;
  return Math.abs(Number(hz) - state.txDialHz) <= ECHO_TOLERANCE_HZ;
}

// A read after the dial was put back that still shows the shifted dial means
// one of two things: a late answer to a poll sent before the restore, or a
// radio that never took the restore (a write that arrived during the TX to RX
// turnaround, or a CAT server that dropped it). Both are answered by sending
// the dial back again: harmless for the first, the fix for the second. At
// most RESTORE_RETRIES times, RESTORE_RETRY_GAP_MS apart; if the radio still
// sits on the shifted dial after that, it is taken as the dial (the operator
// may have tuned there) and the log says so.
const RESTORE_RETRIES = 3;
const RESTORE_RETRY_GAP_MS = 1000;

// One frequency read against the Fake It state. Pure: returns
//   { echo, action: null | 'restore' | 'accept', patch }
// echo: drop the read. action 'restore': send state.dialHz again.
// action 'accept': retries spent, the read is the dial now.
// patch: fields to merge into the state.
function onDialRead(hz, state, now) {
  if (!state || !(state.txDialHz > 0) || state.settled) return { echo: false, action: null, patch: null };
  if (state.active) return { echo: true, action: null, patch: null };
  if (!isShiftEcho(hz, state)) return { echo: false, action: null, patch: { settled: true } };
  // Still waiting for the restore to be written (link down): just drop it.
  if (state.restorePending || !(state.restoredAt > 0)) return { echo: true, action: null, patch: null };
  const tries = Number(state.restoreRetries) || 0;
  const last = Number(state.lastRetryAt) || Number(state.restoredAt) || 0;
  if (tries >= RESTORE_RETRIES) {
    if (now - last < RESTORE_RETRY_GAP_MS) return { echo: true, action: null, patch: null };
    return { echo: false, action: 'accept', patch: { settled: true } };
  }
  if (tries > 0 && now - last < RESTORE_RETRY_GAP_MS) return { echo: true, action: null, patch: null };
  return { echo: true, action: 'restore', patch: { restoreRetries: tries + 1, lastRetryAt: now } };
}

// Where the engine may render shifted audio: a single-band engine, on this
// PC's own radio, with a dial this PC can move for the transmission. Anywhere
// else the tone goes out at the plain audio offset, exactly as with Fake It
// off, instead of a transmission that is refused or lands off frequency:
//   - no radio picked, or a radio without CAT (VOX kits): nothing moves the dial;
//   - a TCI rig (Zeus / Thetis): the TCI transmit path cannot move the dial
//     and refuses a shifted over;
//   - the radio in split: the dial write moves the receive VFO, the radio
//     transmits on the other one, and the signal would land shiftHz away;
//   - more than one band at once, or a laptop driving a remote shack (the
//     shack applies its own setting).
function engineCanShift({ enabled, multiBand, remote, catTarget, catNone, split } = {}) {
  if (!enabled || multiBand || remote || split) return false;
  if (catNone || !catTarget || typeof catTarget !== 'object') return false;
  const type = String(catTarget.type || '');
  return !!type && type !== 'none' && type !== 'tci';
}

// On by default for a new setup, and nobody's existing setup changes
// (Casey 2026-11-23, after N4RLW's IC-7300/IC-7100 power report). The key
// itself is the marker: a brand-new settings object gets it on; an existing
// one that never had it gets it written off, once, so what the operator has
// today (off) stays off after every save and reload. A saved true or false is
// never touched. Returns true when it wrote the key (the caller saves).
const NEW_SETUP_DEFAULT = true;
function seedSetting(s, { fresh = false } = {}) {
  if (!s || typeof s !== 'object') return false;
  if (s.jtcatFakeIt !== undefined && s.jtcatFakeIt !== null) return false;
  s.jtcatFakeIt = fresh ? NEW_SETUP_DEFAULT : false;
  return true;
}

function describeShift(plan, audioHz) {
  if (!plan) return '';
  const sign = plan.shiftHz > 0 ? '+' : '';
  return `Fake It: dial ${(plan.txDialHz / 1e6).toFixed(6)} MHz for this transmission (${sign}${plan.shiftHz} Hz), audio at ${audioHz} Hz`;
}

module.exports = {
  FAKE_IT_MODES,
  ECHO_TOLERANCE_HZ,
  RESTORE_RETRIES,
  RESTORE_RETRY_GAP_MS,
  fakeItShiftHz,
  fakeItApplies,
  shiftFor,
  planShift,
  isShiftEcho,
  onDialRead,
  describeShift,
  engineCanShift,
  NEW_SETUP_DEFAULT,
  seedSetting,
};
