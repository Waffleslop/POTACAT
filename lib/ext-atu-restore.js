'use strict';
// The external RF-sense tune's mode restore (main.js runExternalAtuTune).
// The tune puts the radio in AM for its carrier and must put back exactly
// what the operator had, DATA included, and believe only the radio's
// readback (bobve IC-7300 + LDG over Cloud, 2026-11-03: the radio stayed in
// AM after a tune and FT8 stopped decoding).
//
// An Icom reports USB with its DATA flag separate (CI-V 1A 06), so
// _currentMode reads "USB" during FT8, and a CI-V "USB" set sends DATA OFF.
// Restoring that name dropped the radio out of USB-D. Restore the DATA name
// instead; the codec re-selects the D-number the radio last reported.

const DATA_NAME = { USB: 'DIGU', LSB: 'DIGL', FM: 'DIGFM', AM: 'DIGAM' };

/**
 * The name to send to put the operator's mode back.
 *   mode    the mode the radio reported before the tune (_currentMode)
 *   dataOn  the radio's separate DATA flag was on (Icom dataModeState)
 */
function restoreModeName(mode, dataOn) {
  const m = String(mode || '').toUpperCase();
  if (dataOn && DATA_NAME[m]) return DATA_NAME[m];
  return mode;
}

/**
 * Did the radio take the restore?
 *   readback   the mode the radio reported after the restore was sent
 *   wantMode   the mode it reported before the tune
 *   dataState  the codec's separate DATA flag now ({on}) or null when the
 *              radio has none / never reported one
 *   wantData   it was on before the tune
 */
function modeConfirmed(readback, wantMode, dataState, wantData) {
  if (!readback || String(readback).toUpperCase() !== String(wantMode || '').toUpperCase()) return false;
  if (!dataState) return true;            // no separate flag: the name says it all
  return !!dataState.on === !!wantData;
}

module.exports = { restoreModeName, modeConfirmed, DATA_NAME };
