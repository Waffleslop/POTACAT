/**
 * A stop that arrives while a capture is still opening wins (#905).
 *
 * Opening a capture is async (settings, getUserMedia, addModule). When the
 * stop came in the middle, the open used to finish anyway and keep the
 * capture: FreeDV's receive capture then held the radio's input device after
 * FreeDV had stopped (on macOS until POTACAT quit).
 *
 * begin() marks a new open and returns its token; cancel() (the stop) makes
 * every open in flight stale; a newer begin() does too. The open checks
 * isCurrent(token) after every await and, when it is stale, releases what it
 * opened (releaseStream) and returns without keeping anything.
 *
 * Pure and dual-mode: require() in tests, window.CaptureOpenGuard in the page.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CaptureOpenGuard = api;
}(typeof self !== 'undefined' ? self : this, function () {
  function createOpenGuard() {
    let gen = 0;
    return {
      begin() { return ++gen; },
      cancel() { gen++; },
      isCurrent(token) { return token === gen; },
    };
  }

  /** Stop every track of a MediaStream; safe on null and on a stream already stopped. */
  function releaseStream(stream) {
    if (!stream || typeof stream.getTracks !== 'function') return;
    stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* already gone */ } });
  }

  return { createOpenGuard, releaseStream };
}));
