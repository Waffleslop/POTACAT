'use strict';
// One contact → the ADIF records it becomes. The single definition of what a
// logged contact turns into, so no log surface can disagree with another.
//
// Every surface used to build its records itself, and they drifted: the Log
// QSO window logged "K1A,K1B,K1C" as one callsign (W9TEF), wrote the
// activator's QRZ home state for a park contact (W9TEF), JTCAT auto-log and
// the WSJT-X bridge forwarded every multi-park copy of one contact to the
// external logbook/QRZ/Club Log, ECHOCAT Web re-spotted once per operator of
// a multi-op activation, the web log sheet wrote "US-1,US-2" as POTA_REF on
// both records of a two-fer, and so on (logging parity audit, 2026-10-19).
//
// The rules, in one place:
//   records   one per callsign × the other station's reference × this
//             station's activation reference (calls outermost, so each
//             operator's records stay together)
//   re-spot   only the very first record carries the re-spot flags
//   forward   each CALLSIGN is one physical QSO: its first record is sent to
//             the external logbook / QRZ / Club Log, the rest are not
//   identity  only the first record keeps a caller-supplied uuid
//   location  a contact AT a park is logged at the park: the park's state
//             (or the one the operator picked for a multi-state park) and
//             grid — never anyone's home QTH; a contact not at a park fills
//             only what the caller left blank, from that call's QRZ record
//   names     each callsign gets its own QRZ name/country; the caller's
//             values belong to the first callsign only
//   RST       defaulted by mode when the caller left it blank
//
// Pure: main.js resolves QRZ records, park records and the live activation
// (logContact), this decides the records, saveQsoRecord writes each one.

const { stripSigTag } = require('./log-comment');

/** Program → the record field that carries its reference (null = SIG/SIG_INFO only). */
const PROGRAM_REF_FIELD = Object.freeze({
  POTA: 'potaRef', SOTA: 'sotaRef', WWFF: 'wwffRef', LLOTA: 'llotaRef', WWBOTA: 'wwbotaRef', GMA: null, PARC: null,
});
const MY_REF_FIELDS = ['myPotaRef', 'mySotaRef', 'myWwffRef', 'myLlotaRef'];
const RESPOT_KEYS = ['respot', 'wwffRespot', 'wwffReference', 'llotaRespot', 'llotaReference',
  'wwbotaRespot', 'wwbotaReference', 'dxcRespot', 'gmaRespot', 'respotComment'];
// Fields a caller fills from a QRZ lookup — they describe ONE station.
const STATION_FIELDS = ['name', 'country', 'county', 'state', 'gridsquare'];

const PHONE = new Set(['SSB', 'USB', 'LSB', 'AM', 'FM', 'DV', 'FREEDV', 'DIGITALVOICE']);
const CW = new Set(['CW', 'CW-R', 'CWR']);

function splitList(v) {
  const list = Array.isArray(v) ? v : String(v == null ? '' : v).split(',');
  const out = [];
  for (const x of list) {
    const s = String(x == null ? '' : x).trim().toUpperCase();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * The RST an empty field gets: 59 phone, 599 CW, -00 for the digital modes
 * (what JTCAT and the mobile-device path have always written; "59" on an FT8
 * contact was the KW4N complaint).
 */
function defaultRst(mode) {
  const m = String(mode || '').toUpperCase();
  if (CW.has(m)) return '599';
  if (PHONE.has(m) || !m) return '59';
  return '-00';
}

/** UTC YYYYMMDD / HHMM for an instant (ms, ISO string or Date). */
function utcParts(at) {
  const d = at instanceof Date ? at : new Date(typeof at === 'number' ? at : Date.parse(at));
  if (!Number.isFinite(d.getTime())) return null;
  const iso = d.toISOString();
  return { qsoDate: iso.slice(0, 10).replace(/-/g, ''), timeOn: iso.slice(11, 16).replace(':', '') };
}

/**
 * The other station's references. Two caller shapes:
 *  - `hunted: [{sig, ref}]` (JTCAT/WSJT-X: may span programs; each record
 *    carries only its own program's ref field)
 *  - `sig` + `sigInfo` (the log forms: sigInfo may be a comma list of the
 *    primary program; other programs' *Ref fields ride along unchanged, as
 *    the Log QSO dialog has always written a POTA-primary + WWFF n-fer)
 */
function huntedRefs(entry) {
  if (Array.isArray(entry.hunted) && entry.hunted.length) {
    const out = [];
    for (const h of entry.hunted) {
      const sig = String((h && h.sig) || '').toUpperCase().trim();
      const ref = String((h && h.ref) || '').toUpperCase().trim();
      if (sig && ref && !out.some((o) => o.sig === sig && o.ref === ref)) out.push({ sig, ref, own: true });
    }
    return out;
  }
  const sig = String(entry.sig || '').toUpperCase().trim();
  if (!sig) return [];
  return splitList(entry.sigInfo).map((ref) => ({ sig, ref, own: false }));
}

function parkLocation(park, chosenState) {
  if (!park && !chosenState) return null;
  const states = park && Array.isArray(park.states) ? park.states : [];
  // The operator's pick only stands where it can be true: on an n-fer it
  // must not overwrite a single-state park with another park's state.
  const pick = chosenState && (!states.length || states.includes(chosenState)) ? chosenState : '';
  return {
    state: pick || (states.length === 1 ? states[0] : ''),
    gridsquare: (park && park.grid) || '',
  };
}

/**
 * The state the operator picked for one park. `parkState` is the ADIF STATE
 * value ("NJ"; "US-NJ" is accepted and trimmed to it), or one per park for an
 * n-fer across multi-state parks: "US-0001:NJ,US-0002:PA". A plain value
 * applies to every park that spans it (parkLocation checks).
 */
function parkStateFor(parkState, ref) {
  const raw = String(parkState || '').trim().toUpperCase();
  if (!raw) return '';
  const bare = (v) => { const t = v.trim(); const d = t.lastIndexOf('-'); return d >= 0 && !t.includes(':') ? t.slice(d + 1) : t; };
  if (!raw.includes(':')) return bare(raw);
  const want = String(ref || '').trim().toUpperCase();
  for (const part of raw.split(',')) {
    const i = part.lastIndexOf(':');
    if (i > 0 && part.slice(0, i).trim() === want) return bare(part.slice(i + 1));
  }
  return '';
}

/**
 * @param {object} entry  what the operator logged (qsoData field names);
 *                        callsign/sigInfo may be comma lists
 * @param {object} ctx
 *   myRefs:   [{sig, ref}] this station's activation refs ([] = none)
 *   callInfo: (call) => {name, country, county, state, grid} | null  (QRZ)
 *   parkInfo: (ref)  => {states: [..], grid} | null   (park DB / live spot)
 *   now:      ms, for a contact with no date/time
 * @returns {object[]} the records, in write order
 */
function expandContact(entry, ctx = {}) {
  const calls = splitList(entry.callsign);
  if (!calls.length) return [];
  const hunted = huntedRefs(entry);
  const myRefs = Array.isArray(ctx.myRefs) ? ctx.myRefs : [];
  const callInfo = typeof ctx.callInfo === 'function' ? ctx.callInfo : () => null;
  const parkInfo = typeof ctx.parkInfo === 'function' ? ctx.parkInfo : () => null;

  // One time for every record of the contact.
  const base = { ...entry };
  delete base.hunted;
  if (!base.qsoDate || !base.timeOn) {
    const t = utcParts(base.qsoAt != null ? base.qsoAt : (ctx.now || Date.now()));
    if (t) { base.qsoDate = base.qsoDate || t.qsoDate; base.timeOn = base.timeOn || t.timeOn; }
  }
  delete base.qsoAt;
  if (!base.rstSent) base.rstSent = defaultRst(base.mode);
  if (!base.rstRcvd) base.rstRcvd = defaultRst(base.mode);
  // The operator's own note: strip the auto [SIG ref] tags for every ref of
  // this contact, so record 2 never carries record 1's tag (saveQsoRecord
  // appends each record's own canonical tag).
  let note = String(base.comment || '');
  for (const h of hunted) note = stripSigTag(note, h.sig, h.ref);
  base.comment = note;

  const records = [];
  calls.forEach((call, ci) => {
    const info = callInfo(call) || {};
    const station = ci === 0
      ? Object.fromEntries(STATION_FIELDS.map((k) => [k, entry[k] || '']))
      : Object.fromEntries(STATION_FIELDS.map((k) => [k, '']));
    // QRZ fills what the caller (for callsign 1) left blank.
    if (!station.name && info.name) station.name = info.name;
    if (!station.country && info.country) station.country = info.country;
    const homeState = station.state || info.state || '';
    const homeCounty = station.county || (info.state && info.county ? `${info.state},${info.county}` : '');
    const homeGrid = station.gridsquare || info.grid || '';

    const huntList = hunted.length ? hunted : [null];
    huntList.forEach((h, hi) => {
      const rec = { ...base, callsign: call, name: station.name, country: station.country };
      if (h) {
        rec.sig = h.sig;
        rec.sigInfo = h.ref;
        if (h.own) for (const f of Object.values(PROGRAM_REF_FIELD)) if (f) delete rec[f];
        const field = PROGRAM_REF_FIELD[h.sig];
        if (field) rec[field] = h.ref;
        // At a park: the park's location, or none — never a home QTH. A
        // heard grid (FT8 decode, `gridHeard`) is where they really are.
        const loc = parkLocation(parkInfo(h.ref), parkStateFor(entry.parkState, h.ref));
        rec.state = loc ? loc.state : '';
        rec.county = '';
        rec.gridsquare = (entry.gridHeard && entry.gridsquare) || (loc && loc.gridsquare) || '';
      } else {
        rec.state = homeState;
        rec.county = homeCounty;
        rec.gridsquare = homeGrid;
      }
      delete rec.parkState;
      delete rec.gridHeard;

      const myList = myRefs.length ? myRefs : [null];
      myList.forEach((my, mi) => {
        const r = { ...rec };
        if (my) {
          for (const f of MY_REF_FIELDS) delete r[f];
          r.mySig = my.sig;
          r.mySigInfo = my.ref;
        }
        const firstOfCall = hi === 0 && mi === 0;
        if (records.length > 0) {
          for (const k of RESPOT_KEYS) delete r[k];
          delete r.uuid;
        }
        if (!firstOfCall) r.skipLogbookForward = true;
        records.push(r);
      });
    });
  });
  return records;
}

module.exports = { parkStateFor, expandContact, defaultRst, utcParts, splitList, huntedRefs, PROGRAM_REF_FIELD, RESPOT_KEYS };
