// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Transmit power for SSTV (#279). The operator may give the SSTV window a
// power of its own ("Transmit power for SSTV: [ ] W"). Empty, the default,
// changes nothing: the picture goes out at whatever power the radio is at.
// With a level set, POTACAT sets it just before the picture keys and puts
// the radio's own level back when the picture ends, however it ends
// (finished, HALT, an error, the SWR guard, the stuck-TX limit, a Guest Pass
// ending). The rule above the rules: the app does the setup, and anything it
// changes it restores. Nothing here keys the radio.
//
// The WSPR beacon's power memory and the APRS radio return are the model:
//   - the level to put back is written to disk BEFORE the SSTV level is sent;
//   - the marker is cleared only by the radio's own readback showing the old
//     level, never by a command having been sent, so a crash or a quit in the
//     middle of a picture is repaired by the next session's first readback;
//   - a level the operator sets in between is theirs, never undone.
//   - never a guess: a radio whose power POTACAT does not know is left alone,
//     because there would be nothing to put back.
//
// Pure, dual-mode: `require` in main and the tests, `window.SstvTxPower` in
// the SSTV window (parseWatts and the wording only).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SstvTxPower = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TOL_W = 0.5;            // readbacks are whole watts on most radios
  var MAX_TRIES = 3;          // restore attempts on readbacks before giving up
  var RETRY_GAP_MS = 10000;   // a stale readback right after a restore is not a failure
  var MAX_W = 2000;           // nothing a sane entry asks for; the radio's own maximum clamps further

  var LABEL = 'Transmit power for SSTV';
  var HELP = 'Leave empty to use the radio\'s current power. With a level here, POTACAT sets it before each picture and puts the radio\'s own power back afterwards.';
  var NO_POWER_TEXT = 'This radio\'s power cannot be set by POTACAT, so pictures go out at the power the radio is set to.';
  var NO_RADIO_TEXT = 'No radio connected. The level is used once one is.';
  var REMOTE_TEXT = 'Sending through a remote shack: the shack\'s own SSTV power setting applies.';

  /** The saved/typed level as watts, or null for "use the radio's power"
   *  (empty, 0, negative, not a number). Rounded to 0.1 W, at most MAX_W. */
  function parseWatts(v) {
    if (v === null || v === undefined) return null;
    var s = typeof v === 'string' ? v.trim().replace(/\s*w$/i, '') : v;
    if (s === '') return null;
    var n = Number(s);
    if (!isFinite(n) || n <= 0) return null;
    return Math.round(Math.min(n, MAX_W) * 10) / 10;
  }

  function near(a, b) {
    return Number(a) > 0 && Number(b) > 0 && Math.abs(Number(a) - Number(b)) <= TOL_W;
  }

  /**
   * What to do before a picture keys.
   * @param {object} o
   * @param {*} o.wantW        the saved SSTV level (any form parseWatts takes)
   * @param {number} o.currentW the radio's current power as POTACAT knows it (0 = unknown)
   * @param {boolean} o.canSet  POTACAT can set this radio's power now
   * @param {number} [o.capW]   the Guest Pass cap when a pass would clamp wantW
   * @param {number} [o.limitW] the radio's own maximum / the amplifier drive limit
   * @returns {{action:'none', why:string} | {action:'set', watts:number, restoreW:number, capped:boolean}}
   */
  function plan(o) {
    o = o || {};
    var want = parseWatts(o.wantW);
    if (want === null) return { action: 'none', why: 'empty' };
    if (!o.canSet) return { action: 'none', why: 'no-power-control' };
    var cur = Number(o.currentW);
    if (!(isFinite(cur) && cur > 0)) return { action: 'none', why: 'power-unknown' };
    var w = want;
    var capped = false;
    if (Number(o.capW) > 0 && w > Number(o.capW)) { w = Number(o.capW); capped = true; }
    if (Number(o.limitW) > 0 && w > Number(o.limitW)) w = Number(o.limitW);
    if (near(w, cur) || w === cur) return { action: 'none', why: 'same' };
    return { action: 'set', watts: w, restoreW: cur, capped: capped };
  }

  /**
   * The SSTV power session, with its marker on disk.
   * @param {object} o
   * @param {() => object|null} o.load   the persisted marker {watts, sstvWatts, rigId, at, state}
   * @param {(m: object|null) => void} o.save  persist (null clears); synchronous
   * @param {(watts: number) => boolean} o.setPower  command the radio; false when it could not
   * @param {() => number} [o.now]
   * @param {(s: string) => void} [o.log]
   */
  function createSession(o) {
    o = o || {};
    var now = o.now || Date.now;
    var log = o.log || function () {};
    var live = false;          // a picture this session set the power for is on the air
    var tries = 0;
    var lastTryAt = 0;
    function read() { try { return o.load() || null; } catch (e) { return null; } }
    function write(m) { o.save(m); }

    function sendBack(m, why) {
      tries++;
      lastTryAt = now();
      write(Object.assign({}, m, { state: 'returning' }));
      var ok = false;
      try { ok = o.setPower(m.watts) !== false; } catch (e) { ok = false; }
      if (ok) log('[SSTV] TX power back to ' + m.watts + ' W (' + why + '; it was ' + m.sstvWatts + ' W for the picture)');
      else log('[SSTV] Could not put TX power back to ' + m.watts + ' W (' + why + '): the radio is not reachable. It is put back on the next power report.');
      return ok;
    }

    return {
      /** The marker on disk, or null. */
      pending: function () { return read(); },
      /** A picture this session set the power for is on the air. */
      active: function () { return live; },

      /**
       * A picture is about to key. Returns plan()'s answer; on 'set' the
       * level to put back is saved first, then the SSTV level is sent.
       * A marker already on disk (back-to-back pictures, a restore not yet
       * confirmed) keeps its level: the SSTV level is never saved as home.
       */
      begin: function (args) {
        args = args || {};
        var had = read();
        var cur = args.currentW;
        if (had && had.watts > 0 && (!had.rigId || !args.rigId || had.rigId === args.rigId)) cur = had.watts;
        var p = plan(Object.assign({}, args, { currentW: cur }));
        if (p.action !== 'set') {
          // The radio is at the SSTV level already, and a restore is owed.
          if (p.why === 'same' && had) { live = true; tries = 0; }
          return p;
        }
        write({ watts: p.restoreW, sstvWatts: p.watts, rigId: args.rigId || null, at: now(), state: 'tx' });
        tries = 0;
        var ok = false;
        try { ok = o.setPower(p.watts) !== false; } catch (e) { ok = false; }
        if (!ok) {
          write(had || null);
          return { action: 'none', why: 'not-set' };
        }
        live = true;
        return p;
      },

      /**
       * The picture ended (any way). Puts the level back once; every later
       * call is a no-op until the next begin. Returns 'restored' | 'failed' | 'none'.
       */
      end: function (why) {
        if (!live) return 'none';
        live = false;
        var m = read();
        if (!m || !(m.watts > 0)) return 'none';
        return sendBack(m, why || 'picture ended') ? 'restored' : 'failed';
      },

      /** The operator set a power from any surface: theirs, never undone. */
      operatorSet: function () {
        live = false;
        tries = 0;
        if (read()) write(null);
      },

      /**
       * Every power readback. Returns 'none' | 'confirmed' | 'restored' |
       * 'left-alone' | 'other-rig' | 'gave-up' | 'waiting'.
       */
      onReadback: function (watts, opts) {
        opts = opts || {};
        if (live) return 'none';
        var m = read();
        if (!m) return 'none';
        if (m.rigId && opts.rigId && m.rigId !== opts.rigId) return 'other-rig';
        var w = Number(watts);
        if (!(isFinite(w) && w > 0)) return 'none';
        if (near(w, m.watts)) { write(null); tries = 0; return 'confirmed'; }
        if (near(w, m.sstvWatts)) {
          if (tries >= MAX_TRIES) {
            write(null);
            log('[SSTV] The radio did not take the ' + m.watts + ' W restore after ' + MAX_TRIES + ' tries; giving up. Set TX power by hand.');
            return 'gave-up';
          }
          if (tries > 0 && now() - lastTryAt < RETRY_GAP_MS) return 'waiting';
          sendBack(m, m.state === 'tx' ? 'the last run ended during a picture' : 'the restore did not reach the radio');
          return 'restored';
        }
        write(null);
        tries = 0;
        log('[SSTV] TX power is ' + w + ' W, set since the picture, so the ' + m.watts + ' W from before is not put back');
        return 'left-alone';
      },
    };
  }

  /** The line under the field in the SSTV window, or '' when the level will be used. */
  function stateText(s) {
    s = s || {};
    if (s.remote) return REMOTE_TEXT;
    if (s.why === 'no-radio') return NO_RADIO_TEXT;
    if (!s.canSet) return NO_POWER_TEXT;
    return '';
  }

  return {
    parseWatts: parseWatts, plan: plan, createSession: createSession, near: near, stateText: stateText,
    TOL_W: TOL_W, MAX_TRIES: MAX_TRIES, RETRY_GAP_MS: RETRY_GAP_MS, MAX_W: MAX_W,
    LABEL: LABEL, HELP: HELP, NO_POWER_TEXT: NO_POWER_TEXT, NO_RADIO_TEXT: NO_RADIO_TEXT, REMOTE_TEXT: REMOTE_TEXT,
  };
});
