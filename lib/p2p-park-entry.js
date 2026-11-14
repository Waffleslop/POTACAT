'use strict';
/**
 * The other station's park in the activation screen's quick-log row (#506).
 *
 * Their park (the P2P box) was cleared only by Clear, a successful Log and the
 * return chip. Click a park-to-park spot, fail to work them, type the next
 * caller to your own CQ, and that contact was logged with SIG/SIG_INFO naming
 * a park you never worked: a false park-to-park credit, uploaded to POTA.
 * Typing one reference over an old one could also log the old one.
 *
 * Two rules, both here so they can be tested:
 *
 * 1. A park belongs to the callsign it came with (the spot's call, or what was
 *    in the callsign box when the park was typed). Typing that call on, or
 *    backspacing inside it, keeps the park. Emptying the box, or a call that
 *    is no longer that one (replaced, or a different station typed over it),
 *    clears the park. parkCallAfterEdit() decides it on every edit.
 *
 * 2. What the box shows is what is logged. resolveHunterParks() reads the
 *    typed text; the parks behind a visible "+N" badge (the Ctrl/Cmd+M
 *    multi-park dialog, or an n-fer spot) are kept, because the operator can
 *    see them. A stored reference the box no longer shows is never logged.
 *
 * Dual-mode: require() in tests, window.P2pParkEntry in the renderer.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.P2pParkEntry = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  function normCall(s) {
    return String(s || '').trim().toUpperCase();
  }

  /**
   * After an edit of the callsign box: does their park still belong here?
   * @param {string} parkCall  the call the park came with ('' = typed before any call)
   * @param {string} typedCall the callsign box now
   * @returns {{clear: boolean, parkCall: string}} the call to remember next time
   */
  function parkCallAfterEdit(parkCall, typedCall) {
    const owner = normCall(parkCall);
    const typed = normCall(typedCall);
    if (!typed) return { clear: true, parkCall: '' };
    // Typing on (or the first letters after a park typed with no call yet).
    if (typed.startsWith(owner)) return { clear: false, parkCall: typed };
    // Backspacing inside the same call: the owner stays the full call, so
    // retyping a different ending clears the park.
    if (owner.startsWith(typed)) return { clear: false, parkCall: owner };
    return { clear: true, parkCall: '' };
  }

  /** The box: one reference or a comma list. POTA/WWFF-shaped refs, SOTA
   *  summits and WWBOTA bunkers. @returns {{refs: string[], bad: string[]}} */
  function parseHunterParkInput(text) {
    const refs = [], bad = [];
    for (const tok of String(text || '').toUpperCase().split(/[,;\s]+/).filter(Boolean)) {
      const ok = /^[A-Z]{1,4}-\d{3,5}$/.test(tok) || /^[A-Z0-9]{1,4}\/[A-Z]{2}-\d{3}$/.test(tok) || /^B\/[A-Z]{1,3}-\d{3,5}$/.test(tok);
      if (!ok) bad.push(tok);
      else if (!refs.includes(tok)) refs.push(tok);
    }
    return { refs, bad };
  }

  /**
   * Their parks at log time.
   * @param {object} o
   * @param {string} o.text        the box as typed
   * @param {Array<{ref:string,name?:string,program?:string}>} o.stored  hunterParkRefs
   * @param {boolean} o.badgeShown the "+N" badge is visible (stored.slice(1) are its parks)
   * @param {number} o.max         most parks in one contact
   * @param {function(string):string} o.inferProgram  ref -> program
   * @returns {{refs: Array|null, bad: string[]}} refs null when the text is refused
   */
  function resolveHunterParks(o) {
    const parsed = parseHunterParkInput(o.text);
    if (parsed.bad.length) return { refs: null, bad: parsed.bad };
    if (!parsed.refs.length) return { refs: [], bad: [] };
    const stored = Array.isArray(o.stored) ? o.stored : [];
    const known = new Map(stored.map((p) => [String(p.ref).toUpperCase(), p]));
    const extras = o.badgeShown ? stored.slice(1).map((p) => String(p.ref).toUpperCase()) : [];
    const max = o.max > 0 ? o.max : Infinity;
    const infer = typeof o.inferProgram === 'function' ? o.inferProgram : () => 'POTA';
    const out = [];
    for (const ref of [...parsed.refs, ...extras]) {
      if (out.length >= max || out.some((p) => p.ref === ref)) continue;
      const k = known.get(ref);
      out.push({ ref, name: (k && k.name) || '', program: (k && k.program) || infer(ref) });
    }
    return { refs: out, bad: [] };
  }

  return { parkCallAfterEdit, parseHunterParkInput, resolveHunterParks, normCall };
}));
