// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS "Listen on my radio" puts the radio back where it was (Casey
// 2026-11-17: "Restore the radio's frequency and mode when listening stops,
// including after a crash or quit. Persist the saved state before tuning,
// and restore it at the next start if the last run did not restore it").
//
// The WSPR beacon's power memory is the model (main.js wsprPreCapPower):
//   - the place is written to disk BEFORE the radio is tuned to APRS;
//   - stopping sends the radio back and marks the marker 'returning';
//   - the marker is cleared only by the radio's OWN readback showing the old
//     frequency, never by a command having been sent (a quit's return may
//     never reach the radio);
//   - at the next start the first readback finishes the job: still on the
//     APRS frequency → tune back; already home → clear;
//   - a radio the operator moved since is left where they put it (the
//     Winlink return rule, main.js winlinkLogLeftAlone).
//
// Pure: the caller hands in load/save (settings.aprsListenReturn, a machine
// key) and tune(hz, mode).

'use strict';

const TOL_HZ = 1000;
const MAX_TRIES = 3;

function near(a, b, tol = TOL_HZ) {
  return Number(a) > 0 && Number(b) > 0 && Math.abs(Number(a) - Number(b)) <= tol;
}

/**
 * @param {object} o
 * @param {() => object|null} o.load    the persisted marker
 * @param {(m: object|null) => void} o.save  persist (null clears); must be synchronous
 * @param {(hz: number, mode: string) => void} o.tune
 * @param {() => number} [o.now]
 * @param {(s: string) => void} [o.log]
 */
function createRadioReturn({ load, save, tune, now = Date.now, log = () => {} } = {}) {
  let tries = 0;
  const read = () => { try { return load() || null; } catch { return null; } };
  const write = (m) => { save(m); };

  function sendBack(m, why) {
    tries++;
    const next = { ...m, state: 'returning' };
    write(next);
    log(`APRS: the radio goes back to ${(m.freqHz / 1e6).toFixed(4)} MHz${m.mode ? ' ' + m.mode : ''} (${why})`);
    tune(m.freqHz, m.mode || '');
  }

  return {
    /** The marker on disk, or null. */
    pending: () => read(),

    /**
     * Listening starts. The radio's place is saved first, then `tuneToAprs`
     * runs. A marker already on disk (a pause, or a crash not yet recovered)
     * keeps its FIRST place: 144.390 is never saved as home.
     */
    begin({ freqHz, mode, rigId, listenHz }, tuneToAprs) {
      const had = read();
      const m = had && had.freqHz
        ? { ...had, listenHz: Number(listenHz) || had.listenHz, state: 'listening', at: now() }
        : { freqHz: Number(freqHz) || 0, mode: String(mode || ''), rigId: rigId || null, listenHz: Number(listenHz) || 0, state: 'listening', at: now() };
      write(m);
      tries = 0;
      if (typeof tuneToAprs === 'function') tuneToAprs();
      return m;
    },

    /**
     * Listening stops (switch off, window closed, quit). `nowHz` is the radio's
     * dial now. Returns 'returned' | 'left-alone' | 'none'.
     */
    end(nowHz) {
      const m = read();
      if (!m) return 'none';
      if (!m.freqHz) { write(null); return 'left-alone'; }
      if (nowHz && m.listenHz && !near(nowHz, m.listenHz)) {
        write(null);
        log(`APRS: the radio stays on ${(nowHz / 1e6).toFixed(4)} MHz — it was moved off ${(m.listenHz / 1e6).toFixed(3)} MHz, so it does not go back`);
        return 'left-alone';
      }
      sendBack(m, 'listening stopped');
      tries = 0; // the readbacks that follow may each try again, MAX_TRIES times
      return 'returned';
    },

    /**
     * Every frequency readback. Returns 'none' | 'confirmed' | 'returned' |
     * 'left-alone' | 'other-rig' | 'gave-up'.
     */
    onReadback(hz, { rigId = null, listening = false } = {}) {
      if (listening) return 'none';
      const m = read();
      if (!m || !hz) return 'none';
      if (m.rigId && rigId && m.rigId !== rigId) return 'other-rig';
      if (!m.freqHz) { write(null); return 'left-alone'; }
      if (near(hz, m.freqHz)) { write(null); tries = 0; return 'confirmed'; }
      if (m.listenHz && near(hz, m.listenHz)) {
        if (tries >= MAX_TRIES) return 'gave-up';
        sendBack(m, m.state === 'listening' ? 'the last run ended while listening' : 'the return did not reach the radio');
        return 'returned';
      }
      write(null);
      log(`APRS: the radio is on ${(hz / 1e6).toFixed(4)} MHz, not the APRS frequency, so it is left there`);
      return 'left-alone';
    },

    /** Forget the marker without tuning (Winlink took the radio and owns the return). */
    drop() { if (read()) write(null); },
  };
}

module.exports = { createRadioReturn, near, TOL_HZ, MAX_TRIES };
