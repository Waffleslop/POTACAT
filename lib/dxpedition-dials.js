'use strict';
// DXpedition dials in the JTCAT window's band menu (level_death 2026-10-31).
// The DXpedition feed (worker/dxpeditions, `freqs`) carries the FT8/FT4
// dials an operation announces ("FT8 (F/H) on 14.090"); this picks the ones
// worth offering now: DXpeditions (never a contest station or a home-call
// alias) that are on the air today, or recently announced with no dates.
// Pure; main.js hands the list to the JTCAT window.

const BANDS = [['160m', 1800, 2000], ['80m', 3500, 4000], ['60m', 5330, 5410], ['40m', 7000, 7300], ['30m', 10100, 10150],
  ['20m', 14000, 14350], ['17m', 18068, 18168], ['15m', 21000, 21450], ['12m', 24890, 24990], ['10m', 28000, 29700], ['6m', 50000, 54000]];
const NO_DATES_DAYS = 21;

function bandOf(khz) {
  const b = BANDS.find(([, lo, hi]) => khz >= lo && khz <= hi);
  return b ? b[0] : '';
}

function onAir(rec, nowMs) {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const start = rec.start || '';
  const end = rec.end || '';
  if (start && start > today) return false;
  if (end && end < today) return false;
  if (start || end) return true;
  const seen = Number(rec.firstSeen) || Date.parse(rec.publishedAt || '') || 0;
  return seen > 0 && nowMs - seen <= NO_DATES_DAYS * 86400000;
}

/**
 * @param {object[]} records  feed records
 * @param {{now?: number}} [o]
 * @returns {{call, entity, mode, khz, band, hound, superFox, end}[]} by frequency
 */
function jtcatDxpeditionDials(records, o = {}) {
  const now = o.now || Date.now();
  const out = [];
  const seen = new Set();
  for (const r of records || []) {
    if (!r || !r.call || r.kind === 'contest' || r.aliasOf || !Array.isArray(r.freqs) || !r.freqs.length) continue;
    if (!onAir(r, now)) continue;
    for (const f of r.freqs) {
      const khz = Number(f && f.khz);
      const mode = String(f && f.mode || '').toUpperCase();
      if (!(khz > 0) || (mode !== 'FT8' && mode !== 'FT4')) continue;
      const band = bandOf(khz);
      if (!band) continue;
      const call = String(r.call).toUpperCase();
      const key = `${call}|${mode}|${khz}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ call, entity: r.entity || '', mode, khz, band, hound: !!f.hound, superFox: !!f.superFox, end: r.end || '' });
    }
  }
  return out.sort((a, b) => a.khz - b.khz || a.call.localeCompare(b.call));
}

module.exports = { jtcatDxpeditionDials, bandOf };
