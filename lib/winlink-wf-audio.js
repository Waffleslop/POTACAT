'use strict';
/**
 * Why the Winlink waterfall has nothing to draw, in one plain line.
 *
 * The mail window's waterfall shows the radio's receive audio. On a
 * sound-card rig that audio comes from the modem audio bridge; on Flex
 * Direct / Icom Network it comes from the radio's own stream. When nothing
 * arrives, or only exact zeros arrive, the canvas simply stayed black, and an
 * operator could not tell "the band is empty" from "no audio reaches
 * POTACAT" (N5XHI, 2026-11-15). This decides the line shown over the
 * waterfall; '' means the waterfall has audio and needs no words.
 *
 * Dual-mode: `require` (tests) and `window.WinlinkWfAudio` (the mail window).
 * Tests: test/winlink-wf-audio-test.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WinlinkWfAudio = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  var GRACE_MS = 4000;     // a capture or bridge that is starting gets this long
  var STALE_MS = 3000;     // no frame (or no sound) for this long = say so
  var LEAD = 'No radio audio is reaching POTACAT: ';
  var WHERE = 'check the rig’s audio Input in Settings > My Rigs';

  function secs(ms) { return Math.max(1, Math.round(ms / 1000)); }

  /**
   * @param {object} o
   *   mode         'frames' (audio from main) | 'capture' (this window's own) | 'none'
   *   now          ms
   *   startedAt    ms the waterfall started listening in this mode
   *   lastFrameAt  ms of the last frame of any content (0 = none yet)
   *   lastSoundAt  ms of the last frame with any non-zero sample (0 = none yet)
   *   bridge       { state: 'off'|'starting'|'ok'|'error', error } or null
   *                (null = no bridge on this route: Flex Direct / Icom Network)
   *   captureError the window's own capture failure text, if any
   * @returns {string} the line to show, or '' when audio is arriving.
   */
  function noAudioText(o) {
    o = o || {};
    if (o.mode !== 'frames' && o.mode !== 'capture') return '';
    var now = Number(o.now) || 0;
    var started = o.startedAt == null ? now : Number(o.startedAt) || 0;
    var lastFrame = Number(o.lastFrameAt) || 0;
    var lastSound = Number(o.lastSoundAt) || 0;
    if (o.mode === 'capture' && o.captureError) return LEAD + String(o.captureError);
    var b = o.bridge || null;
    if (o.mode === 'frames' && b) {
      if (b.state === 'error') return LEAD + (b.error ? String(b.error) : 'the modem audio bridge could not open the radio’s audio input; ' + WHERE);
    }
    var inGrace = now - started < GRACE_MS;
    var frameFresh = lastFrame > 0 && now - lastFrame < STALE_MS;
    if (!frameFresh) {
      if (inGrace) return '';
      if (o.mode === 'frames' && b && b.state === 'off') return LEAD + 'the modem audio bridge is not running';
      if (o.mode === 'frames' && b && b.state === 'starting') return LEAD + 'the modem audio bridge is still opening the radio’s audio input';
      return LEAD + (lastFrame > 0 ? 'nothing has arrived for ' + secs(now - lastFrame) + ' s' : 'nothing has arrived yet') + (b || o.mode === 'capture' ? '; ' + WHERE : '');
    }
    // Frames arrive: are they all exact zeros (a muted or wrong input)?
    var soundFresh = lastSound > 0 && now - lastSound < STALE_MS;
    if (!soundFresh && !inGrace) {
      return LEAD + 'the input sends only silence (exact zeros), as a muted or disconnected input does; ' + WHERE;
    }
    return '';
  }

  /** True when a frame carries any non-zero sample. */
  function hasSound(pcm) {
    if (!pcm) return false;
    for (var i = 0; i < pcm.length; i++) if (pcm[i] !== 0) return true;
    return false;
  }

  /** The largest absolute sample of a frame (0..1 full scale). */
  function framePeak(pcm) {
    var pk = 0;
    if (!pcm) return 0;
    for (var i = 0; i < pcm.length; i++) { var a = pcm[i] < 0 ? -pcm[i] : pcm[i]; if (a > pk) pk = a; }
    return pk;
  }

  /**
   * The receive input level beside Busy/Clear: the radio audio the modem
   * hears. A feed near full scale is the known reason a modem's own busy
   * detector never reads clear ("The frequency is busy" on an empty band).
   * The peak is held HOLD_MS so a short burst is still seen.
   */
  var HOLD_MS = 500;
  var HOT_DBFS = -3;       // at or above this the input is too high
  var HOT_TIP = 'The radio audio going into the modem is at the top of the scale. Turn down the radio’s USB or data audio output level, or the sound device’s input level, until this reads below ' + HOT_DBFS + ' dBFS, so the modem can hear a clear channel.';
  function PeakHold(holdMs) { this.holdMs = holdMs == null ? HOLD_MS : holdMs; this.peak = 0; this.at = 0; }
  PeakHold.prototype.note = function (pk, now) {
    if (pk > this.peak || now - this.at > this.holdMs) { this.peak = pk; this.at = now; }
    return this.peak;
  };

  /**
   * @param {number} peak  held peak, 0..1 full scale (0 or less = no audio)
   * @returns {{state:'none'|'ok'|'hot', db:number|null, text:string, title:string}}
   *   'none' shows nothing: the no-audio line over the waterfall says why.
   */
  function inputLevel(peak) {
    if (!(peak > 0)) return { state: 'none', db: null, text: '', title: '' };
    var db = Math.max(-90, Math.min(0, Math.round(20 * Math.log10(peak))));
    if (db >= HOT_DBFS) return { state: 'hot', db: db, text: 'Input too high', title: 'Input ' + db + ' dBFS. ' + HOT_TIP };
    return { state: 'ok', db: db, text: 'Input ' + db + ' dBFS', title: 'The radio audio going into the modem, peak over the last half second (0 dBFS = the top of the scale). Above ' + HOT_DBFS + ' dBFS the modem may never hear a clear channel.' };
  }


  /**
   * The same reading for ECHOCAT, as two optional fields on the
   * winlink-spectrum message (docs/echocat-protocol.md): inputDb = whole dBFS
   * of the held peak, inputHot = at or above HOT_DBFS. No audio (peak 0 or
   * none) = { inputDb: null, inputHot: false }: the device shows nothing.
   */
  function wireInput(peak) {
    var v = inputLevel(peak);
    return { inputDb: v.db, inputHot: v.state === 'hot' };
  }

  return {
    noAudioText: noAudioText, hasSound: hasSound, GRACE_MS: GRACE_MS, STALE_MS: STALE_MS,
    framePeak: framePeak, PeakHold: PeakHold, inputLevel: inputLevel, HOLD_MS: HOLD_MS, HOT_DBFS: HOT_DBFS,
    wireInput: wireInput,
  };
}));
