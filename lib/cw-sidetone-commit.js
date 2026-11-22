// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// ECHOCAT Web's sidetone and the air always agree (#244, Casey 2026-11-19).
//
// The page's iambic keyer chooses each element a little before it sounds:
// the sidetone is scheduled on the audio clock a lead ahead (20 ms for a new
// streak, one space after the last element for a continued one). Until
// 2026-11-19 the element went to the shack at the CHOICE, and a held paddle
// released late could still withdraw it afterwards, judged by when the
// release happened and what the operator could have heard. A withdrawal that
// reached the page after the tone had started cut the tone into a blip while
// the shack dropped the element whole: LZ3AW (TS-480, 25 wpm, Chrome on a
// phone, 1.14.6) heard extra elements in the page's own sidetone that never
// went on the air.
//
// The rule now: an element is COMMITTED when its sidetone starts. Before
// that, the page may withdraw it, and then nothing is heard and nothing is
// sent. From that point it is sent to the shack and it sounds in full on
// both sides; no withdrawal is ever honoured after it. The element reaches
// the shack AT the commit (not at the choice), so a withdrawal never goes on
// the wire. The shack keeps its own copy of the rule (lib/cw-key-playout.js):
// a withdrawal that arrives after the element began there is keyed in full.
//
// Safety stops (STOP, a mode change, paddle keying lost, the socket closing)
// cut both together: the page silences the tone at once and sends a
// cancelling key-up at the point in the element where the tone stopped
// (cutAt), so the shack cuts its copy at the same place. An element not yet
// sounding is dropped on both sides. If the element cannot be sent at its
// commit (the socket is gone), its tone is silenced before it starts and the
// keyer stops (onLost), so the page never sounds what the air will not get.
//
// One clock: `now()` is the sidetone's own clock in ms (the AudioContext's
// currentTime), the clock the tone is scheduled on. A timer only prompts the
// commit; whether the tone has started is always read from that clock.
//
// Dual-mode: `require()` in tests, `window.CwSidetoneCommit` in ECHOCAT Web
// (inlined by lib/remote-server.js).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CwSidetoneCommit = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The audio thread renders in blocks (128 frames, under 3 ms) ahead of
  // currentTime; a change scheduled inside the next block may already be
  // rendered. An element this close to its start counts as started.
  var GUARD_MS = 5;

  /**
   * May the page still withdraw this element? Only while its sidetone has
   * not started (nor is about to, inside the guard) and it was never sent.
   * @param {{soundAt:number, committed?:boolean}|null} el
   * @param {number} nowMs  the sidetone clock
   * @param {number} [guardMs]
   */
  function canWithdraw(el, nowMs, guardMs) {
    if (!el || el.committed) return false;
    var g = guardMs != null ? guardMs : GUARD_MS;
    return Number(nowMs) < Number(el.soundAt) - g;
  }

  /**
   * Where a safety stop at `nowMs` cuts a sent element, on the stream
   * timeline (`at`): the same point in the element where the tone stopped.
   * Before it sounds: just before its start (the shack drops it whole, as
   * the page drops its tone). After it ended: null (nothing to cut).
   * @param {{at:number, ms:number, soundAt:number}|null} el
   * @param {number} nowMs  the sidetone clock
   */
  function cutAt(el, nowMs) {
    if (!el) return null;
    var into = Number(nowMs) - Number(el.soundAt);
    if (into < 0) return el.at - 1;
    if (into >= el.ms) return null;
    return el.at + into;
  }

  /**
   * The page's gate between its keyer and the shack.
   * @param {object} o
   * @param {() => number} o.now  the sidetone clock, ms
   * @param {(msg: object) => boolean} o.send  false when it could not reach the shack
   * @param {(fn: Function, ms: number) => any} o.setTimer
   * @param {(h: any) => void} o.clearTimer
   * @param {(el: object) => void} [o.onLost]  an element could not be sent at its commit
   * @param {number} [o.guardMs]
   */
  function createGate(o) {
    var guard = o.guardMs != null ? o.guardMs : GUARD_MS;
    var pending = null; // chosen, scheduled to sound, not yet committed
    var current = null; // the last element committed (sent)

    function commitPending(fromTimer) {
      var el = pending;
      pending = null;
      if (el.h != null) { o.clearTimer(el.h); el.h = null; }
      el.committed = true;
      current = el;
      var ok = o.send({ type: 'cw-key', at: el.at, down: true, ms: el.ms }) !== false;
      if (!ok) {
        current = null;
        if (fromTimer && o.onLost) o.onLost(el);
      }
      return ok;
    }

    return {
      /** A new iambic element: stream time `at`, length `ms`, sidetone starts at `soundAt`. */
      element: function (at, ms, soundAt) {
        if (pending) commitPending(false);
        var el = { at: at, ms: ms, soundAt: soundAt, committed: false, h: null };
        pending = el;
        el.h = o.setTimer(function () {
          el.h = null;
          if (pending === el) commitPending(true);
        }, Math.max(0, soundAt - guard - o.now()));
        return el;
      },
      /**
       * The keyer wants the pending element back. True: withdrawn, nothing
       * heard, nothing sent. False: it has started to sound and is keyed in full.
       */
      withdraw: function () {
        if (!pending) return false;
        if (canWithdraw(pending, o.now(), guard)) {
          if (pending.h != null) o.clearTimer(pending.h);
          pending = null;
          return true;
        }
        commitPending(false); // its timer is late; the tone has started
        return false;
      },
      /**
       * A safety stop. Drops an element that has not started to sound, and
       * returns where the element now sounding is cut on the stream timeline
       * (cutAt), or null when nothing sent is sounding.
       */
      stop: function () {
        var now = o.now();
        if (pending) {
          if (canWithdraw(pending, now, guard)) {
            if (pending.h != null) o.clearTimer(pending.h);
            pending = null;
          } else commitPending(false);
        }
        var cut = cutAt(current, now);
        current = null;
        return cut;
      },
      get pending() { return pending; },
      get current() { return current; },
    };
  }

  return { GUARD_MS: GUARD_MS, canWithdraw: canWithdraw, cutAt: cutAt, createGate: createGate };
}));
