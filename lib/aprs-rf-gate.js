// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS phase 7: the gate for ONE manual beacon over the radio. The rigctld
// shim's 'aprs' keying owner asks mayKey() at every key-down Dire Wolf
// requests; the APRS window's "Beacon now (radio)" button asks readiness().
//
// It may key only when ALL of these hold:
//   - the APRS window is open, with "Listen on my radio" on and listening;
//   - a real callsign is set (no N0CALL / NOCALL / PCAT placeholder:
//     lib/aprs-igate.js uplinkLogin decides, as for the internet beacon);
//   - the dial is on the APRS frequency POTACAT set for the band, within
//     DIAL_TOLERANCE_HZ. A frequency MATCH, never a band-legality check:
//     POTACAT never refuses transmit for being outside a ham band (Casey,
//     2026-11-12); the operator is responsible for where he transmits;
//   - nothing else transmits or owns the radio (radio owner, PTT, a mode
//     that is keying, the SWR guard);
//   - the radio itself is ready to transmit there, where it reports it (a
//     Flex's interlock NOT_READY: the 8600M refused the 30 m beacon on
//     2026-11-19 with "Interlock is preventing transmission"). One case
//     enables the button anyway: NOT_READY with reason OUT_OF_BAND on a
//     30 m Flex whose beacon will narrow the transmit filter, when the narrow
//     passband on the live dial and mode fits inside 30 m (narrowFits). The
//     radio reads OUT_OF_BAND at 100-3100 Hz on 10.1476 before any key-down
//     (on-air 2026-11-19), and only the narrow filter can change that. The
//     radio stays the judge: the beacon narrows first, waits for READY, and
//     refuses and restores on any other reading (lib/aprs-rf-beacon.js).
//     mayKey (the key-down itself) never makes that exception;
//   - a beacon request is in flight (the operator pressed Send).
// Every refusal has a reason and one plain sentence; main logs each one.
//
// Pure. Dual-mode: require() in main and tests, window.AprsRfGate in the window.
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require : null);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AprsRfGate = api;
})(typeof self !== 'undefined' ? self : this, function (req) {
  'use strict';

  /**
   * How far the dial may sit from the APRS frequency.
   *   2m   1 kHz: an FM channel is 15-20 kHz wide and radios step 5 kHz, so
   *        1 kHz is the readback's own slack (the listen start's
   *        AprsListen.tuneAccepted uses the same).
   *   30m  100 Hz: the 300-baud tones sit 200 Hz apart, and the receive
   *        decoders cover about 100 Hz of mistuning ("7@30"); further off,
   *        the beacon would land beside the channel the iGates listen on.
   */
  const DIAL_TOLERANCE_HZ = Object.freeze({ '2m': 1000, '30m': 100 });

  /**
   * The 30 m band, Hz. Used only to decide whether the beacon's narrow
   * transmit filter can clear the radio's own OUT_OF_BAND reading; it never
   * refuses a transmission (POTACAT never refuses TX by band).
   */
  const BAND_EDGES_HZ = Object.freeze({ '30m': Object.freeze({ lo: 10100000, hi: 10150000 }) });

  /**
   * Does the narrow transmit passband, on this dial and mode, sit inside the
   * band? USB / DIGU: dial + low .. dial + high. LSB / DIGL: dial - high ..
   * dial - low. Any other mode or a missing value: no.
   * @returns {{fits:boolean, loHz?:number, hiHz?:number}}
   */
  function narrowFits({ band, dialHz, mode, filter } = {}) {
    const edges = BAND_EDGES_HZ[band];
    const dial = Number(dialHz);
    if (!edges || !(dial > 0) || !filter || filter.lo == null || filter.hi == null) return { fits: false };
    const lo = Number(filter.lo), hi = Number(filter.hi);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { fits: false };
    const m = String(mode || '').toUpperCase();
    let a, b;
    if (m === 'USB' || m === 'DIGU' || m === 'PKTUSB' || m === 'USB-D' || m === 'DATA-USB') { a = dial + lo; b = dial + hi; }
    else if (m === 'LSB' || m === 'DIGL' || m === 'PKTLSB' || m === 'LSB-D' || m === 'DATA-LSB') { a = dial - hi; b = dial - lo; }
    else return { fits: false };
    return { fits: a >= edges.lo && b <= edges.hi, loHz: a, hiHz: b };
  }

  /** The narrow filter will clear this NOT_READY: OUT_OF_BAND, and the narrow passband fits on the live dial and mode. */
  function narrowClears(s) {
    if (String(s.txInterlockReason || '').trim() !== 'OUT_OF_BAND' || !s.txNarrow) return false;
    return narrowFits({ band: s.band, dialHz: s.dialHz, mode: s.dialMode, filter: s.txNarrow }).fits;
  }

  const OWNER_WORDS = {
    jtcat: 'JTCAT has the radio.',
    winlink: 'A Winlink session has the radio.',
    mercury: 'Mercury has the radio.',
    'atu-wizard': 'The tuner calibration has the radio.',
  };

  const SENTENCES = {
    remote: 'Beacons over the radio go out from the computer the radio is connected to.',
    window: 'Open the APRS window to beacon over the radio.',
    listen: 'Turn on Listen on my radio first. The beacon goes out on the frequency it listens on.',
    notListening: 'Wait until the radio is listening.',
    noFreq: 'POTACAT has no APRS frequency for this band.',
    transmitting: 'The radio is transmitting.',
    swr: 'The SWR guard has tripped. Check the antenna first.',
    noModem: 'Dire Wolf is not available on this computer.',
    busy: 'A beacon is going out now.',
    notAsked: 'No beacon was asked for, so the radio was not keyed.',
    owner: 'Another mode has the radio.',
  };

  /** The radio's own "not ready to transmit here", in plain words. */
  function notReadySentence(reason) {
    const r = String(reason || '').trim();
    return 'The radio is not ready to transmit on this band: its interlock is preventing transmission' + (r ? ' (' + r + ')' : '') + '.';
  }

  function mhz(hz) {
    const n = Number(hz) || 0;
    return n >= 1e8 ? (n / 1e6).toFixed(3) : (n / 1e6).toFixed(4);
  }

  /** The dial is on the APRS frequency for the band (and nothing more). */
  function dialMatches(band, aprsHz, dialHz) {
    const tol = DIAL_TOLERANCE_HZ[band];
    const want = Number(aprsHz), now = Number(dialHz);
    if (!tol || !(want > 0) || !(now > 0)) return false;
    return Math.abs(now - want) <= tol;
  }

  function login(call) {
    const ig = req ? req('./aprs-igate') : (typeof self !== 'undefined' && self.AprsIgate) || null;
    if (ig && ig.uplinkLogin) return ig.uplinkLogin(call);
    return String(call || '').trim() ? { ok: true } : { ok: false, reason: 'no-call', sentence: 'Set your callsign in Settings first.' };
  }

  const no = (reason, sentence) => ({ reason, sentence });

  /**
   * The checks both views share, in the order the operator would fix them.
   * `ownerMine` is the owner that counts as ours ('none' before the press,
   * 'aprs' at the key-down).
   */
  function check(s, ownerMine, allowNarrow) {
    s = s || {};
    if (s.remote) return no('remote', SENTENCES.remote);
    if (!s.windowOpen) return no('window', SENTENCES.window);
    if (!s.listenOn) return no('listen', SENTENCES.listen);
    if (s.listenState !== 'listening') return no('not-listening', SENTENCES.notListening);
    const l = login(s.settingsCall);
    if (!l.ok) return no(l.reason, l.sentence);
    if (!s.band || !DIAL_TOLERANCE_HZ[s.band] || !(Number(s.aprsHz) > 0)) return no('no-freq', SENTENCES.noFreq);
    if (!dialMatches(s.band, s.aprsHz, s.dialHz)) {
      return no('dial', `The radio is on ${Number(s.dialHz) > 0 ? mhz(s.dialHz) + ' MHz' : 'an unknown frequency'}, not the APRS frequency ${mhz(s.aprsHz)} MHz.`);
    }
    const owner = s.radioOwner || 'none';
    if (owner !== ownerMine) {
      if (owner === 'aprs') return no('busy', SENTENCES.busy);
      return no('owner', OWNER_WORDS[owner] || SENTENCES.owner);
    }
    if (s.otherTx) return no('transmitting', `${s.otherTx} is transmitting.`);
    if (s.pttKeyed) return no('transmitting', SENTENCES.transmitting);
    if (s.swrTripped) return no('swr', SENTENCES.swr);
    if (s.txInterlock === 'NOT_READY' && !(allowNarrow && narrowClears(s))) return no('radio-not-ready', notReadySentence(s.txInterlockReason));
    if (s.modemFound === false) return no('no-modem', SENTENCES.noModem);
    return null;
  }

  /** May the "Beacon now (radio)" button send? null = yes, else {reason, sentence}. */
  function readiness(s) {
    s = s || {};
    if (s.inFlight) return no('busy', SENTENCES.busy);
    return check(s, 'none', true);
  }

  /**
   * May the 'aprs' owner key the radio now (the shim's key-down)? A beacon
   * must be in flight and the radio already taken for it ('aprs'), and every
   * readiness condition must still hold. `pttKeyed` is POTACAT's PTT state
   * BEFORE this key-down.
   */
  function mayKey(s) {
    s = s || {};
    if (!s.inFlight) return { ok: false, reason: 'not-asked', sentence: SENTENCES.notAsked };
    if ((s.radioOwner || 'none') !== 'aprs') {
      return { ok: false, reason: 'owner', sentence: OWNER_WORDS[s.radioOwner] || 'The radio was not taken for the beacon.' };
    }
    const r = check(s, 'aprs', false);
    return r ? { ok: false, reason: r.reason, sentence: r.sentence } : { ok: true };
  }

  return { DIAL_TOLERANCE_HZ, BAND_EDGES_HZ, SENTENCES, dialMatches, notReadySentence, narrowFits, readiness, mayKey };
});
