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
  function check(s, ownerMine) {
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
    if (s.modemFound === false) return no('no-modem', SENTENCES.noModem);
    return null;
  }

  /** May the "Beacon now (radio)" button send? null = yes, else {reason, sentence}. */
  function readiness(s) {
    s = s || {};
    if (s.inFlight) return no('busy', SENTENCES.busy);
    return check(s, 'none');
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
    const r = check(s, 'aprs');
    return r ? { ok: false, reason: r.reason, sentence: r.sentence } : { ok: true };
  }

  return { DIAL_TOLERANCE_HZ, SENTENCES, dialMatches, readiness, mayKey };
});
