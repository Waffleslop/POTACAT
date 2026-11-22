'use strict';
// FreeDV PTT refusal (FreeDV audit 2026-11-16, FDV1 row 4).
//
// POTACAT cannot transmit FreeDV yet. While a FreeDV mode runs, the radio is
// in DIGU/DIGL (or plain USB/LSB) on a FreeDV frequency, so a voice key-down
// from any surface (desktop PTT, the VFO window, ECHOCAT, a voice macro)
// would put analog voice on the air where FreeDV stations listen. Refuse it
// and say why.
//
// Key-downs that name what they send (FT8/JTCAT, SSTV, Winlink, a tune
// carrier) pass: each carries opts.emission, and only voice keys without one.
// A release (state false) always passes.

const FREEDV_PTT_REFUSAL =
  'FreeDV transmit is coming in a later update, so PTT is off in FreeDV modes. Tune to an SSB frequency to talk.';

function freedvPttRefusal({ state, freedvRunning, emission, forceDataMode } = {}) {
  if (!state) return null;
  if (!freedvRunning) return null;
  if (emission || forceDataMode) return null;
  return FREEDV_PTT_REFUSAL;
}

module.exports = { freedvPttRefusal, FREEDV_PTT_REFUSAL };
