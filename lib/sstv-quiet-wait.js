// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// SSTV waits for the frequency to be quiet before it transmits (#326: "I've
// accidentally doubled with a few people because my audio was too low").
//
// The rules, each decided here and nowhere else:
//  - Off by default. On with Settings > SSTV window gear > Sending ("Wait for
//    the frequency to be quiet before sending", settings.sstvWaitQuiet), or
//    for one picture when an ECHOCAT client asks (sstv-photo waitQuiet: true).
//    A client can only ask for the wait, never skip the shack's own setting:
//    a Guest Pass phone cannot turn off the owner's courtesy.
//  - The listening is the Winlink busy detector, unchanged
//    (lib/winlink-spectrum.js BusyDetector on SpectrumAccumulator frames), on
//    the SSTV band 1100-2300 Hz (sync 1200, black 1500, white 2300), with the
//    Winlink automatic retry's clear-for-N-seconds watch
//    (lib/winlink-auto-retry.js ChannelWatch). Busy enters at 8 dB over the
//    noise (20 dB for one carrier) held 150 ms, and stays 4 s after the last
//    such frame, so the pause between a picture and its FSK ID still reads busy.
//  - A picture goes as soon as the frequency has read quiet for QUIET_S (5 s)
//    (about 9 s of real silence after a signal, with the detector's 4 s hold),
//    or when the operator presses Send now. If it was already quiet for 5 s
//    when Send was pressed, it goes at once.
//  - It gives up after MAX_WAIT_S (4 min: a PD180 picture is 3 min 7 s) and
//    says so. Nothing is sent then.
//  - With no receive audio reaching POTACAT it cannot hear the frequency: it
//    keeps waiting and says why; Send now or Cancel. It never sends on a guess.
//  - Cancel, HALT, closing the SSTV window or stopping SSTV ends the wait, and
//    nothing is sent. The wait only ever sends the one picture the operator
//    asked to send.
//  - The listening restarts when the dial moves (a picture from ECHOCAT tunes
//    the radio first): quiet heard on another frequency does not count.
//
// Dual-mode: `require()` in main and tests; `window.SstvQuietWait` in the SSTV
// window and ECHOCAT Web (inlined by lib/remote-server.js) for the words. The
// listener needs main's FFT and is built only there.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SstvQuietWait = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var QUIET_S = 5;
  var MAX_WAIT_S = 240;
  var NO_AUDIO_S = 4;
  var BAND_LO_HZ = 1100;
  var BAND_HI_HZ = 2300;
  var DIAL_MOVED_HZ = 500;

  var WAIT_TITLE = 'Waiting for the frequency to clear...';
  var SEND_NOW = 'Send now';
  var CANCEL = 'Cancel';
  var CANCELLED_TEXT = 'Picture not sent: cancelled while waiting for the frequency to clear.';

  /** Does this picture wait? The shack's setting, or the client's request for this one picture. */
  function shouldWait(o) {
    o = o || {};
    return o.enabled === true || o.requested === true;
  }

  /** The dial moved far enough that what was heard before is another frequency. */
  function dialMoved(fromHz, nowHz) {
    return Math.abs((Number(nowHz) || 0) - (Number(fromHz) || 0)) > DIAL_MOVED_HZ;
  }

  function mmss(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    var m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  /**
   * The line under "Waiting for the frequency to clear...".
   * heard: 'busy' | 'quiet' | 'no-audio'; quietSec: how long it has read quiet.
   */
  function waitDetail(o) {
    o = o || {};
    var maxS = Number(o.maxWaitSec) || MAX_WAIT_S;
    var quietS = Number(o.quietNeedSec) || QUIET_S;
    var tail = ' Waited ' + mmss(Math.min(o.waitedSec || 0, maxS)) + ' of ' + mmss(maxS) + '.';
    if (o.heard === 'no-audio') return 'No receive audio is reaching POTACAT, so it cannot hear the frequency.' + tail;
    if (o.heard === 'quiet') return 'Quiet for ' + Math.min(quietS, Math.floor(o.quietSec || 0)) + ' of ' + quietS + ' s.' + tail;
    return 'Someone is on the frequency.' + tail;
  }

  /** Why a picture was not sent when the wait ran out. */
  function giveUpText(heard, maxWaitSec) {
    var min = Math.round((Number(maxWaitSec) || MAX_WAIT_S) / 60);
    var span = min + ' minute' + (min === 1 ? '' : 's');
    if (heard === 'no-audio') return 'Picture not sent: no receive audio reached POTACAT for ' + span + ', so it could not hear whether the frequency was clear.';
    return 'Picture not sent: the frequency stayed busy for ' + span + '.';
  }

  /**
   * The next step of a held picture.
   * channel: ChannelWatch.verdict(now, startedAt): 'clear' | 'busy-wait' | 'no-audio' | 'gave-up'
   * @returns {{act:'send'|'wait'|'give-up'|'cancel', why?:string, heard?:string, waitedSec?:number}}
   */
  function step(o) {
    o = o || {};
    var maxWaitMs = Number(o.maxWaitMs) || MAX_WAIT_S * 1000;
    if (o.cancelled) return { act: 'cancel' };
    if (o.sendNow) return { act: 'send', why: 'now' };
    if (o.channel === 'clear') return { act: 'send', why: 'quiet' };
    var heard = o.channel === 'no-audio' ? 'no-audio' : 'busy';
    var waited = Math.max(0, (o.now || 0) - (o.startedAt || 0));
    if (waited >= maxWaitMs) return { act: 'give-up', heard: heard };
    return { act: 'wait', heard: heard, waitedSec: Math.floor(waited / 1000) };
  }

  /**
   * Main only: listens to the SSTV receive audio on one dial frequency. Feed
   * every receive chunk with push(); ask verdict()/heard() when deciding.
   */
  function QuietListener(o) {
    o = o || {};
    var Spectrum = require('./winlink-spectrum');
    var Retry = require('./winlink-auto-retry');
    this.hz = Number(o.hz) || 0;
    this._now = Number(o.now) || 0;
    this.watch = new Retry.ChannelWatch({ clearMs: QUIET_S * 1000, maxWaitMs: MAX_WAIT_S * 1000, noAudioMs: NO_AUDIO_S * 1000 });
    this.watch.start(this._now);
    this.detector = new Spectrum.BusyDetector(BAND_LO_HZ / Spectrum.SPAN_HZ, BAND_HI_HZ / Spectrum.SPAN_HZ);
    var self = this;
    this.acc = new Spectrum.SpectrumAccumulator(function (mags) {
      self.watch.frame(self.detector.update(mags, self._now).busy, self._now);
    });
  }
  QuietListener.prototype.push = function (pcm, rate, now) {
    if (!pcm || !pcm.length) return;
    this._now = now == null ? Date.now() : Number(now);
    this.acc.push(pcm, rate);
  };
  /** ChannelWatch's verdict with the wait counted from startedAt. */
  QuietListener.prototype.verdict = function (now, startedAt) {
    return this.watch.verdict(now, startedAt);
  };
  /** What the waiting line says: 'busy' | 'quiet' (with quietSec) | 'no-audio'. */
  QuietListener.prototype.heard = function (now, startedAt) {
    var v = this.watch.verdict(now, startedAt);
    if (v === 'no-audio') return { heard: 'no-audio', quietSec: 0 };
    if (this.watch.busyNow || this.watch.clearSince === null) return { heard: this.watch.busyNow ? 'busy' : 'quiet', quietSec: 0 };
    return { heard: 'quiet', quietSec: Math.floor((now - this.watch.clearSince) / 1000) };
  };

  /**
   * One held picture at a time. main.js passes the callbacks and a clock tick;
   * this decides. hold() either sends at once (off, or already quiet) or
   * starts waiting; tick() once a second; sendNow() and cancel() from the
   * operator. A second hold() while waiting replaces the first picture.
   *   onSend(picture, why)        why: 'off' | 'quiet' | 'now'
   *   onStatus(status)            {state:'waiting', waitedSec, maxWaitSec, quietSec, heard, quietNeedSec}
   *   onGiveUp(picture, text)
   *   onCancel(picture, reason)
   */
  function SendGate(cb) {
    this._cb = cb || {};
    this.held = null;
  }
  SendGate.prototype.waiting = function () { return !!this.held; };
  SendGate.prototype.hold = function (picture, o) {
    o = o || {};
    if (this.held) this.cancel('replaced');
    if (!shouldWait(o)) { this._cb.onSend && this._cb.onSend(picture, 'off'); return 'sent'; }
    this.held = { picture: picture, startedAt: Number(o.now) || 0, sendNow: false };
    return this.tick(o.now, o.listener) === 'waiting' ? 'waiting' : 'sent';
  };
  SendGate.prototype.tick = function (now, listener) {
    var h = this.held;
    if (!h) return 'idle';
    now = Number(now) || 0;
    var channel = listener ? listener.verdict(now, h.startedAt)
      : (now - h.startedAt >= NO_AUDIO_S * 1000 ? 'no-audio' : 'busy-wait');
    var st = step({ now: now, startedAt: h.startedAt, sendNow: h.sendNow, channel: channel });
    if (st.act === 'send') { this.held = null; this._cb.onSend && this._cb.onSend(h.picture, st.why); return 'sent'; }
    if (st.act === 'give-up') { this.held = null; this._cb.onGiveUp && this._cb.onGiveUp(h.picture, giveUpText(st.heard)); return 'gave-up'; }
    var h2 = listener && channel !== 'no-audio' ? listener.heard(now, h.startedAt) : { heard: st.heard, quietSec: 0 };
    if (this._cb.onStatus) this._cb.onStatus({ state: 'waiting', waitedSec: st.waitedSec, maxWaitSec: MAX_WAIT_S, quietSec: h2.quietSec, quietNeedSec: QUIET_S, heard: h2.heard });
    return 'waiting';
  };
  /** The operator pressed Send now: the held picture goes on the next tick (main ticks at once). */
  SendGate.prototype.sendNow = function (now, listener) {
    if (!this.held) return false;
    this.held.sendNow = true;
    this.tick(now, listener);
    return true;
  };
  /** Cancel, HALT, window closed, SSTV stopped: nothing is sent. */
  SendGate.prototype.cancel = function (reason) {
    var h = this.held;
    if (!h) return false;
    this.held = null;
    if (this._cb.onCancel) this._cb.onCancel(h.picture, reason || 'cancel');
    return true;
  };

  return {
    QUIET_S: QUIET_S, MAX_WAIT_S: MAX_WAIT_S, NO_AUDIO_S: NO_AUDIO_S,
    BAND_LO_HZ: BAND_LO_HZ, BAND_HI_HZ: BAND_HI_HZ, DIAL_MOVED_HZ: DIAL_MOVED_HZ,
    WAIT_TITLE: WAIT_TITLE, SEND_NOW: SEND_NOW, CANCEL: CANCEL, CANCELLED_TEXT: CANCELLED_TEXT,
    shouldWait: shouldWait, dialMoved: dialMoved, mmss: mmss, waitDetail: waitDetail, giveUpText: giveUpText,
    step: step, QuietListener: QuietListener, SendGate: SendGate,
  };
}));
