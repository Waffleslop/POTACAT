// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Typing and clicking a frequency in the VFO window, at both sizes (#672).
//
// The Large VFO has a keypad pane: clicking the frequency or typing a digit
// opens it, Enter tunes. The Small VFO (the one-line strip) has no room for
// the pane, so before #672 the keypad opened where nobody could see it, and
// digits + Enter tuned the radio to a number the operator never saw.
//
// Now, in the Small VFO:
//   - typing (or a paste) turns the frequency in the strip into the entry, in
//     place: the typed digits show there, Enter tunes, Esc or a click
//     elsewhere puts the live frequency back;
//   - a click on the frequency grows the window to the Large VFO with the
//     keypad open, and Tune or Cancel takes it back to the strip (the same
//     rule as the gear, Casey 2026-11-10);
//   - when the frequency is not on the strip (the operator left it off, or the
//     line was too narrow for it), typing grows to the keypad as a click does.
// A buffer the operator cannot see is never tuned.
//
// Pure. Dual-mode: require() in tests, window.VfoFreqEntry in the page.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VfoFreqEntry = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const isDigit = (k) => typeof k === 'string' && k.length === 1 && k >= '0' && k <= '9';
  const isDot = (k) => k === '.' || k === ',';

  /**
   * What a click on the frequency does.
   * 'locked'      : the VFO lock wins (remind the operator, tune nothing)
   * 'grow-keypad' : Small VFO: grow to the Large VFO with the keypad open
   * 'keypad'      : Large VFO: open the keypad pane
   */
  function clickRoute({ mini, locked } = {}) {
    if (locked) return 'locked';
    return mini ? 'grow-keypad' : 'keypad';
  }

  /**
   * What a key does. st: { mini, entryOpen, keypadShown, freqInStrip, locked }
   *   mini        : the window is the Small VFO
   *   entryOpen   : the strip's frequency is the entry right now
   *   keypadShown : the keypad pane is open AND on screen (never in mini)
   *   freqInStrip : the frequency is on the strip and not hidden for width
   *   locked      : the VFO lock is on
   * Returns one of:
   *   'cancel'      : Esc (put the live frequency back / close the keypad)
   *   'locked'      : a digit while locked in the Small VFO (remind, nothing typed)
   *   'grow-type'   : Small VFO without the frequency on the strip: grow to the keypad, then type
   *   'strip-type'  : add the key to the strip entry (opening it)
   *   'strip-back'  : Backspace in the strip entry
   *   'strip-go'    : Enter in the strip entry
   *   'keypad-type' : Large VFO: add the key to the keypad (opening it)
   *   'keypad-back' : Backspace in the keypad
   *   'keypad-go'   : Enter in the keypad
   *   'none'        : not ours
   */
  function keyRoute(key, st = {}) {
    const mini = !!st.mini;
    if (key === 'Escape') return 'cancel';
    if (isDigit(key) || isDot(key)) {
      if (mini) {
        if (st.locked) return 'locked';
        return st.freqInStrip ? 'strip-type' : 'grow-type';
      }
      return 'keypad-type';
    }
    if (key === 'Backspace') {
      if (mini) return st.entryOpen ? 'strip-back' : 'none';
      return st.keypadShown ? 'keypad-back' : 'none';
    }
    if (key === 'Enter') {
      // Only an entry on screen can tune. In the Small VFO the keypad pane is
      // hidden, so its buffer never tunes from there.
      if (mini) return st.entryOpen && st.freqInStrip ? 'strip-go' : 'none';
      return st.keypadShown ? 'keypad-go' : 'none';
    }
    return 'none';
  }

  /** What a pasted frequency does: 'strip' | 'grow' | 'keypad'. */
  function pasteRoute({ mini, freqInStrip } = {}) {
    if (!mini) return 'keypad';
    return freqInStrip ? 'strip' : 'grow';
  }

  /** The typed text plus one key, as the keypad builds it (10 characters, one point). */
  function addKey(buf, key) {
    const b = String(buf || '');
    if (isDot(key)) return b.includes('.') ? b : b + '.';
    if (!isDigit(key) || b.length >= 10) return b;
    return b + key;
  }

  return { clickRoute, keyRoute, pasteRoute, addKey };
});
