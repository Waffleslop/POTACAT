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

  // The station's own callsign out of a compound one — what QRZ indexes and
  // what a lookup or a QRZ link must use (N0KAH 2026-10-14: "M/NT6B" opened
  // qrz.com/db/M, because every caller took the text before the first "/").
  // A segment counts as a callsign when it has a digit AND ends in a letter
  // (K1ABC, VP2E); a pure prefix ends in its digit (KH6, VE3, DL) or has no
  // digit (M, F), and a suffix is short (P, QRP, 8, MM). Longest callsign
  // segment wins, so a prefix that also looks like a call (VP2E/K1ABC) still
  // yields K1ABC; with none, the old normalizeCall rule; then the first piece.
  //   M/NT6B -> NT6B   NT6B/P -> NT6B   KH6/K1A -> K1A   DL/K3SBP/P -> K3SBP
  function baseCall(call) {
    var c = String(call || '').toUpperCase().replace(/[<>]/g, '').trim();
    if (c.indexOf('/') < 0) return c;
    var segs = c.split('/').filter(Boolean);
    var best = '';
    for (var i = 0; i < segs.length; i++) {
      if (/[0-9]/.test(segs[i]) && /[A-Z]$/.test(segs[i]) && segs[i].length > best.length) best = segs[i];
    }
    return best || normalizeCall(c);
  }

  // Is this decode addressed to (or from) my call? Compares every token as a
  // base call, so a compound call matches in all the forms a decode carries:
  // "<K9CYT/8> W1ABC -10" (report legs hash a nonstandard call), "K9CYT/8"
  // in full (type-4 legs) and plain "K9CYT". The surfaces used to look for
  // " K9CYT/8 " with spaces round it, which the brackets defeat (K9CYT 10/12).
  function isAddressedTo(text, myCall) {
    var me = normalizeCall(myCall);
    if (!me) return false;
    var toks = String(text || '').toUpperCase().split(/\s+/);
    for (var i = 0; i < toks.length; i++) {
      if (toks[i] && normalizeCall(toks[i]) === me) return true;
    }
    return false;
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
      // A hash-bracketed call ("CQ <SP9ABC/P> KO02") is a call the decoder
      // resolved from its hash — answerable once the brackets come off. Left
      // on, they reached the TX builders as part of the callsign and the
      // reply never keyed (LZ3AW 2026-09-18: "TX can't be initiated by
      // clicking on it"). An UNRESOLVED "<...>" is refused: we cannot
      // address a station whose call we have not copied.
      if (looksLikeCallsign(stripHashBrackets(parts[i]))) { callIdx = i; break; }
    }
    if (callIdx === -1) callIdx = 1;
    var call = stripHashBrackets(parts[callIdx] || '');
    if (/^\.+$/.test(call)) call = '';
    return { call: call, grid: parts[callIdx + 1] || '' };
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
    var me = normalizeCall(myCall);
    // Compound message (DXpedition / multi-answer): "K3SBP RR73; AI5MM
    // <AF0E> -14" — two QSOs in one transmission, the sender named only in
    // the second half. Rebuild OUR half as "<ME> <SENDER> <payload>" and
    // classify that; a compound with no half for us is not actionable.
    if (text.indexOf(';') >= 0) {
      var segs = text.split(';').map(function(s) { return s.trim(); }).filter(Boolean);
      if (segs.length !== 2 || !me) return null;
      var mine = null;
      for (var si = 0; si < segs.length; si++) {
        if (normalizeCall(segs[si].split(/\s+/)[0]) === me) { mine = segs[si]; break; }
      }
      var sender = (segs[1].split(/\s+/)[1] || '');
      if (!mine) {
        // Not to us: the operator wants to CALL the station sending it — a
        // Fox working two hounds at once (K3SBP 2026-10-18, "<P4/WE9V>").
        // fox:true tells main to call as a Hound (above 1000 Hz, base call).
        var foxCall = stripHashBrackets(sender);
        if (!looksLikeCallsign(foxCall) || normalizeCall(foxCall) === me) return null;
        return { step: 'reply-cq', call: foxCall, fox: true };
      }
      var mineParts = mine.split(/\s+/);
      var rebuilt = mineParts.length === 2
        ? mineParts[0] + ' ' + sender + ' ' + mineParts[1]   // "K3SBP RR73" + sender
        : mine;                                              // "K3SBP <AF0E> -14" already names them
      return inferReplyStep({ text: rebuilt }, myCall);
    }
    var parts = text.split(/\s+/);

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

  /**
   * Spot Target trigger classifier (2026-07-17): clicking an FT8/FT4 spot in
   * the desktop table arms a target callsign; the decode watcher fires the
   * auto-call ONLY at a polite opening — the target's own CQ, or the target
   * ending a QSO with someone else (their RR73/RRR/73 = classic tail-end;
   * they're listening next cycle). Mid-QSO payloads (grid, report, R-report,
   * bare two-call) deliberately do NOT trigger; they still reveal slot parity,
   * which the watcher records separately for the manual "Call now" button.
   *
   * Returns { trigger: 'cq' | 'tail', call } or null. `call` is the
   * AS-TRANSMITTED call from the decode (portable/full form) because the TX
   * builders must address what's actually on the air — the spot string may
   * differ (spot "W1ABC", on-air "W1ABC/P"). Identity comparison uses
   * normalizeCall so those still match.
   */
  function classifySpotTargetTrigger(text, targetCall, myCall) {
    var t = String(text || '').toUpperCase().trim();
    var target = normalizeCall(targetCall);
    if (!t || !target) return null;
    if (isCqText(t)) {
      var pc = parseCq(t);
      if (pc.call && normalizeCall(pc.call) === target) {
        return { trigger: 'cq', call: stripHashBrackets(pc.call) };
      }
      return null;
    }
    // Tail-end: "ADDRESSEE SENDER RR73|RRR|73" — the SENDER is token 2.
    var parts = t.split(/\s+/);
    if (parts.length < 3) return null;
    var from = stripHashBrackets(parts[1]);
    if (!looksLikeCallsign(from) || normalizeCall(from) !== target) return null;
    // Addressed to US = an exchange with us already in flight (or a straggler)
    // — the direct-caller machinery owns that case, not the spot target.
    if (myCall && normalizeCall(parts[0]) === normalizeCall(myCall)) return null;
    if (/^(RR73|RRR|73)$/.test(parts[2] || '')) return { trigger: 'tail', call: from };
    return null;
  }

  return {
    looksLikeCallsign: looksLikeCallsign,
    normalizeCall: normalizeCall,
    baseCall: baseCall,
    stripHashBrackets: stripHashBrackets,
    isAddressedTo: isAddressedTo,
    isStandardCall: isStandardCall,
    formatDirectedMsg: formatDirectedMsg,
    isCqText: isCqText,
    parseCq: parseCq,
    inferReplyStep: inferReplyStep,
    classifySpotTargetTrigger: classifySpotTargetTrigger,
  };
});
