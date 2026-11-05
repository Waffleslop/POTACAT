'use strict';
/**
 * A radio's real full power, when POTACAT's model has the wrong one
 * (W5LEE 2026-11-05: a 5 W Hermes Lite clone behind SDR software that
 * emulates a 100 W Kenwood. POTACAT's TX Pwr slider ran 0-100 "W", 7 W sent
 * 7 % of the radio's 5 W, and every QSO was logged at the 100 the radio
 * reported at full drive).
 *
 * rig.fullPowerW says what the radio makes at full drive (its 100 %). The
 * model is copied with maxPower set to it and every number that maps watts to
 * the radio's own power value scaled with it, so the slider, the power
 * command, the radio's readback and the logged TX_PWR all agree:
 *
 *   Kenwood/Yaesu PC (powerScale): the radio's full-scale code stays the same,
 *     so a generic 100 W model sends PC100 for 5 W and reads PC100 back as 5 W;
 *   Icom 0-255 and Hamlib's 0-1 RFPOWER: already a fraction of maxPower.
 *
 * Not applied where the watts never pass through POTACAT's scaling: flrig
 * and DXLab Commander take watts themselves, and a model with a power table
 * (powerMap / powerChoices) has fixed steps.
 */

const SKIP_PROTOCOLS = new Set(['flrig', 'commander']);

/** The usable override in watts, or 0 for none. */
function fullPowerOf(rig) {
  const w = Number(rig && rig.fullPowerW);
  return Number.isFinite(w) && w > 0 && w <= 2000 ? w : 0;
}

/**
 * The model to use for a rig: `model` itself when the rig sets no override
 * (or it cannot apply), else a COPY with the power fields rescaled. Never
 * mutates the shared model table entry.
 */
function applyFullPower(model, rig) {
  const w = fullPowerOf(rig);
  if (!model || !w) return model;
  if (SKIP_PROTOCOLS.has(model.protocol) || model.powerMap || Array.isArray(model.powerChoices)) return model;
  const oldMax = Number(model.maxPower) || 100;
  if (Math.abs(oldMax - w) < 1e-9) return model;
  const ratio = w / oldMax;
  const out = { ...model };
  out.maxPower = w;
  out.powerScale = (Number(model.powerScale) || 1) / ratio;
  if (model.minPower != null) out.minPower = Math.round(Number(model.minPower) * ratio * 10) / 10;
  else out.minPower = 0;
  // A QRP radio needs tenths of a watt on the slider and in the log.
  if (w <= 20) {
    out.powerStep = w <= 10 ? 0.1 : 0.5;
    out.powerDecimals = 1;
  }
  out.fullPowerOverride = w;
  return out;
}

module.exports = { applyFullPower, fullPowerOf };
