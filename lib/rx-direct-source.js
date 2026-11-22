/**
 * Which receive audio a pop-out listens to when the radio's audio arrives
 * from main over the network instead of from a sound card (#936).
 *
 * 78hawkeye (IC-7610 over Icom Network, macOS, 1.14.7): with the audio source
 * set to icom-network the JTCAT pop-out opened a local capture, the Mac's
 * default input, a webcam microphone, so its waterfall showed the room, and
 * main never saw the pop-out declare itself a sink for the Icom frames it was
 * ready to send. SSTV painted its waterfall from the same local capture on top
 * of the Icom frames and named the webcam as "(from the radio)".
 *
 * Pure and dual-mode: require() in tests, window.RxDirectSource in the JTCAT
 * and SSTV pop-outs.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RxDirectSource = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Same recency rule as lib/sstv-feed-gate.js: a stream only outranks the
  // local capture while frames are actually arriving.
  const FRESH_WINDOW_MS = 3000;

  /**
   * Does the JTCAT pop-out build its audio from main's 'jtcat-vita49-audio'
   * frames (true) or open a local capture device (false)?
   * @param {string} source  the capture source (jtcatRxSource websdr, else settings.audioSource)
   */
  function jtcatPopoutUsesMainFeed(source) {
    return source === 'smartsdr' || source === 'yaesu-lan' || source === 'websdr'
      || source === 'tci' || source === 'icom-network';
  }

  /**
   * AudioWorklet options for the pop-out's main-feed graph. Icom network
   * frames arrive at 24 kHz with more jitter (UDP, paced in main), so they get
   * the same buffer the main window uses for them (renderer/app.js).
   */
  function jtcatPopoutFeedOptions(source) {
    if (source === 'websdr' || source === 'tci') return { sourceRate: 12000 };
    if (source === 'icom-network') return { sourceRate: 24000, bufferMs: 600, startBufferMs: 150, resumeBufferMs: 200 };
    return { sourceRate: 24000 };
  }

  /**
   * Should the SSTV pop-out drop a buffer from its local capture (waterfall
   * and decoder IPC) because the radio's own stream is live? The local
   * capture stays open as the fallback and takes over once the stream has
   * been quiet for FRESH_WINDOW_MS.
   * @param {string} audioSource    settings.audioSource
   * @param {number} lastStreamMs   last stream frame seen by the pop-out (0 = never)
   * @param {number} nowMs
   */
  function sstvLocalCaptureYields(audioSource, lastStreamMs, nowMs) {
    if (audioSource !== 'smartsdr' && audioSource !== 'icom-network') return false;
    return typeof lastStreamMs === 'number' && lastStreamMs > 0
      && (nowMs - lastStreamMs) < FRESH_WINDOW_MS;
  }

  return { jtcatPopoutUsesMainFeed, jtcatPopoutFeedOptions, sstvLocalCaptureYields, FRESH_WINDOW_MS };
}));
