'use strict';
// The band scope's tight view for a digital mode (Casey 2026-10-30: "zoomed in
// tightly on the frequency, and ensure it's centered ... all activity inside
// the permissible bandwidth").
//
// A digital mode's signals sit in the AUDIO passband above the dial on USB
// (below it on LSB), not on the dial itself, so a scope centred on the dial
// shows them squeezed against one edge. The view centres on the decoder's
// window instead and zooms to just past its edges.
//
// Flex Direct only for now: the Flex takes any panadapter width down to its
// own min_bw (1230 Hz on an 8600/v4) and any centre. The FT-710 and the Icoms
// centre on the dial with fixed spans; an rtl_tcp SDR cannot zoom below
// 200 kHz.

// The audio window each mode decodes in, Hz above the dial.
const WINDOWS = {
  WSPR: { lo: 1400, hi: 1600 },        // WSPR's 200 Hz sub-band
  FT: { lo: 200, hi: 3000 },           // the FT8/FT4/FT2 decoder's candidate range (lib/ft8-worker.js)
};
const MARGIN_HZ = 100;                 // each side of the window
const FLEX_MIN_SPAN_HZ = 1230;         // 8600/v4 pan status min_bw=0.001230, when the radio has not said

/** The decode window for a JTCAT mode, or null for a mode with none. */
function windowFor(mode) {
  const m = String(mode || '').toUpperCase();
  if (!m) return null;
  if (m === 'WSPR') return WINDOWS.WSPR;
  if (m === 'FT8' || m === 'FT4' || m === 'FT2' || m === 'JTTY' || m === 'PSK31' || m === 'JS8') return WINDOWS.FT;
  return null;
}

/** Lower sideband (the window is below the dial). */
function isLowerSideband(rigMode) {
  const m = String(rigMode || '').toUpperCase();
  return m === 'LSB' || m === 'DIGL' || m === 'LSB-D' || m === 'PKTLSB' || m.startsWith('LSB-D');
}

/**
 * The view for a mode: { offsetHz, spanHz, window: { lo, hi } } with the
 * offset and window in Hz relative to the dial (negative on LSB), or null.
 *   mode       the JTCAT engine's mode (FT8, WSPR, ...)
 *   rigMode    the radio's mode (USB, DIGU, LSB ...), for the side
 *   minSpanHz  the radio's narrowest panadapter (Flex min_bw)
 */
function digitalView({ mode, rigMode, minSpanHz } = {}) {
  const w = windowFor(mode);
  if (!w) return null;
  const minSpan = Number(minSpanHz) > 0 ? Number(minSpanHz) : FLEX_MIN_SPAN_HZ;
  const sign = isLowerSideband(rigMode) ? -1 : 1;
  const centre = (w.lo + w.hi) / 2;
  const spanHz = Math.max(minSpan, (w.hi - w.lo) + 2 * MARGIN_HZ);
  const win = sign > 0 ? { lo: w.lo, hi: w.hi } : { lo: -w.hi, hi: -w.lo };
  return { offsetHz: sign * centre, spanHz, window: win };
}

/** One string per distinct view, to act only when it changes. */
function viewKey(v) {
  return v ? `${v.offsetHz}|${v.spanHz}|${v.window.lo}|${v.window.hi}` : '';
}

module.exports = { WINDOWS, MARGIN_HZ, FLEX_MIN_SPAN_HZ, windowFor, isLowerSideband, digitalView, viewKey };
