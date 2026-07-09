/**
 * JTCAT FT8/FT4 message parser — SHARED between the renderers (jtcat-popout.js,
 * app.js) and the main/test processes. Single source of truth for callsign
 * shape, base-call normalization, CQ parsing, and the next-reply-step
 * classifier. Replaces five hand-copied, divergent versions that drifted out
 * of sync and shipped the IU7RAL ("CQ POTA W1AW") and Casey ("K3SBP A1BCD
 * FN30" → grid instead of report) bugs. K3SBP 2026-06-10.
 *
 * Dual-mode: Node `require()` gets `module.exports`; the browser (loaded via a
 * plain <script> tag — the renderers have no require) gets a global
 * `window.JtcatParser`. No DOM or Node dependencies, so it is safe in both.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JtcatParser = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Token shaped like an FT8 callsign? Rejects grids (FN20), reports (-12,
  // R-05), acks (RR73/RRR/73/CQ/DE), CQ-modifiers (POTA/DX/NA/TEST — they are
  // letter-only), and numeric serials (075 — digit-only). A real call has
  // BOTH a letter and a digit, which is exactly what separates it from every
  // modifier token.
  function looksLikeCallsign(tok) {
    if (!tok || tok.length < 3 || tok.length > 11) return false;
    if (/^(CQ|DE|RR73|RRR|73|TU|TNX|QRZ)$/i.test(tok)) return false;
    if (/^R?[+-]\d{2}$/.test(tok)) return false;              // signal report
    if (/^[A-R]{2}\d{2}([A-X]{2})?$/i.test(tok)) return false; // grid 4 or 6
    if (!/[A-Z]/i.test(tok) || !/\d/.test(tok)) return false;
    return /^[A-Z0-9/]+$/i.test(tok);
  }

  // Reduce a callsign token to its base call for identity comparison. Strips a
  // hashed <...> wrapper and a portable affix, so "K3SBP/P", "DL/K3SBP", and
  // "<K3SBP>" all compare equal to "K3SBP". This is what makes "is this
  // addressed to me?" robust when the decode renders my call with a suffix.
  function normalizeCall(call) {
    if (!call) return '';
    var c = String(call).toUpperCase().replace(/[<>]/g, '');
    if (c.indexOf('/') >= 0) {
      var segs = c.split('/').filter(Boolean);
      // Prefer the longest segment that has both a letter and a digit (the
      // full call), e.g. DL/K3SBP -> K3SBP, K3SBP/P -> K3SBP.
      var best = '';
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        if (/[0-9]/.test(s) && /[A-Z]/.test(s) && s.length > best.length) best = s;
      }
      c = best || segs[0] || '';
    }
    return c;
  }

  // Remove a hashed-call <...> wrapper but keep portable affixes intact
  // ("<PJ4/K1ABC>" -> "PJ4/K1ABC"). Unlike normalizeCall this preserves the
  // full transmittable call — use it when building TX messages, use
  // normalizeCall only for identity comparison.
  function stripHashBrackets(tok) {
    return String(tok || '').replace(/^</, '').replace(/>$/, '');
  }

  // Can this call be packed as a standard 28-bit callsign (c28 basecall)?
  // Mirrors pack_basecall() in lib/ft8_native/ft8_lib/ft8/message.c: the call
  // is right-aligned into a 6-char cell with its (last) prefix digit forced to
  // position 3 — so 1x1/2x1 special-event calls (W1A, K2A) ARE standard, while
  // slash calls (PJ4/K1ABC, K3SBP/7) and displaced-digit/long calls (GB13COL,
  // YW18FIFA) are nonstandard and need <hash>/type-4 handling. A bare /P or /R
  // suffix rides a flag bit in standard messages, so it stays standard.
  function isStandardCall(call) {
    if (!call) return false;
    var c = stripHashBrackets(String(call).toUpperCase().trim());
    if (/\/[PR]$/.test(c)) c = c.slice(0, -2);
    if (!c || c.indexOf('/') >= 0) return false;
    if (/^3DA0[A-Z]{1,3}$/.test(c)) c = '3D0' + c.slice(4); // Eswatini rewrite
    else if (/^3X[A-Z][0-9A-Z]{0,4}$/.test(c)) c = 'Q' + c.slice(2); // Guinea rewrite
    // Two right-alignments: AB0XYZ (digit at index 2) or A0XYZ (digit at index 1)
    return /^[A-Z0-9]{2}[0-9][A-Z]{0,3}$/.test(c) ||
      (c.length >= 3 && /^[A-Z0-9][0-9][A-Z]{0,3}$/.test(c));
  }

  // Build a directed TX message applying WSJT-X's bracket rules when one call
  // is nonstandard (the 77-bit protocol can transmit only ONE call in full per
  // message — the other travels as a hash, displayed in <brackets>):
  //   - grid/report legs: type 1 with the NONSTANDARD call hashed
  //       "<GB13COL> K3SBP R-08"; a grid payload is dropped entirely (WSJT-X
  //       omits the locator in nonstandard QSOs — there's no room in type 4
  //       and hash-first type 1 is reserved for reports).
  //   - RRR/RR73/73 legs: type 4 with the nonstandard call in FULL (that's how
  //       cold listeners learn the hash), so the STANDARD call gets brackets:
  //       "GB13COL <K3SBP> RR73".
  //   - both standard: plain text (byte-identical to the legacy builders).
  //   - both nonstandard: null — unsupported pairing (WSJT-X refuses it too).
  function formatDirectedMsg(theirCall, myCall, payload) {
    var them = stripHashBrackets(String(theirCall || '').toUpperCase().trim());
    var mine = stripHashBrackets(String(myCall || '').toUpperCase().trim());
    var pay = String(payload == null ? '' : payload).toUpperCase().trim();
    if (!them || !mine) return null;
    var themStd = isStandardCall(them);
    var mineStd = isStandardCall(mine);
    if (themStd && mineStd) return (them + ' ' + mine + (pay ? ' ' + pay : ''));
    if (!themStd && !mineStd) return null;
    var isAck = /^(RRR|RR73|73)$/.test(pay);
    // No locator in nonstandard QSOs (checked only on non-ack legs: RR73
    // itself is grid-shaped — that's how the protocol encodes it).
    if (!isAck && GRID_RE.test(pay)) pay = '';
    if (isAck) {
      // Type 4: nonstandard call in full, standard call hashed
      return themStd
        ? '<' + them + '> ' + mine + ' ' + pay
        : them + ' <' + mine + '> ' + pay;
    }
    // Type 1: nonstandard call hashed, report (or nothing) in the payload slot
    return themStd
      ? them + ' <' + mine + '>' + (pay ? ' ' + pay : '')
      : '<' + them + '> ' + mine + (pay ? ' ' + pay : '');
  }

  function isCqText(text) {
    return (text || '').toUpperCase().indexOf('CQ ') === 0;
  }

  // CQ [MODIFIER]* CALL [GRID]. Scan for the first callsign-shaped token after
  // CQ. Handles directed/contest/event CQs with no grid ("CQ NA W1ABC", "CQ
  // POTA W1AW", "CQ TEST K1ABC"), numeric serials ("CQ 075 W1ABC FN42"), and
  // special-event calls. Mirrors main.js parseCqMessage (IU7RAL fix) which the
  // renderers never inherited. Falls back to position 1 if nothing is
  // callsign-shaped (e.g. a 5-letter special-event suffix after a modifier).
  function parseCq(text) {
    var parts = (text || '').toUpperCase().split(/\s+/).filter(Boolean);
    var callIdx = -1;
    for (var i = 1; i < parts.length; i++) {
      if (looksLikeCallsign(parts[i])) { callIdx = i; break; }
    }
    if (callIdx === -1) callIdx = 1;
    return { call: parts[callIdx] || '', grid: parts[callIdx + 1] || '' };
  }

  var GRID_RE = /^[A-R]{2}[0-9]{2}([A-X]{2})?$/i; // 4- or 6-char Maidenhead

  /**
   * Decide the next TX step from a decoded message + our callsign.
   * Returns { step, call, theirGrid?, theirReport? } or null when the message
   * isn't actionable (not a CQ, not addressed to us, not a tail-end).
   *
   * Steps: reply-cq | send-report | send-r-report | send-rr73 | send-73
   */
  function inferReplyStep(decode, myCall) {
    var text = ((decode && decode.text) || '').toUpperCase().trim();
    if (!text) return null;
    var parts = text.split(/\s+/);
    var me = normalizeCall(myCall);

    if (isCqText(text)) {
      var pc = parseCq(text);
      if (!pc.call) return null;
      return { step: 'reply-cq', call: pc.call, theirGrid: pc.grid };
    }

    // Addressed to us: <MYCALL> <THEIRCALL> <payload>. Compare on the base
    // call so a portable/hashed rendering of our own call still matches.
    // Their call may render hash-bracketed ("<GB13COL>") — strip for the
    // returned call (it feeds TX builders), and refuse an unresolved "<...>"
    // (we can't address a station whose full call we haven't copied yet).
    if (parts.length >= 2 && me && normalizeCall(parts[0]) === me && parts[1]) {
      var fromCall = stripHashBrackets(parts[1]);
      if (!looksLikeCallsign(fromCall)) return null;
      var payload = parts[2] || '';
      if (payload === 'RR73' || payload === 'RRR' || payload === '73') {
        return { step: 'send-73', call: fromCall };
      }
      var rRpt = payload.match(/^R([+-]\d{2})$/);            // their R+report -> RR73
      if (rRpt) return { step: 'send-rr73', call: fromCall, theirReport: rRpt[1] };
      var plainRpt = payload.match(/^([+-]\d{2})$/);          // their report  -> R+report
      if (plainRpt) return { step: 'send-r-report', call: fromCall, theirReport: plainRpt[1] };
      if (GRID_RE.test(payload)) {                            // their grid    -> report
        return { step: 'send-report', call: fromCall, theirGrid: payload };
      }
      return { step: 'reply-cq', call: fromCall };
    }

    // Tail-end / call-anyone: <TO> <FROM> <payload> where neither is us —
    // target the SENDER (FROM, right-hand call). WSJT-X behavior. Strip a
    // hash wrapper so a bracket-rendered sender is still tail-endable.
    var tailFrom = stripHashBrackets(parts[1] || '');
    if (parts.length >= 2 && parts[0] !== 'CQ' && normalizeCall(parts[0]) !== me &&
        tailFrom && normalizeCall(tailFrom) !== me && looksLikeCallsign(tailFrom)) {
      return { step: 'reply-cq', call: tailFrom };
    }

    return null;
  }

  return {
    looksLikeCallsign: looksLikeCallsign,
    normalizeCall: normalizeCall,
    stripHashBrackets: stripHashBrackets,
    isStandardCall: isStandardCall,
    formatDirectedMsg: formatDirectedMsg,
    isCqText: isCqText,
    parseCq: parseCq,
    inferReplyStep: inferReplyStep,
  };
});
