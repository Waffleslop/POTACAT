// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// PreKeyBuffer — the modem's transmit audio that reached POTACAT before the
// modem's own PTT request did.
//
// An external modem (ardopcf, Dire Wolf) asks for PTT and starts writing its
// frame in the same instant. The audio comes straight to POTACAT's modem
// audio socket; the PTT request goes the long way round (ardopcf -> Pat ->
// the rigctld shim), a few milliseconds later. And the socket backends let
// the modem run up to two buffers ahead of the playback clock, so the first
// 200 ms of every frame is written at once, at the very start.
//
// POTACAT used to discard modem audio that arrived while PTT was not yet
// active ("a stray"). That threw away the first 200 ms of 44 of the 50 ARDOP
// connect requests in one operator's log (GitHub #289: every frame 1545 ms
// instead of 1745 ms, first audio +100 ms after key-down). ardopcf's leader
// is 240 ms, so those frames went on the air with 40 ms of leader and no
// gateway could detect them.
//
// So the audio is held, briefly, and sent the moment PTT arrives. Audio that
// is not followed by a PTT request within `maxAgeMs` is dropped as before:
// nothing here ever reaches a transmitter that was not asked to key.
//
// Pure: a clock is injected for tests.

'use strict';

const PREKEY_DEFAULTS = Object.freeze({ maxAgeMs: 500, maxHoldMs: 600 });

class PreKeyBuffer {
  /** @param {{maxAgeMs?:number, maxHoldMs?:number, now?:()=>number}} [o] */
  constructor({ maxAgeMs = PREKEY_DEFAULTS.maxAgeMs, maxHoldMs = PREKEY_DEFAULTS.maxHoldMs, now } = {}) {
    this._maxAgeMs = maxAgeMs;
    this._maxHoldMs = maxHoldMs;
    this._now = typeof now === 'function' ? now : Date.now;
    this._chunks = []; // {pcm, ms, at}
  }

  /** Audio that arrived with no PTT active. Kept (a copy) until take() or until it is too old. */
  hold(pcm, sampleRate) {
    if (!pcm || !pcm.length || !(sampleRate > 0)) return;
    const now = this._now();
    this._expire(now);
    this._chunks.push({ pcm: Float32Array.from(pcm), ms: (pcm.length / sampleRate) * 1000, at: now });
    // Never more than maxHoldMs of audio: the oldest goes first.
    let total = 0;
    for (const c of this._chunks) total += c.ms;
    while (this._chunks.length > 1 && total > this._maxHoldMs) total -= this._chunks.shift().ms;
  }

  /**
   * PTT arrived: everything recent enough to belong to this key-down, in
   * order, and the buffer is emptied.
   * @returns {{chunks: Float32Array[], ms: number}}
   */
  take() {
    this._expire(this._now());
    const chunks = this._chunks.map((c) => c.pcm);
    const ms = Math.round(this._chunks.reduce((n, c) => n + c.ms, 0));
    this._chunks = [];
    return { chunks, ms };
  }

  /** The carrier dropped or the session ended: nothing held may reach the next over. */
  clear() { this._chunks = []; }

  get heldMs() {
    this._expire(this._now());
    return Math.round(this._chunks.reduce((n, c) => n + c.ms, 0));
  }

  _expire(now) {
    while (this._chunks.length && now - this._chunks[0].at > this._maxAgeMs) this._chunks.shift();
  }
}

module.exports = { PreKeyBuffer, PREKEY_DEFAULTS };
