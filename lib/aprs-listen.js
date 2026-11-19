// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS "Listen on my radio" (receive only): whether it may start, on which
// band, and the one sentence the APRS window shows when it may not. Phase 2
// is 2 m; phase 3 adds 30 m HF APRS (300 baud, 10.1476 MHz USB) and a band
// chip per band the rig has (lib/rig-bands.js decides what the rig has). The
// ft8, winlink and rejected sentences are the plan's own (ops
// aprs-plan-2026-11-17, "Phase 2 in detail"). Pure and dual-mode: require() in main and tests,
// window.AprsListen in the APRS window.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AprsListen = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SENTENCES = {
    ft8: 'FT8 is decoding. Stop it to listen to APRS.',
    winlink: 'A Winlink session has the modem.',
    noBand: 'Your radio has neither 2 m nor 30 m.',
    rejected: (mhz) => 'The radio did not accept ' + mhz + ' MHz.',
    // Not in the plan; each is one plain sentence in the same voice.
    noCat: 'Connect your radio to listen to APRS.',
    noFreq: 'POTACAT has no APRS frequency for your grid square yet.',
    noModem: 'Dire Wolf is not available on this computer.',
    remote: 'Listening runs on the computer the radio is connected to.',
  };

  /** The bands APRS listening knows, in chip order. */
  const BANDS = ['2m', '30m'];
  const LABELS = { '2m': '2 m', '30m': '30 m' };

  function hasTwoMetres(bands) {
    if (!Array.isArray(bands)) return true; // unknown model: not restricted, simply tried (lib/rig-bands.js)
    return bands.indexOf('2m') >= 0;
  }

  /**
   * The band chips for a rig: the APRS bands in its band list
   * (RigBands.bandsForRig, via main's activeRigBands()). A null list is an
   * unknown model, not restricted: both chips.
   */
  function bandChoices(bands) {
    if (!Array.isArray(bands)) return BANDS.slice();
    return BANDS.filter((b) => bands.indexOf(b) >= 0);
  }

  /**
   * The band to listen on: the one the operator picked while the rig has it,
   * else 2 m on a rig with 2 m, else 30 m on an HF rig; null when it has neither.
   */
  function chooseBand(bands, wanted) {
    const c = bandChoices(bands);
    if (wanted && c.indexOf(wanted) >= 0) return wanted;
    return c.length ? c[0] : null;
  }

  /** The mode the window shows beside the frequency. */
  function modeLabel(band) { return band === '30m' ? 'USB' : 'FM'; }

  /**
   * One sentence when the operator's digital filter (settings.digitalFilterWidth,
   * which a DIGU tune sends to the radio) is narrower than 1 kHz: the 30 m
   * tones sit at 1600 and 1800 Hz and a narrow data filter may cut one. 0 is
   * the radio's own filter, which POTACAT does not know. Filters are never
   * changed for APRS; this only says so.
   */
  function filterSentence(band, widthHz) {
    const w = Number(widthHz) || 0;
    if (band !== '30m' || !(w > 0) || w >= 1000) return '';
    return 'Your digital filter is ' + w + ' Hz wide. APRS on 30 m needs 1500 to 1900 Hz to pass.';
  }

  /**
   * Why listening may not start, or null when it may. A radio problem is
   * named before a busy modem: fixing the busy modem would not help.
   * @param {object} f
   * @param {boolean} f.remote          this POTACAT drives a radio elsewhere (ECHOCAT remote)
   * @param {boolean} f.catConnected
   * @param {string[]|null} f.bands     activeRigBands(): null = unrestricted
   * @param {string} [f.band]           '2m' | '30m' (chooseBand); absent = 2 m, as in phase 2
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
    const choices = bandChoices(f.bands);
    if (!choices.length || choices.indexOf(f.band || '2m') < 0) return { reason: 'no-band', sentence: SENTENCES.noBand };
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
   * The radio's mode for listening.
   * 2 m, from the packet rule (lib/packet-rig-mode.js resolvePacketRigMode):
   * FM, then the radio's own FM data mode where POTACAT has a command for it
   * (Icom FM-D, the FT-857 family's PKT). FM data the operator sets by hand:
   * the dial moves, the mode is left alone.
   * 30 m: DIGU, the mode JTCAT tunes for FT8. Each codec turns it into the
   * radio's upper-sideband data mode (DATA-U, USB-D, PKTUSB, DIGU on a Flex),
   * and JTCAT's "Switch radio to DATA mode (PKTUSB) for FT8 / FT4" setting,
   * when off, makes it plain USB (lib/plain-ssb-for-digital.js, in tuneRadio).
   * The packet rule is FM only and does not apply.
   */
  function listenModePlan(pm, band) {
    if (band === '30m') return { tuneMode: 'DIGU', dataMode: null };
    if (!pm) return { tuneMode: 'FM', dataMode: null };
    if (pm.byHand) return { tuneMode: undefined, dataMode: null };
    return { tuneMode: 'FM', dataMode: pm.want === 'fmdata' && pm.dataMode ? pm.dataMode : null };
  }

  /**
   * The one setup line the window shows for this radio, verbatim from
   * lib/rig-setup-notes.js and never written here. '' when the radio has none.
   * 2 m: the PKT RATE step (the Yaesu FT-857/817/818 packet rate menu).
   * 30 m: the step that makes the radio's data mode upper sideband (FT-891
   * DATA BFO, FT-857/818 DIG MODE USER-U); on LSB the tones fall outside
   * the passband at 10.1476 MHz.
   */
  function setupLine(notes, band) {
    const want = band === '30m' ? /DATA BFO|DIG MODE → USER-U/ : /PKT RATE/;
    for (const n of notes || []) {
      for (const s of n.steps || []) if (want.test(s)) return s;
    }
    return '';
  }

  /**
   * Listening stopped: the modem audio lane (its own process, lib/modem-audio-lane.js)
   * goes too when APRS started it, it is still the lane in use, and nobody else
   * needs it, Winlink above all (Casey 2026-11-19: "stop the modem audio process
   * when APRS stops").
   */
  function mayStopLane(o) {
    const x = o || {};
    return !!(x.startedByAprs && x.isCurrent && !x.othersNeed);
  }

  return { SENTENCES, BANDS, LABELS, whyNot, rejectedSentence, tuneAccepted, listenModePlan, setupLine, hasTwoMetres, bandChoices, chooseBand, modeLabel, filterSentence, mayStopLane };
});
