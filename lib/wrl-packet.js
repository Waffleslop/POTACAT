'use strict';

// N1MM-compatible ContactInfo packet for World Radio League's Cat Control.
//
// Extracted from main.js's sendWrlUdp so the packet BUILD is pure and testable
// and the sender is left with nothing but the UDP write. Three separate field
// bugs have landed in this one block (N3VD's dedup collapse, W7DB's missing
// STATE/SIG, W9TEF's numeric TX power), and every one of them was invisible
// until a station reported it, because a UDP send succeeds whether or not the
// packet was well-formed — or, in W9TEF's case, whether or not it was ever
// built.
//
// The load-bearing rule here is that EVERY value is coerced with String()
// before it is escaped. A QSO object reaches this module from a dozen upstream
// paths — the Log QSO pop-out, the in-window log dialog, JTCAT, the phone, the
// ADIF resend — and they do not agree on types: the pop-out sends `txPower` as
// a Number, the ADIF resend path (rawQsoToQsoData) sends the same field as a
// String. `escXml` used to call `.replace` on whatever it was handed, so a
// numeric power threw `str.replace is not a function` and the whole forward
// was lost, while "Resend to Logbook" on the identical contact worked — the
// exact asymmetry W9TEF reported on 1.10.16 through 1.10.18.

const { ensureSigTag } = require('./log-comment');

/**
 * XML-escape a value for the ContactInfo packet. Coerces non-strings — see the
 * module header: the callers genuinely do hand this numbers.
 * @returns {string}
 */
function escXml(value) {
  if (value == null || value === '') return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the N1MM `<contactinfo>` XML for one QSO.
 *
 * @param {object} qsoData - the QSO in saveQsoRecord's shape
 * @param {object} [opts]
 * @param {string} [opts.myCallsign] - settings.myCallsign fallback for mycall
 * @param {string} [opts.myGrid] - settings.grid fallback for my_gridsquare
 * @param {function} [opts.newId] - id source (tests inject a fixed one)
 * @returns {string} the complete XML document
 */
function buildWrlContactInfo(qsoData, opts = {}) {
  const q = qsoData || {};
  const str = (v) => (v == null ? '' : String(v));

  const call = str(q.callsign);
  const mycall = str(q.operator) || str(opts.myCallsign);
  const freqKhz = parseFloat(q.frequency) || 0;
  const rxfreq = Math.round(freqKhz * 100).toString(); // N1MM uses 10 Hz units
  const txfreq = rxfreq;
  const mode = (str(q.mode) || 'SSB').toUpperCase();
  const band = str(q.band).toUpperCase();
  const snt = str(q.rstSent) || '59';
  const rcv = str(q.rstRcvd) || '59';
  const dateStr = str(q.qsoDate);
  const timeStr = str(q.timeOn);
  // Keep real seconds when the QSO has them (ADIF TIME_ON is often HHMMSS).
  // Hardcoding :00 gave every same-minute QSO an identical timestamp, which
  // fed the WRL-side dedup below (N3VD: multi-op logging / resend only
  // landed the first QSO).
  const secStr = timeStr.length >= 6 ? timeStr.slice(4, 6) : '00';
  const ts = dateStr.length === 8 && timeStr.length >= 4
    ? `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)} ${timeStr.slice(0, 2)}:${timeStr.slice(2, 4)}:${secStr}`
    : new Date().toISOString().replace('T', ' ').slice(0, 19);
  // Unique contact ID, N1MM-shaped (32-hex GUID, no dashes). Real N1MM
  // packets always carry <ID>; listeners key dedup/replace on it. Without
  // one, WRL Cat Control falls back to fingerprinting — and two multi-op
  // QSOs logged in the same minute (same time/freq/band/mode/mycall, only
  // <call> differs) collapse to one, dropping every op after the first
  // (N3VD 2026-06-29). Reuse the QSO's stored UUID so a deliberate resend
  // of the same contact is still recognized as the same contact.
  const newId = opts.newId || (() => require('crypto').randomUUID());
  const contactId = str(q.uuid || newId()).replace(/-/g, '');
  // WRL Cat Control drops the ADIF-style sig/sig_info/pota_ref tags below
  // (confirmed by N3VD's WRL export 2026-07-03 — same drop W7DB saw with the
  // contest-pair tags), so the comment text is the ONLY channel that reliably
  // lands a park number in the WRL cloud log. Keep a short [SIG REF] tag in
  // this packet's comment even when `logCommentTags` is off — the operator's
  // own log keeps the clean comment; this is transport-local.
  const comment = ensureSigTag(q.comment,
    str(q.sig) || (q.potaRef ? 'POTA' : ''),
    str(q.sigInfo) || str(q.potaRef));
  const grid = str(q.gridsquare);
  const contestName = str(q.sig);
  const contestNr = str(q.sigInfo);
  // The base N1MM ContactInfo schema doesn't carry STATE / SIG / SIG_INFO
  // and only ships the contest pair (contestname / contestnr). WRL Cat
  // Control's listener doesn't translate those back to ADIF SIG / SIG_INFO
  // on the way to the cloud logbook, so POTA hunts had no SIG fields and
  // none of the QSOs carried STATE (W7DB report). Emit the ADIF-style
  // tags alongside the legacy ones — N1MM ignores unknown tags, and WRL
  // picks them up directly into the ADIF record. Only emit when we have
  // a value so we don't pollute the packet with empty elements.
  const adifField = (name, val) => (escXml(val) ? `  <${name}>${escXml(val)}</${name}>\n` : '');
  const stationCallsign = str(q.stationCallsign) || mycall;
  const myGridsquare = str(q.myGridsquare) || str(opts.myGrid);

  return `<?xml version="1.0" encoding="utf-8"?>\n<contactinfo>\n`
    + `  <app>POTACAT</app>\n`
    + `  <ID>${escXml(contactId)}</ID>\n`
    + `  <contestname>${escXml(contestName)}</contestname>\n`
    + `  <contestnr>${escXml(contestNr)}</contestnr>\n`
    + `  <timestamp>${escXml(ts)}</timestamp>\n`
    + `  <mycall>${escXml(mycall)}</mycall>\n`
    + `  <operator>${escXml(mycall)}</operator>\n`
    + `  <band>${escXml(band)}</band>\n`
    + `  <rxfreq>${rxfreq}</rxfreq>\n`
    + `  <txfreq>${txfreq}</txfreq>\n`
    + `  <call>${escXml(call)}</call>\n`
    + `  <mode>${escXml(mode)}</mode>\n`
    + `  <snt>${escXml(snt)}</snt>\n`
    + `  <rcv>${escXml(rcv)}</rcv>\n`
    + `  <gridsquare>${escXml(grid)}</gridsquare>\n`
    + adifField('state', q.state)
    + adifField('cnty', q.county)
    + adifField('country', q.country)
    + adifField('name', q.name)
    + adifField('sig', q.sig)
    + adifField('sig_info', q.sigInfo)
    + adifField('pota_ref', q.potaRef)
    + adifField('sota_ref', q.sotaRef)
    + adifField('wwff_ref', q.wwffRef)
    + adifField('tx_pwr', q.txPower)
    + adifField('station_callsign', stationCallsign)
    + adifField('my_gridsquare', myGridsquare)
    + adifField('my_sig', q.mySig)
    + adifField('my_sig_info', q.mySigInfo)
    + `  <comment>${escXml(comment)}</comment>\n`
    + `</contactinfo>\n`;
}

module.exports = { escXml, buildWrlContactInfo };
