/**
 * Who may restart the main window's JTCAT capture, and one-at-a-time starts
 * for it (#133: FT8 started from ECHOCAT on a sound-card rig showed "No
 * decodes" until Restart audio).
 *
 * restartDecision / shouldRestartCapture: the main window owns a capture when
 * its own JTCAT view started it OR a remote (ECHOCAT web/app) did, unless the
 * JTCAT popout owns audio. The old rule ("desktop view running and NOT remote")
 * made Restart audio, the engine's silent-capture recovery and a device change
 * from the phone all no-ops for a remote-started FT8.
 *
 * createCaptureSerializer: the capture build is async (settle delay,
 * getUserMedia, resume, addModule) and writes the renderer's globals as it
 * goes. Two builds that overlap can leave two live captures feeding one
 * engine, and a stop during a build can leave a capture running. Here starts
 * run one at a time, the newest request wins, stop() cancels a pending one,
 * and the build calls ctx.stale() after every await: when it returns true the
 * build has been superseded, its work has been torn down, and it must return.
 *
 * Pure and dual-mode: require() in tests, window.JtcatCaptureGate in the page.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JtcatCaptureGate = api;
}(typeof self !== 'undefined' ? self : this, function () {
  function restartDecision(s) {
    const st = s || {};
    if (st.popoutOpen) return { restart: false, why: 'the JTCAT popout owns the capture' };
    if (!st.desktopRunning && !st.remoteActive) return { restart: false, why: 'no capture running in the main window' };
    return { restart: true, why: st.remoteActive && !st.desktopRunning ? 'remote-started capture' : 'desktop capture' };
  }
  function shouldRestartCapture(s) { return restartDecision(s).restart; }

  function createCaptureSerializer(opts) {
    const o = opts || {};
    const log = typeof o.log === 'function' ? o.log : function () {};
    let gen = 0;
    let chain = Promise.resolve();
    return {
      /** Ask for a fresh capture. Resolves true when this request built one. */
      start(reason) {
        const my = ++gen;
        const why = reason || 'unspecified';
        const run = chain.then(async () => {
          if (my !== gen) return false; // a newer start or a stop came first: open nothing
          log(`[JTCAT] capture #${my} starting (${why})`);
          o.teardown();
          let superseded = false;
          const ctx = {
            gen: my,
            reason: why,
            stale() {
              if (superseded) return true;
              if (my === gen) return false;
              superseded = true;
              o.teardown();
              log(`[JTCAT] capture #${my} superseded (${why}) — released`);
              return true;
            },
          };
          let ok = false;
          try { ok = !!(await o.build(ctx)); }
          catch (e) { log(`[JTCAT] capture #${my} failed (${why}): ${(e && (e.name || e.message)) ? [e.name, e.message].filter(Boolean).join(': ') : e}`); ok = false; }
          if (!superseded && ctx.stale()) ok = false; // stopped after the build's last check
          return ok && !superseded;
        });
        chain = run.catch(() => false);
        return run;
      },
      /** Release the capture now and cancel any start still pending. */
      stop() {
        gen++;
        o.teardown();
      },
      get generation() { return gen; },
    };
  }

  /** "label (48000 Hz, 1 ch, id abcdef12)" — what the OS actually opened. */
  function describeTrack(track) {
    if (!track) return '(no track)';
    let st = {};
    try { st = (typeof track.getSettings === 'function' && track.getSettings()) || {}; } catch (e) { st = {}; }
    const parts = [];
    if (st.sampleRate) parts.push(st.sampleRate + ' Hz');
    if (st.channelCount) parts.push(st.channelCount + ' ch');
    if (st.deviceId) parts.push('id ' + String(st.deviceId).slice(0, 8));
    return (track.label || '(no label)') + (parts.length ? ' (' + parts.join(', ') + ')' : '');
  }

  return { restartDecision, shouldRestartCapture, createCaptureSerializer, describeTrack };
}));
