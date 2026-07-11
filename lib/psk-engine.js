// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// PSK31 engine — clean-room, pure JS, runs inline in the main process.
// DBPSK at 31.25 baud per the openly published G3PLX PSK31 description
// (varicode table + cosine-keyed differential BPSK). No GPL code; DSP is
// implemented from first principles, with the symbol-timing loop shape
// following the well-known published technique (per-phase envelope
// histogram + balance detector).
//
// Contract: drop-in sibling of Ft8Engine (lib/ft8-engine.js). JtcatManager
// and main.js reach into the same public underscore fields (_running,
// _txEnabled, _txActive, _txFreq, _mode, _txMessage) and call the same
// method names. PSK31 is a continuous keyboard mode — no slots, no cycles,
// no worker (total RX DSP is <1 ms CPU per second of audio, so it runs
// synchronously inside feedAudio).
//
// RX chain @ 12 kHz mono in:
//   NCO mix to complex baseband at (_rxFreq + AFC)
//   -> 193-tap Blackman windowed-sinc decimating FIR, ÷24 -> 500 Hz
//   -> 33-tap Hann matched filter (2-symbol raised-cosine pulse)
//   -> per-phase envelope bit-clock (16 samples/symbol, scale-invariant,
//      so NO AGC exists anywhere in the chain)
//   -> DBPSK decision (sign of z·conj(prev)) -> varicode FSM -> 'psk-text'
//   AFC: fine decision-directed loop (±7.8 Hz unambiguous) + coarse
//   squared-carrier DFT acquisition while squelch is closed (±20 Hz).
//
// TX: one-shot. setTxMessage() renders the whole message to a single PCM
// buffer (32-symbol idle preamble + varicode + 32-symbol carrier postamble,
// cosine keying, peak 1.0 like lib/wspr/encode.js); requestTx() emits one
// 'tx-start' with the FT2-immediate payload shape so main.js's existing
// dispatch (PTT, SmartSDR/Icom/renderer routes, failsafe) works unchanged.

const { EventEmitter } = require('events');

const SAMPLE_RATE = 12000;
const BAUD = 31.25;
const SPS_TX = 384;              // 12000 / 31.25 — exact integer, TX samples/symbol
const DECIM = 24;                // 12000 -> 500 Hz baseband
const SPS_BB = 16;               // baseband samples per symbol (500 / 31.25)

const DECIM_TAPS = 193;          // windowed-sinc, Blackman, fc = 75 Hz @ 12 kHz
const IN_RING = 512;             // input ring (power of 2, > DECIM_TAPS)
const IN_MASK = IN_RING - 1;
const MF_TAPS = 33;              // Hann pulse spanning 2 symbols @ 500 Hz

const AFC_FINE_GAIN = 0.05;      // per-symbol loop gain -> tau ~ 0.64 s
const AFC_MAX_HZ = 25;           // total AFC excursion clamp
const AFC_COARSE_N = 512;        // 1.024 s of baseband for coarse search
const AFC_COARSE_EVERY = 256;    // re-check every 0.512 s — must beat the fine
                                 // loop to a false lock (see below)
const AFC_COARSE_BINS = 40;      // ±40 bins at 2·Δf -> Δf pull-in ±19.5 Hz
const AFC_COARSE_MIN_RATIO = 3;  // peak/mean power ratio to accept a coarse hit
const AFC_COARSE_SNAP_MIN = 1.5; // Hz — smaller residues belong to the fine loop

const SQL_ALPHA = 0.05;          // quality EMA per symbol -> tau ~ 0.64 s
const SQL_OPEN = 40;             // metric 0-100, open at >=
const SQL_CLOSE = 25;            // close below (hysteresis)
const VCODE_MAX = 0xFFFFF;       // >20 accumulated bits = noise, discard

const TX_PREAMBLE_SYMBOLS = 32;  // 1.024 s idle (continuous reversals) — covers
                                 // RX clock lock (~1 s) + instant-DCD open
const TX_POSTAMBLE_SYMBOLS = 32; // 1.024 s steady carrier: flushes the RX
                                 // matched-filter delay so the last chars decode
const TX_MAX_CHARS = 500;
// main.js's TX failsafe hard-drops PTT at 130 s (armJtcatTxFailsafe clamp).
// Trim the message until the rendered frame fits with margin — a silent
// mid-message PTT cut is worse than a shorter over.
const TX_MAX_SEC = 120;
const TX_SAFETY_GRACE_MS = 5000; // engine's own tx-end backstop = bufDur + this

// ---- varicode ------------------------------------------------------------
// G3PLX PSK31 varicode, ASCII 0-127. Every code starts and ends with 1 and
// never contains '00'; '00' is the inter-character gap. Bit-strings keep the
// table diffable against published references.
const VARICODE = [
  /*NUL*/'1010101011', /*SOH*/'1011011011', /*STX*/'1011101101', /*ETX*/'1101110111',
  /*EOT*/'1011101011', /*ENQ*/'1101011111', /*ACK*/'1011101111', /*BEL*/'1011111101',
  /*BS */'1011111111', /*HT */'11101111',   /*LF */'11101',      /*VT */'1101101111',
  /*FF */'1011011101', /*CR */'11111',      /*SO */'1101110101', /*SI */'1110101011',
  /*DLE*/'1011110111', /*DC1*/'1011110101', /*DC2*/'1110101101', /*DC3*/'1110101111',
  /*DC4*/'1101011011', /*NAK*/'1101101011', /*SYN*/'1101101101', /*ETB*/'1101010111',
  /*CAN*/'1101111011', /*EM */'1101111101', /*SUB*/'1110110111', /*ESC*/'1101010101',
  /*FS */'1101011101', /*GS */'1110111011', /*RS */'1011111011', /*US */'1101111111',
  /*SP */'1',          /* ! */'111111111',  /* " */'101011111',  /* # */'111110101',
  /* $ */'111011011',  /* % */'1011010101', /* & */'1010111011', /* ' */'101111111',
  /* ( */'11111011',   /* ) */'11110111',   /* * */'101101111',  /* + */'111011111',
  /* , */'1110101',    /* - */'110101',     /* . */'1010111',    /* / */'110101111',
  /* 0 */'10110111',   /* 1 */'10111101',   /* 2 */'11101101',   /* 3 */'11111111',
  /* 4 */'101110111',  /* 5 */'101011011',  /* 6 */'101101011',  /* 7 */'110101101',
  /* 8 */'110101011',  /* 9 */'110110111',  /* : */'11110101',   /* ; */'110111101',
  /* < */'111101101',  /* = */'1010101',    /* > */'111010111',  /* ? */'1010101111',
  /* @ */'1010111101', /* A */'1111101',    /* B */'11101011',   /* C */'10101101',
  /* D */'10110101',   /* E */'1110111',    /* F */'11011011',   /* G */'11111101',
  /* H */'101010101',  /* I */'1111111',    /* J */'111111101',  /* K */'101111101',
  /* L */'11010111',   /* M */'10111011',   /* N */'11011101',   /* O */'10101011',
  /* P */'11010101',   /* Q */'111011101',  /* R */'10101111',   /* S */'1101111',
  /* T */'1101101',    /* U */'101010111',  /* V */'110110101',  /* W */'101011101',
  /* X */'101110101',  /* Y */'101111011',  /* Z */'1010101101', /* [ */'111110111',
  /* \ */'111101111',  /* ] */'111111011',  /* ^ */'1010111111', /* _ */'101101101',
  /* ` */'1011011111', /* a */'1011',       /* b */'1011111',    /* c */'101111',
  /* d */'101101',     /* e */'11',         /* f */'111101',     /* g */'1011011',
  /* h */'101011',     /* i */'1101',       /* j */'111101011',  /* k */'10111111',
  /* l */'11011',      /* m */'111011',     /* n */'1111',       /* o */'111',
  /* p */'111111',     /* q */'110111111',  /* r */'10101',      /* s */'10111',
  /* t */'101',        /* u */'110111',     /* v */'1111011',    /* w */'1101011',
  /* x */'11011111',   /* y */'1011101',    /* z */'111010101',  /* { */'1010110111',
  /* | */'110111011',  /* } */'1010110101', /* ~ */'1011010111', /*DEL*/'1110110101',
];

// Fail loud at load — a malformed table silently produces on-air garbage.
if (VARICODE.length !== 128) {
  throw new Error(`PSK31 VARICODE must be 128 entries, got ${VARICODE.length}`);
}
const VARICODE_REVERSE = new Map();
for (let i = 0; i < 128; i++) {
  const bits = VARICODE[i];
  if (!/^1(?:0?1)*$/.test(bits)) {
    throw new Error(`PSK31 varicode ${i} invalid (must start/end with 1, no '00'): ${bits}`);
  }
  const key = parseInt(bits, 2);
  if (VARICODE_REVERSE.has(key)) {
    throw new Error(`PSK31 varicode collision at ${i} (${bits})`);
  }
  VARICODE_REVERSE.set(key, i);
}

/**
 * Encode text to a varicode bit array (0/1 values), with the standard '00'
 * gap appended after every character. Chars outside ASCII 0-127 become '?'.
 * @param {string} text
 * @returns {Uint8Array}
 */
function varicodeEncode(text) {
  const out = [];
  for (const ch of String(text)) {
    let code = ch.codePointAt(0);
    if (code > 127) code = 63; // '?'
    const bits = VARICODE[code];
    for (let i = 0; i < bits.length; i++) out.push(bits.charCodeAt(i) - 48);
    out.push(0, 0);
  }
  return Uint8Array.from(out);
}

/**
 * Batch-decode a varicode bit array (0/1 values) to text. Convenience
 * wrapper over the same FSM the streaming decoder uses; a trailing
 * character without its closing '00' gap is not emitted (matches on-air
 * behavior — the gap is the delimiter).
 * @param {Uint8Array|number[]} bits
 * @returns {string}
 */
function varicodeDecodeBits(bits) {
  let vcode = 0;
  let last = 1;
  let out = '';
  for (let i = 0; i < bits.length; i++) {
    const b = bits[i] ? 1 : 0;
    if (b === 0 && last === 0) {
      const c = vcode >> 1; // strip the first gap bit accumulated below
      if (c >= 1 && VARICODE_REVERSE.has(c)) out += String.fromCharCode(VARICODE_REVERSE.get(c));
      vcode = 0;
    } else {
      vcode = (vcode << 1) | b;
      if (vcode > VCODE_MAX) vcode = 0;
    }
    last = b;
  }
  return out;
}

// ---- filter design ---------------------------------------------------------

/**
 * Windowed-sinc lowpass (Blackman), normalized to unity DC gain.
 * @param {number} taps  odd tap count
 * @param {number} fcHz  cutoff
 * @param {number} fs    sample rate
 * @returns {Float32Array}
 */
function designLowpass(taps, fcHz, fs) {
  const h = new Float32Array(taps);
  const M = (taps - 1) / 2;
  const w = (2 * Math.PI * fcHz) / fs;
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const k = n - M;
    const sinc = k === 0 ? w / Math.PI : Math.sin(w * k) / (Math.PI * k);
    const win = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (taps - 1))
              + 0.08 * Math.cos((4 * Math.PI * n) / (taps - 1));
    h[n] = sinc * win;
    sum += h[n];
  }
  for (let n = 0; n < taps; n++) h[n] /= sum;
  return h;
}

/** Hann pulse (raised cosine spanning the full length), normalized Σ=1. */
function hannPulse(taps) {
  const h = new Float32Array(taps);
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    h[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (taps - 1)));
    sum += h[n];
  }
  for (let n = 0; n < taps; n++) h[n] /= sum;
  return h;
}

// ---- TX modulator ----------------------------------------------------------

/**
 * DBPSK-modulate a bit array at 31.25 baud with cosine keying.
 * Bit 0 = 180° phase reversal at the symbol boundary, bit 1 = no change.
 * The envelope dips to zero through each reversal (quarter-sine ramps per
 * half-symbol), which is what keeps PSK31's occupied bandwidth ~62 Hz.
 * Buffer start/end are treated as reversals so the waveform gets free
 * 16 ms anti-click ramps.
 * @param {Uint8Array|number[]} bits
 * @param {number} freqHz  audio center
 * @param {{sampleRate?:number, peak?:number}} [opts]
 * @returns {Float32Array} 12 kHz PCM, exactly bits.length symbols long
 */
function modulatePsk31(bits, freqHz, opts = {}) {
  const fs = opts.sampleRate || SAMPLE_RATE;
  const peak = opts.peak != null ? opts.peak : 1.0;
  const sps = Math.round(fs / BAUD);
  const half = sps / 2;
  const n = bits.length;
  const signs = new Int8Array(n);
  let s = 1;
  for (let i = 0; i < n; i++) {
    if (!bits[i]) s = -s;
    signs[i] = s;
  }
  const out = new Float32Array(n * sps);
  let phase = 0;
  const dphi = (2 * Math.PI * freqHz) / fs;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const si = signs[i];
    const revIn = i === 0 || signs[i - 1] !== si;
    const revOut = i === n - 1 || signs[i + 1] !== si;
    for (let j = 0; j < sps; j++) {
      let A = 1;
      if (j < half) {
        if (revIn) A = Math.sin((Math.PI * j) / sps);
      } else if (revOut) {
        A = Math.sin((Math.PI * (sps - j)) / sps);
      }
      out[k++] = peak * A * si * Math.sin(phase);
      phase += dphi;
      if (phase > Math.PI) phase -= 2 * Math.PI; // keep bounded for precision
    }
  }
  return out;
}

/** Assemble the on-air frame: idle preamble + varicode(text) + carrier postamble. */
function frameBits(text) {
  const msg = varicodeEncode(text);
  const bits = new Uint8Array(TX_PREAMBLE_SYMBOLS + msg.length + TX_POSTAMBLE_SYMBOLS);
  // preamble: zeros (reversal every symbol = idle) — already zero-filled
  bits.set(msg, TX_PREAMBLE_SYMBOLS);
  bits.fill(1, TX_PREAMBLE_SYMBOLS + msg.length); // postamble: steady carrier
  return bits;
}

// ---- engine ----------------------------------------------------------------

class PskEngine extends EventEmitter {
  constructor() {
    super();
    // Contract fields (read/written externally by jtcat-manager / main.js)
    this._running = false;
    this._txEnabled = false;
    this._txActive = false;
    this._txFreq = 1500;   // audio center — PSK is transceive, RX tracks TX
    this._rxFreq = 1500;
    this._mode = 'PSK31';
    this._txMessage = '';
    this._txSamples = null;
    this._txRenderedMsg = '';
    this._txRenderedFreq = 0;
    this._txEndTimer = null;
    this._holdTxFreq = false;

    // Filters (computed once)
    this._decimFir = designLowpass(DECIM_TAPS, 75, SAMPLE_RATE);
    this._mfFir = hannPulse(MF_TAPS);

    this._resetRx();
  }

  _resetRx() {
    this._ncoPhase = 0;
    this._afcHz = 0;
    this._inI = new Float32Array(IN_RING);
    this._inQ = new Float32Array(IN_RING);
    this._inPos = 0;
    this._decimCount = 0;
    this._mfI = new Float32Array(MF_TAPS);
    this._mfQ = new Float32Array(MF_TAPS);
    this._mfPos = 0;
    this._bbI = new Float32Array(AFC_COARSE_N);
    this._bbQ = new Float32Array(AFC_COARSE_N);
    this._bbPos = 0;
    this._bbCount = 0;
    this._bitclk = 0;
    this._syncbuf = new Float32Array(SPS_BB);
    this._prevI = 0;
    this._prevQ = 0;
    this._havePrev = false;
    this._quality = 0;
    this._dcd = false;
    this._dcdShift = 0;
    this._vcode = 0;
    this._vLastBit = 1;
    this._pendingChars = '';
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._resetRx();
    this.emit('status', { state: 'running', mode: this._mode });
  }

  stop() {
    this._running = false;
    if (this._txEndTimer) {
      clearTimeout(this._txEndTimer);
      this._txEndTimer = null;
    }
    if (this._txActive) {
      this._txActive = false;
      this.emit('tx-end', {});
    }
    this._txSamples = null;
    this._txRenderedMsg = '';
    this.emit('status', { state: 'stopped' });
  }

  /**
   * Feed mono 12 kHz audio. Runs the whole RX chain synchronously — state
   * persists across calls, so any chunk size (1 sample to seconds) decodes
   * identically. Skipped during TX: the rig's RX is muted while keying, and
   * decoding our own sidetone would only feed garbage to the squelch.
   * @param {Float32Array} samples
   */
  feedAudio(samples) {
    if (!this._running || this._txActive) return;
    if (!samples || !samples.length) return;
    const fir = this._decimFir;
    const mf = this._mfFir;
    const inI = this._inI;
    const inQ = this._inQ;
    let pos = this._inPos;
    let phase = this._ncoPhase;
    let decim = this._decimCount;
    const dphiPerSample = (2 * Math.PI) / SAMPLE_RATE;

    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      inI[pos] = x * Math.cos(phase);
      inQ[pos] = -x * Math.sin(phase);
      pos = (pos + 1) & IN_MASK;
      // AFC retunes the NCO between samples; the discontinuity-free phase
      // accumulator plus differential detection make that safe.
      phase += dphiPerSample * (this._rxFreq + this._afcHz);
      if (phase > Math.PI) phase -= 2 * Math.PI;
      if (++decim >= DECIM) {
        decim = 0;
        let bi = 0;
        let bq = 0;
        for (let k = 0; k < DECIM_TAPS; k++) {
          const idx = (pos - 1 - k) & IN_MASK;
          bi += fir[k] * inI[idx];
          bq += fir[k] * inQ[idx];
        }
        this._processBaseband(bi, bq, mf);
      }
    }
    this._inPos = pos;
    this._ncoPhase = phase;
    this._decimCount = decim;

    if (this._pendingChars) {
      const q = Math.max(1e-3, Math.min(0.999, this._quality));
      this.emit('psk-text', {
        chars: this._pendingChars,
        freqHz: Math.round((this._rxFreq + this._afcHz) * 10) / 10,
        snrDb: Math.max(-5, Math.min(30, Math.round(10 * Math.log10(q / (1 - q))))),
        metric: Math.round(100 * Math.max(0, this._quality)),
      });
      this._pendingChars = '';
    }
  }

  /** One 500 Hz baseband sample through matched filter, timing, and decode. */
  _processBaseband(bi, bq, mf) {
    // Coarse-AFC history (pre matched filter)
    this._bbI[this._bbPos] = bi;
    this._bbQ[this._bbPos] = bq;
    this._bbPos = (this._bbPos + 1) % AFC_COARSE_N;
    // Coarse AFC runs even with the squelch OPEN: an offset past ±baud/4
    // (7.8 Hz) makes the fine loop false-lock on the DBPSK alias at
    // Δf − 15.6 Hz, and the instant-DCD opens the squelch on the preamble
    // before a closed-only check would ever fire. The ≥1.5 Hz snap floor in
    // _coarseAfc keeps this from fighting the fine loop once locked.
    if (++this._bbCount >= AFC_COARSE_EVERY) {
      this._bbCount = 0;
      this._coarseAfc();
    }

    // Matched filter (symmetric pulse, so tap order vs ring order is moot)
    const mI = this._mfI;
    const mQ = this._mfQ;
    mI[this._mfPos] = bi;
    mQ[this._mfPos] = bq;
    this._mfPos = (this._mfPos + 1) % MF_TAPS;
    let zi = 0;
    let zq = 0;
    for (let k = 0; k < MF_TAPS; k++) {
      const idx = (this._mfPos + k) % MF_TAPS;
      zi += mf[k] * mI[idx];
      zq += mf[k] * mQ[idx];
    }
    const mag = Math.sqrt(zi * zi + zq * zq);

    // Bit clock: per-phase envelope EMA + half-vs-half balance detector.
    // Scale-invariant (err is normalized), so no AGC needed. The envelope
    // dips at symbol boundaries (cosine keying), and the loop steers those
    // dips to the wrap point so the wrap sample sits at the envelope peak.
    const sb = this._syncbuf;
    const idx = Math.floor(this._bitclk) & (SPS_BB - 1);
    sb[idx] = 0.8 * sb[idx] + 0.2 * mag;
    let sum = 0;
    let ampsum = 0;
    for (let i = 0; i < SPS_BB / 2; i++) {
      sum += sb[i] - sb[i + SPS_BB / 2];
      ampsum += sb[i] + sb[i + SPS_BB / 2];
    }
    const err = ampsum < 1e-9 ? 0 : sum / ampsum;
    this._bitclk += 1 - err / 5;
    if (this._bitclk < 0) this._bitclk += SPS_BB;
    if (this._bitclk >= SPS_BB) {
      this._bitclk -= SPS_BB;
      this._decideSymbol(zi, zq);
    }
  }

  /** DBPSK decision at the symbol instant + AFC/squelch/varicode updates. */
  _decideSymbol(zi, zq) {
    if (!this._havePrev) {
      this._prevI = zi;
      this._prevQ = zq;
      this._havePrev = true;
      return;
    }
    const dr = zi * this._prevI + zq * this._prevQ;
    const di = zq * this._prevI - zi * this._prevQ;
    this._prevI = zi;
    this._prevQ = zq;
    const bit = dr > 0 ? 1 : 0;
    const dphi = Math.atan2(di, dr);

    // Quality: cos(2·dphi) is +1 at both valid DBPSK phases, -1 at ±90°.
    this._quality += SQL_ALPHA * (Math.cos(2 * dphi) - this._quality);

    // Instant DCD: 16 consecutive identical bits = idle preamble (zeros) or
    // steady carrier (ones) — open immediately instead of waiting for the EMA.
    this._dcdShift = ((this._dcdShift << 1) | bit) >>> 0;
    const low16 = this._dcdShift & 0xFFFF;
    if (low16 === 0 || low16 === 0xFFFF) this._quality = 1;

    const metric = 100 * Math.max(0, this._quality);
    if (!this._dcd && metric >= SQL_OPEN) {
      this._dcd = true;
    } else if (this._dcd && metric < SQL_CLOSE) {
      this._dcd = false;
      this._vcode = 0;
      this._vLastBit = 1;
    }

    if (!this._dcd) return;

    // Fine AFC: fold the symbol phase step to the nearest valid DBPSK phase;
    // the residue is frequency error (±baud/4 = ±7.8 Hz unambiguous).
    let e = dphi;
    if (e > Math.PI / 2) e -= Math.PI;
    else if (e < -Math.PI / 2) e += Math.PI;
    this._afcHz += AFC_FINE_GAIN * ((e * BAUD) / (2 * Math.PI));
    if (this._afcHz > AFC_MAX_HZ) this._afcHz = AFC_MAX_HZ;
    else if (this._afcHz < -AFC_MAX_HZ) this._afcHz = -AFC_MAX_HZ;

    // Varicode FSM
    if (bit === 0 && this._vLastBit === 0) {
      const c = this._vcode >> 1;
      if (c >= 1 && VARICODE_REVERSE.has(c)) {
        this._pendingChars += String.fromCharCode(VARICODE_REVERSE.get(c));
      }
      this._vcode = 0;
    } else {
      this._vcode = (this._vcode << 1) | bit;
      if (this._vcode > VCODE_MAX) this._vcode = 0;
    }
    this._vLastBit = bit;
  }

  /**
   * Coarse AFC while squelch is closed: squaring strips the BPSK modulation,
   * leaving a spectral line at 2·Δf. Direct DFT over ±40 bins of the last
   * 1.024 s of baseband; snap if the peak clearly beats the noise floor.
   * The fine loop closes the ≤0.5 Hz residue after the snap.
   */
  _coarseAfc() {
    const N = AFC_COARSE_N;
    const wr = new Float32Array(N);
    const wi = new Float32Array(N);
    for (let n = 0; n < N; n++) {
      const i = this._bbI[n];
      const q = this._bbQ[n];
      wr[n] = i * i - q * q;
      wi[n] = 2 * i * q;
    }
    // Ring order is a circular shift — phase-only for a DFT, magnitude unchanged.
    let peakP = 0;
    let peakB = 0;
    let sumP = 0;
    for (let b = -AFC_COARSE_BINS; b <= AFC_COARSE_BINS; b++) {
      const step = (-2 * Math.PI * b) / N;
      const cs = Math.cos(step);
      const sn = Math.sin(step);
      let cr = 1;
      let ci = 0;
      let ar = 0;
      let ai = 0;
      for (let n = 0; n < N; n++) {
        ar += wr[n] * cr - wi[n] * ci;
        ai += wr[n] * ci + wi[n] * cr;
        const nr = cr * cs - ci * sn;
        ci = cr * sn + ci * cs;
        cr = nr;
      }
      const p = ar * ar + ai * ai;
      sumP += p;
      if (p > peakP) {
        peakP = p;
        peakB = b;
      }
    }
    const meanP = sumP / (2 * AFC_COARSE_BINS + 1);
    if (meanP > 0 && peakP > AFC_COARSE_MIN_RATIO * meanP) {
      const dfHz = ((peakB * 500) / N) / 2; // line sits at 2·Δf
      if (Math.abs(dfHz) < AFC_COARSE_SNAP_MIN) return;
      let next = this._afcHz + dfHz;
      if (next > AFC_MAX_HZ) next = AFC_MAX_HZ;
      else if (next < -AFC_MAX_HZ) next = -AFC_MAX_HZ;
      this._afcHz = next;
      // A snap this size lands mid-bit-pattern — drop any half-accumulated
      // character rather than emit garbage from the pre-snap phase.
      this._vcode = 0;
      this._vLastBit = 1;
      // Flush the history: samples mixed at the OLD tune still rotate at the
      // old 2·Δf, and a window straddling the snap re-detects that stale line
      // and double-snaps right as the first characters arrive. Zeros are
      // spectrally silent, so the next check sees only post-snap truth.
      this._bbI.fill(0);
      this._bbQ.fill(0);
      this._bbCount = 0;
    }
  }

  // ---- TX -------------------------------------------------------------------

  /**
   * Set the audio center. PSK31 is transceive — RX tracks TX. Resets AFC
   * (the operator just retuned; stale AFC would fight the new center) and
   * re-renders a pending message at the new frequency.
   */
  setTxFreq(hz) {
    const f = Math.max(100, Math.min(3000, hz));
    if (f === this._txFreq && f === this._rxFreq) return;
    this._txFreq = f;
    this._rxFreq = f;
    this._afcHz = 0;
    if (this._txMessage && this._txRenderedFreq !== f) this._renderTx();
  }

  /** Alias — same audio center for both directions. */
  setRxFreq(hz) {
    this.setTxFreq(hz);
  }

  /**
   * Store + pre-render the TX message. Returns a Promise for contract
   * parity with Ft8Engine.setTxMessage (rendering itself is synchronous
   * and sub-millisecond).
   */
  setTxMessage(text) {
    let msg = String(text == null ? '' : text).slice(0, TX_MAX_CHARS);
    this._txMessage = msg;
    if (!msg) {
      this._txSamples = null;
      this._txRenderedMsg = '';
      return Promise.resolve(null);
    }
    this._renderTx();
    return Promise.resolve(this._txSamples);
  }

  _renderTx() {
    let msg = this._txMessage;
    let bits = frameBits(msg);
    // Fit under main.js's 130 s failsafe PTT drop, with margin.
    while (bits.length / BAUD > TX_MAX_SEC && msg.length > 1) {
      msg = msg.slice(0, -10);
      bits = frameBits(msg);
    }
    if (msg !== this._txMessage) {
      this.emit('log', `PSK TX message trimmed to ${msg.length} chars (~${Math.round(bits.length / BAUD)} s) to fit the ${TX_MAX_SEC} s TX cap`);
      this._txMessage = msg;
    }
    this._txSamples = modulatePsk31(bits, this._txFreq);
    this._txRenderedMsg = msg;
    this._txRenderedFreq = this._txFreq;
  }

  /** Pure render for tests/preview — does not touch engine TX state. */
  renderMessage(text, freqHz) {
    const f = freqHz != null ? freqHz : this._txFreq;
    return Promise.resolve(modulatePsk31(frameBits(String(text || '')), f));
  }

  /**
   * Fire TX now — PSK has no slots, so this is the whole trigger. Emits one
   * 'tx-start' with the FT2-immediate payload shape; main.js keys PTT,
   * plays the buffer, and calls txComplete().
   * @returns {boolean} true if TX started
   */
  requestTx() {
    if (!this._running || !this._txEnabled || !this._txMessage || this._txActive) return false;
    if (!this._txSamples || this._txRenderedMsg !== this._txMessage
        || this._txRenderedFreq !== this._txFreq) return false;
    this._txActive = true;
    const safetyMs = Math.round((this._txSamples.length / SAMPLE_RATE) * 1000) + TX_SAFETY_GRACE_MS;
    if (this._txEndTimer) clearTimeout(this._txEndTimer);
    this._txEndTimer = setTimeout(() => {
      if (this._txActive) {
        console.warn('[JTCAT] PSK TX safety timeout — forcing tx-end');
        this._txActive = false;
        this.emit('tx-end', {});
      }
    }, safetyMs);
    this.emit('tx-start', {
      samples: this._txSamples,
      message: this._txMessage,
      freq: this._txFreq,
      slot: '--',
      offsetMs: 0,
    });
    return true;
  }

  /** Signal that TX audio playback has completed (called from main process). */
  txComplete() {
    if (!this._txActive) return;
    this._txActive = false;
    if (this._txEndTimer) {
      clearTimeout(this._txEndTimer);
      this._txEndTimer = null;
    }
    this.emit('tx-end', {});
  }

  // ---- Ft8Engine-contract stubs ----------------------------------------------
  // main.js calls these unconditionally on the active engine; they're
  // FT8-slot/WSPR concepts with no PSK meaning. tryImmediateTx maps to the
  // real trigger so any generic "fire now" caller still works.

  tryImmediateTx() { return this.requestTx(); }
  setMode() { /* PSK31 engine is single-mode; family switches rebuild the slice */ }
  setTxSlot() {}
  setHoldTxFreq(on) { this._holdTxFreq = !!on; }
  setLateStartTx() {}
  setApContext() {}
  setAudioLatencyMs() {}
  setAudioLatencyAuto() {}
  seedAudioLatencyMs() {}
  setWsprDial() {}
  reBaseline() {}
  encodeMessage() { return Promise.resolve(null); }
}

module.exports = {
  PskEngine,
  SAMPLE_RATE,
  BAUD,
  VARICODE,
  varicodeEncode,
  varicodeDecodeBits,
  modulatePsk31,
  designLowpass,
};
