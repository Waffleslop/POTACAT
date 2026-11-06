'use strict';
/**
 * JTCAT Hunt filters and priority (plan docs/plan-jtcat-hunt-priorities.md,
 * approved by Casey 2026-11-05; UI reference: the Hunt filters mockup).
 * Pure: main.js and the clients call these, nothing here touches the radio.
 *
 *   - targets: several Hunt targets at once, a station matching ANY of them;
 *   - priority: Strongest (today's order), Farthest, Needed first;
 *   - "Never answer": calls and XX* prefixes, permanent until removed;
 *   - auto-skip: a call whose QSO gave up is skipped for 30 minutes;
 *   - the CQ DX / CQ <continent> rule (no setting): never answer a CQ DX
 *     from our own continent, nor a CQ NA/EU/... aimed at another continent;
 *   - the quiet-reason line, so nobody wonders why Hunt is quiet.
 *
 * Event-needed stations still go first in every priority, as before.
 */

const { gridToLatLon, haversineDistanceMiles } = require('./grid');

// Every target the Hunt picker offers, in the order the Filters panel lists them.
const HUNT_TARGETS = Object.freeze(['pota', 'sota', 'wanted-country', 'new-grid', 'dx', 'watchlist', 'wanted-state', 'chase', 'event', 'fd', 'all']);
const PRIORITIES = Object.freeze(['strongest', 'farthest', 'needed']);
const DEFAULT_PRIORITY = 'strongest';
const DEFAULT_AUTO_SKIP_MIN = 30;

/** A saved target list, cleaned: known targets only, no repeats. */
function normalizeTargets(list) {
  const out = [];
  for (const t of Array.isArray(list) ? list : []) {
    const k = String(t || '').trim();
    if (HUNT_TARGETS.includes(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * The targets a Hunt mode stands for: 'custom' = the saved list (or POTA when
 * the list is empty, so Custom never means "nothing"), anything else = itself.
 */
function targetsForMode(mode, savedTargets) {
  if (mode !== 'custom') return [mode];
  const t = normalizeTargets(savedTargets);
  return t.length ? t : ['pota'];
}

function normalizePriority(p) { return PRIORITIES.includes(p) ? p : DEFAULT_PRIORITY; }

/** Kilometres between two grids, or null when either is missing or invalid. */
function distanceKm(gridA, gridB) {
  const a = gridA && gridToLatLon(String(gridA));
  const b = gridB && gridToLatLon(String(gridB));
  if (!a || !b) return null;
  return Math.round(haversineDistanceMiles(a.lat, a.lon, b.lat, b.lon) * 1.609344);
}

const eventRank = (d) => (d && d.eventMatch && d.eventMatch.status !== 'worked') ? 1 : 0;
// A 0 dB caller is a real 0 dB, not a missing level.
const snr = (d) => (Number.isFinite(d && d.db) ? d.db : -99);
const neededRank = (d) => (d.newDxcc || d.wantedCountry) ? 2 : (d.newGrid ? 1 : 0);

/**
 * A sorted copy of the workable callers. Event-needed first (as before), then
 * the priority, then SNR. Farthest uses the CQ's grid against ours; a caller
 * with no grid sorts after every caller with one.
 */
function rankCallers(callers, { priority, myGrid } = {}) {
  const p = normalizePriority(priority);
  const km = new Map();
  const dist = (d) => {
    if (!km.has(d)) km.set(d, Number.isFinite(d.distanceKm) ? d.distanceKm : distanceKm(d.grid, myGrid));
    const v = km.get(d);
    return v == null ? -1 : v;
  };
  return (callers || []).slice().sort((a, b) => {
    const ev = eventRank(b) - eventRank(a);
    if (ev) return ev;
    if (p === 'farthest') { const d = dist(b) - dist(a); if (d) return d; }
    if (p === 'needed') { const n = neededRank(b) - neededRank(a); if (n) return n; }
    return snr(b) - snr(a);
  });
}

/** A call or "PREFIX*" entry, upper-case, or '' when it is not one. */
function normalizeIgnoreEntry(s) {
  const v = String(s || '').trim().toUpperCase();
  return /^[A-Z0-9/]{1,12}\*?$/.test(v) && /[A-Z0-9]/.test(v) ? v : '';
}

function normalizeIgnoreList(list) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    const v = normalizeIgnoreEntry(e);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Is this call on the Never answer list (exact call, or a prefix ending in *)? */
function isIgnored(call, list) {
  const c = String(call || '').toUpperCase();
  if (!c) return false;
  return (list || []).some((p) => {
    const e = String(p || '').toUpperCase();
    return e.endsWith('*') ? c.startsWith(e.slice(0, -1)) : c === e;
  });
}

/** Calls whose QSO gave up, skipped for a while (per band and mode). */
class AutoSkip {
  constructor() { this._m = new Map(); }
  _k(call, band, mode) { return `${String(call).toUpperCase()}|${band || ''}|${String(mode || '').toUpperCase()}`; }
  note(call, band, mode, now = Date.now()) { if (call) this._m.set(this._k(call, band, mode), now); }
  has(call, band, mode, minutes, now = Date.now()) {
    if (!(minutes > 0)) return false;
    const at = this._m.get(this._k(call, band, mode));
    if (at == null) return false;
    if (now - at >= minutes * 60000) { this._m.delete(this._k(call, band, mode)); return false; }
    return true;
  }
  clear() { this._m.clear(); }
}

const CQ_CONTINENTS = new Set(['NA', 'SA', 'EU', 'AF', 'AS', 'OC', 'AN']);

/** What a CQ is aimed at: 'DX', a continent code, or null for a plain CQ. */
function cqTarget(text) {
  const t = String(text || '').trim().toUpperCase().split(/\s+/);
  if (t[0] !== 'CQ' || t.length < 3) return null;
  if (t[1] === 'DX' || CQ_CONTINENTS.has(t[1])) return t[1];
  return null;
}

/**
 * The CQ DX / CQ <continent> rule (no setting): a CQ DX is not for a station
 * on the caller's own continent, and a CQ NA is only for North America. When
 * either continent is unknown, the CQ is answered as before.
 */
function cqAimedAtUs(text, callerContinent, myContinent) {
  const target = cqTarget(text);
  if (!target) return true;
  const mine = String(myContinent || '').toUpperCase();
  if (!mine) return true;
  if (target === 'DX') {
    const theirs = String(callerContinent || '').toUpperCase();
    return !theirs || theirs !== mine;
  }
  return target === mine;
}

/**
 * The status line: why Hunt answered nobody (or who it answers next).
 * @param {object} r { heard, below, worked, ignored, skipped, ownSlot, notTarget, notForUs, floor, next: {call, why} | null }
 */
function quietReasonText(r) {
  const parts = [`${r.heard || 0} CQ${r.heard === 1 ? '' : 's'} heard`];
  if (r.below) parts.push(`${r.below} below ${r.floor} dB`);
  if (r.worked) parts.push(`${r.worked} worked`);
  if (r.ignored) parts.push(`${r.ignored} ignored`);
  if (r.skipped) parts.push(`${r.skipped} skipped after a failed QSO`);
  if (r.ownSlot) parts.push(`${r.ownSlot} in our own TX slot`);
  if (r.notForUs) parts.push(`${r.notForUs} not calling us (CQ DX or another continent)`);
  if (r.notTarget) parts.push(`${r.notTarget} not a target`);
  const head = 'Hunt: ' + parts.join(', ');
  return r.next ? `${head} · answering ${r.next.call} next${r.next.why ? ` (${r.next.why})` : ''}` : `${head} · nobody to answer this period`;
}

/** Why the chosen caller came first, in a few words, for the status line. */
function nextWhy(d, priority) {
  if (eventRank(d)) return 'event station';
  const p = normalizePriority(priority);
  if (p === 'farthest' && Number.isFinite(d.distanceKm)) return `${d.distanceKm.toLocaleString('en-US')} km`;
  if (p === 'needed' && neededRank(d) === 2) return 'new country';
  if (p === 'needed' && neededRank(d) === 1) return 'new grid';
  return `${d.db} dB`;
}

module.exports = {
  HUNT_TARGETS, PRIORITIES, DEFAULT_PRIORITY, DEFAULT_AUTO_SKIP_MIN,
  normalizeTargets, targetsForMode, normalizePriority, distanceKm, rankCallers,
  normalizeIgnoreEntry, normalizeIgnoreList, isIgnored, AutoSkip,
  cqTarget, cqAimedAtUs, quietReasonText, nextWhy,
};
