// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Mercury audio bridge — pure format/rate conversion + the per-rig/per-OS
// audio-strategy decision. This is the correctness-critical core of Phase 4;
// the impure FIFO transport and the main.js RX-tap/TX-dispatch pumping (Phase
// 4b) sit on top of it.
//
// Mercury's `fifo` backend carries raw **s32le mono @ 8 kHz** (audioio.c). It
// is a POSIX FIFO (`open()` + O_NONBLOCK, `#ifndef FF_WIN`) — so the direct
// bridge is Linux/mac only; on Windows Mercury uses a real audio device.
// POTACAT's engines run at 12 kHz float32, so the bridge resamples 8 kHz ↔
// 12 kHz and converts s32le ↔ float32 at the FIFO boundary.

'use strict';

const path = require('path');

const MERCURY_FIFO_RATE = 8000;   // Mercury fifo backend sample rate
const S32_POS_FULL = 2147483647;  // 2^31 - 1
const S32_SCALE = 2147483648;     // 2^31

/** Decode raw little-endian s32 PCM bytes to normalized float32 [-1,1). */
function s32leToF32(buf) {
  const n = Math.floor((buf ? buf.length : 0) / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt32LE(i * 4) / S32_SCALE;
  return out;
}

/** Encode normalized float32 [-1,1] to little-endian s32 PCM bytes (clamped). */
function f32ToS32LE(f32) {
  const src = f32 instanceof Float32Array ? f32 : Float32Array.from(f32 || []);
  const buf = Buffer.allocUnsafe(src.length * 4);
  for (let i = 0; i < src.length; i++) {
    let s = src[i];
    if (s > 1) s = 1; else if (s < -1) s = -1;
    buf.writeInt32LE(Math.round(s * S32_POS_FULL), i * 4);
  }
  return buf;
}

/**
 * Continuity-preserving linear resampler for a chunked stream. Unlike a
 * stateless per-buffer resample (which clamps at each buffer's edges and so
 * clicks at chunk boundaries), this carries the fractional read phase and the
 * last input sample across calls, so process(a)+process(b) ≈ resampling a∥b.
 */
class StreamingResampler {
  constructor(fromRate, toRate) {
    this.from = fromRate;
    this.to = toRate;
    this.step = fromRate / toRate;  // input samples advanced per output sample
    this.phase = 0;                 // next read position, in input samples, rel. to current chunk start (may be negative → prev)
    this.prev = 0;                  // last input sample of the previous chunk
  }

  process(input) {
    const inp = input instanceof Float32Array ? input : Float32Array.from(input || []);
    const n = inp.length;
    if (!n) return new Float32Array(0);
    if (this.from === this.to) { this.prev = inp[n - 1]; return Float32Array.from(inp); }

    const out = [];
    let p = this.phase;
    // Produce an output for read-position p while its upper neighbor (i0+1) is
    // available in this chunk, i.e. p <= n-1.
    while (p <= n - 1) {
      const i0 = Math.floor(p);
      const frac = p - i0;
      const s0 = i0 < 0 ? this.prev : inp[i0];
      const s1 = (i0 + 1) < 0 ? this.prev : inp[i0 + 1];
      out.push(s0 + (s1 - s0) * frac);
      p += this.step;
    }
    // Shift the reference frame to the next chunk and carry the boundary sample.
    this.phase = p - n;
    this.prev = inp[n - 1];
    return Float32Array.from(out);
  }
}

/**
 * Decide how Mercury should reach the radio for the given rig and OS.
 *   - 'device' → Mercury opens a real sound device (-x wasapi/alsa/coreaudio).
 *   - 'fifo'   → POTACAT bridges Mercury's s32le FIFOs into its own SmartSDR/
 *                Icom routes (no virtual audio device). LINUX/MAC ONLY.
 * `auto` picks fifo for direct-to-radio rig families (Flex, Icom-network) on a
 * fifo-capable OS, else a device. On Windows fifo is never chosen (Mercury's
 * fifo backend is POSIX-only) even if explicitly requested.
 *
 * @param {object} o
 * @param {object} [o.settings]
 * @param {string} [o.rigFamily]   'flex' | 'icom' | 'icom-network' | 'kenwood' | 'yaesu' | ...
 * @param {string} [o.platform]    process.platform
 * @param {string} [o.fifoDir]     dir for the FIFO special files (e.g. userData)
 * @returns {{useFifo:boolean, soundSystem:string, inputDevice:string, outputDevice:string,
 *            rxFifoPath:?string, txFifoPath:?string, reason:string}}
 */
function resolveMercuryAudio({ settings = {}, rigFamily = '', platform = process.platform, fifoDir = '' } = {}) {
  const mode = settings.mercuryAudioBridge || 'auto';
  const fifoCapable = platform !== 'win32'; // spike: Mercury fifo backend is #ifndef FF_WIN
  const directRig = rigFamily === 'flex' || rigFamily === 'icom' || rigFamily === 'icom-network';

  let useFifo;
  let reason;
  if (mode === 'device') { useFifo = false; reason = 'device (forced)'; }
  else if (mode === 'fifo') {
    useFifo = fifoCapable;
    reason = fifoCapable ? 'fifo (forced)' : 'fifo requested but Windows is device-only (Mercury fifo is POSIX-only)';
  } else { // auto
    useFifo = fifoCapable && directRig;
    reason = useFifo ? `auto → fifo (${rigFamily} direct)` : (fifoCapable ? `auto → device (${rigFamily || 'generic'} rig)` : 'auto → device (Windows)');
  }

  // FIFOs only exist on POSIX, so always build POSIX paths regardless of host.
  const rxFifoPath = useFifo && fifoDir ? path.posix.join(fifoDir, 'mercury-rx.fifo') : null; // POTACAT writes radio RX → Mercury reads (-i)
  const txFifoPath = useFifo && fifoDir ? path.posix.join(fifoDir, 'mercury-tx.fifo') : null; // Mercury writes modem TX → POTACAT reads (-o)

  return {
    useFifo,
    soundSystem: useFifo ? 'fifo' : (settings.mercurySoundSystem || 'auto'),
    inputDevice: useFifo ? (rxFifoPath || '') : (settings.mercuryInputDevice || ''),
    outputDevice: useFifo ? (txFifoPath || '') : (settings.mercuryOutputDevice || ''),
    rxFifoPath,
    txFifoPath,
    reason,
  };
}

module.exports = {
  MERCURY_FIFO_RATE,
  s32leToF32,
  f32ToS32LE,
  StreamingResampler,
  resolveMercuryAudio,
};
