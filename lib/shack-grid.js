'use strict';
// lib/shack-grid.js — the grid of the shack this desktop drives (#774).
// A desktop on a Guest Pass, or the owner away from home, hears its decodes
// at the shack, so the JTCAT map centres there, not on this computer's own
// grid. The shack sends it as settings.grid in auth-ok and settings-update.

const MAIDENHEAD = /^[A-R]{2}[0-9]{2}([A-X]{2}([0-9]{2})?)?$/;

/** The shack's grid from its settings blob, upper case; '' when absent or not a locator. */
function shackGridFrom(settings) {
  const g = settings && typeof settings.grid === 'string' ? settings.grid.trim().toUpperCase() : '';
  return MAIDENHEAD.test(g) ? g : '';
}

module.exports = { shackGridFrom };
