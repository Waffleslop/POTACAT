'use strict';
/**
 * What counts as DX (G4BFG + K3SBP, 2026-10-26). Pure, dual-mode.
 *
 * Default: a station in a different DXCC entity from mine ("if it ain't this
 * dirt, it's DX dirt" — Casey). Optional, per operator: a great-circle
 * distance, one for HF and one for 6 m and up (G4BFG: "2 m would be over 100
 * miles, HF over 2000"). A set distance replaces the entity rule for that band
 * group; blank or 0 keeps the entity rule. A spot with no known distance falls
 * back to the entity rule, so a set distance never makes a spot DX by guess.
 *
 * "DX" used to mean "came from the DX Cluster" (source 'dxc'), so a German
 * operator saw a Bulgarian cluster spot labelled DX and a far POTA activator
 * not. The cluster is now labelled Cluster and DX is this rule, on every source.
 */

/** 6 m and up are judged by the VHF distance (6 m DX behaves like 2 m, not 20 m). */
const VHF_FROM_KHZ = 50000;

function bandGroup(freqKhz) {
  const f = Number(freqKhz);
  return Number.isFinite(f) && f >= VHF_FROM_KHZ ? 'vhf' : 'hf';
}

/** A distance setting as positive miles, or 0 = use the entity rule. */
function limitMiles(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * @param {object} p
 * @param {string} [p.myEntity]     my DXCC entity name (cty.dat)
 * @param {string} [p.theirEntity]  the station's DXCC entity name
 * @param {number} [p.distanceMi]   great-circle miles, null when unknown
 * @param {number} [p.freqKhz]
 * @param {object} [opts] { hfMi, vhfMi } — 0/blank = entity rule
 * @returns {boolean}
 */
function isDx(p, opts) {
  const o = opts || {};
  const limit = limitMiles(bandGroup(p && p.freqKhz) === 'vhf' ? o.vhfMi : o.hfMi);
  const d = p ? Number(p.distanceMi) : NaN;
  if (limit > 0 && p && p.distanceMi != null && Number.isFinite(d)) return d > limit;
  const mine = p && p.myEntity ? String(p.myEntity) : '';
  const theirs = p && p.theirEntity ? String(p.theirEntity) : '';
  if (!mine || !theirs) return false; // unknown is never DX
  return mine !== theirs;
}

/** One line for a tooltip: why this spot is (or would be) DX. */
function describeRule(freqKhz, opts) {
  const o = opts || {};
  const group = bandGroup(freqKhz);
  const limit = limitMiles(group === 'vhf' ? o.vhfMi : o.hfMi);
  if (limit > 0) return `DX: farther than ${Math.round(limit)} mi on ${group === 'vhf' ? '6 m and up' : 'HF'}`;
  return 'DX: a different DXCC entity from yours';
}

const api = { VHF_FROM_KHZ, bandGroup, limitMiles, isDx, describeRule };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.DxRule = api;
