'use strict';

// Re-spot a hunted activator after a JTCAT contact (GitHub #351, DA2PK).
// Opt-in: settings.jtcatAutoRespot, off by default. The spot is public and
// goes out under the operator's callsign, so it is only planned when:
//   - the option is on;
//   - the contact was not a manual log (a manual log can carry no reports);
//   - the live spot list places the station at a POTA or WWFF park;
//   - nobody spotted them at that park on this band in the last 10 minutes
//     (every POTACAT hunter with the option on would otherwise add one spot
//     per contact).
// The flags are the ones the Log QSO window's re-spot box sets, so
// logContact / saveQsoRecord post the spot as they do for a phone contact.
//
// Pure: main supplies the settings, the spot list and the clock.

const { freqToBand } = require('./bands');
const JtcatParser = require('../renderer/jtcat-parser'); // dual-mode, pure

const FRESH_SPOT_MS = 10 * 60 * 1000;
const DEFAULT_TEMPLATE = '{rst} in {QTH} 73s {mycallsign} via POTACAT';
const SOURCE_FOR_SIG = { POTA: 'pota', WWFF: 'wwff' };

function spotAgeMs(spot, now) {
  if (!spot || !spot.spotTime) return null;
  const t = String(spot.spotTime);
  const ms = new Date(t.endsWith('Z') ? t : t + 'Z').getTime();
  return Number.isFinite(ms) ? now - ms : null;
}

function refsOf(value) {
  return String(value || '').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * The live spot of this station at this park on this band, under 10 minutes
 * old, or null. A merged spot (main.js dedupeCrossSource) keeps the other
 * program's reference as potaReference / wwffReference.
 */
function freshSpotOf(spots, call, sig, ref, band, now) {
  if (!Array.isArray(spots) || !call || !ref || !band) return null;
  const base = JtcatParser.normalizeCall(call);
  const source = SOURCE_FOR_SIG[sig];
  const want = String(ref).toUpperCase();
  for (const s of spots) {
    if (!s || JtcatParser.normalizeCall(s.callsign) !== base) continue;
    const atPark = (s.source === source && refsOf(s.reference).includes(want))
      || refsOf(s[source + 'Reference']).includes(want);
    if (!atPark) continue;
    const spotBand = s.band || freqToBand((parseFloat(s.frequency) || 0) / 1000) || '';
    if (String(spotBand).toLowerCase() !== String(band).toLowerCase()) continue;
    const age = spotAgeMs(s, now);
    if (age == null || age < 0 || age >= FRESH_SPOT_MS) continue;
    return { spot: s, ageMin: Math.floor(age / 60000) };
  }
  return null;
}

/**
 * What to re-spot after a hunted contact.
 * @returns {null | {pota, wwff, skipped: Array<{sig, ref, ageMin}>}}
 *   null when the option is off, the log is manual, or no POTA/WWFF park.
 *   pota / wwff: the ref to spot, or null (none, or skipped as fresh).
 */
function planAutoRespot({ settings, refs, manual, spots, callsign, band, now }) {
  const s = settings || {};
  if (s.jtcatAutoRespot !== true) return null;
  if (manual) return null;
  if (!Array.isArray(refs) || !refs.length) return null;
  const t = now != null ? now : Date.now();
  const plan = { pota: null, wwff: null, skipped: [] };
  for (const sig of ['POTA', 'WWFF']) {
    const r = refs.find((x) => x && x.sig === sig);
    if (!r) continue;
    const fresh = freshSpotOf(spots, callsign, sig, r.ref, band, t);
    if (fresh) plan.skipped.push({ sig, ref: r.ref, ageMin: fresh.ageMin });
    else plan[sig.toLowerCase()] = r.ref;
  }
  if (!plan.pota && !plan.wwff && !plan.skipped.length) return null;
  return plan;
}

function potaTemplate(s) { return (s && s.respotTemplate) || DEFAULT_TEMPLATE; }
function wwffTemplate(s) { return (s && (s.wwffRespotTemplate || s.respotTemplate)) || DEFAULT_TEMPLATE; }

/**
 * Set the re-spot flags on a JTCAT record. Only the first record of a contact
 * carries them (lib/qso-expand.js), so the POTA park goes first.
 * @returns {boolean} true when a spot was asked for
 */
function applyAutoRespot(qsoData, plan, settings) {
  if (!plan || (!plan.pota && !plan.wwff)) return false;
  if (plan.pota && Array.isArray(qsoData.hunted)) {
    qsoData.hunted.sort((a, b) => (b.sig === 'POTA') - (a.sig === 'POTA'));
  }
  if (plan.pota) {
    qsoData.respot = true;
    qsoData.respotComment = potaTemplate(settings);
  }
  if (plan.wwff) {
    qsoData.wwffRespot = true;
    qsoData.wwffReference = plan.wwff;
    if (plan.pota) qsoData.wwffRespotComment = wwffTemplate(settings);
    else qsoData.respotComment = wwffTemplate(settings);
  }
  return true;
}

module.exports = { planAutoRespot, applyAutoRespot, freshSpotOf, FRESH_SPOT_MS, DEFAULT_TEMPLATE };
