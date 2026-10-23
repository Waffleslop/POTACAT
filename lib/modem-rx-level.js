'use strict';
/**
 * Level control for the radio audio POTACAT hands a soundcard modem (VARA
 * through the virtual cable). K3SBP 2026-10-23, Flex 8600 + VARA HF: the
 * cable carried the receiver's audio at unity, VARA's input VU sat on the red
 * line, and VARA's busy detector then never saw a clear channel ("Waiting for
 * clear channel..." for the whole attempt). VARA wants its input in the green:
 * peaks well under full scale, never clipping.
 *
 * Pure and small: one instance per cable session, `process()` on every chunk.
 * Attack is immediate (a hot chunk is trimmed before it is written), release
 * is slow (a quiet band creeps back up over seconds), and the gain never goes
 * above `maxGain` — this evens out a level, it does not manufacture signal.
 */
class RxLeveler {
  constructor({ target = 0.3, ceiling = 0.5, floor = 0.06, maxGain = 4, minGain = 0.05, releasePerSec = 1.12, floorHoldMs = 4000 } = {}) {
    this.target = target;       // where a hot peak is brought to (-10.5 dBFS)
    this.ceiling = ceiling;     // a peak above this (after gain) trims at once (-6 dBFS)
    this.floor = floor;         // peaks under this for floorHoldMs let the gain creep up
    this.maxGain = maxGain;
    this.minGain = minGain;
    this.releasePerSec = releasePerSec;
    this.floorHoldMs = floorHoldMs;
    this.gain = 1;
    this.peakIn = 0;            // raw peak, held ~500 ms for meters
    this.peakOut = 0;           // after gain
    this.trims = 0;             // how many times the gain was cut
    this._lowSince = 0;
    this._lastAt = 0;
    this._holdUntil = 0;
  }

  get gainDb() { return 20 * Math.log10(this.gain || 1e-9); }

  /** Apply the gain to `f32` (in place, returns it). `now` ms for tests. */
  process(f32, now = Date.now()) {
    if (!f32 || !f32.length) return f32;
    let peak = 0;
    for (let i = 0; i < f32.length; i++) { const a = f32[i] < 0 ? -f32[i] : f32[i]; if (a > peak) peak = a; }
    const dt = this._lastAt ? Math.min(1, (now - this._lastAt) / 1000) : 0;
    this._lastAt = now;
    // attack: a hot chunk is cut to the target before it goes out
    if (peak * this.gain > this.ceiling) {
      this.gain = Math.max(this.minGain, this.target / peak);
      this.trims++;
      this._lowSince = 0;
    } else if (peak * this.gain < this.floor && peak > 0) {
      // release: quiet for a while → creep up, never past maxGain
      if (!this._lowSince) this._lowSince = now;
      else if (now - this._lowSince > this.floorHoldMs && dt > 0) this.gain = Math.min(this.maxGain, this.gain * Math.pow(this.releasePerSec, dt));
    } else {
      this._lowSince = 0;
    }
    if (this.gain !== 1) for (let i = 0; i < f32.length; i++) f32[i] *= this.gain;
    const out = peak * this.gain;
    if (now >= this._holdUntil) { this.peakIn = peak; this.peakOut = out; this._holdUntil = now + 500; }
    else { if (peak > this.peakIn) this.peakIn = peak; if (out > this.peakOut) this.peakOut = out; }
    return f32;
  }

  /** What a meter shows: dBFS of the held peaks and the trim in dB. */
  levels() {
    const db = (p) => (p > 0 ? Math.max(-90, Math.round(20 * Math.log10(p))) : -90);
    return { inDb: db(this.peakIn), outDb: db(this.peakOut), trimDb: Math.round(this.gainDb), hot: this.peakIn >= 0.9 };
  }
}

module.exports = { RxLeveler };
