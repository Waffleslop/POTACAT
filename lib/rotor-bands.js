'use strict';
/**
 * Rotor control only on chosen bands (#356: "I only need it on 20m and up.
 * 30 and below are a dipole. Don't need the beam swinging around on 30, 40
 * and 80.").
 *
 * Settings: `rotorBandsOnly` (default false) and `rotorBands` (band names,
 * lib/bands.js). Off means every band, exactly as before. On, an automatic
 * turn (spot click in Auto, scan, an ECHOCAT tune) on a band that is not
 * ticked is skipped. A click on the bearing is the operator asking, so main
 * does not filter it.
 *
 * Unknown band (a frequency outside every ham band): skipped while the
 * setting is on. The operator has said which bands the beam is for; a
 * frequency that is none of them is not one of them, and not turning is the
 * choice that cannot hurt anything.
 *
 * On with no band ticked is treated as off, so ticking the box before the
 * bands never leaves a rotor that silently stops turning.
 */
const { ALL_BANDS } = require('./rig-bands');

/** Common station when no rig is configured: HF and 6 m. */
const DEFAULT_CHOICES = ['160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m'];

/** Known band names, lower case, low to high, no duplicates. */
function clean(list) {
  if (!Array.isArray(list)) return [];
  const want = new Set(list.map((b) => String(b == null ? '' : b).trim().toLowerCase()));
  return ALL_BANDS.filter((b) => want.has(b));
}

/** True when the band limit is in force (on, with at least one band ticked). */
function isOn(settings) {
  const s = settings || {};
  return s.rotorBandsOnly === true && clean(s.rotorBands).length > 0;
}

/**
 * Should an automatic rotor turn happen on `band`?
 * Returns { turn: true } or { turn: false, line } where `line` is the one
 * log line that says why.
 */
function decide(settings, band) {
  if (!isOn(settings)) return { turn: true };
  const bands = clean(settings.rotorBands);
  const b = String(band == null ? '' : band).trim().toLowerCase();
  if (b && bands.includes(b)) return { turn: true };
  if (!b || !ALL_BANDS.includes(b)) {
    return { turn: false, line: 'Rotor: not turned, this frequency is not a ham band and the rotor is set to turn only on ' + bands.join(' ') + ' (Settings > Tuning > Antenna)' };
  }
  return { turn: false, line: 'Rotor: not turned on ' + b + ', the rotor is set to turn only on ' + bands.join(' ') + ' (Settings > Tuning > Antenna)' };
}

/**
 * The bands to offer as tick boxes: every band any of the operator's rigs
 * covers (each entry is a rig's band list, or null for a rig of unknown model,
 * which is not restricted), plus any band already ticked, low to high.
 */
function choices(rigBandLists, saved) {
  const lists = Array.isArray(rigBandLists) ? rigBandLists : [];
  if (lists.some((l) => !Array.isArray(l))) return ALL_BANDS.slice();
  const set = new Set(lists.length ? [] : DEFAULT_CHOICES);
  for (const l of lists) for (const b of clean(l)) set.add(b);
  for (const b of clean(saved)) set.add(b);
  return ALL_BANDS.filter((b) => set.has(b));
}

module.exports = { ALL_BANDS, clean, isOn, decide, choices };
