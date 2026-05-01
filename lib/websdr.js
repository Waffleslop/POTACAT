'use strict';
//
// WebSDR.org client for PA3FWM-style WebSDR receivers.
//
// Connects via WebSocket to /~~stream on the receiver port (e.g. 8901, 8902),
// sends tune commands as text frames (`GET /~~param?...`), and decodes the
// byte-tagged binary audio stream. Reference: the live websdr-sound.js served
// by every WebSDR site (e.g. http://websdr.ewi.utwente.nl:8901/websdr-sound.js).
//
// Frame tags:
//   0x80 + 128 bytes   128 µ-law samples
//   0x81 + 2 BE bytes  sample rate change (Hz)
//   0x82 + 2 BE bytes  ADPCM step-size (Oa)
//   0x83 + 1 byte      mode/filter flags (Aa); bit 4 disables dithering
//   0x84               128 silent samples
//   0x85 + 6 bytes     "true frequency" feedback
//   0x86               resync marker
//   0x87 + 6 bytes     server time (epoch ms)
//   0x90..0xDF + ...   ADPCM block (128 samples), high nibble encodes bit-shift
//   0x00..0x7F + ...   ADPCM continuation block (uses previous bit-shift)
//   0xF0..0xFF + 1     s-meter (((tag & 0x0F) << 8) | next_byte)
//
// Public API mirrors KiwiSdrClient so main.js can swap between them transparently.
//

const { EventEmitter } = require('events');
const WebSocket = require('ws');

// G.711 µ-law decode lookup table — vendored from websdr-sound.js Sa[]
// (verbatim; output range ±32256, standard µ-law with bias 132).
const MULAW_LUT = new Int16Array([
  -5504, -5248, -6016, -5760, -4480, -4224, -4992, -4736, -7552, -7296, -8064, -7808, -6528, -6272, -7040, -6784,
  -2752, -2624, -3008, -2880, -2240, -2112, -2496, -2368, -3776, -3648, -4032, -3904, -3264, -3136, -3520, -3392,
  -22016, -20992, -24064, -23040, -17920, -16896, -19968, -18944, -30208, -29184, -32256, -31232, -26112, -25088, -28160, -27136,
  -11008, -10496, -12032, -11520, -8960, -8448, -9984, -9472, -15104, -14592, -16128, -15616, -13056, -12544, -14080, -13568,
  -344, -328, -376, -360, -280, -264, -312, -296, -472, -456, -504, -488, -408, -392, -440, -424,
  -88, -72, -120, -104, -24, -8, -56, -40, -216, -200, -248, -232, -152, -136, -184, -168,
  -1376, -1312, -1504, -1440, -1120, -1056, -1248, -1184, -1888, -1824, -2016, -1952, -1632, -1568, -1760, -1696,
  -688, -656, -752, -720, -560, -528, -624, -592, -944, -912, -1008, -976, -816, -784, -880, -848,
  5504, 5248, 6016, 5760, 4480, 4224, 4992, 4736, 7552, 7296, 8064, 7808, 6528, 6272, 7040, 6784,
  2752, 2624, 3008, 2880, 2240, 2112, 2496, 2368, 3776, 3648, 4032, 3904, 3264, 3136, 3520, 3392,
  22016, 20992, 24064, 23040, 17920, 16896, 19968, 18944, 30208, 29184, 32256, 31232, 26112, 25088, 28160, 27136,
  11008, 10496, 12032, 11520, 8960, 8448, 9984, 9472, 15104, 14592, 16128, 15616, 13056, 12544, 14080, 13568,
  344, 328, 376, 360, 280, 264, 312, 296, 472, 456, 504, 488, 408, 392, 440, 424,
  88, 72, 120, 104, 24, 8, 56, 40, 216, 200, 248, 232, 152, 136, 184, 168,
  1376, 1312, 1504, 1440, 1120, 1056, 1248, 1184, 1888, 1824, 2016, 1952, 1632, 1568, 1760, 1696,
  688, 656, 752, 720, 560, 528, 624, 592, 944, 912, 1008, 976, 816, 784, 880, 848,
]);

// ADPCM decoder needs ≥400 bytes to safely decode one 128-sample block.
// Worst case is ~370 bytes (G=1 max-bit-width samples); 400 leaves slack
// for the 32-bit lookahead window the bit unpacker uses.
const ADPCM_MIN_BYTES = 400;

class WebSdrClient extends EventEmitter {
  constructor() {
    super();
    this._ws = null;
    this._connected = false;
    this._host = '';
    this._port = 8901;
    this._buf = Buffer.alloc(0);
    this._sampleRate = 7350; // default; updated by 0x81 frames
    this._desiredFreqKhz = 0;
    this._desiredMode = 'usb';
    this._callsign = '';
    this._band = 0;

    // ADPCM state — survives across blocks, resets on µ-law/silence/tune
    this._taps = new Int32Array(20); // N[]
    this._history = new Int32Array(20); // O[]
    this._stepSize = 0; // Oa
    this._modeFlags = 0; // Aa
    this._dither = 0; // fa
    this._bitShift = 0; // G — carries across continuation tags

    this._diagFrames = 0;
  }

  get connected() { return this._connected; }

  /**
   * Connect to a WebSDR.org receiver and start streaming.
   * @param {string} host
   * @param {number} port — default 8901
   * @param {number} freqKhz — initial frequency
   * @param {string} mode — 'usb', 'lsb', 'cw', 'am', 'fm'
   * @param {object} [options]
   * @param {string} [options.callsign] — included in the `name=` URL param so
   *   the WebSDR sysop sees who's listening. POTACAT_<call> if provided.
   * @param {number} [options.band] — band index for multi-band sites (default 0)
   */
  connect(host, port, freqKhz, mode, options = {}) {
    this.disconnect();
    this._host = host;
    this._port = port || 8901;
    this._desiredFreqKhz = freqKhz || 7200;
    this._desiredMode = (mode || 'usb').toLowerCase();
    this._callsign = (options.callsign || '').trim();
    this._band = options.band != null ? options.band : 0;

    const url = `ws://${this._host}:${this._port}/~~stream`;
    this.emit('log', `connecting ${url}`);

    try {
      // Origin header is mandatory — WebSDR.org servers reject WS upgrades
      // without an Origin matching the receiver host. User-Agent is a
      // belt-and-suspenders thing; browsers always send it and at least one
      // server (na5b.com) appears to want a non-empty value.
      this._ws = new WebSocket(url, {
        handshakeTimeout: 10000,
        origin: `http://${this._host}:${this._port}`,
        headers: { 'User-Agent': 'POTACAT/1.0 (WebSDR client)' },
      });
    } catch (err) {
      this.emit('error', err.message);
      return;
    }

    this._ws.on('open', () => {
      this._connected = true;
      this.emit('connected');
      // Send the initial tune command immediately on open.
      this._sendTune();
    });

    this._ws.on('message', (data) => {
      // ws library hands us a Buffer for binary frames or a String for text frames.
      // WebSDR.org server only sends binary; if we get a string, just log it.
      if (typeof data === 'string') {
        this.emit('log', `text frame: ${data.slice(0, 80)}`);
        return;
      }
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      this._onBinary(buf);
    });

    this._ws.on('close', () => {
      this._cleanup();
      this.emit('disconnected');
    });

    this._ws.on('error', (err) => {
      this.emit('error', err.message || 'WebSocket error');
    });
  }

  disconnect() {
    if (this._ws) {
      try { this._ws.close(); } catch {}
    }
    this._cleanup();
  }

  /** Tune to a new frequency and/or mode without reconnecting. */
  tune(freqKhz, mode, opts = {}) {
    if (freqKhz != null) this._desiredFreqKhz = freqKhz;
    if (mode) this._desiredMode = mode.toLowerCase();
    if (opts.band != null) this._band = opts.band;
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._sendTune(opts);
    // Reset ADPCM predictor on retune — old history would predict garbage.
    this._taps.fill(0);
    this._history.fill(0);
    this._dither = 0;
  }

  // --- Internal ---

  _cleanup() {
    this._connected = false;
    this._ws = null;
    this._buf = Buffer.alloc(0);
  }

  _sendTune(opts = {}) {
    const m = (this._desiredMode || 'usb').toUpperCase();
    let lo, hi;
    if (opts.lo != null && opts.hi != null) {
      lo = opts.lo; hi = opts.hi;
    } else {
      switch (m) {
        case 'USB': lo = 300; hi = 2700; break;
        case 'LSB': lo = -2700; hi = -300; break;
        case 'CW': lo = 300; hi = 800; break;
        case 'AM': lo = -4000; hi = 4000; break;
        case 'FM': lo = -6000; hi = 6000; break;
        default: lo = 300; hi = 2700; break;
      }
    }
    const name = encodeURIComponent('POTACAT' + (this._callsign ? '_' + this._callsign : ''));
    // Frequency in kHz, decimal allowed — server parses as float.
    const params = `f=${this._desiredFreqKhz}&band=${this._band}&lo=${lo}&hi=${hi}&mode=${m}&name=${name}`;
    const cmd = `GET /~~param?${params}`;
    try {
      this._ws.send(cmd);
      this.emit('log', `tx: ${cmd}`);
    } catch (err) {
      this.emit('error', `tune send failed: ${err.message}`);
    }
  }

  _onBinary(buf) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, buf]) : buf;
    this._parse();
  }

  /**
   * Parse all complete tagged frames out of the accumulated buffer, emitting
   * 'audio' / 'smeter' / 'log' as we go. Leaves any incomplete trailing frame
   * in the buffer for the next call.
   */
  _parse() {
    const samples = [];
    let a = 0;
    let unknownStreak = 0;
    while (a < this._buf.length) {
      const advance = this._parseTag(this._buf, a, samples);
      if (advance === -1) break; // incomplete frame — wait for more data
      if (advance === -2) { unknownStreak++; a++; if (unknownStreak > 16) break; continue; }
      unknownStreak = 0;
      a += advance;
    }
    if (a > 0) {
      this._buf = a < this._buf.length ? this._buf.slice(a) : Buffer.alloc(0);
    }
    if (samples.length) {
      const pcm = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        // Clamp to [-1, 1) — the predictor can occasionally overshoot.
        const v = samples[i] / 32768;
        pcm[i] = v > 0.9999 ? 0.9999 : (v < -1 ? -1 : v);
      }
      this._diagnostic(pcm);
      this.emit('audio', pcm, this._sampleRate);
    }
  }

  /**
   * Process one tag at offset `a`. Returns:
   *   ≥1   number of bytes consumed
   *   -1   need more data (incomplete frame)
   *   -2   unknown tag (caller advances by 1 and tries again)
   */
  _parseTag(buf, a, out) {
    if (a >= buf.length) return -1;
    const tag = buf[a];

    // 0xF0..0xFF — s-meter
    if ((tag & 0xF0) === 0xF0) {
      if (a + 2 > buf.length) return -1;
      const smeter = ((tag & 0x0F) << 8) | buf[a + 1];
      this.emit('smeter', smeter * 10);
      return 2;
    }

    // 0x80 — 128 µ-law samples
    if (tag === 0x80) {
      if (a + 129 > buf.length) return -1;
      for (let i = 0; i < 128; i++) {
        out.push(MULAW_LUT[buf[a + 1 + i]]);
      }
      // µ-law block resets ADPCM predictor state.
      this._taps.fill(0);
      this._history.fill(0);
      this._dither = 0;
      return 129;
    }

    // 0x81 — sample rate change (BE uint16)
    if (tag === 0x81) {
      if (a + 3 > buf.length) return -1;
      const newRate = (buf[a + 1] << 8) | buf[a + 2];
      if (newRate > 0 && newRate !== this._sampleRate) {
        this._sampleRate = newRate;
        this.emit('log', `sample rate: ${newRate} Hz`);
        this.emit('info', { sampleRate: newRate });
      }
      return 3;
    }

    // 0x82 — ADPCM step-size param (BE uint16)
    if (tag === 0x82) {
      if (a + 3 > buf.length) return -1;
      this._stepSize = (buf[a + 1] << 8) | buf[a + 2];
      return 3;
    }

    // 0x83 — mode/filter flags
    if (tag === 0x83) {
      if (a + 2 > buf.length) return -1;
      this._modeFlags = buf[a + 1];
      return 2;
    }

    // 0x84 — 128 silent samples
    if (tag === 0x84) {
      for (let i = 0; i < 128; i++) out.push(0);
      this._taps.fill(0);
      this._history.fill(0);
      this._dither = 0;
      return 1;
    }

    // 0x85 — true-frequency feedback (6 bytes after tag)
    if (tag === 0x85) {
      if (a + 7 > buf.length) return -1;
      // Could decode and emit; not needed for audio.
      return 7;
    }

    // 0x86 — resync
    if (tag === 0x86) return 1;

    // 0x87 — server time (6 bytes)
    if (tag === 0x87) {
      if (a + 7 > buf.length) return -1;
      return 7;
    }

    // 0x90..0xDF — ADPCM block, new bit-shift G = 14 - (tag>>4)
    if (tag >= 0x90 && tag <= 0xDF) {
      if (buf.length - a < ADPCM_MIN_BYTES) return -1;
      this._bitShift = 14 - (tag >> 4);
      return this._decodeAdpcm(buf, a, 4, out);
    }

    // 0x00..0x7F — ADPCM continuation, reuses previous G
    if ((tag & 0x80) === 0) {
      if (buf.length - a < ADPCM_MIN_BYTES) return -1;
      return this._decodeAdpcm(buf, a, 1, out);
    }

    // 0xE0..0xEF — unhandled in PA3FWM's reference; most servers don't emit
    return -2;
  }

  /**
   * ADPCM block decoder — direct port of the inner loop in websdr-sound.js
   * onmessage. 128 samples, variable-bit-length encoding driven by:
   *   - G       bit-shift (1..5; from tag high nibble at block start)
   *   - Oa      step-size (set by 0x82 frames)
   *   - Aa      mode flags (bit 4 = no dither, low nibble = filter index)
   *   - N[]/O[] 20-tap LMS predictor (taps + history)
   * Returns bytes consumed from `startA`.
   */
  _decodeAdpcm(buf, startA, initialM, out) {
    let a = startA;
    const N = this._taps;
    const O = this._history;
    const G = this._bitShift;
    const Oa = this._stepSize;
    const Aa = this._modeFlags;
    let fa = this._dither;
    let m = initialM;
    let s = 0;
    const j = (Aa & 16) === 16 ? 12 : 14;
    const Z = [999, 999, 8, 4, 2, 1, 99, 99];

    while (s < 128) {
      // 32-bit big-endian window into the bit stream, left-shifted by m
      // to discard bits already consumed in the current byte.
      let f =
        ((buf[a] | 0) << 24) |
        ((buf[a + 1] | 0) << 16) |
        ((buf[a + 2] | 0) << 8) |
        (buf[a + 3] | 0);
      f = (f << m) | 0;

      let e = 0;
      let r = 15 - G;
      let w = Oa;

      // Count leading zeros (up to r positions).
      if (f !== 0) {
        while ((f & 0x80000000) === 0 && e < r) {
          f = (f << 1) | 0;
          e++;
        }
      }

      if (e < r) {
        r = e;
        e++;
        f = (f << 1) | 0;
      } else {
        // Long zero run — read 8 bits as the run-length encoding.
        r = (f >>> 24) & 0xFF;
        e += 8;
        f = (f << 8) | 0;
      }

      let S = 0;
      if (r >= Z[G]) S++;
      if (r >= Z[G - 1]) S++;
      if (S > G - 1) S = G - 1;

      // Decoded delta z = signed value reconstructed from r and remaining bits.
      let z = (((f >>> 16) & 0xFFFF) >> (17 - G)) & ((-1) << S);
      z += r << (G - 1);
      if ((f & (1 << (32 - G + S))) !== 0) {
        z |= (1 << S) - 1;
        z = ~z;
      }

      // Advance bit pointer by (e + G - S) bits; spill into bytes.
      m += e + G - S;
      while (m >= 8) {
        a++;
        m -= 8;
      }

      // Predictor: dot product of taps × history.
      let pred = 0;
      for (let i = 0; i < 20; i++) pred += N[i] * O[i];
      pred = pred | 0;
      pred = pred >= 0 ? pred >> 12 : (pred + 4095) >> 12;

      // Step: w = z * step + step / 2. delta = w >> 4 (used in LMS update).
      w = z * w + (w >> 1);
      const delta = w >> 4;

      // LMS adaptation — update taps and shift history.
      for (let i = 19; i >= 0; i--) {
        N[i] += -(N[i] >> 7) + ((O[i] * delta) >> j);
        if (i === 0) break;
        O[i] = O[i - 1];
      }

      O[0] = pred + w;
      const sample = O[0] + (fa >> 4);
      // fa is a slow-decay dither-like accumulator unless mode bit 4 says no.
      fa = (Aa & 16) === 16 ? 0 : fa + ((O[0] << 4) >> 3);

      out.push(sample);
      s++;
    }

    this._dither = fa;

    // Mirror the original outer-loop semantics:
    //   if m===0 the inner ended exactly at a byte boundary; we want next
    //   tag to be at byte `a`. Otherwise we discard the partial byte and
    //   move on (matching the reference; protocol pads to byte boundary).
    return m === 0 ? (a - startA) : (a - startA + 1);
  }

  /**
   * First three frames after every connect get a verbose-log line with
   * sample range/meanAbs/etc. — same pattern as the KiwiSDR client uses.
   */
  _diagnostic(pcm) {
    if (this._diagFrames >= 3 || pcm.length === 0) return;
    this._diagFrames++;
    let mn = Infinity, mx = -Infinity, sumAbs = 0;
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      sumAbs += Math.abs(v);
    }
    const meanAbs = sumAbs / pcm.length;
    this.emit(
      'log',
      `frame#${this._diagFrames} samples=${pcm.length} rate=${this._sampleRate}Hz range=${mn.toFixed(3)}..${mx.toFixed(3)} meanAbs=${meanAbs.toFixed(3)}`
    );
  }
}

module.exports = { WebSdrClient, MULAW_LUT };
