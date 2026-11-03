/**
 * Capture-stall watchdog for JTCAT's sound-card capture (kc8zp_ryan
 * 2026-11-03: after the rig sat idle, FT8 in ECHOCAT Web stopped decoding.
 * The progress bar is drawn from the page's own clock, so it kept moving, and
 * opening FT8 on the phone fixed it because the phone's jtcat-start always
 * rebuilds capture).
 *
 * The capture code restarted only on the track's 'ended' event. An OS that
 * MUTES the track, suspends the AudioContext, or simply stops delivering
 * buffers after idle fires no 'ended', and capture stayed dead while the
 * engine cycled on nothing. This decides when a live capture has stopped
 * delivering and should be resumed or rebuilt; the renderer does the work.
 *
 * Pure and dual-mode: require() in tests, window.CaptureStall in the main
 * window and the JTCAT window (one copy of the rules for both captures).
 *
 * Rules:
 *  - nothing is judged in the first GRACE_MS after a (re)start;
 *  - a suspended/interrupted AudioContext is asked to resume() first, and
 *    rebuilt if it is still not running SUSPEND_MS later;
 *  - no buffer for STALL_MS, or a track muted for MUTED_MS, is a rebuild;
 *  - buffers of exact digital zero for ZERO_MS is a rebuild (a radio's audio
 *    always carries some noise; a muted OS capture delivers zeros);
 *  - rebuilds back off: BACKOFF_MS, doubling per rebuild that did not bring
 *    audio back, capped at MAX_BACKOFF_MS; HEALTHY_MS of real audio after a
 *    rebuild resets the count.
 * STALL_MS and MUTED_MS are longer than an FT8 transmission (12.6 s), so a
 * radio that goes quiet on its USB audio while keyed is never rebuilt for it.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaptureStall = api;
}(typeof self !== 'undefined' ? self : this, function () {
  const GRACE_MS = 15000;
  const STALL_MS = 20000;
  const MUTED_MS = 20000;
  const SUSPEND_MS = 10000;
  const ZERO_MS = 60000;
  const BACKOFF_MS = 30000;
  const MAX_BACKOFF_MS = 5 * 60000;
  const HEALTHY_MS = 60000;

  /** True when any sample in the buffer is not exactly zero (early exit). */
  function hasSignal(samples) {
    if (!samples) return false;
    const n = samples.length || 0;
    for (let i = 0; i < n; i++) if (samples[i] !== 0) return true;
    return false;
  }

  class CaptureStallWatch {
    constructor(now) {
      this.restarts = 0;
      this.lastRestartAt = 0;
      this.started(now);
    }

    /** A capture (re)started at `now`. */
    started(now) {
      this.startedAt = now;
      this.lastSampleAt = now;
      this.lastSignalAt = now;
      this.mutedSince = 0;
      this.suspendedSince = 0;
      this.resumeAskedAt = 0;
    }

    /** A buffer arrived. */
    noteSamples(samples, now) {
      this.lastSampleAt = now;
      if (hasSignal(samples)) {
        this.lastSignalAt = now;
        if (this.restarts && now - this.startedAt >= HEALTHY_MS) this.restarts = 0;
      }
    }

    /** Minimum time between two rebuilds, given how many came before. */
    backoffMs() {
      return Math.min(MAX_BACKOFF_MS, BACKOFF_MS * Math.pow(2, Math.max(0, this.restarts - 1)));
    }

    /**
     * @param {number} now
     * @param {{ctxState?: string, trackMuted?: boolean, trackEnded?: boolean}} live
     * @returns {{action: 'none'|'resume'|'restart', reason?: string}}
     */
    tick(now, live) {
      const l = live || {};
      if (l.trackMuted) { if (!this.mutedSince) this.mutedSince = now; } else this.mutedSince = 0;
      const notRunning = l.ctxState && l.ctxState !== 'running' && l.ctxState !== 'closed';
      if (notRunning) { if (!this.suspendedSince) this.suspendedSince = now; } else this.suspendedSince = 0;

      if (now - this.startedAt < GRACE_MS) return { action: 'none' };
      // 'ended' has its own restart path in the renderer.
      if (l.trackEnded) return { action: 'none' };

      let reason = null;
      if (notRunning) {
        if (now - this.suspendedSince < SUSPEND_MS) {
          if (!this.resumeAskedAt || now - this.resumeAskedAt >= 5000) {
            this.resumeAskedAt = now;
            return { action: 'resume', reason: `the AudioContext is ${l.ctxState}` };
          }
          return { action: 'none' };
        }
        reason = `the AudioContext stayed ${l.ctxState} after resume()`;
      } else if (this.mutedSince && now - this.mutedSince >= MUTED_MS) {
        reason = `the OS muted the audio track ${Math.round((now - this.mutedSince) / 1000)} s ago`;
      } else if (now - this.lastSampleAt >= STALL_MS) {
        reason = `no audio arrived for ${Math.round((now - this.lastSampleAt) / 1000)} s`;
      } else if (now - this.lastSignalAt >= ZERO_MS) {
        reason = `the input has been exact digital silence for ${Math.round((now - this.lastSignalAt) / 1000)} s`;
      }
      if (!reason) return { action: 'none' };
      if (this.lastRestartAt && now - this.lastRestartAt < this.backoffMs()) return { action: 'none' };
      this.restarts++;
      this.lastRestartAt = now;
      return { action: 'restart', reason };
    }
  }

  return {
    CaptureStallWatch, hasSignal,
    GRACE_MS, STALL_MS, MUTED_MS, SUSPEND_MS, ZERO_MS, BACKOFF_MS, MAX_BACKOFF_MS, HEALTHY_MS,
  };
}));
