'use strict';
//
// The Elecraft K4's panadapter over the network (GitHub #396).
//
// What Elecraft documents (K4 Programmer's Reference rev. D5, 2025-04-23,
// "Streaming Data"): the K4 streams "dB/bin (for reproducing panadapter
// data)" over Ethernet, "data flows continuously" once connected, and
// "details on streaming data protocols are available on request". The byte
// layout is therefore not in Elecraft's public reference. The same reference
// documents the display commands that shape the stream: #SPN (span, 6000 to
// 368000 Hz), #FPS (1 to 30 frames a second), #REF (reference level).
//
// The layout below was learned from the open-source K4 client QK4
// (github.com/mikeg-dal/QK4, GPL-3.0: src/network/protocol.h,
// docs/k4-protocol-quirks.md sections 9 and 15, src/dsp/spectrumscale.h),
// whose author measured it on a K4D. The METHOD only: no QK4 code is copied
// here. Each field is stated as a fact about the wire, and the tests build
// frames from this description.
//
// The packet rides the K4's framed TCP session (lib/cat.js: FE FD FC FB,
// u32 BE length, payload, FB FC FD FE). A PAN payload (type 0x02):
//   byte  0      type (0x02 PAN; 0x03 MiniPAN has the same header)
//   byte  1      version
//   byte  2      sequence (wraps)
//   byte  3      pan type
//   byte  4      receiver: 0 = Main, 1 = Sub
//   bytes 5-6    u16 LE  number of bins that follow (1024 on a K4D)
//   bytes 7-10   reserved
//   bytes 11-18  i64 LE  centre frequency of the bins, Hz
//   bytes 19-22  i32 LE  width the bins cover, kHz: one of the radio's five
//                        tiers 24 / 48 / 96 / 192 / 384, chosen by the radio
//                        from the span (the span itself is narrower)
//   bytes 23-26  i32 LE  the radio's noise floor, tenths of a dBm
//   bytes 27..   one byte per bin, 1 dB per step: dBm = byte - 162
//                        (QK4's calibration against the radio's own SMH meter)
// In a MiniPAN (0x03) bytes 19-22 are the mini-pan's own span in kHz and
// bytes 23-26 are not a noise floor; its bytes are dBm = byte - 118.
//
// Not verified by a POTACAT owner yet: an owner's capture
// (k4-pan-frame.bin, saved by main.js on the first frame) settles every
// field. Pure: no I/O.

const TYPE_PAN = 0x02;
const TYPE_MINIPAN = 0x03;
const HEADER_BYTES = 27;
const TIERS_KHZ = [24, 48, 96, 192, 384];
const DBM_OFFSET = 162;          // PAN:     dBm = byte - 162
const MINIPAN_DBM_OFFSET = 118;  // MiniPAN: dBm = byte - 118
const OUT_BINS = 850;            // every POTACAT scope surface draws 850 levels

// The window POTACAT's 0..255 levels cover. The K4's own AutoRef keeps its
// REF near the noise (about -132 dBm in QK4's notes), S9 is -73 dBm. 110 dB
// puts the noise low and a very strong signal at the top. Published with the
// state as dbmMin/dbmMax, so the level scale reads true dBm.
const DBM_MIN = -150;
const DBM_MAX = -40;

/**
 * One PAN or MiniPAN payload (the bytes between the K4 frame's length and its
 * end marker), or null when it is not one or cannot be drawn.
 * Returns { type, mini, version, seq, panType, receiver, binCount, centerHz,
 *   spanHz, noiseFloorDbm, dbmOffset, bins } where bins is a view, not a copy.
 */
function parsePanPayload(payload) {
  if (!payload || payload.length < HEADER_BYTES + 1) return null;
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const type = buf[0];
  if (type !== TYPE_PAN && type !== TYPE_MINIPAN) return null;
  const mini = type === TYPE_MINIPAN;
  const declared = buf.readUInt16LE(5);
  const available = buf.length - HEADER_BYTES;
  // A PAN states its bin count; trust it only when the bytes are there.
  // A frame shorter than it says is cut, and is dropped.
  if (declared > available) return null;
  const binCount = declared > 0 ? declared : available;
  const centerHz = Number(buf.readBigInt64LE(11));
  const widthKhz = buf.readInt32LE(19);
  if (!(centerHz > 0) || !(widthKhz > 0) || widthKhz > 1000) return null;
  const nf = buf.readInt32LE(23);
  return {
    type, mini,
    version: buf[1],
    seq: buf[2],
    panType: buf[3],
    receiver: buf[4],
    binCount,
    centerHz,
    spanHz: widthKhz * 1000,
    tierKnown: !mini && TIERS_KHZ.includes(widthKhz),
    noiseFloorDbm: mini ? null : nf / 10,
    dbmOffset: mini ? MINIPAN_DBM_OFFSET : DBM_OFFSET,
    bins: buf.subarray(HEADER_BYTES, HEADER_BYTES + binCount),
  };
}

/** dBm of one raw bin byte. */
function binDbm(pan, b) { return b - pan.dbmOffset; }

/** A dBm as POTACAT's 0..255 level over [dbmMin, dbmMax]. */
function levelFor(dbm, dbmMin = DBM_MIN, dbmMax = DBM_MAX) {
  const v = Math.round(((dbm - dbmMin) / (dbmMax - dbmMin)) * 255);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * The scope frame every surface draws: 850 levels, each the PEAK of the K4
 * bins it covers (so a narrow carrier survives 1024 -> 850).
 */
function toScopeFrame(pan, { bins = OUT_BINS, seq = 0, dbmMin = DBM_MIN, dbmMax = DBM_MAX } = {}) {
  const wf1 = new Uint8Array(bins);
  const n = pan && pan.bins ? pan.bins.length : 0;
  if (n) {
    for (let x = 0; x < bins; x++) {
      const lo = Math.floor((x * n) / bins);
      const hi = Math.max(lo + 1, Math.floor(((x + 1) * n) / bins));
      let peak = 0;
      for (let i = lo; i < hi && i < n; i++) if (pan.bins[i] > peak) peak = pan.bins[i];
      wf1[x] = levelFor(binDbm(pan, peak), dbmMin, dbmMax);
    }
  }
  return { seq, kind: 0, wf1, aligned: true };
}

/**
 * Where the bins sit: the packet's own centre and width, whatever the dial
 * says (in CW the K4 offsets its display by the pitch; in its fixed modes the
 * dial moves inside the window). So the anchor is 'fixed': the axis is
 * exactly what the packet states.
 */
function axisFor(pan) {
  if (!pan) return null;
  return { anchor: 'fixed', centerHz: pan.centerHz, spanHz: pan.spanHz };
}

/** The median bin in dBm: a free check of the 162 offset against the radio's own noise floor. */
function medianDbm(pan) {
  if (!pan || !pan.bins || !pan.bins.length) return null;
  const s = Array.from(pan.bins).sort((a, b) => a - b);
  return binDbm(pan, s[s.length >> 1]);
}

/** One line for the log: what the first frame looked like. */
function describePan(pan) {
  if (!pan) return 'not a PAN frame';
  const med = medianDbm(pan);
  return `${pan.mini ? 'MiniPAN' : 'PAN'} v${pan.version}, ${pan.receiver === 0 ? 'Main' : pan.receiver === 1 ? 'Sub' : 'receiver ' + pan.receiver}, `
    + `${pan.binCount} bins, centre ${(pan.centerHz / 1e6).toFixed(6)} MHz, ${pan.spanHz / 1000} kHz wide`
    + (pan.mini ? '' : (pan.tierKnown ? ' (a known tier)' : ' (NOT one of the five known tiers)'))
    + (pan.noiseFloorDbm != null ? `, radio noise floor ${pan.noiseFloorDbm.toFixed(1)} dBm` : '')
    + (med != null ? `, median bin ${med} dBm` : '');
}

module.exports = {
  TYPE_PAN, TYPE_MINIPAN, HEADER_BYTES, TIERS_KHZ, DBM_OFFSET, MINIPAN_DBM_OFFSET, OUT_BINS, DBM_MIN, DBM_MAX,
  parsePanPayload, binDbm, levelFor, toScopeFrame, axisFor, medianDbm, describePan,
};
