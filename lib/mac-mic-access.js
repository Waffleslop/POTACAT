/**
 * macOS microphone permission and the silence it causes (#463, #125).
 *
 * When macOS refuses POTACAT the microphone, every audio input (the radio's
 * USB sound card included) still opens, but delivers exact digital zero: the
 * listen test reads -120 dBFS, FT8 decodes nothing, ECHOCAT plays silence,
 * and nothing tells the operator why. This module holds the one rule for
 * "say the microphone-permission message", for every capture (listen test,
 * JTCAT, SSTV, Winlink's modem audio, ECHOCAT audio):
 *
 *  - only on macOS (platform 'darwin'), never on Windows or Linux;
 *  - say it when macOS reports the permission 'denied' or 'restricted';
 *  - or when a capture has delivered nothing but exact zeros since it started,
 *    for SILENT_MS. A radio's audio always carries some noise; a refused
 *    capture is zeros from the first buffer. A capture that has once heard
 *    sound is never judged again (a radio that mutes its USB audio while
 *    transmitting must not raise this message);
 *  - once per session per surface; the message clears when audio arrives.
 *
 * Pure and dual-mode: require() in main and tests, window.MacMicAccess in
 * the windows that capture.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MacMicAccess = api;
}(typeof self !== 'undefined' ? self : this, function () {
  const SILENT_MS = 5000;
  const SETTINGS_PATH = 'System Settings > Privacy & Security > Microphone';

  const MESSAGES = {
    denied: 'macOS is not letting POTACAT hear the radio\'s audio. To fix it, open '
      + SETTINGS_PATH + ', turn on POTACAT, then restart POTACAT.',
    silence: 'No sound is reaching POTACAT from the radio. macOS may be blocking it. Open '
      + SETTINGS_PATH + ', turn on POTACAT, then restart POTACAT.',
  };

  /** True when any sample is not exactly zero. Accepts a peak number or a sample array. */
  function hasSound(x) {
    if (typeof x === 'number') return x !== 0 && !Number.isNaN(x);
    if (!x) return false;
    const n = x.length || 0;
    for (let i = 0; i < n; i++) if (x[i] !== 0) return true;
    return false;
  }

  /**
   * The one decision.
   * @param {{platform: string, status?: string|null, silentMs?: number, heardSound?: boolean, minSilentMs?: number}} o
   *   status: Electron systemPreferences.getMediaAccessStatus('microphone')
   *   ('granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'), or null when not read.
   *   silentMs: how long this capture has delivered only exact zeros since it started.
   *   heardSound: the capture has delivered a non-zero sample since it started.
   * @returns {{say: boolean, reason: 'denied'|'silence'|null, message: string}}
   */
  function micVerdict(o) {
    const x = o || {};
    const no = { say: false, reason: null, message: '' };
    if (x.platform !== 'darwin') return no;
    if (x.status === 'denied' || x.status === 'restricted') {
      return { say: true, reason: 'denied', message: MESSAGES.denied };
    }
    const min = typeof x.minSilentMs === 'number' ? x.minSilentMs : SILENT_MS;
    if (!x.heardSound && typeof x.silentMs === 'number' && x.silentMs >= min) {
      return { say: true, reason: 'silence', message: MESSAGES.silence };
    }
    return no;
  }

  /** The permission as one line for the session log and Report a Bug ('' off macOS). */
  function describeMicStatus(platform, status) {
    if (platform !== 'darwin') return '';
    switch (status) {
      case 'granted': return 'granted';
      case 'denied': return 'DENIED (System Settings > Privacy & Security > Microphone)';
      case 'restricted': return 'RESTRICTED by a device policy';
      case 'not-determined': return 'not asked yet';
      default: return status ? String(status) : 'could not be read';
    }
  }

  /**
   * One capture's exact-zero watch. Feed it each buffer (or each peak); it
   * returns 'silent' once when the capture has delivered only zeros for
   * SILENT_MS since started(), and 'sound' once when sound then arrives.
   * Otherwise null.
   */
  class SilenceWatch {
    constructor(now, silentMs) {
      this.silentMs = typeof silentMs === 'number' ? silentMs : SILENT_MS;
      this.started(now);
    }

    started(now) {
      this.startedAt = now;
      this.heardSound = false;
      this.reported = false;
    }

    note(samplesOrPeak, now) {
      if (this.heardSound) return null;
      if (hasSound(samplesOrPeak)) {
        this.heardSound = true;
        if (this.reported) { this.reported = false; return 'sound'; }
        return null;
      }
      if (!this.reported && now - this.startedAt >= this.silentMs) {
        this.reported = true;
        return 'silent';
      }
      return null;
    }

    /** How long this capture has been zeros only (0 once it heard sound). */
    silentFor(now) { return this.heardSound ? 0 : Math.max(0, now - this.startedAt); }
  }

  /**
   * Main's per-session record: the message is shown once per surface per
   * session, and cleared when that surface hears sound.
   */
  class MicNoticeLedger {
    constructor() { this.shown = new Set(); this.showing = new Set(); }
    /** True when the message should be shown now for this surface. */
    show(surface) {
      const k = String(surface || 'audio');
      if (this.shown.has(k)) return false;
      this.shown.add(k); this.showing.add(k);
      return true;
    }
    /** True when this surface's message was showing and should be cleared. */
    clear(surface) {
      const k = String(surface || 'audio');
      return this.showing.delete(k);
    }
  }

  return { SILENT_MS, SETTINGS_PATH, MESSAGES, hasSound, micVerdict, describeMicStatus, SilenceWatch, MicNoticeLedger };
}));
