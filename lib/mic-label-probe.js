'use strict';
/**
 * Unlock audio device names with the least possible side effect (#743).
 *
 * Chromium hides device labels from enumerateDevices() until the page has
 * opened a microphone once. Several lists (the Settings summary, the rig audio
 * lists, VARA setup, the VFO window's mic list) open one only for that and
 * close it at once. getUserMedia({ audio: true }) leaves echo cancellation,
 * noise suppression and auto gain ON; on macOS that switches on the system
 * voice processing, which changes the level of whatever is playing until the
 * mic closes. This probe asks for all three OFF and stops every track before
 * it returns. Real captures (JTCAT, SSTV, FreeDV, ECHOCAT audio) do not use it.
 *
 * unlockDeviceLabels(mediaDevices) resolves when the mic has been opened and
 * closed; it rejects with the getUserMedia error (mic refused, none present)
 * so a caller can still enumerate and say why the names are blank.
 *
 * Dual-mode: require() in tests, window.MicLabelProbe in the renderer.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MicLabelProbe = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  function constraints() {
    return { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } };
  }

  async function unlockDeviceLabels(mediaDevices) {
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      throw new Error('mediaDevices.getUserMedia is not available');
    }
    const stream = await mediaDevices.getUserMedia(constraints());
    const tracks = (stream && typeof stream.getTracks === 'function') ? stream.getTracks() : [];
    for (const t of tracks) { try { t.stop(); } catch (e) { /* already ended */ } }
  }

  return { constraints: constraints, unlockDeviceLabels: unlockDeviceLabels };
}));
