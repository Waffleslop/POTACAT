'use strict';

// COMMENT-field tag handling for logged QSOs. POTACAT auto-injects an OTA
// reference tag into COMMENT from several upstream points — the desktop
// renderer and the phone-log path both add a short `[SIG SIG_INFO]` (leading on
// phone, trailing on desktop), and saveQsoRecord appends the fuller
// `[SIG REF locationDesc name]`. KE4EST wants a toggle to keep COMMENT exactly
// what the operator typed; SIG/SIG_INFO/POTA_REF stay populated regardless.
//
// saveQsoRecord uses these to be the single authority: strip whatever short/full
// tag arrived, then (only when tags are enabled) re-append the canonical one.
// This also fixes the phone-path double-tag — the old trailing-only strip left a
// leading `[POTA US-1234]` in place, so injector 2 produced
// `[POTA US-1234] note [POTA US-1234 US-GA Name]`.

/**
 * Strip an auto-injected `[SIG SIG_INFO …]` tag from a comment — leading,
 * trailing, or repeated. Matched precisely to this QSO's own sig + sigInfo so a
 * user's own bracketed note (`[fixed station]`) is left untouched. Matches both
 * the short `[POTA US-1234]` and the fuller `[POTA US-1234 US-GA Park Name]`.
 * @returns {string} the trimmed remainder
 */
function stripSigTag(comment, sig, sigInfo) {
  const base = String(comment == null ? '' : comment);
  if (!sig || !sigInfo) return base.trim();
  const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\s*\\[${esc(sig)}\\s+${esc(sigInfo)}[^\\]]*\\]`, 'gi');
  return base.replace(re, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Append a bracket tag to a base comment (space-joined; tag-only if base empty).
 * @returns {string}
 */
function appendTag(base, tag) {
  const b = String(base == null ? '' : base).trim();
  const t = String(tag == null ? '' : tag).trim();
  if (!t) return b;
  return b ? `${b} ${t}` : t;
}

module.exports = { stripSigTag, appendTag };
