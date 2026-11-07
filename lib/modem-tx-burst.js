// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// TxBurst — one transmission of an external modem (Dire Wolf, ardopcf, VARA)
// as POTACAT saw it: when the modem asked for PTT, when its audio started and
// stopped flowing through POTACAT's modem audio path, how loud it was, when
// it asked for PTT off and when the carrier actually dropped. Pure; main.js
// feeds it from the rigctld shim's setPtt hooks and the modem audio server's
// 'tx' event and logs the summary at key-up.
//
// Why: a packet session that connects and then times out (N5XHI, FT-857 +
// TI-3000, #128) leaves a log of "PTT write" lines and nothing about what
// went out while the key was down. Whether the modem's audio began before
// the radio was keyed, how far under full scale it played, and whether the
// tail was cut by the unkey are the questions the next log must answer.

'use strict';

function dbfs(peak) {
  if (!(peak > 0)) return null;
  return Math.round(20 * Math.log10(peak) * 10) / 10;
}

class TxBurst {
  /** @param {{now?: () => number}} [o] a clock, for tests */
  constructor({ now } = {}) {
    this._now = typeof now === 'function' ? now : Date.now;
    this.reset();
  }

  reset() {
    this.keyedAt = 0;
    this.firstAudioAt = 0;
    this.lastAudioAt = 0;
    this.unkeyAskedAt = 0;
    this.samples = 0;
    this.rate = 0;
    this.chunks = 0;
    this.peak = 0;
  }

  /** PTT is being requested (the modem keyed through the shim). */
  keyDown() {
    this.reset();
    this.keyedAt = this._now();
  }

  get active() { return this.keyedAt > 0; }

  /** The modem asked for PTT off; the carrier is still up for the drain hold. */
  unkeyAsked() {
    if (this.keyedAt && !this.unkeyAskedAt) this.unkeyAskedAt = this._now();
  }

  /** Keyed again inside the drain hold: the same over continues. */
  rekeyed() {
    this.unkeyAskedAt = 0;
  }

  /**
   * A chunk of the modem's transmit audio, mono Float32 at `sampleRate`,
   * as it enters POTACAT's radio path (before any level trim).
   */
  noteAudio(pcm, sampleRate) {
    if (!this.keyedAt || !pcm || !pcm.length) return;
    const t = this._now();
    if (!this.firstAudioAt) this.firstAudioAt = t;
    this.lastAudioAt = t;
    this.samples += pcm.length;
    if (sampleRate > 0) this.rate = sampleRate;
    this.chunks++;
    let p = this.peak;
    for (let i = 0; i < pcm.length; i++) {
      const a = pcm[i] < 0 ? -pcm[i] : pcm[i];
      if (a > p) p = a;
    }
    this.peak = p;
  }

  /**
   * The carrier dropped. Returns the summary (numbers + `text`) and forgets
   * the burst. `gainDb` is the trim the TX leveler applied on the way out.
   * Returns null when nothing was keyed.
   */
  keyUp({ gainDb } = {}) {
    if (!this.keyedAt) return null;
    const now = this._now();
    const o = {
      keyedMs: now - this.keyedAt,
      audioMs: this.rate ? Math.round((this.samples / this.rate) * 1000) : 0,
      chunks: this.chunks,
      firstAudioMs: this.firstAudioAt ? this.firstAudioAt - this.keyedAt : null,
      lastAudioMs: this.lastAudioAt ? this.lastAudioAt - this.keyedAt : null,
      unkeyAskedMs: this.unkeyAskedAt ? this.unkeyAskedAt - this.keyedAt : null,
      peakDbfs: dbfs(this.peak),
      gainDb: Number.isFinite(gainDb) ? Math.round(gainDb * 10) / 10 : null,
    };
    o.text = describeBurst(o);
    this.reset();
    return o;
  }
}

/** One log line for a finished over. */
function describeBurst(o) {
  const asked = o.unkeyAskedMs != null ? `; PTT off asked at +${o.unkeyAskedMs} ms` : '; PTT off was never asked for';
  if (!o.audioMs) return `PTT held ${o.keyedMs} ms — the modem sent NO audio while keyed${asked}`;
  const gain = o.gainDb ? ` (${o.gainDb > 0 ? '+' : ''}${o.gainDb} dB applied on the way out)` : '';
  const peak = o.peakDbfs != null ? `, peak ${o.peakDbfs} dBFS${gain}` : '';
  return `PTT held ${o.keyedMs} ms: modem audio ${o.audioMs} ms (started +${o.firstAudioMs} ms, ended +${o.lastAudioMs} ms)${peak}${asked}`;
}

module.exports = { TxBurst, describeBurst, dbfs };
