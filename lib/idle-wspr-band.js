'use strict';
/**
 * Which band idle-RX WSPR listens on (artificialjumpprotection, IC-7100 with
 * no HF antenna, 2026-11-05): it went to 20 m with 20 m turned off in the
 * rig's band list, and there was no 2 m to choose, though the WSPR table has a
 * 2 m dial (144.489, 2aee1afd).
 *
 * The saved band if this radio has it; otherwise the first band in the list
 * that it has; null when it has none of them. 70 cm is not offered: the WSPR
 * table (lib/wspr/bands.js) has no 70 cm dial to tune.
 */
const RigBands = require('./rig-bands');

const IDLE_WSPR_BANDS = Object.freeze(['40m', '30m', '20m', '17m', '15m', '10m', '2m']);

function pickIdleWsprBand(saved, rigBands) {
  const ok = (b) => IDLE_WSPR_BANDS.includes(b) && RigBands.allowed(rigBands, b);
  if (ok(saved)) return saved;
  return IDLE_WSPR_BANDS.find(ok) || null;
}

/** The WSPR hop list, without bands this radio is not used on. */
function hopBandsForRig(bands, rigBands) {
  return (bands || []).filter((b) => RigBands.allowed(rigBands, b));
}

module.exports = { IDLE_WSPR_BANDS, pickIdleWsprBand, hopBandsForRig };
