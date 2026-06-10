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
    if (parts.length >= 2 && me && normalizeCall(parts[0]) === me && parts[1]) {
      var fromCall = parts[1];
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
    // target the SENDER (FROM, right-hand call). WSJT-X behavior.
    if (parts.length >= 2 && parts[0] !== 'CQ' && normalizeCall(parts[0]) !== me &&
        parts[1] && normalizeCall(parts[1]) !== me && looksLikeCallsign(parts[1])) {
      return { step: 'reply-cq', call: parts[1] };
    }

    return null;
  }

  return {
    looksLikeCallsign: looksLikeCallsign,
    normalizeCall: normalizeCall,
    isCqText: isCqText,
    parseCq: parseCq,
    inferReplyStep: inferReplyStep,
  };
});
