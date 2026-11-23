// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Which CW sideband a tune puts the radio in (GitHub #753).
//
// One question per rig in the rig editor, "CW sideband":
//   - Automatic (the default, and POTACAT's behaviour before this setting):
//     a CW tune sends the radio's normal CW mode (CW-U on a Yaesu, CW on an
//     Icom, Kenwood or Elecraft) on every band, and a radio the operator has
//     put in the reverse mode (CW-L / CW-R) stays there (the AE4XO rule,
//     v1.9.21 "CW Sideband Preserved"). POTACAT has never picked the CW
//     sideband by band; only SSB follows the band (lib/ssb-sideband.js).
//   - Always CW-U (CW): every CW tune, on every band, uses the normal mode.
//   - Always CW-L (CW-R): every CW tune, on every band, uses the reverse mode.
//
// The setting travels as a mode name, so every path a CW tune takes (spot
// click, VFO window, band buttons, ECHOCAT, a reconnect's mode re-send) gets
// it from RigController without knowing about it:
//   requestFor(mode, setting)  'CW' -> 'CW' (Automatic), 'CWU' or 'CWR'
//   wireReverse(request, now)  what the codec sends: the reverse mode or not
// and both answer through sidebandFor(), the one decision.
//
// Each codec's own words for the two modes (no radio menu path here; the
// wire values are the ones the codecs already used for CW and CW-R):
//   Yaesu / Kenwood / Elecraft serial (kenwood codec)  MD3 / MD7
//   Icom CI-V (serial, CI-V over TCP, LAN)              06 03 / 06 07
//   Hamlib rigctld                                      M CW / M CWR
//   flrig                                               the radio's CW-U|CW / CW-L|CW-R
//   DXLab Commander                                     CW / CW-R
//   FT-817/818/857/897 (yaesu-legacy)                   mode byte 02 / 03
//   TCI (Thetis, Zeus, ExpertSDR)                       modulation CWU / CWL
// A Flex has one CW mode, and a SmartSDR CAT (TS-2000 emulation) or K4
// network link is the older client with no reverse mode, so those radio
// types do not show the question.
//
// Dual-mode: Node `require()` gets module.exports; the browser gets
// window.CwSideband. Pure: no DOM, no Node.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CwSideband = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var AUTO = 'band';
  var UPPER = 'upper';
  var LOWER = 'lower';

  // Rig editor radio types whose link can set both CW modes.
  var RADIO_TYPES = ['serialcat', 'icom', 'civ-tcp', 'icom-network', 'yaesu-lan', 'hamlib', 'rigctldnet', 'flrig', 'dxlab-commander', 'tci'];

  function appliesToRadioType(radioType) {
    return RADIO_TYPES.indexOf(String(radioType || '')) !== -1;
  }

  function normalizeSetting(v) {
    return v === UPPER || v === LOWER ? v : AUTO;
  }

  /** The rig's setting. Absent (every rig before #753) is Automatic. */
  function settingOf(rig) {
    return normalizeSetting(rig && rig.cwSideband);
  }

  var CW_NAMES = { 'CW': AUTO, 'CWU': UPPER, 'CW-U': UPPER, 'CWR': LOWER, 'CW-R': LOWER, 'CWL': LOWER, 'CW-L': LOWER };

  function isCw(mode) {
    return Object.prototype.hasOwnProperty.call(CW_NAMES, String(mode || '').toUpperCase());
  }

  /**
   * The one decision: the sideband a CW tune puts the radio in.
   * @param {object} o
   * @param {string} o.setting          settingOf(rig): 'band' (Automatic), 'upper', 'lower'
   * @param {boolean} [o.currentReverse] the radio is in its reverse CW mode now
   * @returns {'upper'|'lower'}
   */
  function sidebandFor(o) {
    o = o || {};
    var s = normalizeSetting(o.setting);
    if (s === UPPER) return UPPER;
    if (s === LOWER) return LOWER;
    return o.currentReverse ? LOWER : UPPER; // Automatic: keep a reverse the operator set
  }

  /**
   * The mode name a tune hands the codec. CW becomes CWU or CWR when the rig
   * has a fixed choice; an explicit CW-R (a saved preset) stays as it is under
   * Automatic. Every other mode is unchanged.
   */
  function requestFor(mode, setting) {
    if (!isCw(mode)) return mode;
    var s = normalizeSetting(setting);
    if (s === UPPER) return 'CWU';
    if (s === LOWER) return 'CWR';
    return mode;
  }

  /** The setting a request carries: CW is Automatic, CWU upper, CWR / CW-L lower. */
  function settingFromRequest(mode) {
    var s = CW_NAMES[String(mode || '').toUpperCase()];
    return s || AUTO;
  }

  /** Codec side: send the reverse CW mode? (null when the request is not CW). */
  function wireReverse(mode, currentReverse) {
    if (!isCw(mode)) return null;
    return sidebandFor({ setting: settingFromRequest(mode), currentReverse: !!currentReverse }) === LOWER;
  }

  /**
   * A CW tune must send the mode even when the radio already reads "CW": the
   * codecs read CW and CW-R alike, so the change check alone would leave a
   * Kenwood in the wrong sideband. currentReverse null = not known.
   */
  function needsSet(mode, currentReverse) {
    if (!isCw(mode) || currentReverse == null) return false;
    return wireReverse(mode, currentReverse) !== !!currentReverse;
  }

  /** The radio's own names for the two modes. */
  function namesFor(brand) {
    if (String(brand || '') === 'Yaesu') return { upper: 'CW-U', lower: 'CW-L', upperAlt: 'CW', lowerAlt: 'CW-R' };
    return { upper: 'CW', lower: 'CW-R', upperAlt: '', lowerAlt: '' };
  }

  var LABEL = 'CW sideband';

  /** The rig editor's choices, in the radio's words. */
  function choices(brand) {
    var n = namesFor(brand);
    return [
      { value: AUTO, label: 'Automatic (default)' },
      { value: UPPER, label: 'Always ' + n.upper },
      { value: LOWER, label: 'Always ' + n.lower + (n.lower === 'CW-R' ? ' (reverse)' : '') },
    ];
  }

  function helpText(brand) {
    var n = namesFor(brand);
    return 'Automatic: a CW spot tunes the radio to ' + n.upper + ' on every band, and if you put the radio in ' + n.lower +
      ' yourself it stays there. Always: every CW tune, on every band, uses that one, also after a restart.';
  }

  return {
    AUTO: AUTO, UPPER: UPPER, LOWER: LOWER, RADIO_TYPES: RADIO_TYPES, LABEL: LABEL,
    appliesToRadioType: appliesToRadioType,
    normalizeSetting: normalizeSetting,
    settingOf: settingOf,
    isCw: isCw,
    sidebandFor: sidebandFor,
    requestFor: requestFor,
    settingFromRequest: settingFromRequest,
    wireReverse: wireReverse,
    needsSet: needsSet,
    namesFor: namesFor,
    choices: choices,
    helpText: helpText,
  };
});
