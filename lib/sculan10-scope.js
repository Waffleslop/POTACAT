'use strict';
/**
 * Yaesu SCU-LAN10 band scope (EXPERIMENTAL): the SCOPE channel's frames,
 * decoded only as far as the spec marks verified (SPEC.md "Scope Channel"):
 *
 *   - one 4096-byte body per sweep line, about 25 a second;
 *   - each byte is one amplitude, INVERTED: 0 = strongest, 255 = weakest
 *     (magnitude = 1 - raw/255), so POTACAT's level is 255 - raw;
 *   - the active spectrum ends at a "boundary marker", the first byte <= 1
 *     searched from byte 500 (a reference block averaging > 225 is the
 *     fallback); the marker is stable for a span and does not move with the
 *     dial;
 *   - "bin doubling": only the first marker/2 bytes are a usable spectrum
 *     line, read from byte 0 (found by trial on a live FTDX10, reason unknown);
 *   - bins map linearly across the radio's configured span.
 *
 * Everything past the marker (a reference block, a region centred on 128) is
 * NOT decoded: the spec says no working renderer has verified it.
 *
 * The frame is not forced into lib/yaesu-scope.js's FT-710 USB layout (850 + 850
 * inverted bins, FF 01 EE 01 tail): that is a different capture path and the
 * spec does not say the two match. describeFrame() reports whether a real
 * frame happens to carry that tail, so an owner's first report settles it.
 */

const FRAME_BYTES = 4096;   // every capture in the spec
const OUT_BINS = 850;       // what every scope client draws (the FT-710, Flex and SDR frames)
const SEARCH_FROM = 500;    // spec: skip strong signals at low bin indices
const SEARCH_TO = 3000;
const REF_BLOCK = 64;
const REF_AVG = 225;

/**
 * Where the active spectrum ends, by the spec's heuristic.
 * @returns {{ end: number, method: 'marker'|'reference'|'default' }}
 */
function findSpectrumEnd(raw) {
  const n = raw ? raw.length : 0;
  const to = Math.min(n, SEARCH_TO);
  for (let i = SEARCH_FROM; i < to; i++) if (raw[i] <= 1) return { end: i, method: 'marker' };
  for (let start = SEARCH_FROM; start < Math.min(n - REF_BLOCK, SEARCH_TO); start += REF_BLOCK) {
    let sum = 0;
    for (let i = start; i < start + REF_BLOCK; i++) sum += raw[i];
    if (sum / REF_BLOCK > REF_AVG) return { end: Math.max(100, start - 100), method: 'reference' };
  }
  return { end: Math.min(n, 2000), method: 'default' };
}

/**
 * The marker does not move for a given span, but a strong signal reads 0 or 1
 * too, and one landing between byte 500 and the marker would be taken for it
 * (the heuristic searches from 500 and the marker sits near 1700-1900). So:
 * once the same marker is found three frames running it is LOCKED, and a later
 * frame keeps it while that byte still reads <= 1. A span change moves the
 * marker; the old position then no longer reads <= 1 and the search runs again.
 *
 * Before the lock, the "doubled" half of the line makes this likely: if that
 * half repeats the line, every full-scale signal puts a 0 or 1 above byte 500,
 * and a steady carrier would be locked in as the marker. So a candidate that
 * the spec's observations confirm is preferred: a byte <= 1 FOLLOWED by the
 * reference block (the next 64 bytes average over 225; the spec saw ~233
 * right after the marker in every capture). No such byte: the spec's own
 * first-byte rule, unchanged.
 */
function findConfirmedMarker(raw) {
  // The spec's value table: 0 is the strongest signal, 1 is RESERVED for the
  // boundary marker. A full-scale signal reads 0, so a byte of exactly 1 is
  // the better candidate, and one with the reference block after it the best
  // (a noise floor near 225 can pass that average test too, so it only ranks
  // candidates, never invents one). Order: 1 + reference, then 1, then
  // 0 + reference; null leaves the spec's own first-byte rule.
  const n = raw ? raw.length : 0;
  const to = Math.min(n, SEARCH_TO);
  const refAfter = (i) => {
    if (i + REF_BLOCK >= n) return false;
    let sum = 0;
    for (let j = i + 1; j <= i + REF_BLOCK; j++) sum += raw[j];
    return sum / REF_BLOCK > REF_AVG;
  };
  let firstOne = null;
  for (let i = SEARCH_FROM; i < to; i++) {
    if (raw[i] !== 1) continue;
    if (refAfter(i)) return { end: i, method: 'marker+reference' };
    if (firstOne == null) firstOne = i;
  }
  if (firstOne != null) return { end: firstOne, method: 'marker' };
  for (let i = SEARCH_FROM; i < to; i++) if (raw[i] === 0 && refAfter(i)) return { end: i, method: 'marker+reference' };
  return null;
}

class MarkerTracker {
  constructor() { this.locked = null; this._cand = null; this._count = 0; }
  reset() { this.locked = null; this._cand = null; this._count = 0; }
  find(raw) {
    if (this.locked != null && this.locked < raw.length && raw[this.locked] <= 1) {
      return { end: this.locked, method: 'locked' };
    }
    if (this.locked != null) this.locked = null; // span changed (or the frame is odd): search again
    const r = findConfirmedMarker(raw) || findSpectrumEnd(raw);
    if (r.method === 'marker' || r.method === 'marker+reference') {
      if (r.end === this._cand) this._count++;
      else { this._cand = r.end; this._count = 1; }
      if (this._count >= 3) this.locked = r.end;
    } else { this._cand = null; this._count = 0; }
    return r;
  }
}

/**
 * Decode one frame body into the usable spectrum line.
 * @returns {{ end, method, usable, levels: Uint8Array }} levels: 0 weakest .. 255 strongest
 */
function decodeScopeFrame(raw, tracker) {
  const r = tracker ? tracker.find(raw) : findSpectrumEnd(raw);
  const usable = Math.max(0, Math.floor(r.end / 2));
  const levels = new Uint8Array(usable);
  for (let i = 0; i < usable; i++) levels[i] = 255 - raw[i];
  return { end: r.end, method: r.method, usable, levels };
}

/**
 * The usable line, stretched or squeezed to the 850 points every client draws.
 * Peak-hold when squeezing, so a narrow signal is never dropped between points.
 */
function toScopeFrame(levels, { bins = OUT_BINS, seq = 0 } = {}) {
  const wf1 = new Uint8Array(bins);
  const n = levels ? levels.length : 0;
  if (n) {
    for (let x = 0; x < bins; x++) {
      const a = Math.floor((x * n) / bins);
      const b = Math.max(a + 1, Math.floor(((x + 1) * n) / bins));
      let m = 0;
      for (let i = a; i < b && i < n; i++) if (levels[i] > m) m = levels[i];
      wf1[x] = m;
    }
  }
  return { seq, kind: 0, wf1, aligned: true };
}

/** Frequency of usable bin i, linear across the span centred on the dial. */
function binToHz(i, usable, centerHz, spanHz) {
  if (!(usable > 0) || !(spanHz > 0)) return null;
  return Math.round(centerHz - spanHz / 2 + ((i + 0.5) * spanHz) / usable);
}

/** One line for the log: what a tester's first frame looked like. */
const METHOD_WORDS = {
  marker: 'first byte <= 1 after 500',
  'marker+reference': 'first byte <= 1 after 500 with the reference block after it',
  reference: 'no marker; reference-block fallback',
  locked: 'locked',
  default: 'no marker or reference block; default',
};

function describeFrame(raw, decoded) {
  const d = decoded || decodeScopeFrame(raw, new MarkerTracker());
  const spec = findSpectrumEnd(raw);
  const active = Array.from(raw.subarray ? raw.subarray(0, d.usable) : raw.slice(0, d.usable)).sort((a, b) => a - b);
  const q = (p) => (active.length ? active[Math.min(active.length - 1, Math.floor(p * active.length))] : '-');
  const ft710Tail = raw.length === FRAME_BYTES && raw[FRAME_BYTES - 4] === 0xFF && raw[FRAME_BYTES - 3] === 0x01 && raw[FRAME_BYTES - 2] === 0xEE && raw[FRAME_BYTES - 1] === 0x01;
  return `${raw.length} bytes${raw.length !== FRAME_BYTES ? ` (the spec says ${FRAME_BYTES})` : ''}; `
    + `boundary marker at byte ${d.end} (${METHOD_WORDS[d.method] || d.method})${spec.end !== d.end ? `; the spec's first-byte rule alone would stop at byte ${spec.end}` : ''}, `
    + `${d.usable} usable bins; raw min/median/max ${q(0)}/${q(0.5)}/${q(0.999)}; `
    + `FT-710 USB tail FF 01 EE 01: ${ft710Tail ? 'yes' : 'no'}`;
}

/**
 * A frame built the way the spec describes one, for tests and the fake unit:
 * `levels` (0 weakest .. 255 strongest) as the line at bytes 0..n-1, the same
 * line again at n..2n-1 (the doubling; its true content is unknown), the
 * marker at 2n, a reference block (233) after it, then a region centred on
 * 128, then zero padding.
 */
function buildSpecFrame(levels, { length = FRAME_BYTES, refBytes = 400, refValue = 233, secondaryBytes = 600, secondHalf = 'copy' } = {}) {
  const n = levels.length;
  const buf = Buffer.alloc(length, 0);
  for (let i = 0; i < n; i++) {
    // A byte of 0 or 1 inside the line would read as the marker; a real
    // radio has the same problem (see MarkerTracker), the fixture avoids it
    // unless a test asks for it by passing 254/255 levels.
    buf[i] = 255 - levels[i];
    buf[n + i] = secondHalf === 'copy' ? 255 - levels[i] : 220; // 'floor': noise, for tests that need the half quiet
  }
  const marker = 2 * n;
  if (marker < length) buf[marker] = 1;
  let p = marker + 1;
  for (let i = 0; i < refBytes && p < length; i++) buf[p++] = refValue;
  for (let i = 0; i < secondaryBytes && p < length; i++) buf[p++] = 128 + ((i * 7) % 9) - 4;
  return buf;
}

module.exports = {
  FRAME_BYTES, OUT_BINS, SEARCH_FROM,
  findSpectrumEnd, findConfirmedMarker, MarkerTracker, decodeScopeFrame, toScopeFrame, binToHz, describeFrame, buildSpecFrame,
};
