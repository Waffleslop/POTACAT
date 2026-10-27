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
//
// Every activation goes this way, including one logged in the home grid
// square: a grid square can span two counties, and the home location's
// county is not the park's. Blank MY_GRIDSQUARE / MY_STATE are filled only by
// the caller's `fill` (the park database via lib/activation-station.js, which
// gives a state only for a single-state park). A US park batch still without
// a state, or any batch without a grid, is NOT uploaded: an incomplete
// station record at LoTW is permanent, a skipped batch is one fix away.
'use strict';

const { serializeAdifFields, ADIF_HEADER } = require('./adif-writer');

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

/** A US park (POTA US-xxxx / K-xxxx): LoTW credits US contacts by state. */
function needsState(ref) {
  return /^(US|K)-/i.test(ref);
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
 * @returns {{ home: object[], activations: object[] }}
 *   activation: { key, call, grid, state, ref, label, records, dateFrom, dateTo,
 *                 filled, skip }  — skip is a reason string or null
 */
function splitForLotw(qsos, opts = {}) {
  const home = [];
  const byKey = new Map();
  const fallbackCall = str(opts.myCallsign).toUpperCase();
  for (const q of qsos || []) {
    const ref = activationRef(q);
    if (!ref) {
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
    const call = (str(rec.STATION_CALLSIGN) || str(rec.OPERATOR) || fallbackCall).toUpperCase();
    const grid = str(rec.MY_GRIDSQUARE).toUpperCase();
    const state = str(rec.MY_STATE).toUpperCase();
    const county = str(rec.MY_CNTY);
    const key = `${call}|${grid}|${ref}|${state}|${county.toUpperCase()}`;
    let b = byKey.get(key);
    if (!b) {
      b = { key, call, grid, state, county, ref, records: [], dateFrom: '', dateTo: '', filled: 0, skip: null, label: '' };
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
    b.label = `${b.ref}${b.grid ? ' ' + b.grid : ''}${b.state ? ' ' + b.state : ''}${countyName ? ', ' + countyName : ''}${dates ? ` (${dates})` : ''}`;
    if (!b.call) b.skip = 'no station callsign on these QSOs';
    else if (!b.grid) b.skip = `no grid for ${b.ref}: the QSOs have no MY_GRIDSQUARE and the park is not in POTACAT's park list`;
    else if (needsState(b.ref) && !b.state) b.skip = `no state for ${b.ref}: the QSOs have no MY_STATE and the park list gives no single state`;
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

/** One batch as ADIF text for TQSL (the log itself is never rewritten here). */
function batchAdif(records) {
  let content = ADIF_HEADER;
  for (const q of records || []) content += '\n' + serializeAdifFields(q) + '\n';
  return content;
}

module.exports = { splitForLotw, activationRef, needsState, buildActivationTqslArgs, batchAdif };
