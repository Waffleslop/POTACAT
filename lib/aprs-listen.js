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

  /**
   * Listen on open (Casey 2026-11-20: "The main goal is to listen on my radio,
   * so that should switch on by default when the user opens APRS"). Whether
   * the APRS window, just opened, starts receive-only listening by itself, and
   * on which band. Receive only: it tunes the radio, it never transmits, and
   * nothing about either beacon changes. Every refusal the Listen switch has
   * (whyNot) holds here too, and a few more: anything that has the radio or is
   * keying it. Any no is silent: the window shows the normal off state.
   * @param {object} f
   * @param {boolean} f.firstOpen        the first 'aprs-ready' since the window was created (a reload is not an open)
   * @param {boolean} f.operatorOff      the operator switched listening off since the window opened
   * @param {boolean} f.listening        listening is already on (the switch, Idle Mode or an ECHOCAT device)
   * @param {boolean} f.transmitting     anything keys the radio (PTT, JTCAT, Winlink, the phone, a tune)
   * @param {boolean} f.rfInFlight       an APRS radio beacon is on its way
   * @param {boolean} f.jtcatQso         a JTCAT/FT8 QSO is in progress
   * @param {string}  f.radioOwner       main's radioOwner: 'none' | 'jtcat' | 'mercury' | 'winlink'
   * @param {boolean} f.guestPass        a Guest Pass session is on this station
   * @param {string}  [f.bandWanted]     the band picked earlier this session ('' = the rig's default)
   *   ...and every whyNot field (remote, catConnected, bands, freq, modemFound, ft8Decoding, winlinkHasModem);
   *   f.freq may be a function of the band, since the frequency depends on the band chosen here.
   * @returns {{start:boolean, band:string, reason:string}}
   */
  function autoListenOnOpen(f) {
    f = f || {};
    const no = (reason) => ({ start: false, band: '', reason });
    if (!f.firstOpen) return no('not-first-open');
    if (f.operatorOff) return no('operator-off');
    if (f.listening) return no('listening');
    if (f.transmitting) return no('transmitting');
    if (f.rfInFlight) return no('rf-beacon');
    if (f.jtcatQso) return no('jtcat-qso');
    if (f.radioOwner && f.radioOwner !== 'none') return no('owner-' + f.radioOwner);
    if (f.guestPass) return no('guest-pass');
    const band = chooseBand(f.bands, f.bandWanted);
    if (!band) return no('no-band');
    const freq = typeof f.freq === 'function' ? f.freq(band) : f.freq;
    const why = whyNot(Object.assign({}, f, { band, freq }));
    if (why) return no(why.reason);
    return { start: true, band, reason: '' };
  }

  // ── The radio moved off the APRS frequency ─────────────────────────────────
  // On air 2026-11-20 (FLEX-8600M, Flex Direct): listening on 10.1476 MHz DIGU,
  // then spot clicks and the phone took the radio to 28.074 FT8 and 18, 14 and
  // 7 MHz SSB. Nothing noticed: the window kept saying "Listening on my radio"
  // on 30 m for an hour with the radio on 20 m voice. Now any move off the
  // listen frequency or out of its mode, whoever made it (a spot, ECHOCAT, the
  // VFO knob, another window), pauses listening and lets go of the radio.

  /** Readback tolerance: the radio's own rounding (10 Hz steps, a Flex slice), never a real move. */
  const MOVED_TOL_HZ = 100;
  /** After listening starts, readbacks settle (the data mode is set, the slice mirrors) before a move counts. */
  const MOVED_GRACE_MS = 3000;
  const MOVED_TITLE = 'Paused: your radio moved';

  /**
   * The mode's family, from any codec's name for it: 'usb' (USB, DIGU, PKTUSB,
   * DATA-U, USB-D), 'lsb', 'fm' (FM, FM-D, PKT, DATA-FM), 'am', 'cw', 'rtty',
   * or '' when POTACAT does not know the name. An unknown name never counts as
   * a move: a radio's odd readback must not pause listening.
   */
  function modeFamily(mode) {
    const m = String(mode || '').toUpperCase().replace(/[\s_\-]/g, '');
    if (!m) return '';
    if (/^(USB|DIGU|PKTUSB|PKTU|DATAU|DATAUSB|USBDATA|USBD\d?|DIGITALU)$/.test(m)) return 'usb';
    if (/^(LSB|DIGL|PKTLSB|PKTL|DATAL|DATALSB|LSBDATA|LSBD\d?|DIGITALL)$/.test(m)) return 'lsb';
    if (/^(FM|NFM|FMN|FMD\d?|DATAFM|FMDATA|PKTFM|PKT|DFM|WFM)$/.test(m)) return 'fm';
    if (/^(AM|AMN|AMD\d?|DATAAM|SAM)$/.test(m)) return 'am';
    if (/^(CW|CWR|CWU|CWL)$/.test(m)) return 'cw';
    if (/^(RTTY|RTTYR|FSK|FSKR)$/.test(m)) return 'rtty';
    return '';
  }

  /** The mode family listening needs on a band: 30 m is upper sideband (DIGU), 2 m is FM. */
  function listenFamily(band) { return band === '30m' ? 'usb' : 'fm'; }

  /**
   * One sentence when the radio reads back a lower-sideband mode while 30 m
   * listening runs, else '' (#843). Some radios put their data mode on LSB
   * (a Yaesu DATA-L, a data mode menu left on LSB); on 10.1476 MHz the tones
   * then fall outside what Dire Wolf hears and nothing decodes, with no word.
   * The move watch never pauses for it (a mode change counts only after the
   * right family was read back), so this says it instead. POTACAT does not
   * change the radio's sideband menu; the operator does.
   */
  function sidebandSentence(band, mode) {
    if (band !== '30m' || modeFamily(mode) !== 'lsb') return '';
    return 'Your radio is on lower sideband (' + String(mode).trim() + '). APRS on 30 m is upper sideband: set the radio\'s data mode to USB, or nothing will decode.';
  }

  /**
   * Watches the radio's readbacks while it listens. Made when listening has
   * started (the state is 'listening': the radio took the frequency and
   * Dire Wolf is up), so POTACAT's own tune to APRS is never a move.
   *  - frequency: more than MOVED_TOL_HZ from the APRS frequency AND from the
   *    radio's own first readback on it (a radio that rounds stays put);
   *  - mode: only after a mode of the right family has been read back, and
   *    only to another KNOWN family (DIGU -> USB is still upper sideband);
   *  - never while an APRS radio beacon is on its way (it never moves the
   *    radio, but its own Dire Wolf has the modem), never inside the grace.
   * check() returns null, or {why: 'frequency'|'mode', hz, mode}.
   */
  function createMoveWatch({ band = '2m', listenHz = 0, now = Date.now, tolHz = MOVED_TOL_HZ, graceMs = MOVED_GRACE_MS } = {}) {
    const listen = Number(listenHz) || 0;
    const want = listenFamily(band);
    const startedAt = now();
    let anchorHz = 0;
    let modeOk = false;
    return {
      check({ hz = 0, mode = '', rfInFlight = false } = {}) {
        if (rfInFlight || !listen) return null;
        const h = Number(hz) || 0;
        if (h > 0 && !anchorHz && tuneAccepted(listen, h)) anchorHz = h;
        const fam = modeFamily(mode);
        if (fam && fam === want) modeOk = true;
        if (now() - startedAt < graceMs) return null;
        if (h > 0 && Math.abs(h - listen) > tolHz && (!anchorHz || Math.abs(h - anchorHz) > tolHz)) {
          return { why: 'frequency', hz: h, mode: String(mode || '') };
        }
        if (modeOk && fam && fam !== want) return { why: 'mode', hz: h, mode: String(mode || '') };
        return null;
      },
    };
  }

  function mhz3(hz) { return (Number(hz) / 1e6).toFixed(3); }

  /**
   * The radio card's line while paused this way, from the radio's place now:
   * "Your radio is on 14.317 MHz USB. Turn listening on to go back to 30 m."
   */
  function movedLine({ hz = 0, mode = '', band = '' } = {}) {
    const back = 'Turn listening on to go back to ' + (LABELS[band] || 'APRS') + '.';
    if (!(Number(hz) > 0)) return 'Your radio moved off the APRS frequency. ' + back;
    return 'Your radio is on ' + mhz3(hz) + ' MHz' + (mode ? ' ' + String(mode) : '') + '. ' + back;
  }

  /** The one sentence for surfaces with no title (ECHOCAT's listen.sentence): the title, then the line. */
  function movedSentence(o) { return MOVED_TITLE + '. ' + movedLine(o); }

  /** The log line when it pauses. */
  function movedLogLine({ hz = 0, mode = '', listenMhz = '', why = 'frequency' } = {}) {
    const where = Number(hz) > 0 ? (Number(hz) / 1e6).toFixed(4) + ' MHz' + (mode ? ' ' + mode : '') : 'another frequency';
    return 'paused: the radio moved to ' + where + (why === 'mode' ? ' (the mode changed)' : '') +
      ', off ' + (listenMhz || 'the APRS frequency') + (listenMhz ? ' MHz' : '') +
      '. Listening is off, and the radio stays where it was put (no return to the place saved before listening).';
  }

  return { SENTENCES, BANDS, LABELS, whyNot, rejectedSentence, tuneAccepted, listenModePlan, setupLine, hasTwoMetres, bandChoices, chooseBand, modeLabel, filterSentence, mayStopLane, autoListenOnOpen,
    MOVED_TOL_HZ, MOVED_GRACE_MS, MOVED_TITLE, modeFamily, listenFamily, sidebandSentence, createMoveWatch, movedLine, movedSentence, movedLogLine };
});
