'use strict';
/**
 * A digital-mode spot names where the signal is (dial + audio offset), not
 * the dial: an FT8 activator on 7074 + 1000 Hz is spotted at 7075 kHz, and
 * tuning 7075 puts every other FT8 signal outside the passband (level_death
 * 2026-11-04). A spot for FT8/FT4/FT2 that sits in a mode dial's passband
 * (500 Hz below to 3 kHz above) tunes that dial instead.
 */
const SNAP_MODES = new Set(['FT8', 'FT4', 'FT2']);
const BELOW_HZ = 500;
const ABOVE_HZ = 3000;

/**
 * @param {number} freqHz   the spotted frequency
 * @param {string} mode     the spot's mode (only FT8/FT4/FT2 snap)
 * @param {(mode:string)=>Object<string,number>} dialsFor  band -> dial kHz
 * @returns {number|null}   the dial in Hz, or null = tune as spotted
 */
function snapToDial(freqHz, mode, dialsFor) {
  const m = String(mode || '').toUpperCase();
  if (!SNAP_MODES.has(m) || !Number.isFinite(freqHz) || freqHz <= 0) return null;
  const dials = (dialsFor && dialsFor(m)) || {};
  for (const khz of Object.values(dials)) {
    const dial = Math.round(Number(khz) * 1000);
    if (!dial) continue;
    if (freqHz === dial) return null; // already on it
    if (freqHz >= dial - BELOW_HZ && freqHz < dial + ABOVE_HZ) return dial;
  }
  return null;
}

module.exports = { snapToDial, SNAP_MODES, BELOW_HZ, ABOVE_HZ };
