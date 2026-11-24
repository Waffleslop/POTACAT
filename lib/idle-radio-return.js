// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Idle Mode puts the radio back where it found it (#1051, Casey 2026-11-24:
// "make every idle mode put the radio back on its frequency and mode when it
// ends"). One path for SSTV, WSPR, PSK31, JTTY and JS8 on idle. APRS on idle
// goes back through APRS listening's own return (lib/aprs-radio-return.js),
// which this follows:
//   - the place (frequency, mode, filter width) is written to disk BEFORE the
//     session moves the radio;
//   - every frequency the session itself tunes is noted (its "idle dials": the
//     WSPR dial, a band hop, a sunrise band change);
//   - when idle ends the radio goes back ONLY if it is still on an idle dial,
//     within TOL_HZ. Anywhere else the operator moved it (the knob, SmartSDR,
//     a spot click), so it stays there and the log says why;
//   - an operator's own action that ends idle (a spot click, a transmit, a
//     mode or program started) wins: no return at all;
//   - a radio that is not connected when idle ends is not tuned then; its first
//     readback after it comes back decides, by the same rule. So does the first
//     readback after a crash or a quit whose command did not land;
//   - the marker is cleared only by the radio's own readback at home, never by
//     a command having been sent.
//
// Pure: the caller hands in load/save (settings.idleRxReturn, a machine key)
// and tune({freqHz, mode, filterWidth}). Nothing here transmits.

'use strict';

const TOL_HZ = 1000;           // "still where idle put it"
const SETTLE_MS = 8000;        // after an idle tune, a readback from before it may still arrive
const RETURN_SETTLE_MS = 3000; // after a return is sent, give it time to land before trying again
const MAX_TRIES = 3;
const MAX_DIALS = 24;
const ACTIVITY_STEP_HZ = 50;   // a dial reading that moves less is jitter, not a hand on the knob

function near(a, b, tol = TOL_HZ) {
  return Number(a) > 0 && Number(b) > 0 && Math.abs(Number(a) - Number(b)) <= tol;
}

const mhz = (hz) => (Number(hz) / 1e6).toFixed(4) + ' MHz';
const placeText = (hz, mode) => mhz(hz) + (mode ? ' ' + mode : '');

/**
 * @param {object} o
 * @param {() => object|null} o.load    the persisted marker
 * @param {(m: object|null) => void} o.save  persist (null clears); synchronous
 * @param {(place: {freqHz:number, mode:string, filterWidth?:number}) => void} o.tune
 * @param {() => number} [o.now]
 * @param {(s: string) => void} [o.log]
 */
function createIdleReturn({ load, save, tune, now = Date.now, log = () => {} } = {}) {
  let tries = 0;
  let lastSelfTuneAt = 0;
  let lastSentAt = 0;
  let lastHz = 0;
  const read = () => { try { return load() || null; } catch { return null; } };
  const write = (m) => { save(m); };
  const atIdleDial = (m, hz) => !!(m && Array.isArray(m.dials) && m.dials.some((d) => near(d, hz)));
  const homeOf = (m) => m.home || {};

  function sendBack(m, { fromHz, fromMode, why }) {
    tries++;
    lastSentAt = now();
    write({ ...m, state: 'returning' });
    const h = homeOf(m);
    log(`Idle Mode: the radio goes back from ${placeText(fromHz, fromMode)} to ${placeText(h.freqHz, h.mode)}${h.filterWidth ? ', filter ' + h.filterWidth + ' Hz' : ''} (${why})`);
    const place = { freqHz: Number(h.freqHz), mode: String(h.mode || '') };
    if (Number(h.filterWidth) > 0) place.filterWidth = Number(h.filterWidth);
    tune(place);
  }

  function leave(hz, why) {
    write(null);
    tries = 0;
    log(`Idle Mode: the radio stays on ${mhz(hz)}: ${why}, so it does not go back`);
  }

  return {
    /** The marker on disk, or null. */
    pending: () => read(),

    /**
     * An idle session starts. `home` is where the radio is now. A marker still
     * pending from an earlier session (a disconnect, a crash) keeps ITS home
     * while the radio is still on that session's dial: an idle dial is never home.
     */
    begin({ home, rigId = null, label = '' } = {}) {
      const h = home || {};
      const had = read();
      tries = 0;
      lastSelfTuneAt = 0;
      if (had && had.home && Number(had.home.freqHz) > 0 && atIdleDial(had, h.freqHz) &&
          (!had.rigId || !rigId || had.rigId === rigId)) {
        const m = { ...had, label: label || had.label || '', state: 'idle', at: now() };
        write(m);
        lastHz = Number(h.freqHz) || 0;
        return m;
      }
      if (!(Number(h.freqHz) > 0)) {
        write(null);
        lastHz = 0;
        log('Idle Mode: no reading of the radio\'s frequency, so there is no place to put it back to');
        return null;
      }
      const m = {
        home: { freqHz: Math.round(Number(h.freqHz)), mode: String(h.mode || '') },
        rigId: rigId || null, label: String(label || ''), dials: [], state: 'idle', at: now(),
      };
      if (Number(h.filterWidth) > 0) m.home.filterWidth = Number(h.filterWidth);
      write(m);
      lastHz = m.home.freqHz;
      return m;
    },

    /** The session itself tuned the radio here (Hz). */
    noteDial(hz) {
      const f = Math.round(Number(hz) || 0);
      if (!(f > 0)) return;
      lastSelfTuneAt = now();
      const m = read();
      if (!m || m.state !== 'idle') return;
      const dials = Array.isArray(m.dials) ? m.dials.slice() : [];
      if (!dials.some((d) => near(d, f, 1))) dials.push(f);
      while (dials.length > MAX_DIALS) dials.shift();
      write({ ...m, dials });
    },

    /** True while the radio reads back on a frequency the session put it on. */
    atIdleDial: (hz) => atIdleDial(read(), hz),

    /**
     * A readback while the session runs. 'moved' when the operator moved the
     * radio outside POTACAT (the knob, SmartSDR): off every idle dial, or back
     * home by hand after the session tuned away. Right after the session's own
     * tune a stale readback is not a move.
     */
    watch(hz) {
      const f = Number(hz) || 0;
      const m = read();
      if (!m || m.state !== 'idle' || !(f > 0)) return 'none';
      const prev = lastHz;
      lastHz = f;
      if (atIdleDial(m, f)) return 'none';
      if (now() - lastSelfTuneAt < SETTLE_MS) return 'none';
      if (near(f, homeOf(m).freqHz)) {
        // Home: never left (no tune landed), or the operator tuned back by hand.
        return atIdleDial(m, prev) ? 'moved' : 'none';
      }
      return 'moved';
    },

    /** The operator took the radio (a spot click, a transmit, a knob turn): no return. */
    operatorTook(why, hz) {
      const m = read();
      if (!m) return;
      leave(Number(hz) || 0, String(why || 'the operator took the radio'));
    },

    /**
     * Idle ends. Returns 'returned' | 'home' | 'left-alone' | 'pending' | 'none'.
     */
    end({ nowHz = 0, nowMode = '', connected = true } = {}) {
      const m = read();
      if (!m) return 'none';
      const f = Number(nowHz) || 0;
      if (!connected || !(f > 0)) {
        write({ ...m, state: 'ended', endedAt: now() });
        log(`Idle Mode: the radio is not connected, so it is not moved now. It goes back to ${placeText(homeOf(m).freqHz, homeOf(m).mode)} when it reconnects, only if it is still where Idle Mode left it`);
        return 'pending';
      }
      if (near(f, homeOf(m).freqHz) && !atIdleDial(m, f)) {
        write(null);
        tries = 0;
        return 'home';
      }
      if (atIdleDial(m, f)) {
        tries = 0;
        sendBack(m, { fromHz: f, fromMode: nowMode, why: (m.label ? m.label + ' ' : '') + 'receive ended' });
        return 'returned';
      }
      leave(f, 'it was moved off the Idle Mode frequency');
      return 'left-alone';
    },

    /**
     * Every frequency readback while no idle session runs: a return a
     * disconnect, a crash or a lost command left. Returns 'none' | 'confirmed'
     * | 'returned' | 'left-alone' | 'other-rig' | 'gave-up'.
     */
    onReadback(hz, { rigId = null, active = false, mode = '' } = {}) {
      if (active) return 'none';
      const m = read();
      const f = Number(hz) || 0;
      if (!m || !(f > 0)) return 'none';
      if (m.rigId && rigId && m.rigId !== rigId) return 'other-rig';
      if (m.state === 'returning' && now() - lastSentAt < RETURN_SETTLE_MS) return 'none';
      if (near(f, homeOf(m).freqHz) && !atIdleDial(m, f)) { write(null); tries = 0; return 'confirmed'; }
      if (atIdleDial(m, f)) {
        if (tries >= MAX_TRIES) {
          write(null);
          tries = 0;
          log(`Idle Mode: the radio did not go back to ${mhz(homeOf(m).freqHz)} after ${MAX_TRIES} tries; it is left on ${mhz(f)}`);
          return 'gave-up';
        }
        const why = m.state === 'returning' ? 'the return did not reach the radio'
          : m.state === 'ended' ? 'the radio is back and still where Idle Mode left it'
            : 'the last run ended during Idle Mode';
        sendBack(m, { fromHz: f, fromMode: mode, why });
        return 'returned';
      }
      leave(f, 'it is not on the Idle Mode frequency any more');
      return 'left-alone';
    },

    /** Forget the place without tuning. */
    drop() { if (read()) write(null); tries = 0; },
  };
}

/**
 * Before idle starts: did the radio's dial or mode change since the last
 * reading? Any change is someone using the radio (the knob, SmartSDR, a
 * logger), so the idle countdown starts again. note() returns true on a change.
 */
function createDialActivity({ stepHz = ACTIVITY_STEP_HZ } = {}) {
  let anchorHz = 0;
  let lastMode = '';
  return {
    note(hz, mode) {
      const f = Number(hz) || 0;
      const md = String(mode || '').toUpperCase();
      let changed = false;
      if (f > 0) {
        if (anchorHz > 0 && Math.abs(f - anchorHz) > stepHz) changed = true;
        if (!anchorHz || changed) anchorHz = f;
      }
      if (md) {
        if (lastMode && md !== lastMode && anchorHz > 0) changed = true;
        lastMode = md;
      }
      return changed;
    },
  };
}

module.exports = {
  createIdleReturn, createDialActivity, near,
  TOL_HZ, SETTLE_MS, RETURN_SETTLE_MS, MAX_TRIES, ACTIVITY_STEP_HZ,
};
