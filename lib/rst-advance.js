'use strict';
/**
 * RST Sent -> RST Rcvd auto-advance that agrees with the Tab key (#388).
 *
 * Typing a full report in RST Sent ("59" on phone, "599" on CW and data)
 * moves the cursor to RST Rcvd by itself, as N1MM does. An operator who also
 * presses Tab from habit used to go one field too far: the jump had already
 * put the cursor in Rcvd, so Tab took it on to State and the received report
 * was typed there (first activation, Discord 2026-11-11).
 *
 * The rule: a Tab pressed in Rcvd straight after the jump, before anything
 * else is typed there, is the operator's own "next field" and is absorbed;
 * the cursor stays in Rcvd. Any other key, a click away, or going back to
 * Sent ends that window, so a second Tab (or Tab after typing the received
 * report) moves on as normal. Shift+Tab is never absorbed. Deleting in Sent
 * never jumps.
 *
 * DOM-free so it can be tested; renderer/app.js wires it to the inputs.
 * Dual-mode: require() in tests, window.RstAdvance in the renderer.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RstAdvance = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  /** Whether an input event in RST Sent should move the cursor to Rcvd. */
  function shouldAdvance(length, expected, inputType) {
    // Only typing jumps; a delete, cut or undo never does. inputType is
    // missing on a synthetic event: treat that as typing.
    if (inputType && !String(inputType).startsWith('insert')) return false;
    const want = Number(expected) > 0 ? Number(expected) : 2;
    return Number(length) >= want;
  }

  /** One per Sent/Rcvd pair. */
  function create() {
    let armed = false; // Rcvd was reached by the jump and nothing has been typed there yet
    return {
      /** Input in Sent. Returns true when the caller should focus Rcvd. */
      sentInput(length, expected, inputType) {
        if (!shouldAdvance(length, expected, inputType)) return false;
        armed = true;
        return true;
      },
      /**
       * A keydown in Rcvd. Returns true when the caller should
       * preventDefault (the habit Tab right after the jump).
       */
      rcvdKeydown(e) {
        if (!armed) return false;
        const k = e || {};
        if (k.key === 'Shift') return false; // the modifier alone does not end the window
        armed = false;
        return k.key === 'Tab' && !k.shiftKey && !k.ctrlKey && !k.altKey && !k.metaKey;
      },
      /** Rcvd lost focus (a click away), or Sent was focused again. */
      reset() { armed = false; },
      get armed() { return armed; },
    };
  }

  return { shouldAdvance, create };
}));
