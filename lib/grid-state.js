'use strict';
/**
 * Which US state (or Canadian province) an FT8 decode is from, with how sure
 * we are. Main-process only (reads assets/geo/grid-states.json, built by
 * scripts/build-geo-assets.js from Natural Earth). Plan:
 * docs/worked-states-countries-plan.md, decision 4.
 *
 * The grid comes first: a 4-character grid wholly inside one state is
 * CERTAIN; one that straddles lists its states. QRZ's home state is second,
 * and only resolves a straddle or stands in when there is no grid at all: a
 * station operating portable is where its grid says, not where QRZ says.
 * Hunt answers only a certain state, or a straddle whose every state is
 * wanted (Casey 2026-10-23); a QRZ-only guess is a badge, never a reply.
 */
const path = require('path');
const WorkedRoster = require('./worked-roster');

let TABLE = null;
function table() {
  if (!TABLE) {
    try { TABLE = require(path.join(__dirname, '..', 'assets', 'geo', 'grid-states.json')); }
    catch { TABLE = {}; }
  }
  return TABLE;
}

/** For tests: use another table. */
function _setTable(t) { TABLE = t; }

/**
 * @param {string} grid  4 (or more) character Maidenhead grid
 * @returns {{states: string[], certain: boolean, known: boolean}}
 *   known = the grid touches a tracked state at all
 */
function statesForGrid(grid) {
  const g = String(grid || '').trim().toUpperCase().slice(0, 4);
  if (!/^[A-R]{2}\d{2}$/.test(g)) return { states: [], certain: false, known: false };
  const states = table()[g];
  if (!states || !states.length) return { states: [], certain: false, known: false };
  return { states: states.slice(), certain: states.length === 1, known: true };
}

/**
 * The state for one decode.
 * @param {{grid?: string, qrzState?: string, entity?: string}} o
 *   entity = the cty.dat entity name of the call (United States, Alaska,
 *   Hawaii, Canada; anything else -> null)
 * @returns {null | {code: string, candidates: string[], certain: boolean, source: 'grid'|'grid+qrz'|'qrz'}}
 *   code is 'NJ', or 'NJ/PA' for an unresolved straddle.
 */
function stateForDecode(o) {
  const entity = String((o && o.entity) || '');
  if (!WorkedRoster.tracksEntity(entity)) return null;
  const validFor = (code) => WorkedRoster.stateKeys(entity, code).length > 0;
  const grid = String((o && o.grid) || '').trim().toUpperCase();
  const qrz = String((o && o.qrzState) || '').trim().toUpperCase();
  const qrzOk = qrz && validFor(qrz) ? qrz : '';

  if (grid) {
    const g = statesForGrid(grid);
    if (!g.known) return null; // a grid outside every tracked state: they are not in one, whatever QRZ says
    const candidates = g.states.filter(validFor);
    if (!candidates.length) return null; // the grid is in the other country (a VE call in CN88 is in BC, not WA)
    if (candidates.length === 1) return { code: candidates[0], candidates, certain: true, source: 'grid' };
    if (qrzOk && candidates.includes(qrzOk)) return { code: qrzOk, candidates: [qrzOk], certain: true, source: 'grid+qrz' };
    return { code: candidates.join('/'), candidates, certain: false, source: 'grid' };
  }
  if (qrzOk) return { code: qrzOk, candidates: [qrzOk], certain: false, source: 'qrz' };
  return null;
}

/** Hunt may answer: a certain state, or a straddle with every state wanted. Never a QRZ-only guess. */
function huntMayAnswer(state, isWantedFn) {
  if (!state || !state.candidates || !state.candidates.length) return false;
  if (state.source === 'qrz') return false;
  return state.candidates.every((c) => isWantedFn(c));
}

module.exports = { statesForGrid, stateForDecode, huntMayAnswer, _setTable };
