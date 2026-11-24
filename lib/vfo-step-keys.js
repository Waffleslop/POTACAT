/**
 * Step tuning by button and arrow key (#256): the VFO window's Step down /
 * Step up buttons and its arrow keys, and the arrow keys on ECHOCAT Web's
 * VFO view. One rule for both surfaces:
 *   - Up / Down tune one step; Left / Right make the step smaller / bigger.
 *   - Never while the operator types (a text box, a list, a slider) and never
 *     with Ctrl, Alt or Cmd held (those are shortcuts).
 *   - A press tunes at once; holding repeats after a short wait at a steady rate.
 *   - No dial known yet (0): nothing tunes, so a step never starts from 0.
 * Tuning only moves the frequency; nothing here can transmit.
 * Dual-mode: require() in tests, window.VfoStepKeys in the VFO window and
 * ECHOCAT Web (inlined by lib/remote-server.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VfoStepKeys = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const HOLD_DELAY_MS = 400;    // a press, then this wait before repeating
  const HOLD_INTERVAL_MS = 100; // then one step every this many ms (10 a second)

  /** The frequency one step up (dir 1) or down (dir -1), in Hz; 0 = do nothing. */
  function stepFreqHz(freqHz, stepHz, dir) {
    const f = Number(freqHz), s = Number(stepHz);
    if (!(f > 0) || !(s > 0) || (dir !== 1 && dir !== -1)) return 0;
    return Math.max(0, Math.round(f + dir * s));
  }

  /** The step list index after moving by delta, held inside the list. */
  function stepIndexMove(idx, delta, len) {
    const n = Math.max(0, Math.floor(Number(len) || 0));
    if (!n) return 0;
    const i = Math.floor(Number(idx) || 0) + (delta > 0 ? 1 : delta < 0 ? -1 : 0);
    return Math.min(n - 1, Math.max(0, i));
  }

  const NOT_TYPING_INPUTS = { checkbox: 1, radio: 1, button: 1, submit: 1, reset: 1, color: 1, file: 1, image: 1 };
  /** Does this element take arrow keys itself (text box, list, slider, editable)? */
  function isTypingTarget(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = String(el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return !NOT_TYPING_INPUTS[String(el.type || 'text').toLowerCase()];
    return false;
  }

  /**
   * What an arrow key does: 'up' | 'down' (tune a step), 'step-bigger' |
   * 'step-smaller' (change the step), or null (leave the key alone).
   * opts.typing: the focused element takes the key itself.
   */
  function keyAction(e, opts) {
    if (!e || (opts && opts.typing)) return null;
    if (e.ctrlKey || e.altKey || e.metaKey) return null;
    switch (e.key) {
      case 'ArrowUp': return 'up';
      case 'ArrowDown': return 'down';
      case 'ArrowRight': return 'step-bigger';
      case 'ArrowLeft': return 'step-smaller';
      default: return null;
    }
  }

  /**
   * Press-and-hold repeat. start(dir) calls step(dir) at once, then again after
   * delayMs and every intervalMs until stop(). A step that returns false (VFO
   * locked, no dial) ends the hold. A second start in the same direction while
   * held (keyboard auto-repeat) is ignored. Timers can be passed in for tests.
   */
  function createHoldRepeat(step, opts) {
    const o = opts || {};
    const delayMs = o.delayMs != null ? o.delayMs : HOLD_DELAY_MS;
    const intervalMs = o.intervalMs != null ? o.intervalMs : HOLD_INTERVAL_MS;
    const t = o.timers || {};
    const setT = t.setTimeout || setTimeout, clearT = t.clearTimeout || clearTimeout;
    const setI = t.setInterval || setInterval, clearI = t.clearInterval || clearInterval;
    let dir = 0, waitId = null, repeatId = null;

    function stop() {
      if (waitId != null) clearT(waitId);
      if (repeatId != null) clearI(repeatId);
      waitId = null; repeatId = null; dir = 0;
    }
    function fire() {
      if (step(dir) === false) stop();
    }
    function start(d) {
      if (d !== 1 && d !== -1) return;
      if (dir === d) return;
      stop();
      dir = d;
      fire();
      if (!dir) return;
      waitId = setT(() => {
        waitId = null;
        if (!dir) return;
        fire();
        if (dir) repeatId = setI(fire, intervalMs);
      }, delayMs);
    }
    return { start, stop, held: () => dir };
  }

  return {
    HOLD_DELAY_MS, HOLD_INTERVAL_MS,
    stepFreqHz, stepIndexMove, isTypingTarget, keyAction, createHoldRepeat,
  };
});
