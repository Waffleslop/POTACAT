// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Which path POTACAT drives the radio on right now, in the order main.js
// tuneRadio() checks them. One answer to "is the radio reachable for
// tuning", for every feature that moves the radio and puts it back
// (APRS "Listen on my radio" first).
//
// Found on a FLEX-8600M on 2026-11-18: with Flex Direct up ("Connected to
// Flex 8600") APRS refused with "Connect your radio to listen to APRS."
// because it asked `cat && cat.connected`. On Flex Direct the CAT entry is
// the SmartSDR CAT shim on 127.0.0.1:5002, dead without SmartSDR; the radio
// is driven through the SmartSDR API, as tuneRadio already does.
//
// Pure: the caller hands in the live state.
'use strict';

const ROUTES = ['tci', 'flex-wsjtx', 'flex-direct', 'cat'];

/**
 * @param {object} s
 * @param {boolean} s.tciTarget          a TCI catTarget is active (main.js tciRigTarget())
 * @param {boolean} s.tciLinked          its link is up (tciRigLinked())
 * @param {boolean} s.wsjtxMode          settings.enableWsjtx: WSJT-X holds the CAT port
 * @param {boolean} s.smartSdrConnected  the SmartSDR API socket is up
 * @param {boolean} s.smartSdrCanTune    the SmartSDR API can tune a slice (smartSdr.canTune)
 * @param {boolean} s.smartSdrSelf       POTACAT is the GUI client with its own slice (smartSdr.mode === 'self')
 * @param {boolean} s.catConnected       cat && cat.connected (serial CAT, rigctld, Icom Network, CI-V/TCP, the 5002 shim)
 * @param {string}  [s.catTargetType]    settings.catTarget.type
 * @returns {''|'tci'|'flex-wsjtx'|'flex-direct'|'cat'} '' = nothing can tune the radio
 */
function tuneRoute(s) {
  s = s || {};
  // A TCI rig (Zeus / Thetis) tunes over its own link and nothing else.
  if (s.tciTarget) return s.tciLinked ? 'tci' : '';
  // WSJT-X mode with CAT closed: only a Flex on the SmartSDR API can be tuned.
  if (s.wsjtxMode && !s.catConnected) return (s.smartSdrConnected && s.catTargetType === 'tcp') ? 'flex-wsjtx' : '';
  // Flex Direct: our own slice, or the API when no live CAT shim is beside it.
  if (s.smartSdrCanTune && (s.smartSdrSelf || !s.catConnected)) return 'flex-direct';
  if (s.catConnected) return 'cat';
  return '';
}

/** The radio can be tuned (and so put back) now. */
function canTune(s) { return tuneRoute(s) !== ''; }

/**
 * A mode sent on its own (cat.setModeOnly: the packet data mode, the mode
 * sent again by name after a return) goes over CAT only. On a Flex route the
 * live `cat`, if any, is SmartSDR's shim and would move SmartSDR's slice.
 */
function modeOverCat(route) { return route === 'cat'; }

/**
 * The dial and mode to save before the radio moves, read from the route's own
 * readback: on Flex the slice (main.js mirrors it into the dial from the
 * SmartSDR API, never from the shim), on TCI the TCI dial, on CAT the radio's
 * CAT readback. An Icom's USB + DATA flag is a CAT readback only, so its data
 * form (DIGU) applies to the CAT route alone.
 *
 * @param {object} o
 * @param {string} o.route        tuneRoute()
 * @param {number} o.freqHz       the dial (main.js _currentFreqHz)
 * @param {string} o.mode         the mode (main.js _currentMode)
 * @param {string} [o.catDataForm] the CAT data form of the mode ('' when the radio reports no DATA flag)
 * @returns {{freqHz:number, mode:string}}
 */
function placeBefore({ route, freqHz, mode, catDataForm } = {}) {
  const hz = Number(freqHz) > 0 ? Math.round(Number(freqHz)) : 0;
  const m = String(mode || '');
  return { freqHz: hz, mode: route === 'cat' && catDataForm ? String(catDataForm) : m };
}

module.exports = { ROUTES, tuneRoute, canTune, modeOverCat, placeBefore };
