'use strict';
// Decoded FreeDV speech level for the ECHOCAT audio track (FDV1).
//
// The phone hears decoded FreeDV on the same track as the radio audio, so it
// is brought to roughly the level of normal SSB receive audio: switching
// between FreeDV and SSB does not jump, and RX Level on the phone keeps its
// meaning. A slow follower of the speech RMS sets one gain; silence (squelch,
// gaps between overs) leaves it alone, so the noise floor is never pumped up.
//
// Dual-mode: require() in tests, window.FreedvSpeechLevel in remote-audio.html.

(function (root) {
  const TARGET_RMS = 0.1;      // about -20 dBFS, where SSB receive audio sits
  const SILENCE_RMS = 0.003;   // below this a frame does not move the level
  const MIN_GAIN = 0.1;
  const MAX_GAIN = 8;
  const FOLLOW = 0.15;         // per-frame smoothing of the measured RMS

  function rmsOf(samples) {
    if (!samples || !samples.length) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  }

  function createLeveller() {
    let level = 0;  // smoothed RMS of speech frames seen so far
    return {
      // Int16Array (or array of ints) in, Float32Array out at the target level.
      process(int16) {
        const n = int16 ? int16.length : 0;
        const out = new Float32Array(n);
        for (let i = 0; i < n; i++) out[i] = int16[i] / 32768;
        const r = rmsOf(out);
        if (r >= SILENCE_RMS) level = level ? level + FOLLOW * (r - level) : r;
        const gain = level ? Math.min(MAX_GAIN, Math.max(MIN_GAIN, TARGET_RMS / level)) : 1;
        for (let i = 0; i < n; i++) {
          const v = out[i] * gain;
          out[i] = v > 1 ? 1 : (v < -1 ? -1 : v);
        }
        return out;
      },
      reset() { level = 0; },
      get level() { return level; },
    };
  }

  const api = { createLeveller, rmsOf, TARGET_RMS, MAX_GAIN, MIN_GAIN, SILENCE_RMS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FreedvSpeechLevel = api;
})(typeof window !== 'undefined' ? window : globalThis);
