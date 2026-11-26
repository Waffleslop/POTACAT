'use strict';
// lib/sdrconnect-protocol.js — the SDRconnect WebSocket API, pure (no sockets).
//
// SDRconnect (SDRplay's receiver program, GUI or headless) serves a WebSocket
// API for other programs, by default on port 5454. Through it POTACAT reads an
// SDRplay nRSP-ST (a network receiver) or any SDRplay RSP that SDRconnect has
// open: spectrum bins for the band scope, demodulated 48 kHz audio for
// listening and JTCAT. POTACAT ships nothing of SDRplay's; this is our own
// code written from SDRplay's published document:
//   "SDRconnect WebSocket API 1.0.3" (PDF, 2026-06-15),
//   https://api.sdrplay.com/docs/SDRconnect_WebSocket_API.pdf
// Section names below refer to that document ("API 1.0.3, <section>").
//
// Points the document does not settle are marked UNCONFIRMED; the code reads
// them tolerantly so the first capture from a real receiver can confirm or
// correct them without a rewrite.

const DEFAULT_PORT = 5454;
const BINS = 850;              // the band scope's frame width (lib/sdr-scope.js BINS)
const AUDIO_RATE = 48000;      // API 1.0.3, Binary Messages: "Stereo Audio @ 48kHz (LRLR)"
const SUPPORTED_API_MAJOR = 1;

// API 1.0.3, Message Structure: every text frame is one JSON object
// { event_type, property, value, device? }, every value a string.
const EVENT = Object.freeze({
  // from SDRconnect
  PROPERTY_CHANGED: 'property_changed',
  GET_PROPERTY_RESPONSE: 'get_property_response',
  // from the client
  SET_PROPERTY: 'set_property',
  GET_PROPERTY: 'get_property',
  IQ_STREAM_ENABLE: 'iq_stream_enable',
  AUDIO_STREAM_ENABLE: 'audio_stream_enable',
  SPECTRUM_ENABLE: 'spectrum_enable',
  DEVICE_STREAM_ENABLE: 'device_stream_enable',
  SELECTED_DEVICE: 'selected_device',
  SELECTED_DEVICE_SERIAL: 'selected_device_serial',
  SELECTED_DEVICE_NAME: 'selected_device_name',
});

// API 1.0.3, "Valid property field values" (the ones POTACAT uses).
const PROP = Object.freeze({
  CENTER: 'device_center_frequency',   // Uint64 Hz, the hardware LO
  VFO: 'device_vfo_frequency',         // Uint64 Hz, the demodulator's frequency
  SAMPLE_RATE: 'device_sample_rate',   // Double Hz (writable)
  LNA: 'lna_state',                    // Uint32, the RF gain step
  LNA_MIN: 'lna_state_min',
  LNA_MAX: 'lna_state_max',
  BANDWIDTH: 'filter_bandwidth',       // Uint32 Hz
  DEMOD: 'demodulator',                // AM / USB / LSB / CW / SAM / NFM / WFM
  STARTED: 'started',
  CAN_CONTROL: 'can_control',
  AGC: 'agc_enable',                   // the AUDIO AGC (the API has no hardware AGC)
  VOLUME: 'audio_volume_percent',
  MUTE: 'audio_mute',
  SPECTRUM_TOP: 'spectrum_ref_level',  // Double dB, top of the spectrum display
  SPECTRUM_BOTTOM: 'spectrum_base',    // Double dB, bottom of the spectrum display
  SIGNAL_POWER: 'signal_power',        // Double dB
  VALID_DEVICES: 'valid_devices',      // comma-delimited display names
  ACTIVE_DEVICE: 'active_device',      // display name in use
  API_VERSION: 'api_version',          // String, e.g. "1.0.3"
});

/**
 * Binary frames: a 2-byte little-endian type, then the payload
 * (API 1.0.3, Binary Messages).
 * UNCONFIRMED: the type numbers. The document's table prints the numbers one
 * row below their descriptions; this reading (1 audio, 2 IQ, 3 spectrum,
 * 4-6 the same for a dual tuner's second channel) is the one two independent
 * third-party clients took. It is a table here so a capture can correct it.
 */
const BINARY_TYPES = Object.freeze({
  1: { kind: 'audio', device: 'primary' },
  2: { kind: 'iq', device: 'primary' },
  3: { kind: 'spectrum', device: 'primary' },
  4: { kind: 'audio', device: 'secondary' },
  5: { kind: 'iq', device: 'secondary' },
  6: { kind: 'spectrum', device: 'secondary' },
});

/** Every value travels as a string (API 1.0.3, Message Structure). */
function str(v) {
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (v == null) return '';
  return String(v);
}

/** One client message, as the JSON text frame SDRconnect expects. */
function buildMessage(eventType, property, value, device) {
  const m = { event_type: String(eventType), property: property == null ? '' : String(property), value: str(value) };
  if (device === 'primary' || device === 'secondary') m.device = device;
  return JSON.stringify(m);
}

/** A text frame from SDRconnect, or null when it is not one we can read. */
function parseText(text) {
  let o;
  try { o = typeof text === 'string' ? JSON.parse(text) : JSON.parse(String(text)); } catch { return null; }
  if (!o || typeof o !== 'object' || typeof o.event_type !== 'string') return null;
  return {
    eventType: o.event_type,
    property: o.property == null ? '' : String(o.property),
    // Tolerant: the document says strings, but a number or boolean reads the same.
    value: o.value == null ? '' : str(o.value),
    device: o.device === 'secondary' ? 'secondary' : 'primary',
  };
}

/**
 * A binary frame: { type, kind, device, payload } or null (shorter than its
 * type word). An unknown type comes back with kind 'unknown' so a caller can
 * count it. 16-bit payloads with an odd byte drop the dangling byte.
 */
function parseBinary(buf) {
  if (!buf || buf.length < 2) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const type = b.readUInt16LE(0);
  const t = BINARY_TYPES[type];
  let payload = b.subarray(2);
  if (!t) return { type, kind: 'unknown', device: 'primary', payload };
  if ((t.kind === 'audio' || t.kind === 'iq') && (payload.length & 1)) payload = payload.subarray(0, payload.length - 1);
  return { type, kind: t.kind, device: t.device, payload };
}

/** "true" / "1" / true -> true. Anything else false. */
function parseBool(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

/** A number from a string value, or null. */
function parseNum(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** valid_devices: a comma-delimited list of display names (API 1.0.3). */
function parseValidDevices(v) {
  return String(v == null ? '' : v).split(',').map((s) => s.trim()).filter(Boolean);
}

/** "1.0.3" -> { major: 1, minor: 0, patch: 3, text } or null. */
function parseApiVersion(v) {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i.exec(String(v == null ? '' : v));
  if (!m) return null;
  return { major: +m[1], minor: +(m[2] || 0), patch: +(m[3] || 0), text: String(v).trim() };
}

/** True when this client speaks the version SDRconnect reports (same major). */
function apiVersionSupported(v) {
  const p = typeof v === 'object' && v ? v : parseApiVersion(v);
  return !!(p && p.major === SUPPORTED_API_MAJOR);
}

/**
 * The demodulator and filter for a rig mode. SDRconnect's demodulators:
 * AM, USB, LSB, CW, SAM, NFM, WFM (API 1.0.3, property `demodulator`).
 * Data modes (FT8, DIGU, PKTUSB...) are USB with a 3 kHz filter.
 * opts.lo/hi (kHz, the JTCAT passband) set the width when given.
 */
function demodFor(rigMode, opts) {
  const m = String(rigMode || 'USB').toUpperCase().replace(/[^A-Z0-9]/g, '');
  let demodulator = 'USB';
  let bandwidthHz = 2700;
  if (m === 'LSB' || m === 'DIGL' || m === 'PKTLSB' || m === 'LSBD' || m === 'DATALSB') { demodulator = 'LSB'; }
  else if (m === 'CW' || m === 'CWR' || m === 'CWU' || m === 'CWL') { demodulator = 'CW'; bandwidthHz = 500; }
  else if (m === 'AM' || m === 'SAM') { demodulator = m; bandwidthHz = 6000; }
  else if (m === 'FM' || m === 'NFM' || m === 'FMN' || m === 'FMD' || m === 'PKTFM' || m === 'DATAFM') { demodulator = 'NFM'; bandwidthHz = 12500; }
  else if (m === 'WFM' || m === 'FMW' || m === 'BFM') { demodulator = 'WFM'; bandwidthHz = 200000; }
  else if (m === 'USB' || m === 'SSB') { demodulator = 'USB'; }
  else { demodulator = 'USB'; bandwidthHz = 3000; } // DIGU, PKTUSB, FT8, FT4, RTTY, PSK, WSPR...
  if (opts && Number.isFinite(Number(opts.hi)) && Number(opts.hi) > 0) {
    // An SSB filter starts at the carrier (ssb_lowcut_frequency trims the
    // bottom), so its width is the passband's top edge.
    bandwidthHz = Math.max(500, Math.round(Number(opts.hi) * 1000));
  }
  return { demodulator, bandwidthHz };
}

/**
 * The band scope's span choices. POTACAT asks SDRconnect for `sampleRate`
 * and crops the centre `spanHz` out of the bins.
 * UNCONFIRMED: which sample rates SDRconnect accepts on each receiver; the
 * rate is read back after it is set and the span is labelled from that.
 * UNCONFIRMED: that the spectrum bins cover the whole sample rate (they are
 * "normalised to visible range"; if SDRconnect's own zoom narrows them, the
 * read-back rate overstates the span).
 */
const SPANS = Object.freeze([
  { spanHz: 200000, sampleRate: 2000000, label: '200 kHz' },
  { spanHz: 800000, sampleRate: 2000000, label: '800 kHz' },
  { spanHz: 1600000, sampleRate: 2000000, label: '1.6 MHz' },
  { spanHz: 5000000, sampleRate: 6000000, label: '5 MHz' },
  { spanHz: 8000000, sampleRate: 10000000, label: '8 MHz' },
]);

function spanChoices() { return SPANS.map((s) => ({ ...s })); }

/** The span entry for a saved spanHz (800 kHz when unknown). */
function spanFor(spanHz) {
  return SPANS.find((s) => s.spanHz === Number(spanHz)) || SPANS[1];
}

/**
 * The span actually drawn: what was asked for, but never more than the bins
 * cover (90% of the read-back sample rate, the receiver's usable passband).
 */
function drawnSpanHz(wantedSpanHz, sampleRateHz) {
  const want = Number(wantedSpanHz) || SPANS[1].spanHz;
  const rate = Number(sampleRateHz);
  if (!(rate > 0)) return want;
  return Math.min(want, Math.round(rate * 0.9));
}

/**
 * Spectrum bins in, the scope's 850 levels out.
 *   u8            the payload of a spectrum frame
 *   visibleSpanHz what the bins cover (the sample rate)
 *   wantedSpanHz  what the scope draws, centred
 *   opts.shiftHz  the scope's centre minus the bins' centre (a listener moved
 *                 the receiver: the dial sits off centre in the bins)
 *   opts.topDb / opts.bottomDb  spectrum_ref_level / spectrum_base: bin 255
 *                 is topDb, bin 0 is bottomDb ("normalised to visible range")
 *   opts.state    a {} kept between frames: the tracked noise floor
 * The bins are turned back into dB and re-levelled against a tracked noise
 * floor (the rtl_tcp source's mapping, lib/sdr-scope.js toLevels), so the
 * picture looks the same whatever SDRconnect's own display range is.
 * Peak-hold when squeezing, linear interpolation when stretching; columns
 * outside the bins are the noise floor (0).
 */
function levelsFromBins(u8, visibleSpanHz, wantedSpanHz, opts = {}) {
  const bins = opts.bins || BINS;
  const out = new Uint8Array(bins);
  const n = u8 ? u8.length : 0;
  const vis = Number(visibleSpanHz);
  if (n < 2 || !(vis > 0)) return out;
  const want = Number(wantedSpanHz) > 0 ? Number(wantedSpanHz) : vis;
  const shift = Number(opts.shiftHz) || 0;
  const top = Number.isFinite(Number(opts.topDb)) ? Number(opts.topDb) : 0;
  const bottom = Number.isFinite(Number(opts.bottomDb)) ? Number(opts.bottomDb) : -120;
  const range = top - bottom || 120;
  const hzPerBin = vis / n;
  // Bin i is centred at (i + 0.5) * hzPerBin - vis/2 from the bins' centre.
  const firstHz = shift - want / 2;
  const perCol = want / bins;
  const binsPerCol = perCol / hzPerBin;
  const db = new Float64Array(bins);
  const have = new Uint8Array(bins);
  for (let x = 0; x < bins; x++) {
    const fHz = firstHz + (x + 0.5) * perCol;
    const f = (fHz + vis / 2) / hzPerBin - 0.5;   // fractional bin index
    if (f < -0.5 || f > n - 0.5) continue;
    let v;
    if (binsPerCol > 1) {
      const a = Math.max(0, Math.floor(f - binsPerCol / 2));
      const b = Math.min(n - 1, Math.ceil(f + binsPerCol / 2));
      v = 0;
      for (let i = a; i <= b; i++) if (u8[i] > v) v = u8[i];
    } else {
      const i = Math.max(0, Math.min(n - 2, Math.floor(f)));
      const t = Math.max(0, Math.min(1, f - i));
      v = u8[i] * (1 - t) + u8[i + 1] * t;
    }
    db[x] = bottom + (v / 255) * range;
    have[x] = 1;
  }
  // Re-level against a tracked floor (the 20th percentile, smoothed).
  const present = [];
  for (let x = 0; x < bins; x++) if (have[x]) present.push(db[x]);
  if (!present.length) return out;
  present.sort((a, b) => a - b);
  const floorNow = present[Math.floor(0.2 * (present.length - 1))];
  const st = opts.state || {};
  st.floorDb = st.floorDb == null || !Number.isFinite(st.floorDb) ? floorNow : st.floorDb + (floorNow - st.floorDb) * 0.2;
  const base = st.floorDb + LEVEL_BASE_DB;
  for (let x = 0; x < bins; x++) {
    if (!have[x]) continue;
    const v = Math.round(((db[x] - base) / LEVEL_RANGE_DB) * 255);
    out[x] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}
// The same mapping as lib/sdr-scope.js (its levelScale labels it).
const LEVEL_RANGE_DB = 60;
const LEVEL_BASE_DB = -3;

/**
 * Signed 16-bit stereo LRLR at 48 kHz -> mono Float32Array (-1..1), the
 * average of both channels (API 1.0.3, Binary Messages, type 1).
 */
function stereoToMono(payload) {
  const b = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
  const frames = Math.floor(b.length / 4);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = (b.readInt16LE(4 * i) + b.readInt16LE(4 * i + 2)) / 65536;
  return out;
}

/**
 * What POTACAT reads at connect and puts back when it is done, in the order
 * it is put back (rate before centre before VFO, so the VFO lands inside the
 * restored window). The receiver is often shared; its owner finds it as they
 * left it.
 */
const SNAPSHOT_PROPS = Object.freeze([
  PROP.SAMPLE_RATE, PROP.CENTER, PROP.VFO, PROP.LNA, PROP.DEMOD, PROP.BANDWIDTH,
  PROP.AGC, PROP.VOLUME, PROP.MUTE, PROP.SPECTRUM_TOP, PROP.SPECTRUM_BOTTOM,
]);
function snapshotProps() { return SNAPSHOT_PROPS.slice(); }

/** True when two property values mean the same (numbers compare as numbers). */
function sameValue(a, b) {
  if (a === b) return true;
  const x = parseNum(a), y = parseNum(b);
  if (x != null && y != null) return Math.abs(x - y) < 1e-6;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * The set_property messages that put `before` back, for the properties in
 * `touched` (the ones POTACAT changed) that differ from `now`.
 * Returns text frames in SNAPSHOT_PROPS order.
 */
function restoreMessages(before, now, touched, device) {
  const out = [];
  const b = before || {};
  const n = now || {};
  const t = touched ? new Set(touched) : null;
  for (const p of SNAPSHOT_PROPS) {
    if (t && !t.has(p)) continue;
    if (!(p in b) || b[p] == null || b[p] === '') continue;
    if (p in n && sameValue(n[p], b[p])) continue;
    out.push(buildMessage(EVENT.SET_PROPERTY, p, b[p], device));
  }
  return out;
}

/**
 * The RF gain step to set: null for 'auto' (leave SDRconnect's own setting),
 * else the step clamped into lna_state_min..lna_state_max.
 * UNCONFIRMED: which way the steps run. On SDRplay's own server 0 is the
 * most gain; whether lna_state over the WebSocket runs the same way is not
 * stated. The settings label the ends "most gain" and "least gain" only
 * once a receiver has confirmed it; until then they show the plain step.
 */
function lnaForGain(gain, min, max) {
  if (gain == null || gain === '' || gain === 'auto') return null;
  const g = Math.round(Number(gain));
  if (!Number.isFinite(g)) return null;
  const has = (v) => v != null && v !== '' && Number.isFinite(Number(v));
  const lo = has(min) ? Number(min) : 0;
  const hi = has(max) && Number(max) >= lo ? Number(max) : Math.max(lo, g);
  return Math.max(lo, Math.min(hi, g));
}

/**
 * What a failure means to the operator, in one sentence each (the shape of
 * lib/sdr-scope.js describeSdrError: key, severity, headline, detail, action).
 */
function describeSdrConnectError(key, { host = '127.0.0.1', port = DEFAULT_PORT, detail = '', version = '', device = '' } = {}) {
  const where = `${host}:${port}`;
  switch (key) {
    case 'refused':
      return { key, severity: 'blocker', headline: `SDRconnect is not answering at ${where}`,
        detail: 'Nothing is listening there. SDRconnect may not be running, or its WebSocket server is off.',
        action: 'Start SDRconnect on that PC, turn on its WebSocket server (port 5454), then press Retry.' };
    case 'unreachable':
      return { key, severity: 'blocker', headline: `Cannot reach ${where}`, detail: detail || 'The computer did not answer.',
        action: 'Check the address in Settings > Radio, Edit the rig, Band scope from an SDR.' };
    case 'not-sdrconnect':
      return { key, severity: 'error', headline: `${where} is not SDRconnect`,
        detail: detail || 'It accepted the connection but did not answer as SDRconnect.',
        action: 'Check the port: SDRconnect uses 5454.' };
    case 'api-version':
      return { key, severity: 'blocker', headline: `This SDRconnect speaks a newer version (${version || 'unknown'})`,
        detail: `POTACAT understands version ${SUPPORTED_API_MAJOR} of SDRconnect's WebSocket API.`,
        action: 'Update POTACAT, or use the SDRconnect version that came before.' };
    case 'no-device':
      return { key, severity: 'blocker', headline: device ? `SDRconnect does not have ${device}` : 'SDRconnect has no receiver open',
        detail: 'POTACAT uses the receiver SDRconnect has open.',
        action: 'Open your receiver in SDRconnect once (for an nRSP-ST, pick it from SDRconnect\'s device list), then press Retry.' };
    case 'no-control':
      return { key, severity: 'warn', headline: 'Someone else is controlling this receiver',
        detail: 'The scope shows what it is tuned to; tuning waits until control comes back.',
        action: '' };
    case 'stalled':
      return { key, severity: 'error', headline: 'SDRconnect stopped sending',
        detail: 'It is connected but nothing has arrived for several seconds.',
        action: 'POTACAT reconnects by itself; check SDRconnect if it does not recover.' };
    default:
      return { key: key || 'error', severity: 'error', headline: 'SDRconnect connection error', detail };
  }
}

module.exports = {
  DEFAULT_PORT, BINS, AUDIO_RATE, SUPPORTED_API_MAJOR, EVENT, PROP, BINARY_TYPES, SPANS,
  LEVEL_RANGE_DB, LEVEL_BASE_DB,
  buildMessage, parseText, parseBinary, parseBool, parseNum, parseValidDevices, parseApiVersion, apiVersionSupported,
  demodFor, spanChoices, spanFor, drawnSpanHz, levelsFromBins, stereoToMono,
  snapshotProps, sameValue, restoreMessages, lnaForGain, describeSdrConnectError,
};
