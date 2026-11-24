/**
 * When ECHOCAT Web must let go of PTT, and whether the shack still needs to
 * hear the release (K4DZC report, FT-710, #935).
 *
 * PTT stayed keyed after the operator let go when:
 *  - Space was held and the window lost focus, so keyup never came;
 *  - a text box had focus at the moment Space came up;
 *  - a press on the PTT button was cancelled by the browser (pointercancel);
 *  - the release happened while the socket was down, so it was dropped.
 *
 * Two pieces, both pure (no DOM, no socket, no timers):
 *
 *  Holds: which gestures (the 'pointer' on a PTT button, the 'space' key) are
 *  holding PTT right now. A lifecycle event (window blur, page hidden,
 *  pagehide) lets go of every gesture hold. Space starts PTT only when no text
 *  box has focus, and lets go on keyup whatever has focus while it holds.
 *  Toggles that do not depend on this page staying in front (the Bluetooth
 *  headset button, the speaker-mic) are not gesture holds and keep their own
 *  release.
 *
 *  Off owed: the release went out on a socket that was not open, or on one
 *  that closed before the shack said anything after it (a dead socket can
 *  still read OPEN). The page then sends PTT off first thing after it is
 *  admitted again (auth-ok), before anything that could key.
 *
 * Nothing here ever starts PTT: it only says when to stop.
 *
 * Dual-mode: Node require() gets module.exports, ECHOCAT Web gets
 * window.PttRelease (inlined by lib/remote-server.js).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PttRelease = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const GESTURES = ['pointer', 'space'];

  /** Is this element a place the operator types (Space is a character there)? */
  function isTypingTarget(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    return /^(INPUT|TEXTAREA|SELECT)$/.test(String(el.tagName || '').toUpperCase());
  }

  function create() {
    const held = { pointer: false, space: false };
    let owed = false;        // the shack may still be keyed by us: send off after the next auth-ok
    let unconfirmed = false; // a release went out and nothing has been heard since

    return {
      /** A gesture began holding PTT. */
      press(source) { if (source in held) held[source] = true; },

      /** That gesture let go. True when it was holding (the caller stops PTT). */
      release(source) {
        if (!(source in held) || !held[source]) return false;
        held[source] = false;
        return true;
      },

      holding(source) {
        if (source) return !!held[source];
        return GESTURES.some((g) => held[g]);
      },

      /** Window blur, page hidden, pagehide: every gesture lets go. True when one was holding. */
      releaseAll() {
        const any = GESTURES.some((g) => held[g]);
        for (const g of GESTURES) held[g] = false;
        return any;
      },

      /** Space keydown: start PTT? Never on a repeat, never while typing in a box. */
      spaceStarts(e, typing) {
        return !!(e && e.code === 'Space' && !e.repeat && !typing);
      },

      /**
       * Space keyup: stop PTT? Always while Space holds PTT, whatever has
       * focus; otherwise as before (Space up outside a text box stops PTT).
       */
      spaceReleases(e, typing) {
        if (!e || e.code !== 'Space') return false;
        return held.space || !typing;
      },

      /** An unkey (ptt off or estop) was due. socketOpen: it went out on an open socket. */
      offSent(socketOpen) {
        if (socketOpen) unconfirmed = true;
        else { owed = true; unconfirmed = false; }
      },

      /** The shack sent something: the socket was alive after the release. */
      heard() { unconfirmed = false; },

      /** The socket closed. A release nobody answered may never have arrived. */
      socketClosed() {
        if (unconfirmed) owed = true;
        unconfirmed = false;
      },

      /** Is an off owed? (read-only) */
      offOwed() { return owed; },

      /** Admitted again: true once if PTT off must be sent now. */
      takeOwed() {
        const o = owed;
        owed = false;
        return o;
      },
    };
  }

  return { GESTURES, isTypingTarget, create };
});
