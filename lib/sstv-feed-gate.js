'use strict';
/**
 * SSTV decoder audio ingress gates — pure decision functions.
 *
 * Extracted 2026-07-07 after the v1.8.15–17 outage: the gates deciding which
 * audio path feeds the SSTV decoder were inline expressions scattered across
 * four main.js handlers, so a wrong gate shipped green (no test could reach
 * it) and users' decoders starved silently. Every combination is now
 * table-tested in test/sstv-feed-gate-test.js.
 *
 * Model: exactly ONE ingress should feed the decoder at a time —
 *   - a direct radio stream (SmartSDR VITA-49 dax_rx, K4 network, Icom
 *     RS-BA1) when the corresponding source is selected AND audio has
 *     actually arrived recently ("fresh"), else
 *   - the renderer's soundcard/DAX-device capture as the fallback.
 *
 * "Fresh" (recency) is the load-bearing idea: the old gates keyed on
 * connection OBJECTS existing, but a stream can exist and deliver nothing
 * (DAX channel conflict, yielded slot, muted slice). Freshness keys on
 * frames actually delivered, so the mic fallback engages within
 * FRESH_WINDOW_MS of a stream going quiet and hands back when it returns.
 */

const FRESH_WINDOW_MS = 3000;

function isFresh(lastFeedMs, nowMs) {
  return typeof lastFeedMs === 'number' && lastFeedMs > 0
    && (nowMs - lastFeedMs) < FRESH_WINDOW_MS;
}

/**
 * Should main accept renderer-captured audio (the `sstv-audio` IPC) into the
 * decoder? Also governs `sstv-set-sample-rate` (the renderer's AudioContext
 * rate must only apply when the renderer is the live ingress).
 *
 * @param {object} s
 * @param {boolean} s.engineRunning  sstvEngine exists
 * @param {boolean} s.feedPaused     error-storm circuit breaker tripped
 * @param {string}  s.audioSource    settings.audioSource
 * @param {boolean} s.smartSdrAudioUp   SmartSDR audio client object exists
 * @param {number}  s.lastVitaFeedMs    last VITA-49 SSTV feed timestamp (0 = never)
 * @param {boolean} s.k4Connected       K4 network CAT connected
 * @param {number}  s.lastK4FeedMs      last K4 SSTV feed timestamp
 * @param {boolean} s.icomConnected     Icom RS-BA1 CAT connected
 * @param {number}  s.lastIcomFeedMs    last Icom SSTV feed timestamp
 * @param {number}  s.now               Date.now()
 * @returns {{accept: boolean, reason: string}}
 */
function rendererAudioDecision(s) {
  if (!s.engineRunning) return { accept: false, reason: 'engine-off' };
  if (s.feedPaused) return { accept: false, reason: 'breaker' };
  // A direct stream only outranks the renderer while it is actually
  // delivering audio — existence of the client object is not enough.
  if (s.audioSource === 'smartsdr' && s.smartSdrAudioUp && isFresh(s.lastVitaFeedMs, s.now)) {
    return { accept: false, reason: 'vita-live' };
  }
  if (s.k4Connected && isFresh(s.lastK4FeedMs, s.now)) {
    return { accept: false, reason: 'k4-live' };
  }
  if (s.audioSource === 'icom-network' && s.icomConnected && isFresh(s.lastIcomFeedMs, s.now)) {
    return { accept: false, reason: 'icom-live' };
  }
  return { accept: true, reason: 'renderer-fallback' };
}

/**
 * Should a direct radio stream frame (VITA-49 / K4 / Icom) feed the decoder?
 * @param {object} s
 * @param {boolean} s.engineRunning
 * @param {boolean} s.feedPaused
 * @param {string}  s.audioSource      settings.audioSource
 * @param {'smartsdr'|'k4'|'icom-network'} s.path  which stream this frame came from
 * @param {boolean} [s.k4Connected]    required for path 'k4'
 * @returns {{accept: boolean, reason: string}}
 */
function streamAudioDecision(s) {
  if (!s.engineRunning) return { accept: false, reason: 'engine-off' };
  if (s.feedPaused) return { accept: false, reason: 'breaker' };
  if (s.path === 'smartsdr') {
    return s.audioSource === 'smartsdr'
      ? { accept: true, reason: 'vita' }
      : { accept: false, reason: 'source-mismatch' };
  }
  if (s.path === 'k4') {
    // K4 keys on the active CAT connection, not audioSource (its network
    // audio rides the CAT link) — mirrors the v1.9.x k4Active gate fix.
    return s.k4Connected
      ? { accept: true, reason: 'k4' }
      : { accept: false, reason: 'k4-disconnected' };
  }
  if (s.path === 'icom-network') {
    return s.audioSource === 'icom-network'
      ? { accept: true, reason: 'icom' }
      : { accept: false, reason: 'source-mismatch' };
  }
  return { accept: false, reason: 'unknown-path' };
}

module.exports = { rendererAudioDecision, streamAudioDecision, isFresh, FRESH_WINDOW_MS };
