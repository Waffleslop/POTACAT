'use strict';
/**
 * The Kenwood PC (RF power) command on the TCP CAT path (lib/cat.js
 * CatClient): watts <-> the radio's PC value, through the rig model's
 * power fields. GitHub #184.
 *
 * A Hermes Lite behind deskHPSDR or Zeus emulates a 100 W TS-2000: PC000 to
 * PC100 is its drive, 0 to 100 % of whatever the radio really makes. The rig's
 * Full power (W) (lib/rig-full-power.js) already rescales the model so that
 * PC100 means, say, 6 W (powerScale = 100 / 6). The serial Kenwood codec
 * (lib/codecs/kenwood-codec.js) used those fields; the TCP client wrote the
 * watts straight out, so 6 W on the slider sent PC006, 6 % drive, and 1 W
 * sent PC001 (the reporter's logs, v1.14.1).
 *
 * With no Full power set, a 100 W model has powerScale 1 and maxPower 100,
 * and the command is exactly what it always was: PC + whole watts, 3 digits.
 */

/** The power fields of a rig model, with the defaults CatClient always had. */
function pcPowerConfig(model) {
  const m = model || {};
  const scale = Number(m.powerScale) > 0 ? Number(m.powerScale) : 1;
  const max = Number(m.maxPower) > 0 ? Number(m.maxPower) : 100;
  const min = Number(m.minPower) > 0 ? Math.min(Number(m.minPower), max) : 0;
  const decimals = m.powerDecimals != null ? Number(m.powerDecimals) : (scale > 1 ? 1 : 0);
  return { minPower: min, maxPower: max, powerScale: scale, powerDecimals: decimals };
}

/**
 * Watts -> { watts, raw, cmd }: the level clamped to the radio's range, the
 * PC value for it and the command. null for a value that is not a number.
 */
function encodePcPower(watts, config) {
  const cfg = config || pcPowerConfig(null);
  const n = Number(watts);
  if (watts === null || watts === '' || !Number.isFinite(n)) return null;
  const clamped = Math.max(cfg.minPower, Math.min(cfg.maxPower, n));
  // A 100 W model keeps whole watts, as the TCP path always sent them.
  const w = cfg.powerScale === 1 ? Math.round(clamped) : clamped;
  const raw = Math.max(0, Math.min(999, Math.round(w * cfg.powerScale)));
  const shown = Number((raw / cfg.powerScale).toFixed(cfg.powerDecimals));
  return { watts: shown, raw, cmd: `PC${String(raw).padStart(3, '0')};` };
}

/**
 * The radio's PC answer (what follows "PC") -> watts, or null. Leading digits
 * only, as before: a K4 answers with a range letter after them.
 */
function decodePcPower(payload, config) {
  const cfg = config || pcPowerConfig(null);
  const m = /^(\d+)/.exec(String(payload == null ? '' : payload).trim());
  if (!m) return null;
  const raw = parseInt(m[1], 10);
  return Number((raw / cfg.powerScale).toFixed(cfg.powerDecimals));
}

module.exports = { pcPowerConfig, encodePcPower, decodePcPower };
