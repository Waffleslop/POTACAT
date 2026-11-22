'use strict';
/**
 * One FreeDV station, one row (#742).
 *
 * FreeDV spots arrive from two feeds: PSKReporter (source 'pskr', mode only
 * "FREEDV") and FreeDV Reporter, qso.freedv.org (source 'freedv', mode with
 * the codec, e.g. "FREEDV-RADEV1"). Each feed dedupes only itself and the
 * cross-source dedupe in main.js skips both, so a station heard on both
 * showed twice. Here a PSKReporter FreeDV spot folds into the FreeDV Reporter
 * spot for the same call; the FreeDV Reporter spot survives because it
 * carries the codec (RADE vs 700E/1600), which the engine and badge need.
 *
 * The window is 2 kHz. FreeDV Reporter gives the station's own dial
 * frequency; PSKReporter gives the dial of whoever decoded it, rounded to
 * 0.1 kHz. A FreeDV/RADE signal is about 1.5 kHz wide, so a receiver that
 * decodes it sits within roughly 1 kHz of the sender's dial. 2 kHz covers
 * that with margin and is still less than the spacing of the FreeDV
 * calling frequencies, so the same call on another frequency or band (a
 * PSKReporter spot from earlier on 40 m, say) keeps its own row.
 */

const FREEDV_MERGE_WINDOW_KHZ = 2;

function isFreedvMode(mode) {
  return /^FREEDV/i.test(String(mode || ''));
}

function callKey(s) {
  return String((s && s.callsign) || '').toUpperCase();
}

/**
 * Returns a new list: every 'pskr' FreeDV spot that has a 'freedv' spot for
 * the same call within windowKhz is dropped, and that 'freedv' spot is
 * replaced by a copy tagged sources: ['freedv', 'pskr']. Inputs are not
 * mutated; everything else passes through in order.
 */
function mergeFreedvSpots(spots, windowKhz = FREEDV_MERGE_WINDOW_KHZ) {
  if (!Array.isArray(spots)) return [];
  const reporterByCall = new Map();
  for (const s of spots) {
    if (!s || s.source !== 'freedv') continue;
    const k = callKey(s);
    if (!k) continue;
    if (!reporterByCall.has(k)) reporterByCall.set(k, []);
    reporterByCall.get(k).push(s);
  }
  if (reporterByCall.size === 0) return spots.slice();

  const merged = new Set();
  const dropped = new Set();
  for (const s of spots) {
    if (!s || s.source !== 'pskr' || !isFreedvMode(s.mode)) continue;
    const twins = reporterByCall.get(callKey(s));
    if (!twins) continue;
    const f = parseFloat(s.frequency);
    if (!Number.isFinite(f)) continue;
    const twin = twins.find((r) => Math.abs((parseFloat(r.frequency) || 0) - f) <= windowKhz);
    if (!twin) continue;
    dropped.add(s);
    merged.add(twin);
  }

  const out = [];
  for (const s of spots) {
    if (dropped.has(s)) continue;
    if (merged.has(s)) {
      const sources = Array.isArray(s.sources) && s.sources.length ? s.sources.slice() : [s.source];
      if (!sources.includes('pskr')) sources.push('pskr');
      out.push({ ...s, sources });
    } else {
      out.push(s);
    }
  }
  return out;
}

/** The FreeDV Reporter list without that call (its 'remove' event). */
function dropFreedvStation(spots, callsign) {
  const list = Array.isArray(spots) ? spots : [];
  const k = String(callsign || '').toUpperCase();
  if (!k) return list.slice();
  return list.filter((s) => callKey(s) !== k);
}

module.exports = { FREEDV_MERGE_WINDOW_KHZ, isFreedvMode, mergeFreedvSpots, dropFreedvStation };
