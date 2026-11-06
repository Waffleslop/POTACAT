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

// While the dial is shifted, and for a short time after it is put back, a
// frequency the radio reports at the shifted dial is ours, not the
// operator's: it must never reach the displays, the log, the JTCAT band
// anchor or the wrong-band guard.
const LATE_READ_MS = 3000;
function isShiftEcho(hz, state, now) {
  if (!state || !(state.txDialHz > 0)) return false;
  if (state.active) return true;
  if (!(state.restoredAt > 0) || now - state.restoredAt > LATE_READ_MS) return false;
  return Math.abs(Number(hz) - state.txDialHz) <= 10;
}

function describeShift(plan, audioHz) {
  if (!plan) return '';
  const sign = plan.shiftHz > 0 ? '+' : '';
  return `Fake It: dial ${(plan.txDialHz / 1e6).toFixed(6)} MHz for this transmission (${sign}${plan.shiftHz} Hz), audio at ${audioHz} Hz`;
}

module.exports = {
  FAKE_IT_MODES,
  LATE_READ_MS,
  fakeItShiftHz,
  fakeItApplies,
  shiftFor,
  planShift,
  isShiftEcho,
  describeShift,
};
