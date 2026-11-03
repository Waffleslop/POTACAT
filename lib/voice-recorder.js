/**
 * Voice macro recorder (ride1226, 2026-10-31: "recording cuts off after 5-10
 * seconds", "no audio", "the button does nothing"). What the old inline
 * recorder in renderer/app.js got wrong, each fixed here:
 *   - It saved through btoa(String.fromCharCode.apply(null, bytes)). Chromium
 *     refuses an argument list that long, so a recording past roughly 10-20 s
 *     threw inside the FileReader callback and was never saved, silently.
 *     base64 is now built in 32 KB slices (bytesToBase64).
 *   - A second click while the microphone was still opening started a second
 *     recording (there was nothing to stop yet). The state machine has a
 *     'requesting' state: a stop there cancels, and the button says so.
 *   - A microphone error left the macro bar's button on STOP for good.
 *     Every failure goes to state 'error' with the device and the reason.
 *   - No timeslice: start(250) delivers audio as it is captured, so a device
 *     that goes away mid-take still saves what was recorded.
 *   - Silence was invisible: onLevel reports the input level while recording.
 * Dual-mode: require() in tests, window.VoiceRecorder in the page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VoiceRecorder = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** base64 of a byte array, in slices small enough for any engine. */
  function bytesToBase64(bytes, btoaFn) {
    const enc = btoaFn || (typeof btoa === 'function' ? btoa : (s) => Buffer.from(s, 'binary').toString('base64'));
    let bin = '';
    const STEP = 0x8000;
    for (let i = 0; i < bytes.length; i += STEP) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
    }
    return enc(bin);
  }

  /** A readable reason for a getUserMedia / MediaRecorder failure. */
  function describeMicError(err, deviceLabel) {
    const name = (err && err.name) || '';
    const dev = deviceLabel ? `"${deviceLabel}"` : 'the microphone';
    if (name === 'NotAllowedError' || name === 'SecurityError') return `the system refused ${dev} (microphone permission is off for POTACAT in the operating system's privacy settings)`;
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return `${dev} is not connected (pick another in Recording mic)`;
    if (name === 'NotReadableError' || name === 'AbortError') return `${dev} is in use by another program or stopped answering`;
    return (err && err.message) ? err.message : String(err || 'unknown error');
  }

  /**
   * @param {object} deps
   *   getUserMedia(constraints) -> Promise<MediaStream>
   *   MediaRecorder              constructor
   *   maxMs                      longest take (stops by itself)
   *   onState(state, info)       'requesting' | 'recording' | 'saving' | 'idle' | 'error'
   *   onDone(blob, ms)           a finished take with audio in it
   *   onLevel(peak 0..1)         optional, while recording
   *   levelMeter(stream)         optional -> { read(): peak, close() }
   *   setTimer / clearTimer      injectable timers (tests)
   */
  function createVoiceRecorder(deps) {
    const setT = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clearT = deps.clearTimer || ((h) => clearTimeout(h));
    const now = deps.now || (() => Date.now());
    let state = 'idle';
    let take = 0; // which start() a callback belongs to
    let rec = null, stream = null, meter = null, maxTimer = null, levelTimer = null, chunks = [], startedAt = 0;

    function set(s, info) { state = s; if (deps.onState) deps.onState(s, info || {}); }
    function release() {
      if (maxTimer) { clearT(maxTimer); maxTimer = null; }
      if (levelTimer) { clearT(levelTimer); levelTimer = null; }
      if (meter) { try { meter.close(); } catch { /* closed */ } meter = null; }
      if (stream) { try { stream.getTracks().forEach((t) => t.stop()); } catch { /* gone */ } stream = null; }
      rec = null;
    }
    function pollLevel(my) {
      if (my !== take || state !== 'recording' || !meter) return;
      try { if (deps.onLevel) deps.onLevel(meter.read()); } catch { /* meter gone */ }
      levelTimer = setT(() => pollLevel(my), 100);
    }

    async function start({ deviceId, deviceLabel, mimeType } = {}) {
      if (state === 'requesting' || state === 'recording') return false;
      const my = ++take;
      chunks = [];
      set('requesting', { deviceLabel });
      let s;
      try {
        s = await deps.getUserMedia(deviceId ? { audio: { deviceId: { exact: deviceId } } } : { audio: true });
      } catch (err) {
        if (my !== take) return false;
        set('error', { message: describeMicError(err, deviceLabel) });
        return false;
      }
      if (my !== take || state !== 'requesting') { // stopped while the mic was opening
        try { s.getTracks().forEach((t) => t.stop()); } catch { /* gone */ }
        return false;
      }
      stream = s;
      try {
        rec = new deps.MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      } catch (err) {
        release();
        set('error', { message: describeMicError(err, deviceLabel) });
        return false;
      }
      rec.ondataavailable = (e) => { if (my === take && e && e.data && e.data.size > 0) chunks.push(e.data); };
      rec.onerror = (e) => { if (my === take) { release(); set('error', { message: describeMicError(e && e.error, deviceLabel) }); } };
      rec.onstop = () => {
        if (my !== take) return;
        const ms = now() - startedAt;
        const got = chunks;
        const type = (rec && rec.mimeType) || mimeType || 'audio/webm';
        release();
        if (!got.length) { set('error', { message: `nothing was recorded from ${deviceLabel ? `"${deviceLabel}"` : 'the microphone'}` }); return; }
        set('saving', { ms });
        const Blob_ = deps.Blob || Blob;
        Promise.resolve(deps.onDone ? deps.onDone(new Blob_(got, { type }), ms) : null)
          .then(() => { if (my === take) set('idle', { saved: true, ms }); })
          .catch((err) => { if (my === take) set('error', { message: 'could not save the recording: ' + ((err && err.message) || err) }); });
      };
      if (deps.levelMeter) { try { meter = deps.levelMeter(stream); } catch { meter = null; } }
      startedAt = now();
      rec.start(250);
      set('recording', { deviceLabel, maxMs: deps.maxMs });
      if (deps.maxMs > 0) maxTimer = setT(() => { if (my === take) stop(); }, deps.maxMs);
      pollLevel(my);
      return true;
    }

    function stop() {
      if (state === 'requesting') { take++; release(); set('idle', { cancelled: true }); return; }
      if (state === 'recording' && rec) { try { rec.stop(); } catch { release(); set('idle', {}); } }
    }

    return { start, stop, get state() { return state; } };
  }

  return { createVoiceRecorder, bytesToBase64, describeMicError };
});
