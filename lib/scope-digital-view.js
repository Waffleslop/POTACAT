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
const MARGIN_HZ = 100;                 // each side of the window, the least the view shows
const SLACK_HZ = 50;                   // asked for on top of the margin, so a radio that rounds the width down still shows it
const FLEX_MIN_SPAN_HZ = 1230;         // 8600/v4 pan status min_bw=0.001230, when the radio has not said
const SETTLE_MS = 600;                 // a pan status this long after our ask is the radio's answer, not a stale line
const CENTRE_TOLERANCE_HZ = 50;        // a reported centre this close to the ask: the radio did as asked
const MAX_SPAN_ASKS = 3;               // widen the pan at most this many times per view
const WINLINK_SPAN_HZ = 6000;          // the Winlink view's width (Casey 2026-11-15: about 6 kHz, room either side of a 2.4 kHz channel)
const AUDIO_SPAN_HZ = 3000;            // lib/winlink-spectrum.js SPAN_HZ: markerBand's fractions are of 0 to 3000 Hz audio

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
  const spanHz = Math.max(minSpan, (w.hi - w.lo) + 2 * (MARGIN_HZ + SLACK_HZ));
  const win = sign > 0 ? { lo: w.lo, hi: w.hi } : { lo: -w.hi, hi: -w.lo };
  return { offsetHz: sign * centre, spanHz, window: win };
}

/** An FM mode: the modem's audio is not offset from the dial, so there is no channel to centre on. */
function isFmRigMode(rigMode) {
  const m = String(rigMode || '').toUpperCase();
  return m === 'FM' || m === 'NFM' || m === 'DFM' || m === 'FMN' || m === 'WFM' || m.startsWith('FM-');
}

/**
 * The Flex slice's data offset for the rig mode, Hz: digu_offset on DIGU,
 * digl_offset on DIGL (slice status keys), 0 on any other mode or when the
 * slice has not said. SmartSDR shows a DIGU/DIGL slice that many Hz from its
 * suppressed carrier, so an audio tone lands that much lower (DIGU) or
 * higher (DIGL) than dial + audio.
 */
function flexDigOffsetHz(rigMode, sliceKv) {
  const m = String(rigMode || '').toUpperCase();
  const kv = sliceKv || {};
  const key = m === 'DIGU' ? 'digu_offset' : m === 'DIGL' ? 'digl_offset' : '';
  const v = key ? Number(kv[key]) : 0;
  return Number.isFinite(v) ? Math.round(v) : 0;
}

/**
 * The Winlink view (ECHOCAT's ask, 2026-11-15): the pan centred on the
 * modem's channel at its RF position and WINLINK_SPAN_HZ wide, so the channel
 * sits in the middle with room either side for a neighbour or noise.
 *   band         lib/winlink-spectrum.js markerBand(mode, bw): {lo, hi} as fractions of 0 to 3000 Hz audio
 *   rigMode      USB/DIGU: above the dial; LSB/DIGL: below; FM: no view (null)
 *   digOffsetHz  flexDigOffsetHz(): the slice's DIGU/DIGL offset, which moves where the audio lands
 *   minSpanHz    the radio's narrowest panadapter
 * Returns { kind: 'winlink', offsetHz, spanHz, window: {lo, hi} } relative to the dial, or null.
 */
function winlinkView({ band, rigMode, digOffsetHz, minSpanHz } = {}) {
  if (!band || !(Number(band.hi) > Number(band.lo))) return null;
  if (isFmRigMode(rigMode)) return null;
  const lo = Math.round(Number(band.lo) * AUDIO_SPAN_HZ);
  const hi = Math.round(Number(band.hi) * AUDIO_SPAN_HZ);
  const off = Number(digOffsetHz) || 0;
  const win = isLowerSideband(rigMode) ? { lo: off - hi, hi: off - lo } : { lo: lo - off, hi: hi - off };
  const minSpan = Number(minSpanHz) > 0 ? Number(minSpanHz) : FLEX_MIN_SPAN_HZ;
  const spanHz = Math.max(minSpan, WINLINK_SPAN_HZ, (win.hi - win.lo) + 2 * (MARGIN_HZ + SLACK_HZ));
  return { kind: 'winlink', offsetHz: Math.round((win.lo + win.hi) / 2), spanHz, window: win };
}

/**
 * Which view the pan takes. A running Winlink radio session has the radio,
 * so its view wins; then the JTCAT digital view as before; then a device
 * that asked for the Winlink view. 'winlink' | 'jtcat' | null.
 */
function pickView({ winlinkSession, jtcatWanted, winlinkAsked } = {}) {
  if (winlinkSession) return 'winlink';
  if (jtcatWanted) return 'jtcat';
  if (winlinkAsked) return 'winlink';
  return null;
}

/** One string per distinct view, to act only when it changes. */
function viewKey(v) {
  return v ? `${v.offsetHz}|${v.spanHz}|${v.window.lo}|${v.window.hi}` : '';
}

/**
 * Where the pan really is, Hz from the dial, from the centre the pan status
 * reports (`center=`). The axis follows this, not the centre we asked for: a
 * radio that rounds, clamps or ignores the ask would otherwise have every
 * surface draw the frames shifted.
 *   reportedCentreHz  the pan status centre
 *   ask               { hz, dial, at } the last centre we sent and the dial it was for
 *   dialHz            the live dial, used only when nothing was asked
 * The offset is taken against the ask's dial, so a status line that answers
 * an ask made 50 ms ago while the knob spins gives the same offset as the
 * next one (no flash). A centre far from a fresh ask is a line from before
 * it (a bandwidth echo carrying the old centre): null, hold the axis. Once
 * the ask is SETTLE_MS old, whatever the radio reports is where it put the
 * pan, near the ask or not.
 */
function panOffsetFromStatus({ reportedCentreHz, ask, dialHz, nowMs, settleMs = SETTLE_MS, toleranceHz = CENTRE_TOLERANCE_HZ } = {}) {
  const c = Number(reportedCentreHz);
  if (!(c > 0)) return null;
  if (ask && Number(ask.hz) > 0 && Number(ask.dial) > 0) {
    const near = Math.abs(c - ask.hz) <= toleranceHz;
    const settled = (Number(nowMs) || 0) - (Number(ask.at) || 0) >= settleMs;
    return near || settled ? Math.round(c - ask.dial) : null;
  }
  const d = Number(dialHz);
  return d > 0 ? Math.round(c - d) : null;
}

/**
 * Whether a pan of spanHz centred offsetHz from the dial shows the view's
 * whole decode window with at least marginHz either side, and if not, the
 * width to ask for (centred where the pan really is, plus the slack).
 */
function viewFit(view, { offsetHz, spanHz, marginHz = MARGIN_HZ } = {}) {
  if (!view || !view.window || !(Number(spanHz) > 0) || !Number.isFinite(Number(offsetHz))) return { fits: true, needSpanHz: 0 };
  const off = Number(offsetHz);
  const half = Math.max(view.window.hi + marginHz - off, off - (view.window.lo - marginHz));
  const fits = Number(spanHz) / 2 >= half - 1;   // 1 Hz: the status is in whole Hz
  return { fits, needSpanHz: fits ? 0 : Math.ceil((2 * half + 2 * SLACK_HZ) / 10) * 10 };
}

module.exports = {
  WINDOWS, MARGIN_HZ, SLACK_HZ, FLEX_MIN_SPAN_HZ, SETTLE_MS, CENTRE_TOLERANCE_HZ, MAX_SPAN_ASKS, WINLINK_SPAN_HZ,
  windowFor, isLowerSideband, digitalView, viewKey, panOffsetFromStatus, viewFit,
  isFmRigMode, flexDigOffsetHz, winlinkView, pickView,
};
