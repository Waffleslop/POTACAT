// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS "Listen on my radio" (phase 2, 2 m, receive only): whether it may
// start, and the one sentence the APRS window shows when it may not. The
// first four sentences are the plan's own (ops aprs-plan-2026-11-17,
// "Phase 2 in detail"). Pure and dual-mode: require() in main and tests,
// window.AprsListen in the APRS window.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AprsListen = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SENTENCES = {
    ft8: 'FT8 is decoding. Stop it to listen to APRS.',
    winlink: 'A Winlink session has the modem.',
    no2m: 'Your radio has no 2 m. APRS on 30 m is coming.',
    rejected: (mhz) => 'The radio did not accept ' + mhz + ' MHz.',
    // Not in the plan; each is one plain sentence in the same voice.
    noCat: 'Connect your radio to listen to APRS.',
    noFreq: 'POTACAT has no APRS frequency for your grid square yet.',
    noModem: 'Dire Wolf is not available on this computer.',
    remote: 'Listening runs on the computer the radio is connected to.',
  };

  function hasTwoMetres(bands) {
    if (!Array.isArray(bands)) return true; // unknown model: not restricted, simply tried (lib/rig-bands.js)
    return bands.indexOf('2m') >= 0;
  }

  /**
   * Why listening may not start, or null when it may. A radio problem is
   * named before a busy modem: fixing the busy modem would not help.
   * @param {object} f
   * @param {boolean} f.remote          this POTACAT drives a radio elsewhere (ECHOCAT remote)
   * @param {boolean} f.catConnected
   * @param {string[]|null} f.bands     activeRigBands(): null = unrestricted
   * @param {{hz:number, mhz:string}|null} f.freq  lib/aprs-rf-frequency.js
   * @param {boolean} f.modemFound      the Dire Wolf binary
   * @param {boolean} f.ft8Decoding
   * @param {boolean} f.winlinkHasModem a Winlink session (or its held dial) has the modem
   * @returns {{reason:string, sentence:string}|null}
   */
  function whyNot(f) {
    f = f || {};
    if (f.remote) return { reason: 'remote', sentence: SENTENCES.remote };
    if (!f.catConnected) return { reason: 'no-cat', sentence: SENTENCES.noCat };
    if (!hasTwoMetres(f.bands)) return { reason: 'no-2m', sentence: SENTENCES.no2m };
    if (!f.freq || !f.freq.hz) return { reason: 'no-freq', sentence: SENTENCES.noFreq };
    if (!f.modemFound) return { reason: 'no-modem', sentence: SENTENCES.noModem };
    if (f.ft8Decoding) return { reason: 'ft8', sentence: SENTENCES.ft8 };
    if (f.winlinkHasModem) return { reason: 'winlink', sentence: SENTENCES.winlink };
    return null;
  }

  function rejectedSentence(freq) {
    return SENTENCES.rejected(freq && freq.mhz ? freq.mhz : ((Number(freq && freq.hz) || 0) / 1e6).toFixed(3));
  }

  /** Did the radio take the frequency? Its own readback within 1 kHz. */
  function tuneAccepted(wantHz, nowHz) {
    return Number(nowHz) > 0 && Math.abs(Number(nowHz) - Number(wantHz)) <= 1000;
  }

  /**
   * The radio's mode for listening, from the packet rule (lib/packet-rig-mode.js
   * resolvePacketRigMode): FM, then the radio's own FM data mode where
   * POTACAT has a command for it (Icom FM-D, the FT-857 family's PKT). FM data
   * the operator sets by hand: the dial moves, the mode is left alone.
   */
  function listenModePlan(pm) {
    if (!pm) return { tuneMode: 'FM', dataMode: null };
    if (pm.byHand) return { tuneMode: undefined, dataMode: null };
    return { tuneMode: 'FM', dataMode: pm.want === 'fmdata' && pm.dataMode ? pm.dataMode : null };
  }

  /**
   * The one setup line the window shows for this radio: the PKT RATE step
   * from lib/rig-setup-notes.js (the Yaesu FT-857/817/818 packet rate menu),
   * verbatim. Never written here. '' when the radio has none.
   */
  function setupLine(notes) {
    for (const n of notes || []) {
      for (const s of n.steps || []) if (/PKT RATE/.test(s)) return s;
    }
    return '';
  }

  return { SENTENCES, whyNot, rejectedSentence, tuneAccepted, listenModePlan, setupLine, hasTwoMetres };
});
