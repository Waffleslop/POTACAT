// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// The last second of the radio's receive audio at 12 kHz mono, for the
// phone's VFO waterfall when no FT8/JS8 engine is running (capability
// 'rx-spectrum'; echocat 2026-10-27, Casey's go 10-28). main.js feeds it
// from whichever RX audio it already has — the Flex (SmartSDR Direct) and
// Icom Network streams in main, or the ECHOCAT audio window's spectrum-only
// capture of a sound-card radio — and lib/spectrum-fft.js computeSpectrumBins
// reads it exactly as it reads the engine's buffer, so the bins on the wire
// are the same shape (0..255, 0..3000 Hz).
'use strict';

const RATE = 12000;

class RxSpectrumRing {
  constructor(seconds = 1) {
    this.buffer = new Float32Array(Math.round(RATE * seconds));
    this.offset = 0;          // next write position (computeSpectrumBins reads behind it)
    this.lastPushAt = 0;
  }

  /** Append a frame of mono PCM at any rate (resampled to 12 kHz). */
  push(pcm, sampleRate, now = Date.now()) {
    const src = pcm instanceof Float32Array ? pcm : new Float32Array(pcm || []);
    if (!src.length) return;
    const rate = Number(sampleRate) || RATE;
    const step = rate / RATE;
    const n = Math.max(1, Math.floor(src.length / step));
    const buf = this.buffer;
    let w = this.offset;
    if (step === 1) {
      for (let i = 0; i < n; i++) { buf[w] = src[i]; w = (w + 1) % buf.length; }
    } else if (Number.isInteger(step)) {
      // 24k / 48k: average each group (a cheap low-pass before decimating).
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let k = 0; k < step; k++) s += src[i * step + k];
        buf[w] = s / step; w = (w + 1) % buf.length;
      }
    } else {
      for (let i = 0; i < n; i++) {
        const pos = i * step;
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, src.length - 1);
        buf[w] = src[i0] + (src[i1] - src[i0]) * (pos - i0);
        w = (w + 1) % buf.length;
      }
    }
    this.offset = w;
    this.lastPushAt = now;
  }

  /** Audio arrived within maxAgeMs (a stopped stream must not paint stale bins). */
  fresh(now = Date.now(), maxAgeMs = 1500) {
    return this.lastPushAt > 0 && now - this.lastPushAt <= maxAgeMs;
  }

  clear() { this.buffer.fill(0); this.offset = 0; this.lastPushAt = 0; }
}

module.exports = { RxSpectrumRing, RATE };
