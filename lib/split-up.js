// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Split "up N" with one click (#689, DA2PK): the TX VFO goes to the receive
// frequency plus an offset and split is switched on; pressing again returns
// to simplex. A DX station or a busy activator says "up 1" or "up 5"; before
// this it took four steps on the radio while the pile-up went on.
//
// It only sets VFOs. It never keys the radio. "Up" is the dial frequency plus
// N kHz in every mode (in CW, SSB and data alike), which is what "up 1" means
// on the air; the sideband is the radio's own and is not changed here.
//
// Pure, dual-mode: `require` in main.js (the `split-up` rig-control action)
// and the tests, `window.SplitUp` in the VFO window and ECHOCAT Web.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SplitUp = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** The offsets offered, in kHz: the three the issue asks for, and one down. */
  var OFFSETS_KHZ = [1, 2, 5, -1];
  var DEFAULT_KHZ = 1;

  /** One of OFFSETS_KHZ; anything else is the default (+1 kHz). */
  function normalizeOffset(v) {
    var n = Number(v);
    return OFFSETS_KHZ.indexOf(n) >= 0 ? n : DEFAULT_KHZ;
  }

  /** The TX frequency in Hz: the dial plus the offset, to the hertz. */
  function txHz(rxHz, offsetKhz) {
    return Math.round(Number(rxHz)) + Math.round(normalizeOffset(offsetKhz) * 1000);
  }

  /** "Up 1", "Up 5", "Down 1": the words an operator hears on the air. */
  function label(offsetKhz) {
    var n = normalizeOffset(offsetKhz);
    return (n < 0 ? 'Down ' : 'Up ') + Math.abs(n);
  }

  /** The choice's text in the offset menu: "+1 kHz", "-1 kHz". */
  function optionText(offsetKhz) {
    var n = normalizeOffset(offsetKhz);
    return (n < 0 ? '-' : '+') + Math.abs(n) + ' kHz';
  }

  /**
   * Offered only where the radio can switch split AND set the other VFO's
   * frequency (caps.splitUp from main.js getRigCapabilities: split, and a
   * TX-frequency command this link can really send).
   */
  function available(caps) {
    return !!(caps && caps.splitUp);
  }

  /** True when a receive range covers hz. Unknown reach (null, empty) never refuses. */
  function inReach(reach, hz) {
    if (!Array.isArray(reach) || !reach.length) return true;
    for (var i = 0; i < reach.length; i++) {
      var r = reach[i];
      if (Array.isArray(r) && hz >= Number(r[0]) && hz <= Number(r[1])) return true;
    }
    return false;
  }

  function mhzText(hz) {
    return (hz / 1e6).toFixed(3) + ' MHz';
  }

  var LOCKED_TEXT = 'VFO locked. Unlock the VFO to change frequency.';

  function refuse(reason, message) {
    return { ok: false, reason: reason, message: message, steps: [] };
  }

  /**
   * Split up N: what to send, or why not.
   *   opts.rxHz       the radio's dial (the receive frequency)
   *   opts.offsetKhz  one of OFFSETS_KHZ
   *   opts.split      split is on now
   *   opts.locked     the VFO lock is on
   *   opts.available  available(caps)
   *   opts.reach      the radio's receive ranges [[lo, hi], ...] (optional)
   * Returns { ok, txHz, steps: [{ action, value?, hz? }] } in the order to
   * send them: split on first (DXLab Commander sets the TX frequency only
   * once split is on), then the other VFO.
   */
  function plan(opts) {
    var o = opts || {};
    if (!o.available) return refuse('unavailable', 'This radio cannot set a split TX frequency from POTACAT.');
    if (o.locked) return refuse('locked', LOCKED_TEXT);
    var rx = Math.round(Number(o.rxHz));
    if (!isFinite(rx) || rx <= 0) return refuse('no-freq', 'No frequency from the radio yet.');
    var tx = txHz(rx, o.offsetKhz);
    if (!inReach(o.reach, tx)) return refuse('out-of-range', mhzText(tx) + ' is outside what this radio can tune.');
    var steps = [];
    if (!o.split) steps.push({ action: 'set-split', value: true });
    steps.push({ action: 'set-freq-other', hz: tx });
    return { ok: true, txHz: tx, steps: steps };
  }

  /** Back to simplex: split off. The TX VFO is left where it was; the radio transmits on the dial again. */
  function planOff(opts) {
    var o = opts || {};
    if (!o.available) return refuse('unavailable', 'This radio cannot set a split TX frequency from POTACAT.');
    if (o.locked) return refuse('locked', LOCKED_TEXT);
    return { ok: true, steps: [{ action: 'set-split', value: false }] };
  }

  /**
   * The one button: off -> split up N; on -> back to simplex. Changing N
   * while split is on uses plan() directly (the TX VFO moves, split stays).
   */
  function press(opts) {
    return opts && opts.split ? planOff(opts) : plan(opts);
  }

  /** The button's face: { text, on, title }. */
  function buttonFace(split, offsetKhz) {
    if (split) {
      return { text: 'Split off', on: true, title: 'Split is on. Click to transmit on the receive frequency again.' };
    }
    return {
      text: 'Split ' + label(offsetKhz).toLowerCase(),
      on: false,
      title: 'Split on, and transmit ' + Math.abs(normalizeOffset(offsetKhz)) + ' kHz '
        + (normalizeOffset(offsetKhz) < 0 ? 'below' : 'above') + ' the receive frequency. Sets the VFOs only; it does not transmit.',
    };
  }

  return {
    OFFSETS_KHZ: OFFSETS_KHZ,
    DEFAULT_KHZ: DEFAULT_KHZ,
    LOCKED_TEXT: LOCKED_TEXT,
    normalizeOffset: normalizeOffset,
    txHz: txHz,
    label: label,
    optionText: optionText,
    available: available,
    inReach: inReach,
    plan: plan,
    planOff: planOff,
    press: press,
    buttonFace: buttonFace,
  };
});
