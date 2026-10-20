'use strict';
// CW speed for spots that never carry one (2026-10-19): a POTA/SOTA/WWFF spot
// says "CW" and nothing about speed, while the skimmers POTACAT already hears
// (RBN, the CW Spots club feed, RBN-style cluster lines) measure it on every
// CQ. This remembers the speed each station was last skimmed at, by call and
// frequency, and fills it into a CW spot that has none.
//
// A reading counts only when it is the SAME station on the same frequency
// (within MATCH_KHZ — a skimmer and a hand spot rarely agree to the 100 Hz)
// and recent (MAX_AGE_MS): an activator who sped up for a pile-up, or moved
// band, must not keep an old number.
//
// Pure apart from Date.now() defaults. main.js feeds it and calls fillSpots.

const MATCH_KHZ = 2;
const MAX_AGE_MS = 15 * 60 * 1000;
const MAX_CALLS = 5000;

class CwSpeedCache {
  constructor(opts = {}) {
    this._maxCalls = opts.maxCalls || MAX_CALLS;
    this._byCall = new Map(); // CALL -> [{khz, wpm, at}] newest last, ≤ 4
  }

  /** A skimmed CW reading: callsign, frequency (kHz), speed (WPM). */
  note(callsign, freqKhz, wpm, at = Date.now()) {
    const call = String(callsign || '').toUpperCase().trim();
    const khz = parseFloat(freqKhz);
    const w = parseInt(wpm, 10);
    if (!call || !(khz > 0) || !(w >= 5 && w <= 99)) return;
    let list = this._byCall.get(call);
    if (list) this._byCall.delete(call); // re-insert = most recently heard last
    else list = [];
    const near = list.findIndex((r) => Math.abs(r.khz - khz) <= MATCH_KHZ);
    if (near >= 0) list.splice(near, 1);
    list.push({ khz, wpm: w, at });
    if (list.length > 4) list.shift();
    this._byCall.set(call, list);
    while (this._byCall.size > this._maxCalls) this._byCall.delete(this._byCall.keys().next().value);
  }

  /** The station's skimmed speed on this frequency, or null. */
  lookup(callsign, freqKhz, now = Date.now()) {
    const list = this._byCall.get(String(callsign || '').toUpperCase().trim());
    const khz = parseFloat(freqKhz);
    if (!list || !(khz > 0)) return null;
    let best = null;
    for (const r of list) {
      if (now - r.at > MAX_AGE_MS || Math.abs(r.khz - khz) > MATCH_KHZ) continue;
      if (!best || r.at > best.at) best = r;
    }
    return best ? best.wpm : null;
  }

  /**
   * Fill `wpm` into CW spots that have none. Returns a new array; a filled
   * spot is a clone (the source lists are never mutated) marked
   * `wpmFrom: 'skimmer'` so a surface can say where the number came from.
   */
  fillSpots(spots, now = Date.now()) {
    return spots.map((s) => {
      if (!s || s.wpm || String(s.mode || '').toUpperCase() !== 'CW') return s;
      const w = this.lookup(s.callsign, s.frequency, now);
      return w ? { ...s, wpm: w, wpmFrom: 'skimmer' } : s;
    });
  }
}

/** The WPM in an RBN-style comment ("CW 18 dB 22 WPM CQ"), or null. */
function wpmFromComment(comment) {
  const m = String(comment || '').match(/(\d+)\s*WPM/i);
  return m ? parseInt(m[1], 10) : null;
}

module.exports = { CwSpeedCache, wpmFromComment, MATCH_KHZ, MAX_AGE_MS };
