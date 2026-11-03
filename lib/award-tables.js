'use strict';
/**
 * The Worked All States and DXCC tables for ECHOCAT (Casey 2026-10-24: "add
 * WAS DXCC tables next", phone parity with the desktop). Main builds the
 * rows here with the SAME rules the desktop views use, so a phone never
 * computes its own version of them:
 *
 * - WAS: renderer/was-view.js — WorkedRoster.matrix over US_STATES, the Mode
 *   select's scope (all = 'band', a family = 'band-mode' on a sample mode,
 *   anything else = 'band-exact'), "Count" worked | confirmed, 50 = the award.
 * - DXCC: renderer/app.js renderDxccMatrix — buildDxccData entities, the
 *   DXCC_MODE_GROUPS mode filter, a band filter, X / 100, "DXCC!" at 100, and
 *   the Challenge count over DXCC_CHALLENGE_BANDS (All Bands only). The
 *   desktop's DXCC data is every logged QSO (parseAdifFile confirmedOnly:
 *   false), so its cells are 'worked' — never claimed as confirmed here.
 *
 * test/award-tables-test.js holds these constants to app.js / was-view.js.
 */

const WorkedRoster = require('./worked-roster');

const DXCC_MODE_GROUPS = {
  phone: ['SSB', 'AM', 'FM', 'USB', 'LSB'],
  cw: ['CW'],
  digital: ['FT8', 'FT4', 'FT2', 'RTTY', 'PSK31', 'JT65', 'JT9', 'DATA', 'OLIVIA', 'MFSK'],
};
const DXCC_CHALLENGE_BANDS = ['160m', '80m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m'];
const MODES = ['all', 'phone', 'cw', 'digital'];
/** renderer/app.js DXCC_BANDS, verbatim (the DXCC matrix's column order). */
const DXCC_BANDS = ['2200m', '630m', '160m', '80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m', '4m', '2m', '70cm', '1.25m', '33cm', '23cm', '13cm', '9cm', '6cm', '3cm', '1.25cm'];

/** was-view.js scopeFor(), verbatim. */
function wasScopeFor(modeValue) {
  if (!modeValue || modeValue === 'all') return { scope: 'band', mode: '' };
  if (modeValue === 'phone' || modeValue === 'cw' || modeValue === 'digital') {
    const sample = modeValue === 'phone' ? 'SSB' : (modeValue === 'cw' ? 'CW' : 'FT8');
    return { scope: 'band-mode', mode: sample };
  }
  return { scope: 'band-exact', mode: String(modeValue).toUpperCase() };
}

/**
 * @param roster lib/worked-roster.js roster (main's workedRoster)
 * @param {{mode?: string, count?: 'worked'|'confirmed'}} opts
 */
function buildWasTable(roster, opts) {
  const o = opts || {};
  const sc = wasScopeFor(o.mode);
  const confirmedOnly = o.count === 'confirmed';
  const rows = WorkedRoster.matrix(roster || WorkedRoster.empty(), 'state', WorkedRoster.US_STATES, { scope: sc.scope, mode: sc.mode });
  let worked = 0, confirmed = 0;
  for (const r of rows) {
    if (r.overall !== 'none') worked++;
    if (r.overall === 'confirmed') confirmed++;
    r.done = confirmedOnly ? r.overall === 'confirmed' : r.overall !== 'none';
  }
  const n = confirmedOnly ? confirmed : worked;
  return {
    table: 'was',
    mode: o.mode || 'all',
    count: confirmedOnly ? 'confirmed' : 'worked',
    bands: WorkedRoster.BANDS.slice(),
    rows,
    summary: {
      worked, confirmed, total: rows.length, shown: n,
      // was-view.js: 'WAS!' at 50 confirmed; 'All 50 worked' when counting worked.
      award: confirmed >= 50 ? 'WAS!' : (worked >= 50 && !confirmedOnly ? 'All 50 worked' : ''),
    },
  };
}

/**
 * @param dxccData main's buildDxccData() result ({entities:[{name,prefix,continent,confirmed:{band:[modes]}}]})
 * @param {string[]} bands the desktop's DXCC_BANDS column order
 * @param {{mode?: string, band?: string}} opts
 */
function buildDxccTable(dxccData, bands, opts) {
  const o = opts || {};
  const group = o.mode && o.mode !== 'all' ? DXCC_MODE_GROUPS[o.mode] : null;
  const filter = group ? new Set(group) : null;
  const band = o.band && o.band !== 'all' ? o.band : 'all';
  const on = (ent, b) => {
    const modes = ent.confirmed && ent.confirmed[b];
    if (!modes || !modes.length) return false;
    return !filter || modes.some((m) => filter.has(m));
  };
  const rows = [];
  let count = 0, challenge = 0;
  for (const ent of (dxccData && dxccData.entities) || []) {
    const cells = {};
    let any = false;
    if (band === 'all') {
      for (const b of bands) {
        const w = on(ent, b);
        cells[b] = w ? 'worked' : 'none';
        if (w) {
          any = true;
          if (DXCC_CHALLENGE_BANDS.includes(b)) challenge++;
        }
      }
    } else {
      any = on(ent, band);
      cells[band] = any ? 'worked' : 'none';
    }
    if (any) count++;
    rows.push({ name: ent.name, prefix: ent.prefix || '', continent: ent.continent || '', cells, overall: any ? 'worked' : 'none', done: any });
  }
  return {
    table: 'dxcc',
    mode: o.mode || 'all',
    band,
    bands: band === 'all' ? bands.slice() : [band],
    rows,
    summary: {
      count, goal: 100, award: count >= 100 ? 'DXCC!' : '',
      challenge: band === 'all' ? challenge : null,
      empty: !(dxccData && dxccData.entities && dxccData.entities.length),
    },
  };
}

module.exports = { DXCC_MODE_GROUPS, DXCC_CHALLENGE_BANDS, DXCC_BANDS, MODES, wasScopeFor, buildWasTable, buildDxccTable };
