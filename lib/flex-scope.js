// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// The Flex's OWN panadapter as POTACAT's band scope (Flex Direct only; Casey
// 2026-10-28). In Flex Direct POTACAT is the radio's GUI client and the pan
// the radio built for our slice is ours, so its FFT stream reaches the UDP
// port POTACAT already listens on; nothing of a SmartSDR is touched (SmartSDR
// is not running in that mode). Bound mode keeps the audio waterfall.
//
// Verified against a real FLEX-8600 on v4 (test/fixtures/flex-pan/8600-capture.txt):
//   VITA-49, 28-byte header, stream id = pan id (0x4000000x), packet class
//   0x8003 at byte 14; then a 12-byte payload header, all big-endian:
//     start_bin_index u16, num_bins u16, bin_size u16 (2), total_bins u16,
//     frame_index u32
//   then num_bins u16 bins, then a 4-byte trailer. A frame of 850 bins comes
//   as two packets (670 + 180). A bin is a Y PIXEL: 0 = max_dbm (top),
//   y_pixels-1 = min_dbm. The first frames after a resize carry junk, so a
//   frame with any bin outside 0..y_pixels-1 is dropped.
// Out: the same 850-level frames as lib/yaesu-scope.js (level 0..255, higher
// = stronger), so the pop-out, the JTCAT strip and ECHOCAT need nothing new.
'use strict';

const { EventEmitter } = require('events');

const PACKET_CLASS_FFT = 0x8003;
const HEADER_BYTES = 28;
const PAYLOAD_HEADER_BYTES = 12;
const BINS = 850;          // what POTACAT asks the radio for (= ScopeAxis.BINS)
const Y_PIXELS = 256;      // so a pixel maps 1:1 onto a 0..255 level

/** The `display pan set` that makes the radio stream what this module expects. */
function panSizeCommand(panId, fps = 15) {
  const f = Math.max(5, Math.min(30, Math.round(Number(fps) || 15)));
  return `display pan set ${panId} xpixels=${BINS} ypixels=${Y_PIXELS} fps=${f}`;
}

/** One VITA-49 FFT packet → { streamId, start, num, total, frame, bins } or null. */
function parseFftPacket(buf) {
  if (!buf || buf.length < HEADER_BYTES + PAYLOAD_HEADER_BYTES) return null;
  if ((buf[0] & 0xF8) !== 0x38) return null;
  if (buf.readUInt16BE(14) !== PACKET_CLASS_FFT) return null;
  const p = HEADER_BYTES;
  const start = buf.readUInt16BE(p);
  const num = buf.readUInt16BE(p + 2);
  const size = buf.readUInt16BE(p + 4);
  const total = buf.readUInt16BE(p + 6);
  const frame = buf.readUInt32BE(p + 8);
  if (size !== 2 || !num || !total || start + num > total) return null;
  if (p + PAYLOAD_HEADER_BYTES + num * 2 > buf.length) return null;
  const bins = new Uint16Array(num);
  for (let i = 0; i < num; i++) bins[i] = buf.readUInt16BE(p + PAYLOAD_HEADER_BYTES + i * 2);
  return { streamId: buf.readUInt32BE(4), start, num, total, frame, bins };
}

/** A pixel row (0 = top = strongest) → a 0..255 level (255 = strongest). */
function levelFromPixel(v, yPixels = Y_PIXELS) {
  const max = Math.max(1, yPixels - 1);
  return Math.max(0, Math.min(255, Math.round(255 - (v * 255) / max)));
}

/**
 * Reassembles packets into whole frames. Emits 'frame' { seq, kind: 0,
 * wf1: Uint8Array(total), aligned: true, total } — the lib/yaesu-scope.js
 * frame shape. A frame that never completes is replaced by the next.
 */
class PanFrameAssembler extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.yPixels = opts.yPixels || Y_PIXELS;
    this._frame = -1;
    this._buf = null;
    this._have = 0;
    this._bad = false;
    this.seq = 0;
    this.dropped = 0;
  }

  feed(pkt) {
    if (!pkt) return;
    if (pkt.frame !== this._frame || !this._buf || this._buf.length !== pkt.total) {
      this._frame = pkt.frame;
      this._buf = new Uint8Array(pkt.total);
      this._have = 0;
      this._bad = false;
    }
    for (let i = 0; i < pkt.num; i++) {
      const v = pkt.bins[i];
      if (v >= this.yPixels) this._bad = true;
      this._buf[pkt.start + i] = levelFromPixel(v, this.yPixels);
    }
    this._have += pkt.num;
    if (this._have < pkt.total) return;
    const wf1 = this._buf;
    const bad = this._bad;
    this._buf = null;
    this._frame = -1;
    if (bad) { this.dropped++; return; }
    this.seq = (this.seq + 1) >>> 0;
    this.emit('frame', { seq: this.seq, kind: 0, wf1, aligned: true, total: wf1.length });
  }
}

/** `display pan 0x40000000 center=14.100000 bandwidth=0.200000 ...` → geometry fields present. */
function parsePanGeometry(line) {
  const m = /\|display pan (0x[0-9A-Fa-f]+) (.+)$/.exec(String(line || ''));
  if (!m) return null;
  const out = { panId: m[1] };
  const get = (k) => {
    const mm = new RegExp('(?:^| )' + k + '=([^ ]+)').exec(m[2]);
    return mm ? mm[1] : null;
  };
  const center = parseFloat(get('center'));
  const bw = parseFloat(get('bandwidth'));
  if (Number.isFinite(center) && center > 0) out.centerHz = Math.round(center * 1e6);
  if (Number.isFinite(bw) && bw > 0) out.spanHz = Math.round(bw * 1e6);
  // The narrowest width the radio allows (1230 Hz on an 8600/v4): the digital view's zoom floor.
  const minBw = parseFloat(get('min_bw'));
  if (Number.isFinite(minBw) && minBw > 0) out.minSpanHz = Math.round(minBw * 1e6);
  const xp = parseInt(get('x_pixels'), 10);
  const yp = parseInt(get('y_pixels'), 10);
  if (Number.isFinite(xp)) out.xPixels = xp;
  if (Number.isFinite(yp)) out.yPixels = yp;
  const handle = get('client_handle');
  if (handle) out.clientHandle = handle.replace(/^0x/i, '').toUpperCase();
  // The pan's vertical scale: pixel 0 = max_dbm, the last row = min_dbm, so
  // after levelFromPixel a level of 255 is max_dbm and 0 is min_dbm.
  const lo = parseFloat(get('min_dbm'));
  const hi = parseFloat(get('max_dbm'));
  if (Number.isFinite(lo)) out.dbmMin = lo;
  if (Number.isFinite(hi)) out.dbmMax = hi;
  return Object.keys(out).length > 1 ? out : null;
}

/**
 * Keep the slice in view: the pan does not follow the dial, so when the dial
 * leaves the inner 90% of the pan, recentre it on the dial (Flex Direct: the
 * pan is ours). Returns the new centre in Hz, or null to leave it.
 */
function recentreFor(dialHz, centerHz, spanHz) {
  if (!(dialHz > 0) || !(centerHz > 0) || !(spanHz > 0)) return null;
  const half = (spanHz / 2) * 0.9;
  return Math.abs(dialHz - centerHz) > half ? dialHz : null;
}

// The zoom steps offered for a Flex pan (Hz, ascending). The radio clamps to
// what the pan accepts and reports the real bandwidth in its status.
const SPANS = [5000, 10000, 25000, 50000, 100000, 200000, 500000, 1000000];

/** The allowed span nearest to `hz` (a stored or asked-for value). */
function nearestSpan(hz, spans = SPANS) {
  const v = Number(hz);
  if (!Number.isFinite(v) || v <= 0) return null;
  let best = spans[0];
  for (const s of spans) if (Math.abs(s - v) < Math.abs(best - v)) best = s;
  return best;
}

module.exports = {
  PACKET_CLASS_FFT, BINS, Y_PIXELS, SPANS, nearestSpan,
  panSizeCommand, parseFftPacket, levelFromPixel, PanFrameAssembler, parsePanGeometry, recentreFor,
};
