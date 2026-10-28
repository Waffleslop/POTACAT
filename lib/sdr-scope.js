'use strict';
// lib/sdr-scope.js — a band scope from a separate local SDR, for ANY radio
// (AB9AI 2026-07-18, W9TEF's SDRplay on his FTDX5000's RX loop, K6CSG's
// FTDX10). The FT-710 streams its own scope over USB (lib/yaesu-scope.js);
// every other radio needs a receiver of its own, and the one protocol nearly
// every cheap SDR speaks is rtl_tcp: rtl_tcp for RTL-SDR dongles, rsp_tcp for
// SDRplay, and a dozen bridges for the rest. So POTACAT is an rtl_tcp CLIENT —
// it never opens a USB device, ships no driver and links nothing; the operator
// runs the server that came with their SDR.
//
// What this module owns (all of it pure or socket-only, no Electron):
//   - the protocol: the 12-byte "RTL0" greeting and the 5-byte commands
//     (parseHeader / buildCommand), and RtlTcpClient, which keeps the socket
//     alive with backoff, says WHICH thing is wrong (not running, refused,
//     no greeting, stalled) and hands out IQ aligned to whole sample pairs
//     however TCP chops it;
//   - the picture: SpectrumBuilder turns u8 IQ into frames of 850 levels
//     (0..255), the exact shape lib/yaesu-scope.js parseScopeFrame produces,
//     so the pop-out, the JTCAT strip and ECHOCAT draw an SDR exactly like the
//     radio's own scope. Hann window, radix-2 FFT, a few averaged per frame,
//     only ~12 frames a second whatever the sample rate (the rest of the IQ is
//     skipped — a scope is not a receiver), the DC spike notched out, the
//     roll-off edges cropped, and an auto-tracking noise floor so a gain
//     change never turns the waterfall white or black.
//
// main.js (startSdrScope & co.) decides when it runs, points the SDR at the
// dial (+ an offset for an IF tap or an upconverter) and forwards frames.

const net = require('net');
const { EventEmitter } = require('events');

const BINS = 850;
const HEADER_BYTES = 12;
const DEFAULT_PORT = 1234;

// rtl_tcp command bytes (rtl_tcp.c / rsp_tcp use the same numbers).
const CMD = {
  FREQ: 0x01, SAMPLE_RATE: 0x02, GAIN_MODE: 0x03, GAIN: 0x04,
  PPM: 0x05, IF_GAIN: 0x06, TEST_MODE: 0x07, AGC: 0x08,
  DIRECT_SAMPLING: 0x09, OFFSET_TUNING: 0x0a, GAIN_INDEX: 0x0d, BIAS_TEE: 0x0e,
};

// rtlsdr_tuner enum, as the greeting reports it.
const TUNER_NAMES = {
  0: 'unknown tuner', 1: 'E4000', 2: 'FC0012', 3: 'FC0013', 4: 'FC2580', 5: 'R820T/R820T2', 6: 'R828D',
};

/**
 * The span choices. An SDR's passband rolls off at the edges, so the drawn
 * span is ~80% of the sample rate. RTL2832 rates must sit in 225-300 kHz or
 * 900 kHz-3.2 MHz; these three are valid there and on rsp_tcp.
 */
const SPANS = [
  { sampleRate: 250000, spanHz: 200000 },
  { sampleRate: 1024000, spanHz: 800000 },
  { sampleRate: 2048000, spanHz: 1600000 },
];

function spanForRate(sampleRate) {
  const s = SPANS.find((x) => x.sampleRate === Number(sampleRate));
  return s ? s.spanHz : Math.round(Number(sampleRate) * 0.8) || 0;
}

/** Normalise the per-rig settings block, filling every default. */
function normalizeSdrSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const rate = SPANS.some((s) => s.sampleRate === Number(r.sampleRate)) ? Number(r.sampleRate) : 1024000;
  const port = parseInt(r.port, 10);
  const gain = r.gain === 'auto' || r.gain == null || r.gain === '' ? 'auto' : Number(r.gain);
  return {
    enabled: r.enabled === true,
    host: String(r.host || '127.0.0.1').trim() || '127.0.0.1',
    port: port > 0 && port < 65536 ? port : DEFAULT_PORT,
    sampleRate: rate,
    gain: gain === 'auto' || !Number.isFinite(gain) ? 'auto' : Math.max(0, Math.min(60, gain)),
    directSampling: ['off', 'i', 'q'].includes(String(r.directSampling || '').toLowerCase()) ? String(r.directSampling).toLowerCase() : 'off',
    ppm: Number.isFinite(Number(r.ppm)) ? Math.max(-200, Math.min(200, Math.round(Number(r.ppm)))) : 0,
    offsetHz: Number.isFinite(Number(r.offsetHz)) ? Math.round(Number(r.offsetHz)) : 0,
    // On an FT-710 its own USB scope wins unless the operator picks the SDR.
    preferSdr: r.preferSdr === true,
  };
}

/** The 12-byte greeting: "RTL0", tuner type, tuner gain count (both u32 BE). */
function parseHeader(buf) {
  if (!buf || buf.length < HEADER_BYTES) return null;
  if (buf.toString('latin1', 0, 4) !== 'RTL0') return null;
  const tunerType = buf.readUInt32BE(4);
  return { tunerType, tunerName: TUNER_NAMES[tunerType] || `tuner ${tunerType}`, gainCount: buf.readUInt32BE(8) };
}

/** A 5-byte command: one byte, then the parameter as a 32-bit big-endian word. */
function buildCommand(cmd, param) {
  const b = Buffer.alloc(5);
  b[0] = cmd & 0xff;
  const v = Math.round(Number(param) || 0);
  if (v < 0) b.writeInt32BE(v, 1); else b.writeUInt32BE(v >>> 0, 1);
  return b;
}

/** The command list that puts a freshly connected server where the settings say. */
function setupCommands(s, centerHz) {
  const out = [
    buildCommand(CMD.SAMPLE_RATE, s.sampleRate),
    buildCommand(CMD.DIRECT_SAMPLING, s.directSampling === 'i' ? 1 : s.directSampling === 'q' ? 2 : 0),
    buildCommand(CMD.PPM, s.ppm),
  ];
  if (s.gain === 'auto') {
    out.push(buildCommand(CMD.GAIN_MODE, 0), buildCommand(CMD.AGC, 1));
  } else {
    out.push(buildCommand(CMD.GAIN_MODE, 1), buildCommand(CMD.AGC, 0), buildCommand(CMD.GAIN, Math.round(s.gain * 10)));
  }
  if (centerHz > 0) out.push(buildCommand(CMD.FREQ, centerHz));
  return out;
}

/**
 * Where the SDR tunes for a radio dial. The scope draws centred on the dial;
 * offsetHz moves the SDR for an IF tap (a radio's IF out, W9TEF's RX loop on
 * a separate band, an upconverter's +125 MHz).
 */
function sdrCenterForDial(dialHz, offsetHz) {
  const d = Number(dialHz) || 0;
  if (!(d > 0)) return 0;
  return Math.max(0, Math.round(d + (Number(offsetHz) || 0)));
}

// ─── FFT ─────────────────────────────────────────────────────────────────────

const _fftCache = new Map();
function fftPlan(n) {
  if (_fftCache.has(n)) return _fftCache.get(n);
  if (n < 2 || (n & (n - 1))) throw new Error('FFT size must be a power of two');
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)); // Hann
  const plan = { n, rev, cos, sin, win };
  _fftCache.set(n, plan);
  return plan;
}

/** In-place iterative radix-2 FFT (decimation in time). */
function fftInPlace(re, im) {
  const n = re.length;
  const { rev, cos, sin } = fftPlan(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step], wi = sin[k * step];
        const a = start + k, b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

/**
 * Power spectrum of `n` complex samples from u8 IQ at byte offset `off`,
 * fftshifted so index n/2 is the centre (0 Hz), in linear power.
 */
function powerSpectrumU8(iq, off, n) {
  const { win } = fftPlan(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    re[i] = ((iq[off + 2 * i] - 127.5) / 127.5) * win[i];
    im[i] = ((iq[off + 2 * i + 1] - 127.5) / 127.5) * win[i];
  }
  fftInPlace(re, im);
  const out = new Float64Array(n);
  const h = n >> 1;
  for (let i = 0; i < n; i++) {
    const k = (i + h) % n; // fftshift
    out[i] = re[k] * re[k] + im[k] * im[k];
  }
  return out;
}

/**
 * Remove the DC spike every zero-IF SDR has at its centre: the `width` bins
 * either side of centre are replaced by a straight line between their
 * neighbours. The scope centres on the dial, so this is the one place a real
 * signal could sit — on HF a few hundred Hz at most, which the operator is
 * already tuned to and hears.
 */
function notchDc(power, width) {
  const n = power.length;
  const c = n >> 1;
  const w = Math.max(1, width | 0);
  const lo = c - w - 1, hi = c + w + 1;
  if (lo < 0 || hi >= n) return power;
  const a = power[lo], b = power[hi];
  for (let i = lo + 1; i < hi; i++) power[i] = a + (b - a) * (i - lo) / (hi - lo);
  return power;
}

/**
 * Crop the centred span out of the (shifted) spectrum and resample it to
 * `bins` columns — peak-hold when squeezing (a narrow carrier survives, as
 * ScopeAxis.downsampleBins does), linear interpolation when stretching.
 */
function cropResample(power, sampleRate, spanHz, bins) {
  const n = power.length;
  const hzPerFft = sampleRate / n;
  const half = Math.min(spanHz, sampleRate) / 2;
  const first = n / 2 - half / hzPerFft;
  const last = n / 2 + half / hzPerFft;
  const out = new Float64Array(bins);
  const per = (last - first) / (bins - 1);
  for (let x = 0; x < bins; x++) {
    const f = first + x * per;
    if (per > 1) {
      const a = Math.max(0, Math.floor(f - per / 2));
      const b = Math.min(n - 1, Math.ceil(f + per / 2));
      let m = 0;
      for (let i = a; i <= b; i++) if (power[i] > m) m = power[i];
      out[x] = m;
    } else {
      const i = Math.max(0, Math.min(n - 2, Math.floor(f)));
      const t = Math.max(0, Math.min(1, f - i));
      out[x] = power[i] * (1 - t) + power[i + 1] * t;
    }
  }
  return out;
}

/**
 * Linear power → 0..255 levels against a noise floor that tracks the
 * picture (the 20th percentile of this frame, smoothed). `rangeDb` above the
 * floor is full scale; the floor itself sits a few levels up so the noise is
 * visible as texture, as on a radio's scope.
 */
const LEVEL_RANGE_DB = 60;   // full scale above the floor
const LEVEL_BASE_DB = -3;    // level 0 sits this far from the tracked floor
/** What a level means: dB over the tracked noise floor, a fixed mapping
 *  (60/255 dB per level), so the scope can label it — never dBm. */
function levelScale() {
  return { unit: 'dB', min: LEVEL_BASE_DB, max: LEVEL_BASE_DB + LEVEL_RANGE_DB };
}

function toLevels(power, state, { rangeDb = LEVEL_RANGE_DB, floorPct = 0.2, smooth = 0.2 } = {}) {
  const n = power.length;
  const db = new Float64Array(n);
  for (let i = 0; i < n; i++) db[i] = 10 * Math.log10(power[i] + 1e-20);
  const sorted = Array.from(db).sort((a, b) => a - b);
  const floorNow = sorted[Math.floor(floorPct * (n - 1))];
  const st = state || {};
  st.floorDb = st.floorDb == null || !Number.isFinite(st.floorDb) ? floorNow : st.floorDb + (floorNow - st.floorDb) * smooth;
  const base = st.floorDb + LEVEL_BASE_DB;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = Math.round(((db[i] - base) / rangeDb) * 255);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

/**
 * IQ in, frames out. Feed it whatever the socket delivers; it takes one
 * fftSize block every sampleRate/(fps*avg) samples, averages `avg` of them,
 * and emits { seq, kind: 0, wf1: Uint8Array(850), aligned: true } — the
 * lib/yaesu-scope.js frame shape.
 */
class SpectrumBuilder extends EventEmitter {
  constructor({ sampleRate = 1024000, spanHz, fftSize = 2048, fps = 12, avg = 3, bins = BINS, dcNotchBins } = {}) {
    super();
    this.sampleRate = sampleRate;
    this.spanHz = spanHz || spanForRate(sampleRate);
    this.fftSize = fftSize;
    this.fps = Math.max(1, Math.min(30, fps));
    this.avg = Math.max(1, avg);
    this.bins = bins;
    // ~600 Hz of notch whatever the rate: enough to swallow the spike.
    this.dcNotchBins = dcNotchBins != null ? dcNotchBins : Math.max(1, Math.ceil(300 / (sampleRate / fftSize)));
    this._hop = Math.max(fftSize, Math.floor(sampleRate / (this.fps * this.avg)));
    this._buf = Buffer.alloc(0);   // pending bytes, always < one hop + one block
    this._skip = 0;                // samples still to skip before the next block
    this._acc = null;
    this._accN = 0;
    this._seq = 0;
    this._levelState = {};
  }

  feed(chunk) {
    let data = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    const blockBytes = this.fftSize * 2;
    let pos = 0;
    for (;;) {
      if (this._skip > 0) {
        const can = Math.min(this._skip * 2, data.length - pos);
        const even = can - (can & 1);
        pos += even;
        this._skip -= even / 2;
        if (this._skip > 0) break;
      }
      if (data.length - pos < blockBytes) break;
      const p = powerSpectrumU8(data, pos, this.fftSize);
      pos += blockBytes;
      this._skip = this._hop - this.fftSize;
      if (!this._acc) this._acc = new Float64Array(this.fftSize);
      for (let i = 0; i < p.length; i++) this._acc[i] += p[i];
      if (++this._accN >= this.avg) {
        for (let i = 0; i < this._acc.length; i++) this._acc[i] /= this._accN;
        this._emit(this._acc);
        this._acc = null;
        this._accN = 0;
      }
    }
    this._buf = pos < data.length ? Buffer.from(data.subarray(pos)) : Buffer.alloc(0);
  }

  _emit(power) {
    notchDc(power, this.dcNotchBins);
    const cropped = cropResample(power, this.sampleRate, this.spanHz, this.bins);
    const wf1 = toLevels(cropped, this._levelState);
    this.emit('frame', { seq: (this._seq = (this._seq + 1) >>> 0), kind: 0, wf1, aligned: true });
  }
}

// ─── The rtl_tcp client ──────────────────────────────────────────────────────

/**
 * What a failure means to the operator. `key` is stable (tests, UI), the
 * words are what the scope window shows.
 */
function describeSdrError(key, { host = '127.0.0.1', port = DEFAULT_PORT, detail = '' } = {}) {
  const where = `${host}:${port}`;
  switch (key) {
    case 'refused':
      return { key, severity: 'blocker', headline: `Nothing is listening at ${where}`,
        detail: 'POTACAT reads the SDR through an rtl_tcp server, and none is running there.',
        action: 'Start rtl_tcp (RTL-SDR) or rsp_tcp (SDRplay) on that address, then press Retry.' };
    case 'unreachable':
      return { key, severity: 'blocker', headline: `Cannot reach ${where}`, detail: detail || 'The host did not answer.',
        action: 'Check the SDR host and port in Settings > My Rigs > Band scope from an SDR.' };
    case 'no-header':
      return { key, severity: 'error', headline: `${where} is not an rtl_tcp server`,
        detail: 'It accepted the connection but never sent the RTL0 greeting.',
        action: 'Check the port: rtl_tcp and rsp_tcp default to 1234.' };
    case 'stalled':
      return { key, severity: 'error', headline: 'The SDR stopped sending samples',
        detail: 'The server is connected but no IQ has arrived for several seconds (the dongle may have been unplugged, or another program took it).',
        action: 'POTACAT reconnects by itself; restart the rtl_tcp server if it does not recover.' };
    default:
      return { key: key || 'error', severity: 'error', headline: 'SDR connection error', detail };
  }
}

class RtlTcpClient extends EventEmitter {
  /**
   * @param {{host?, port?, stallMs?, backoffMs?, maxBackoffMs?, connectTimeoutMs?, headerTimeoutMs?}} opts
   */
  constructor(opts = {}) {
    super();
    this.host = opts.host || '127.0.0.1';
    this.port = opts.port || DEFAULT_PORT;
    this.stallMs = opts.stallMs || 5000;
    this.backoffMs = opts.backoffMs || 2000;
    this.maxBackoffMs = opts.maxBackoffMs || 30000;
    this.connectTimeoutMs = opts.connectTimeoutMs || 5000;
    this.headerTimeoutMs = opts.headerTimeoutMs || 3000;
    this.header = null;
    this.state = 'idle'; // idle | connecting | live | retrying | closed
    this._socket = null;
    this._want = false;
    this._attempt = 0;
    this._retryTimer = null;
    this._stallTimer = null;
    this._headerTimer = null;
    this._pending = Buffer.alloc(0);
    this._odd = null;          // a dangling I byte waiting for its Q
    this._queue = [];          // commands issued before the greeting
    this.bytes = 0;
  }

  start() {
    this._want = true;
    if (!this._socket && !this._retryTimer) this._connect();
  }

  stop() {
    this._want = false;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    this._teardown();
    this._setState('closed');
  }

  send(buf) {
    if (this._socket && this.header) {
      try { this._socket.write(buf); } catch { /* the close path reconnects */ }
    } else {
      this._queue.push(buf);
    }
  }

  command(cmd, param) { this.send(buildCommand(cmd, param)); }
  setFrequency(hz) { this.command(CMD.FREQ, hz); }

  _setState(s, info) {
    if (this.state === s && !info) return;
    this.state = s;
    this.emit('state', s, info || null);
  }

  _connect() {
    this._setState('connecting');
    const sock = net.connect({ host: this.host, port: this.port });
    this._socket = sock;
    this._pending = Buffer.alloc(0);
    this._odd = null;
    this.header = null;
    sock.setNoDelay(true);
    sock.setTimeout(this.connectTimeoutMs, () => {
      if (this._socket === sock && !this.header) this._fail('unreachable', `no answer within ${this.connectTimeoutMs / 1000} s`);
    });
    sock.on('connect', () => {
      if (this._socket !== sock) return;
      sock.setTimeout(0);
      this._headerTimer = setTimeout(() => { if (this._socket === sock && !this.header) this._fail('no-header'); }, this.headerTimeoutMs);
    });
    sock.on('data', (chunk) => { if (this._socket === sock) this._onData(chunk); });
    sock.on('error', (err) => {
      if (this._socket !== sock) return;
      const key = err && err.code === 'ECONNREFUSED' ? 'refused' : 'unreachable';
      this._fail(key, err && err.message);
    });
    sock.on('close', () => {
      if (this._socket !== sock) return;
      this._fail(this.header ? 'stalled' : 'refused', 'connection closed');
    });
  }

  _onData(chunk) {
    this.bytes += chunk.length;
    if (!this.header) {
      this._pending = Buffer.concat([this._pending, chunk]);
      if (this._pending.length < HEADER_BYTES) return;
      const h = parseHeader(this._pending);
      if (!h) { this._fail('no-header'); return; }
      this.header = h;
      if (this._headerTimer) { clearTimeout(this._headerTimer); this._headerTimer = null; }
      this._attempt = 0;
      const rest = this._pending.subarray(HEADER_BYTES);
      this._pending = Buffer.alloc(0);
      this._setState('live', h);
      this.emit('header', h);
      for (const b of this._queue.splice(0)) { try { this._socket.write(b); } catch { /* reconnects */ } }
      this._armStall();
      if (rest.length) this._emitIq(rest);
      return;
    }
    this._armStall();
    this._emitIq(chunk);
  }

  // IQ comes in pairs; a chunk may end between an I and its Q.
  _emitIq(chunk) {
    let data = chunk;
    if (this._odd != null) { data = Buffer.concat([Buffer.from([this._odd]), chunk]); this._odd = null; }
    if (data.length & 1) { this._odd = data[data.length - 1]; data = data.subarray(0, data.length - 1); }
    if (data.length) this.emit('iq', data);
  }

  _armStall() {
    if (this._stallTimer) clearTimeout(this._stallTimer);
    this._stallTimer = setTimeout(() => { if (this._socket) this._fail('stalled'); }, this.stallMs);
  }

  _teardown() {
    if (this._stallTimer) { clearTimeout(this._stallTimer); this._stallTimer = null; }
    if (this._headerTimer) { clearTimeout(this._headerTimer); this._headerTimer = null; }
    const s = this._socket;
    this._socket = null;
    this.header = null;
    if (s) { try { s.destroy(); } catch { /* gone */ } }
  }

  _fail(key, detail) {
    this._teardown();
    const info = describeSdrError(key, { host: this.host, port: this.port, detail });
    this.emit('problem', info);
    if (!this._want) { this._setState('closed'); return; }
    const delay = Math.min(this.maxBackoffMs, this.backoffMs * Math.pow(2, this._attempt++));
    this._setState('retrying', { ...info, retryInMs: delay });
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (this._want) this._connect();
    }, delay);
  }
}

module.exports = {
  BINS, HEADER_BYTES, DEFAULT_PORT, CMD, TUNER_NAMES, SPANS,
  spanForRate, normalizeSdrSettings, parseHeader, buildCommand, setupCommands, sdrCenterForDial,
  fftPlan, fftInPlace, powerSpectrumU8, notchDc, cropResample, toLevels, levelScale, LEVEL_RANGE_DB, LEVEL_BASE_DB,
  SpectrumBuilder, RtlTcpClient, describeSdrError,
};
