// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS 30 m listening: the receive filter, set and put back (#840; Casey
// 2026-11-21, "set the receive filter so 1450 to 1950 Hz is passed, and put
// the radio's own filter back when listening stops, the same way the 30 m
// beacon restores its transmit filter. Keep the warning for RIT.").
//
// 300 baud HF APRS sits at 1600 and 1800 Hz with about 150 Hz of sidebands, so
// the slice must pass 1450 to 1950 Hz (lib/aprs-listen.js HF_NEED_*). A
// FlexRadio slice left on a narrow DIGU filter (an FT8 or PSK filter) heard
// nothing while the window said Listening. Now, once the radio is on the APRS
// frequency, a filter that does not pass that range is widened just enough
// (its wider edge is kept), the window says so in one line, and the radio's
// own filter goes back when listening stops, pauses or yields to Winlink.
//
// Put back only when it is still POTACAT's: if the slice changed mode or the
// operator changed the filter while listening, their filter is left alone and
// the log says so (aprs-radio-return's rule, "a radio the operator moved since
// is left where they put it").
//
// RIT is never changed: a RIT offset is the operator's, and it only gets a
// sentence. Receive only: nothing here transmits.
//
// Flex only: POTACAT reads the slice's filter edges and sets them with
// `filt <slice> <lo> <hi>` (lib/smartsdr.js setSliceFilter). Any other radio
// keeps the warning from the digital filter width (lib/aprs-listen.js
// filterSentence), as before.
//
// Dual-mode is not needed: main only. Pure apart from the read/set/log deps.
'use strict';

const AprsListen = require('./aprs-listen');

const NEED_LO = AprsListen.HF_NEED_LO_HZ;   // 1450
const NEED_HI = AprsListen.HF_NEED_HI_HZ;   // 1950
/** Room beyond the need on each side when widening, so a filter skirt does not sit on a sideband. */
const MARGIN_HZ = 50;

function num(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * What to do with the slice's filter. `edges` {lo, hi} in Hz, as the radio
 * reports them. Returns:
 *   {action:'none', saved}             it already passes 1450 to 1950 Hz
 *   {action:'widen', saved, target}    set target, put saved back afterwards
 *   {action:'unknown'}                 no usable report (not upper sideband, no edges)
 */
function planRxFilter({ band, edges } = {}) {
  if (band !== '30m') return { action: 'none' };
  const lo = num(edges && edges.lo), hi = num(edges && edges.hi);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo) || hi <= 0) return { action: 'unknown' };
  const saved = { lo: Math.round(lo), hi: Math.round(hi) };
  if (saved.lo <= NEED_LO && saved.hi >= NEED_HI) return { action: 'none', saved };
  const target = { lo: Math.max(0, Math.min(saved.lo, NEED_LO - MARGIN_HZ)), hi: Math.max(saved.hi, NEED_HI + MARGIN_HZ) };
  return { action: 'widen', saved, target };
}

/** The one line the window shows after widening. */
function widenedSentence(saved, target) {
  return 'POTACAT widened your receive filter from ' + saved.lo + '-' + saved.hi + ' Hz to ' + target.lo + '-' + target.hi +
    ' Hz for APRS. It goes back when listening stops.';
}

/** One sentence when RIT is on with an offset, else ''. RIT is the operator's; POTACAT never changes it. */
function ritSentence({ band, ritOn, ritHz } = {}) {
  if (band !== '30m') return '';
  const on = ritOn === true || ritOn === 1 || ritOn === '1';
  const hz = Math.round(num(ritHz));
  if (!on || !Number.isFinite(hz) || hz === 0) return '';
  return 'RIT is on (' + (hz > 0 ? '+' : '') + hz + ' Hz), so your radio listens beside 10.1476 MHz. Turn RIT off to decode APRS.';
}

/**
 * The guard main keeps while listening on 30 m.
 * deps:
 *   read() -> {idx, lo, hi, mode, ritOn, ritHz} | null   the slice now (null: no Flex)
 *   set(idx, lo, hi)                                      send the filter (one command, both edges)
 *   log(line)
 */
function createRxFilterGuard(deps) {
  const d = deps || {};
  const log = typeof d.log === 'function' ? d.log : () => {};
  let held = null; // {idx, mode, saved, target}

  /** At a 30 m start, after the radio took the frequency. Returns {action, sentence, rit}. */
  function widen(band) {
    if (held) restore('a new start');
    const s = band === '30m' && typeof d.read === 'function' ? d.read() : null;
    if (!s) return { action: band === '30m' ? 'unknown' : 'none', sentence: '', rit: '' };
    const rit = ritSentence({ band, ritOn: s.ritOn, ritHz: s.ritHz });
    if (rit) log('the radio has RIT on (' + s.ritHz + ' Hz) while listening on 30 m; POTACAT leaves RIT alone');
    const plan = planRxFilter({ band, edges: { lo: s.lo, hi: s.hi } });
    if (plan.action !== 'widen') return { action: plan.action, sentence: '', rit };
    d.set(s.idx, plan.target.lo, plan.target.hi);
    held = { idx: s.idx, mode: String(s.mode || ''), saved: plan.saved, target: plan.target };
    log(`receive filter ${plan.saved.lo}-${plan.saved.hi} Hz widened to ${plan.target.lo}-${plan.target.hi} Hz for 30 m APRS; it goes back when listening stops`);
    return { action: 'widen', sentence: widenedSentence(plan.saved, plan.target), rit, saved: plan.saved, target: plan.target };
  }

  /** Listening stopped, paused, moved or yielded: the operator's filter goes back if it is still ours to put back. */
  function restore(why) {
    const h = held;
    held = null;
    if (!h) return { action: 'none' };
    const s = typeof d.read === 'function' ? d.read() : null;
    const put = `${h.saved.lo}-${h.saved.hi} Hz`;
    if (!s) { log(`the radio is not connected, so its receive filter could not be put back to ${put} (${why})`); return { action: 'not-connected' }; }
    if (s.idx !== h.idx) { log(`the slice changed, so its receive filter was not put back to ${put} (${why})`); return { action: 'left', reason: 'slice' }; }
    if (h.mode && s.mode && String(s.mode) !== h.mode) {
      log(`the slice is in ${s.mode} now, so the ${h.mode} receive filter was left at ${h.target.lo}-${h.target.hi} Hz, not put back to ${put} (${why})`);
      return { action: 'left', reason: 'mode' };
    }
    const lo = Math.round(num(s.lo)), hi = Math.round(num(s.hi));
    // Still the target, or still the saved edges (the status after our set has not arrived): ours to put back.
    const ours = (lo === h.target.lo && hi === h.target.hi) || (lo === h.saved.lo && hi === h.saved.hi);
    if (Number.isFinite(lo) && Number.isFinite(hi) && !ours) {
      log(`the receive filter was changed to ${lo}-${hi} Hz while listening, so it is left there, not put back to ${put} (${why})`);
      return { action: 'left', reason: 'changed' };
    }
    d.set(h.idx, h.saved.lo, h.saved.hi);
    log(`receive filter put back to ${put} (${why})`);
    return { action: 'restored', saved: h.saved };
  }

  return { widen, restore, get held() { return held ? { ...held } : null; } };
}

module.exports = { planRxFilter, widenedSentence, ritSentence, createRxFilterGuard, MARGIN_HZ };
