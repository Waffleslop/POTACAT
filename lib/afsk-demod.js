// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// AFSK APRS demodulator, receive only, pure JavaScript.
//
// Written from the published specifications and textbook DSP: Bell 202 tones
// (1200 baud, mark 1200 Hz / space 2200 Hz), the 300-baud HF APRS convention
// (1600 / 1800 Hz on USB, APRS Protocol Reference 1.0.1), AX.25 2.2 (NRZI,
// HDLC flags, bit stuffing, the address field and the FCS). No code was taken
// from Dire Wolf, multimon-ng or any other demodulator.
//
// It is the shared core for ECHOCAT's own decoder (APRS phase 9, vendored into
// the phone app) and the desktop's fallback when Dire Wolf is absent. The core
// uses only plain arrays, typed arrays and Math: no Buffer, no WebAssembly,
// no SharedArrayBuffer, so it runs under React Native Hermes unchanged.
//
// Signal chain, per decoder:
//   input -> (integer decimation with a windowed-sinc low-pass, when the
//   input rate is a multiple of the working rate) -> a band-pass around the
//   tones -> two quadrature correlators, one per tone, each a running sum
//   over a little more than one bit (1.2 bits at 1200 baud, 1.4 at 300) ->
//   soft bit = w * |mark|^2 - |space|^2 (w is the slicer's twist weight) ->
//   bit clock: a digital PLL nudged toward each zero crossing of the soft
//   bit (located to a fraction of a sample), sampling at mid-bit ->
//   NRZI (no change = 1) -> HDLC (flags, abort on seven 1s, unstuffing) ->
//   FCS check (CRC-16/X.25) -> AX.25 address field -> TNC2 text.
//
// 2 m (1200 baud): one decoder, three slicers with the mark weighted 0, +6
// and -6 dB, for the de-emphasis twist of FM radios.
// HF (300 baud): N decoders with the tone pair shifted across a span
// (default 7 at 30 Hz, -90..+90 Hz), one slicer each.
// Any frame that passes its FCS is kept; copies of the same frame from
// several decoders or slicers within dedupeMs of audio time are dropped.
//
// API:
//   const d = createDemod({ sampleRate: 12000, mode: '1200' | '300',
//                           span: { decoders: 7, stepHz: 30 } });
//   d.onFrame((f) => { f.tnc2 ... });   // returns an unsubscribe function
//   d.push(float32Samples);             // any length, any time
//   d.stats();                          // counters
//
// Frame object: { tnc2, from, to, path[], info (latin1 string), pid,
//   control, bytes (Uint8Array, FCS removed), fcs, decoder, offsetHz,
//   slicer, sample (input-rate index of the closing flag), time (seconds) }.
// decoder/offsetHz name the decoder that finished the frame first. Each
// decoder copes with tens of Hz either side, so it is not a tuning measurement.
// Only UI frames (APRS) are delivered; other AX.25 frames are counted in stats.
//
// Dual-mode: require() in Node, window.AfskDemod in a page.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AfskDemod = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MODES = {
    // win: correlator length in bits. bpTaps: band-pass length at the working
    // rate; its edges come from the tones, the span and the baud rate. Both
    // were picked by measuring decode rates in white noise (test/afsk-demod-test.js).
    1200: { baud: 1200, mark: 1200, space: 2200, workRate: 12000, decoders: 1, stepHz: 0, slicers: [1, 4, 0.25], win: 1.2, bpTaps: 31, bpMargin: 300 },
    300: { baud: 300, mark: 1600, space: 1800, workRate: 12000, decoders: 7, stepHz: 30, slicers: [1], win: 1.4, bpTaps: 63, bpMargin: 200 },
  };

  const MIN_FRAME = 18; // two addresses (14) + control + PID + FCS (2)
  const MAX_FRAME = 330;
  const MAX_DIGIS = 8;

  // ── CRC-16/X.25 (AX.25 FCS): reflected 0x8408, init 0xFFFF, out ^0xFFFF ──
  const CRC_TABLE = (function () {
    const t = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? ((c >>> 1) ^ 0x8408) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();

  /** The FCS of bytes[0..len): the value sent, low byte first. */
  function crc16x25(bytes, len) {
    const n = len == null ? bytes.length : len;
    let c = 0xffff;
    for (let i = 0; i < n; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xff];
    return (c ^ 0xffff) & 0xffff;
  }
  /** True when the last two bytes are the FCS of the rest. */
  function fcsOk(bytes, len) {
    const n = len == null ? bytes.length : len;
    if (n < 3) return false;
    const want = bytes[n - 2] | (bytes[n - 1] << 8);
    return crc16x25(bytes, n - 2) === want;
  }

  // ── AX.25 address field and UI frame -> TNC2 ───────────────────────────────
  function decodeAddress(bytes, at) {
    let call = '';
    let ended = false;
    for (let i = 0; i < 6; i++) {
      const b = bytes[at + i];
      if (b & 1) return null; // the extension bit is only ever set in byte 7
      const c = b >> 1;
      if (c === 0x20) { ended = true; continue; }
      if (ended) return null; // a character after padding
      const ok = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a);
      if (!ok) return null;
      call += String.fromCharCode(c);
    }
    if (!call) return null;
    const s = bytes[at + 6];
    const ssid = (s >> 1) & 0x0f;
    return { call: ssid ? call + '-' + ssid : call, h: (s & 0x80) !== 0, last: (s & 1) !== 0 };
  }

  /**
   * An AX.25 frame without its FCS -> { from, to, path[], info, pid, control,
   * tnc2 } for a UI frame, or null. The TNC2 path marks the last digipeater
   * whose has-been-repeated bit is set with '*', the APRS convention.
   */
  function ax25ToTnc2(bytes, len) {
    const n = len == null ? bytes.length : len;
    const addrs = [];
    let at = 0;
    for (;;) {
      if (at + 7 > n) return null;
      const a = decodeAddress(bytes, at);
      if (!a) return null;
      addrs.push(a);
      at += 7;
      if (a.last) break;
      if (addrs.length > 2 + MAX_DIGIS) return null;
    }
    if (addrs.length < 2) return null;
    if (at + 2 > n) return null;
    const control = bytes[at];
    if ((control & 0xef) !== 0x03) return null; // UI, with or without P/F
    const pid = bytes[at + 1];
    let info = '';
    for (let i = at + 2; i < n; i++) info += String.fromCharCode(bytes[i]);
    const digis = addrs.slice(2);
    let lastH = -1;
    for (let i = 0; i < digis.length; i++) if (digis[i].h) lastH = i;
    const path = digis.map((d, i) => (i === lastH ? d.call + '*' : d.call));
    const to = addrs[0].call;
    const from = addrs[1].call;
    const head = from + '>' + to + (path.length ? ',' + path.join(',') : '');
    return { from, to, path, info, pid, control, tnc2: head + ':' + info };
  }

  // ── HDLC deframer: NRZI-decoded bits in, FCS-checked frames out ───────────
  function createHdlc(onFrame) {
    const buf = new Uint8Array(MAX_FRAME + 2);
    let nbits = 0;
    let ones = 0;
    let inFrame = false;
    const st = { flags: 0, aborts: 0, fcsFail: 0, tooLong: 0, ok: 0 };

    function bit(b) {
      if (b) {
        ones++;
        if (ones >= 7) { // abort / idle: drop whatever was collecting
          if (ones === 7 && inFrame && nbits > 7) st.aborts++;
          inFrame = false; nbits = 0;
          return;
        }
        append(1);
        return;
      }
      if (ones === 6) { // 0 1 1 1 1 1 1 0: a flag
        st.flags++;
        if (inFrame) {
          const n = nbits - 7; // the flag's 0 and six 1s went in
          if (n >= MIN_FRAME * 8 && (n & 7) === 0) {
            const len = n >> 3;
            if (fcsOk(buf, len)) { st.ok++; onFrame(buf.slice(0, len)); } else st.fcsFail++;
          }
        }
        inFrame = true; nbits = 0; ones = 0;
        return;
      }
      if (ones === 5) { ones = 0; return; } // a stuffed 0
      ones = 0;
      append(0);
    }
    function append(b) {
      if (!inFrame) return;
      if (nbits >= (MAX_FRAME + 1) * 8) { st.tooLong++; inFrame = false; nbits = 0; return; }
      const j = nbits >> 3, k = nbits & 7;
      buf[j] = (buf[j] & ~(1 << k)) | (b << k);
      nbits++;
    }
    return { bit, stats: st, inFrame: () => inFrame };
  }

  // ── Front end: decimating low-pass (windowed sinc, Blackman) ──────────────
  function makeDecimator(factor, inRate) {
    if (factor <= 1) return null;
    const taps = 8 * factor + 1;
    const fc = (0.45 * inRate / factor) / inRate; // cycles per input sample
    const h = new Float64Array(taps);
    const mid = (taps - 1) / 2;
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      const x = i - mid;
      const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
      const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (taps - 1));
      h[i] = sinc * w; sum += h[i];
    }
    for (let i = 0; i < taps; i++) h[i] /= sum;
    const ring = new Float64Array(taps * 2); // doubled so a window is contiguous
    let pos = 0, phase = 0;
    return {
      /** One input sample in; returns NaN or the next output sample. */
      step(x) {
        ring[pos] = x; ring[pos + taps] = x;
        pos = pos + 1 === taps ? 0 : pos + 1;
        if (++phase < factor) return NaN;
        phase = 0;
        let acc = 0;
        for (let i = 0; i < taps; i++) acc += h[i] * ring[pos + i];
        return acc;
      },
    };
  }

  // ── Band-pass ahead of the correlators (windowed sinc, Hamming) ──────────
  function makeBandpass(f1, f2, taps, rate) {
    const h = new Float64Array(taps);
    const mid = (taps - 1) / 2;
    const lp = (f, x) => (x === 0 ? 2 * f / rate : Math.sin(2 * Math.PI * f / rate * x) / (Math.PI * x));
    for (let i = 0; i < taps; i++) {
      const x = i - mid;
      h[i] = (lp(f2, x) - lp(f1, x)) * (0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1)));
    }
    const ring = new Float64Array(taps * 2);
    let pos = 0;
    return {
      f1, f2,
      step(x) {
        ring[pos] = x; ring[pos + taps] = x;
        pos = pos + 1 === taps ? 0 : pos + 1;
        let acc = 0;
        for (let i = 0; i < taps; i++) acc += h[i] * ring[pos + i];
        return acc;
      },
    };
  }

  // ── One tone pair: two quadrature correlators over one bit ───────────────
  function makeCorrelator(freq, rate, n) {
    const w = 2 * Math.PI * freq / rate;
    const cw = Math.cos(w), sw = Math.sin(w);
    const ri = new Float64Array(n), rq = new Float64Array(n);
    return { cw, sw, c: 1, s: 0, ri, rq, si: 0, sq: 0, pos: 0, n, renorm: 0 };
  }

  function makeSlicer(weight, spb, gains) {
    return {
      weight, step: 1 / spb, gains,
      prev: 0, phase: 0, sampled: false, level: 0, hdlc: null,
    };
  }

  /**
   * createDemod({ sampleRate, mode, span, dedupeMs }) -> { push, onFrame, stats }
   *   mode: '1200' (2 m Bell 202) or '300' (HF, 1600/1800 Hz).
   *   span: { decoders, stepHz } (default 7 at 30 Hz for 300 baud, 1 for 1200),
   *         or a number of decoders; at most 15.
   *   dedupeMs: copies of one frame within this much audio are one (default 1000).
   * For experiments only: slicers (mark power weights), workRate, pll { search, locked }.
   */
  function createDemod(opts) {
    const o = opts || {};
    const sampleRate = Number(o.sampleRate) || 12000;
    const modeKey = String(o.mode == null ? '1200' : o.mode).replace(/[^0-9]/g, '');
    const m = MODES[modeKey];
    if (!m) throw new Error('AFSK mode must be 1200 or 300, not ' + o.mode);
    if (!(sampleRate >= 8000 && sampleRate <= 192000)) throw new Error('sample rate ' + sampleRate + ' out of range');

    let decoders = m.decoders, stepHz = m.stepHz;
    if (typeof o.span === 'number') decoders = o.span;
    else if (o.span && typeof o.span === 'object') {
      if (o.span.decoders != null) decoders = Number(o.span.decoders);
      if (o.span.stepHz != null) stepHz = Number(o.span.stepHz);
    }
    decoders = Math.max(1, Math.min(15, Math.round(decoders) || 1));
    const slicerWeights = Array.isArray(o.slicers) && o.slicers.length ? o.slicers.slice(0, 5) : m.slicers;

    // Working rate: the input rate divided by the largest whole factor that
    // stays at or above the mode's working rate (48000 -> 12000, 44100 -> 14700).
    const workRate = Number(o.workRate) || m.workRate;
    const factor = Math.max(1, Math.floor(sampleRate / workRate));
    const rate = sampleRate / factor;
    const decim = makeDecimator(factor, sampleRate);
    const spb = rate / m.baud;
    const n = Math.max(2, Math.round(spb * m.win));
    const gains = { search: 0.5, locked: 0.15 };
    if (o.pll && typeof o.pll === 'object') {
      if (o.pll.search > 0 && o.pll.search <= 1) gains.search = Number(o.pll.search);
      if (o.pll.locked > 0 && o.pll.locked <= 1) gains.locked = Number(o.pll.locked);
    }
    const dedupeSamples = Math.round(sampleRate * (o.dedupeMs == null ? 1000 : Number(o.dedupeMs)) / 1000);

    const lowOff = -((decoders - 1) / 2) * stepHz;
    const bp = makeBandpass(
      Math.max(100, Math.min(m.mark, m.space) + lowOff - m.bpMargin),
      Math.min(rate / 2 - 100, Math.max(m.mark, m.space) - lowOff + m.bpMargin),
      m.bpTaps, rate);

    const listeners = [];
    const stats = {
      mode: modeKey, sampleRate, workRate: rate, decoders, slicers: slicerWeights.length,
      samples: 0, frames: 0, dupes: 0, nonUi: 0, fcsFail: 0, flags: 0, perDecoder: new Array(decoders).fill(0),
    };
    const recent = []; // { key, sample }
    let inCount = 0; // input samples so far

    const decs = [];
    for (let d = 0; d < decoders; d++) {
      const off = (d - (decoders - 1) / 2) * stepHz;
      const dec = {
        index: d, offsetHz: off,
        mark: makeCorrelator(m.mark + off, rate, n),
        space: makeCorrelator(m.space + off, rate, n),
        slicers: [],
      };
      slicerWeights.forEach((wgt, si) => {
        const sl = makeSlicer(wgt, spb, gains);
        sl.hdlc = createHdlc((bytes) => deliver(bytes, dec, si));
        dec.slicers.push(sl);
      });
      decs.push(dec);
    }

    function deliver(bytes, dec, si) {
      const len = bytes.length - 2;
      const fcs = bytes[len] | (bytes[len + 1] << 8);
      const key = fcs + ':' + len;
      const now = inCount;
      while (recent.length && now - recent[0].sample > dedupeSamples) recent.shift();
      for (let i = 0; i < recent.length; i++) if (recent[i].key === key) { stats.dupes++; return; }
      const body = bytes.subarray(0, len);
      const ui = ax25ToTnc2(body, len);
      if (!ui) { stats.nonUi++; return; }
      recent.push({ key, sample: now });
      stats.frames++;
      stats.perDecoder[dec.index]++;
      const f = {
        tnc2: ui.tnc2, from: ui.from, to: ui.to, path: ui.path, info: ui.info, pid: ui.pid, control: ui.control,
        bytes: body.slice(), fcs, decoder: dec.index, offsetHz: dec.offsetHz, slicer: si,
        sample: now, time: now / sampleRate,
      };
      for (let i = 0; i < listeners.length; i++) {
        try { listeners[i](f); } catch (e) { /* a listener's fault never stops the decoder */ }
      }
    }

    // One correlator step: returns |sum|^2 over the last bit.
    function corr(c, x) {
      // Advance the local oscillator (a rotation), renormalising now and then.
      const nc = c.c * c.cw - c.s * c.sw;
      const ns = c.s * c.cw + c.c * c.sw;
      c.c = nc; c.s = ns;
      if (++c.renorm === 1024) {
        c.renorm = 0;
        const g = 1 / Math.sqrt(nc * nc + ns * ns);
        c.c *= g; c.s *= g;
      }
      const pi = x * c.c, pq = x * c.s;
      const p = c.pos;
      c.si += pi - c.ri[p]; c.sq += pq - c.rq[p];
      c.ri[p] = pi; c.rq[p] = pq;
      c.pos = p + 1 === c.n ? 0 : p + 1;
      return c.si * c.si + c.sq * c.sq;
    }

    function slice(sl, soft) {
      const prev = sl.prev;
      let ph = sl.phase + sl.step;
      // A zero crossing of the soft bit is a bit boundary: pull the clock to it.
      if ((soft > 0) !== (prev > 0) && soft !== prev) {
        const t = prev / (prev - soft); // where between the two samples it crossed
        let e = sl.phase + t * sl.step; // the clock's phase at the crossing (want 0)
        e -= Math.floor(e + 0.5);
        // Hard while hunting for flags, gentle once a flag has been found.
        ph -= (sl.hdlc.inFrame() ? sl.gains.locked : sl.gains.search) * e;
      }
      if (ph < 0) { ph += 1; sl.sampled = true; }
      if (!sl.sampled && ph >= 0.5) {
        // Mid-bit: the decision, interpolated to the exact instant.
        const back = (ph - 0.5) / sl.step; // samples since mid-bit (0..1)
        const v = back >= 1 ? prev : soft + (prev - soft) * back;
        decide(sl, v);
        sl.sampled = true;
      }
      if (ph >= 1) {
        if (!sl.sampled) decide(sl, soft);
        ph -= 1; sl.sampled = false;
      }
      sl.phase = ph;
      sl.prev = soft;
    }

    function decide(sl, v) {
      const level = v > 0 ? 1 : 0;
      sl.hdlc.bit(level === sl.level ? 1 : 0); // NRZI: no change is a 1
      sl.level = level;
    }

    function work(raw) {
      const x = bp.step(raw);
      for (let d = 0; d < decs.length; d++) {
        const dec = decs[d];
        const pm = corr(dec.mark, x);
        const ps = corr(dec.space, x);
        const sls = dec.slicers;
        for (let s = 0; s < sls.length; s++) slice(sls[s], sls[s].weight * pm - ps);
      }
    }

    function push(samples) {
      if (!samples) return;
      const len = samples.length | 0;
      for (let i = 0; i < len; i++) {
        let x = +samples[i];
        if (x !== x) x = 0; // NaN guard
        inCount++;
        if (decim) {
          const y = decim.step(x);
          if (y === y) work(y);
        } else work(x);
      }
      stats.samples = inCount;
    }

    function onFrame(cb) {
      if (typeof cb !== 'function') return function () {};
      listeners.push(cb);
      return function () { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    }

    function getStats() {
      let fcsFail = 0, flags = 0;
      for (const dec of decs) for (const sl of dec.slicers) { fcsFail += sl.hdlc.stats.fcsFail; flags += sl.hdlc.stats.flags; }
      return {
        mode: stats.mode, sampleRate: stats.sampleRate, workRate: stats.workRate,
        decoders: stats.decoders, slicers: stats.slicers,
        offsetsHz: decs.map((d) => d.offsetHz), bandpassHz: [Math.round(bp.f1), Math.round(bp.f2)],
        samples: inCount, seconds: inCount / sampleRate,
        frames: stats.frames, dupes: stats.dupes, nonUi: stats.nonUi, fcsFail, flags,
        perDecoder: stats.perDecoder.slice(),
      };
    }

    return { push, onFrame, stats: getStats };
  }

  return { createDemod, crc16x25, fcsOk, ax25ToTnc2, createHdlc, MODES };
});
