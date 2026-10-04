'use strict';
// JTTY encoder: operator text -> frames -> tones -> audio.
//
// JTTY (WSJT-X 3.2, K1JT) is a keyboard-to-keyboard and contest mode with
// RTTY's feel and far better weak-signal performance: 4-GFSK at 31.25 baud,
// 127 Hz wide, 1.888 s frames, no timed T/R sequences. Phase 1 of
// docs/jtty-integration-plan.md: this module is the transmit side, pure JS,
// bit-exact to the reference grammar (test/jtty-codec-test.js). The receive
// side is Phase 2.

const codec = require('./source-codec');
const fec = require('./fec');
const waveform = require('./waveform');

const PROFILE_NAMES = { unknown: codec.PROFILE.UNKNOWN, 'field-day': codec.PROFILE.FIELD_DAY, 'rtty-roundup': codec.PROFILE.RTTY };

function profileOf(p) {
  if (p == null || p === '') return codec.PROFILE.UNKNOWN;
  if (typeof p === 'number') return p;
  const v = PROFILE_NAMES[String(p).toLowerCase()];
  return v == null ? -1 : v;
}

/**
 * Pack text into frames without rendering audio.
 * @returns {{ok:true, text, frames, words, nframes, durationSec} | {ok:false, error}}
 */
function pack(text, profile) {
  const r = codec.packMessage(text, profileOf(profile));
  if (r.error) return { ok: false, error: r.error };
  return {
    ok: true,
    text: r.text,
    frames: r.frames,
    words: r.frames.map(codec.frameHex),
    nframes: r.frames.length,
    durationSec: r.frames.length * fec.SYMBOLS_PER_FRAME / waveform.BAUD,
  };
}

/**
 * Encode a message to audio.
 * @param {string} text
 * @param {object} [o] { profile: 'unknown'|'field-day'|'rtty-roundup', f0: 1500, sampleRate: 12000 }
 * @returns pack()'s result plus { tones, pcm: Float32Array, sampleRate, f0 }
 */
function encode(text, o) {
  const opts = o || {};
  const p = pack(text, opts.profile);
  if (!p.ok) return p;
  if (p.nframes === 0) return { ok: false, error: 'empty message' };
  const tones = fec.framesToTones(p.frames);
  const sampleRate = opts.sampleRate || waveform.SAMPLE_RATE;
  const f0 = opts.f0 == null ? 1500 : opts.f0;
  const pcm = waveform.generateWaveform(tones, { f0, sampleRate });
  return Object.assign(p, { tones, pcm, sampleRate, f0 });
}

/** Frames -> text, the receive-side rendering (used by the Phase 2 decoder and tests). */
function decodeFrames(frames) { return codec.unpackMessage(frames); }

module.exports = { pack, encode, decodeFrames, profileOf, PROFILE_NAMES, codec, fec, waveform, JTTY_SPEC_TAG: codec.JTTY_SPEC_TAG };
