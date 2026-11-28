// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Per-activation LoTW upload: split the log into the HOME batch (signed with
// the operator's chosen TQSL Station Location, as before) and one batch per
// activation, each signed in TQSL's QTH update mode with NO Station Location
// (`-l "" -c CALL -f update`), so the station's grid and state come from the
// records alone. Signing an activation with the home location stamped the
// home grid, state and county onto a contact made in a park in another state,
// or TQSL refused it ("Station Location does not match QSO details": 32 of
// K3SBP's NY and portable contacts, 131 Fort Washington ones, 2026-10-17).
//
// Verified against TQSL 2.8.6 with a synthetic log signed to a file: the
// signed station record held exactly CALL, DXCC (from the certificate),
// GRIDSQUARE and US_STATE from MY_GRIDSQUARE / MY_STATE, nothing from any
// Station Location; a record with no MY_STATE was signed with no state.
// MY_CNTY "VA,Fairfax" is signed as US_COUNTY Fairfax (re-checked against
// TQSL 2.8.6, 2026-10-27; lib/station-county.js).
//
// Every activation goes this way, including one logged in the home grid
// square: a grid square can span two counties, and the home location's
// county is not the park's. Blank MY_GRIDSQUARE / MY_STATE are filled only by
// the caller's `fill` (the park database via lib/activation-station.js, which
// gives a state only for a single-state park). A US park batch still without
// a state, or any batch without a grid, is NOT uploaded: an incomplete
// station record at LoTW is permanent, a skipped batch is one fix away.
//
// A Guest Pass contact (APP_POTACAT_GUEST_PASS, #822) was made at the station
// that lent the radio, not at the guest's home: signing it with the guest's
// Station Location would put the guest's QTH on it at LoTW (or TQSL would
// refuse the home batch over the station's MY_GRIDSQUARE). It goes in its own
// batch the same way an activation does, signed from the records alone with
// the station's grid, state and county. One with no MY_GRIDSQUARE (a station
// on a POTACAT from before #822) is held back, never signed with the home.
//
// Three guards on every activation batch (#1136, an operator's full-log
// upload after moving from another logger, 2026-11-27):
//   - DXCC entity. With no Station Location TQSL takes the entity from the
//     certificate, and when it cannot (more than one certificate for the
//     call) every QSO fails "no valid callsign certificate ... in entity
//     -NONE-". The batch copy carries MY_DXCC from its state: 291 for the
//     lower 48 and DC, 6 for Alaska, 110 for Hawaii. One the record has is kept.
//   - County. An activation is signed with a county only when it is the one
//     the operator picked for that park (settings.parkCounties). Any other
//     county (one imported with the log, typed in, or picked before the pick
//     changed) is left off the batch copy: a missing county is harmless at
//     LoTW, a wrong one is permanent. Guest Pass contacts keep the county the
//     lending station stamped from its own pick.
//   - State. A batch whose state is not one the park lies in (a park in
//     Missouri signed as Tennessee) is held back and listed as not uploaded.
'use strict';

const { serializeAdifFields, ADIF_HEADER } = require('./adif-writer');
const { adifExportRecord } = require('./adif-mode');

const REF_FIELDS = ['MY_POTA_REF', 'MY_SIG_INFO', 'MY_SOTA_REF', 'MY_WWFF_REF'];

function str(v) { return v == null ? '' : String(v).trim(); }

/** The program reference that makes a record an activation record, or ''. */
function activationRef(q) {
  for (const f of REF_FIELDS) {
    const v = str(q && q[f]);
    if (v) return v.toUpperCase();
  }
  return '';
}

/** A contact made on a lent station (Guest Pass), as the station marked it. */
function isGuestPass(q) {
  return str(q && q.APP_POTACAT_GUEST_PASS) === '1';
}

/** A US park (POTA US-xxxx / K-xxxx): LoTW credits US contacts by state. */
function needsState(ref) {
  return /^(US|K)-/i.test(ref);
}

// ADIF Primary Administrative Subdivision codes of DXCC entity 291 (the
// lower 48 and DC), plus the two states that are entities of their own.
const US_291 = new Set(('AL AZ AR CA CO CT DE DC FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY').split(' '));

/** The DXCC entity a US MY_STATE implies: 291, 6 (AK), 110 (HI), or '' for anything else. */
function dxccForState(state) {
  const st = str(state).toUpperCase();
  if (st === 'AK') return '6';
  if (st === 'HI') return '110';
  return US_291.has(st) ? '291' : '';
}

/** The separate references in a ref field ("US-0001,US-0002" -> two). */
function refList(ref) {
  return str(ref).toUpperCase().split(',').map((r) => r.trim()).filter(Boolean);
}

/**
 * The record's county when it is the operator's pick for one of its parks,
 * as "ST,County" (the spelling of the pick); '' otherwise.
 * A bare county ("Dyer") takes its state from the record's MY_STATE.
 */
function pickedCounty(ref, state, county, parkCounty) {
  if (typeof parkCounty !== 'function') return '';
  const m = /^([A-Za-z]{2})\s*,\s*(.+)$/.exec(str(county));
  const cst = m ? m[1].toUpperCase() : str(state).toUpperCase();
  const cname = (m ? m[2] : str(county)).trim().toLowerCase();
  if (!cst || !cname) return '';
  for (const r of refList(ref)) {
    const pc = parkCounty(r);
    if (!pc || !str(pc.state) || !str(pc.county)) continue;
    if (str(pc.state).toUpperCase() === cst && str(pc.county).toLowerCase() === cname) return `${cst},${str(pc.county)}`;
  }
  return '';
}

/**
 * The states the park list puts the batch's parks in, or null when any of
 * them is unknown (then nothing can be said about the state).
 */
function parkStatesOf(ref, parkStates) {
  if (typeof parkStates !== 'function') return null;
  const all = new Set();
  for (const r of refList(ref)) {
    if (!needsState(r)) return null;
    const list = parkStates(r);
    if (!Array.isArray(list) || !list.length) return null;
    for (const st of list) if (str(st)) all.add(str(st).toUpperCase());
  }
  return all.size ? all : null;
}

function fmtDate(d) {
  const s = str(d);
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}

/**
 * @param {object[]} qsos  parseAllRawQsos records (not mutated)
 * @param {object} [opts]
 *   myCallsign  fallback station callsign
 *   fill(q)     -> { MY_GRIDSQUARE?, MY_STATE?, MY_CNTY? } for blanks it can fill from real data
 *   parkCounty(ref) -> { state, county } | null, the operator's county pick for a park
 *   parkStates(ref) -> ['MO'] etc., the states the park list puts a park in ([] or null: unknown)
 * @returns {{ home: object[], activations: object[] }}
 *   activation: { key, call, grid, state, ref, guestPass, label, records, dateFrom, dateTo,
 *                 filled, skip }  — skip is a reason string or null; a Guest Pass
 *                 batch has ref '' and guestPass true
 */
function splitForLotw(qsos, opts = {}) {
  const home = [];
  const byKey = new Map();
  const fallbackCall = str(opts.myCallsign).toUpperCase();
  for (const q of qsos || []) {
    const ref = activationRef(q);
    const guest = isGuestPass(q);
    if (!ref && !guest) {
      // The home batch is signed WITH the operator's TQSL Station Location,
      // which is the authority for the home QTH: a record's own MY_STATE /
      // MY_CNTY that disagreed with it would make TQSL refuse the whole
      // batch ("Station Location does not match QSO details"). Those fields
      // still reach every other logger; LoTW gets them from the location.
      const h = { ...q };
      delete h.MY_STATE;
      delete h.MY_CNTY;
      home.push(h);
      continue;
    }
    const rec = { ...q };
    let filled = false;
    if (typeof opts.fill === 'function') {
      const add = opts.fill(rec) || {};
      for (const k of ['MY_GRIDSQUARE', 'MY_STATE', 'MY_CNTY']) {
        if (!str(rec[k]) && str(add[k])) { rec[k] = str(add[k]); filled = true; }
      }
    }
    // County: only the operator's pick for this park (#1136).
    if (ref && !guest && str(rec.MY_CNTY)) {
      const picked = pickedCounty(ref, rec.MY_STATE, rec.MY_CNTY, opts.parkCounty);
      if (picked) rec.MY_CNTY = picked;
      else delete rec.MY_CNTY;
    }
    // DXCC entity from the state, so TQSL never has to guess it (#1136).
    if (!str(rec.MY_DXCC)) {
      const dxcc = dxccForState(rec.MY_STATE);
      if (dxcc) rec.MY_DXCC = dxcc;
    }
    const call = (str(rec.STATION_CALLSIGN) || str(rec.OPERATOR) || fallbackCall).toUpperCase();
    const grid = str(rec.MY_GRIDSQUARE).toUpperCase();
    const state = str(rec.MY_STATE).toUpperCase();
    const county = str(rec.MY_CNTY);
    const key = `${call}|${grid}|${ref}|${state}|${county.toUpperCase()}${guest ? '|GUEST' : ''}`;
    let b = byKey.get(key);
    if (!b) {
      b = { key, call, grid, state, county, ref, guestPass: guest, records: [], dateFrom: '', dateTo: '', filled: 0, skip: null, label: '' };
      byKey.set(key, b);
    }
    b.records.push(rec);
    if (filled) b.filled++;
    const d = str(rec.QSO_DATE);
    if (d && (!b.dateFrom || d < b.dateFrom)) b.dateFrom = d;
    if (d && (!b.dateTo || d > b.dateTo)) b.dateTo = d;
  }
  const activations = [...byKey.values()];
  for (const b of activations) {
    const dates = b.dateFrom === b.dateTo ? fmtDate(b.dateFrom) : `${fmtDate(b.dateFrom)} to ${fmtDate(b.dateTo)}`;
    const countyName = b.county ? b.county.replace(/^[A-Za-z]{2}\s*,\s*/, '') : '';
    b.label = `${b.ref || 'Guest Pass'}${b.grid ? ' ' + b.grid : ''}${b.state ? ' ' + b.state : ''}${countyName ? ', ' + countyName : ''}${dates ? ` (${dates})` : ''}`;
    if (!b.call) b.skip = 'no station callsign on these QSOs';
    else if (!b.grid && !b.ref) b.skip = 'no grid for these Guest Pass contacts: the station that lent the radio did not send where it is (an older POTACAT there); add its grid square to them to upload';
    else if (!b.grid) b.skip = `no grid for ${b.ref}: the QSOs have no MY_GRIDSQUARE and the park is not in POTACAT's park list`;
    else if (b.ref && needsState(b.ref) && !b.state) b.skip = `no state for ${b.ref}: the QSOs have no MY_STATE and the park list gives no single state`;
    else if (b.ref && b.state) {
      const states = parkStatesOf(b.ref, opts.parkStates);
      if (states && !states.has(b.state)) {
        b.skip = `state ${b.state} on these QSOs, but ${b.ref} is in ${[...states].join(' or ')}: correct MY_STATE in the log to upload them`;
      }
    }
  }
  activations.sort((x, y) => (x.dateFrom < y.dateFrom ? -1 : x.dateFrom > y.dateFrom ? 1 : x.key < y.key ? -1 : 1));
  return { home, activations };
}

/** argv for one activation batch: QTH update mode, no Station Location. */
function buildActivationTqslArgs({ call, adifPath, password }) {
  const args = ['-q', '-x', '-d', '-u', '-a', 'compliant', '-l', '', '-c', String(call || ''), '-f', 'update'];
  if (password) args.push('-p', String(password));
  args.push(String(adifPath || ''));
  return args;
}

/**
 * One batch as ADIF text for TQSL (the log itself is never rewritten here).
 * Each record goes out with the writer's MODE/SUBMODE (#381): a record logged
 * before FT4/FT2 were written as MFSK keeps MODE=FT4 / MODE=FT2 on disk, and
 * TQSL refuses MODE=FT2 ("Invalid MODE"), so the batch copy says MFSK/FT2.
 */
function batchAdif(records) {
  let content = ADIF_HEADER;
  for (const q of records || []) content += '\n' + serializeAdifFields(adifExportRecord(q)) + '\n';
  return content;
}

module.exports = { splitForLotw, activationRef, needsState, dxccForState, buildActivationTqslArgs, batchAdif };
