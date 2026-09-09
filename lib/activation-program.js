/**
 * Which award program the operator is ACTIVATING under.
 *
 * POTACAT hardcoded `MY_SIG: 'POTA'` in eleven places, so a SOTA, WWFF, LLOTA
 * or WWBOTA activator got `MY_SIG=POTA` on every contact they logged. Unlike a
 * missing field, a wrong one stays invisible until an award check fails.
 *
 * The program is STORED on each park ref, never re-derived at log time, and
 * `inferParkProgram()` is only ever a seeder and a fallback. The reason is
 * concrete: an LLOTA reference (LLCL-0001) is structurally identical to a POTA
 * one (US-0512), so no amount of pattern matching can tell them apart — and
 * the same is true of PARC (US-NC-2540). Inference is a convenience at the
 * moment of typing, when the operator can still see and correct it; as a
 * source of truth at save time it is silently wrong for a whole program.
 *
 * The safety property everything here rests on: **anything unrecognised, or
 * missing, resolves to POTA.** That is what today's code does unconditionally,
 * so an unmigrated setting or an unclassifiable ref keeps the current
 * behaviour byte-for-byte and this change cannot make a correct POTA log wrong.
 *
 * Dual-mode: Node `require()` gets `module.exports`; the renderers have no
 * require, so a plain <script> tag gets `window.ActivationProgram`.
 * Tests: test/activation-program-test.js.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ActivationProgram = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_PROGRAM = 'POTA';

  /**
   * Guess a program from the shape of a reference.
   *
   * Moved verbatim out of renderer/app.js so main, the renderer and the tests
   * share one definition. Shapes: SOTA `W4C/CM-001` (slash), WWFF `KFF-1234`
   * (FF- designator), WWBOTA `B/US-1234` (B/ prefix, checked BEFORE the
   * generic slash or it would read as SOTA).
   *
   * Known blind spots, deliberate and documented rather than papered over:
   * LLOTA and PARC refs are indistinguishable from POTA by shape and come back
   * POTA. That is exactly why callers store the result instead of calling this
   * at save time.
   */
  function inferParkProgram(ref) {
    var r = String(ref == null ? '' : ref).toUpperCase();
    if (/^B\//.test(r)) return 'WWBOTA';
    if (r.indexOf('/') !== -1) return 'SOTA';
    if (/FF-\d/.test(r)) return 'WWFF';
    return DEFAULT_PROGRAM;
  }

  /** The stored program for one ref entry, with the POTA fallback applied. */
  function programOf(entry) {
    if (!entry) return DEFAULT_PROGRAM;
    var p = String(entry.program || '').toUpperCase().trim();
    return p || DEFAULT_PROGRAM;
  }

  /**
   * Seed `program` onto park-ref entries that lack it, preserving one the
   * operator already has. Used at every point a ref is entered and once at
   * settings load, so a value saved before this existed gets filled in.
   */
  function normalizeParkRefs(refs) {
    if (!Array.isArray(refs)) return [];
    var out = [];
    for (var i = 0; i < refs.length; i++) {
      var r = refs[i];
      if (!r || !r.ref) continue;
      var program = String(r.program || '').toUpperCase().trim() || inferParkProgram(r.ref);
      // Copy the entry rather than rebuilding it: the phone's
      // set-activator-park carries an `id` alongside ref/name, and rebuilding
      // from known fields would silently drop anything a caller added.
      var entry = {};
      for (var k in r) { if (Object.prototype.hasOwnProperty.call(r, k)) entry[k] = r[k]; }
      entry.ref = r.ref;
      entry.name = r.name || '';
      entry.program = program;
      out.push(entry);
    }
    return out;
  }

  /** The program of the primary (first) activation ref. */
  function primaryProgram(refs) {
    if (!Array.isArray(refs) || refs.length === 0) return DEFAULT_PROGRAM;
    return programOf(refs[0]);
  }

  /**
   * Every `{sig, ref}` the operator is activating under, primary refs first,
   * then cross-program references — with duplicates removed.
   *
   * The dedupe is load-bearing, not tidiness. Before this change a SOTA-primary
   * operator had to type the summit into the primary field (logged POTA —
   * wrong) AND the X-Ref SOTA slot (logged SOTA — right); their SOTA upload
   * worked *because* of that second record. The moment the primary starts
   * reporting SOTA, those two become the same record and the cross-product
   * emits it twice — and nothing downstream catches it, because
   * `_qsoDedupKey` deliberately includes `mySigInfo` so genuine multi-park
   * records survive.
   *
   * The operator's X-Ref input is deliberately NOT cleared to achieve this.
   * Silently emptying a field somebody typed is worse than filtering a
   * duplicate they cannot see.
   */
  function activationMyRefs(parkRefs, crossRefs) {
    var out = [];
    var seen = Object.create(null);
    function add(sig, ref) {
      if (!ref) return;
      var s = String(sig || DEFAULT_PROGRAM).toUpperCase().trim() || DEFAULT_PROGRAM;
      var key = s + '|' + String(ref).toUpperCase().trim();
      if (seen[key]) return;
      seen[key] = true;
      out.push({ sig: s, ref: ref });
    }
    if (Array.isArray(parkRefs)) {
      for (var i = 0; i < parkRefs.length; i++) {
        if (parkRefs[i] && parkRefs[i].ref) add(programOf(parkRefs[i]), parkRefs[i].ref);
      }
    }
    if (Array.isArray(crossRefs)) {
      for (var j = 0; j < crossRefs.length; j++) {
        if (crossRefs[j] && crossRefs[j].ref) add(crossRefs[j].program, crossRefs[j].ref);
      }
    }
    return out;
  }

  /** Canonical dedupe key for a (program, ref) pair. */
  function refKey(program, ref) {
    var p = String(program || DEFAULT_PROGRAM).toUpperCase().trim() || DEFAULT_PROGRAM;
    return p + '|' + String(ref == null ? '' : ref).toUpperCase().trim();
  }

  /**
   * The set of keys the PRIMARY refs already cover, so a caller looping over
   * cross-references separately can skip the ones that duplicate a primary.
   *
   * main.js keeps its two loops (primary refs, then cross-refs) because each
   * carries its own save origin and uuid handling; this gives them the same
   * dedupe `activationMyRefs` bakes in for the single-loop callers.
   */
  function myRefKeys(parkRefs) {
    var keys = new Set();
    if (!Array.isArray(parkRefs)) return keys;
    for (var i = 0; i < parkRefs.length; i++) {
      if (parkRefs[i] && parkRefs[i].ref) keys.add(refKey(programOf(parkRefs[i]), parkRefs[i].ref));
    }
    return keys;
  }

  return {
    DEFAULT_PROGRAM: DEFAULT_PROGRAM,
    inferParkProgram: inferParkProgram,
    programOf: programOf,
    normalizeParkRefs: normalizeParkRefs,
    primaryProgram: primaryProgram,
    activationMyRefs: activationMyRefs,
    refKey: refKey,
    myRefKeys: myRefKeys,
  };
});
