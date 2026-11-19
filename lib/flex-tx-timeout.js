// SPDX-License-Identifier: Apache-2.0
/**
 * The Flex's own transmit timeout, and the SmartLink transmit gate.
 *
 * Why: a client that vanishes silently (TCP open, no traffic) leaves a Flex
 * TRANSMITTING until something unkeys it. Measured 2026-11-17 on an 8600M
 * (v4.2.20) into a dummy load: still keyed after 45 s, because the radio's
 * interlock `timeout=` was 0 (no radio-side TX timeout). Over SmartLink a silent
 * drop is an ordinary event (a hotel Wi-Fi, a phone hotspot).
 *
 * The rule (Casey, 2026-11-17), for every Flex rig, LAN and SmartLink alike:
 *   - Once POTACAT is the radio's GUI client, read the interlock `timeout=`. If
 *     it is 0, set it with `interlock timeout=<ms>` to the rig's "Radio transmit
 *     timeout" (Off / 3 / 5 / 10 minutes, default 5). A non-zero value the
 *     operator set elsewhere is never changed. Off leaves the radio alone.
 *   - It is a PERSISTENT radio setting: it applies to every client of the radio
 *     (SmartSDR, Maestro), not only POTACAT.
 *   - Backstop on a SmartLink rig: a key-down is refused while the radio's
 *     timeout is still 0 (or not yet reported), with GATE_TEXT.
 * The `interlock timeout=<ms>` command and its unit come from FlexRadio's API
 * wiki (interlock command). POTACAT's D0 capture shows the status as `timeout=0`.
 *
 * Dual-mode: Node `require()` gets module.exports; the rig editor loads it with a
 * <script> tag and gets `window.FlexTxTimeout`. No DOM or Node imports.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FlexTxTimeout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CHOICES = [0, 3, 5, 10];   // minutes; 0 = Off
  var DEFAULT_MINUTES = 5;
  var OPTIONS = [
    { value: 0, label: 'Off' },
    { value: 3, label: '3 minutes' },
    { value: 5, label: '5 minutes' },
    { value: 10, label: '10 minutes' },
  ];

  var GATE_TEXT = "Transmit over SmartLink needs the radio's transmit timeout turned on, so a dropped connection cannot leave it transmitting. Turn on Radio transmit timeout in Settings > My Rigs.";

  var NO_TX_AUDIO_TEXT = 'Voice and digital transmit over FlexRadio SmartLink are not built yet, so POTACAT does not key the radio for them: it would send a carrier with no audio. CW and Tune work.';

  /** The rig's setting in minutes (0 = Off). Missing or unknown: the default. */
  function minutesFor(rig) {
    var v = rig ? rig.flexTxTimeoutMin : undefined;
    if (v === undefined || v === null || v === '') return DEFAULT_MINUTES;
    var n = Number(v);
    return CHOICES.indexOf(n) >= 0 ? n : DEFAULT_MINUTES;
  }

  /** The radio's reported timeout as a number, or null when not reported yet. */
  function radioTimeout(kv) {
    if (!kv || kv.timeout === undefined || kv.timeout === null || kv.timeout === '') return null;
    var n = Number(kv.timeout);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * What to do with the radio's timeout.
   * @param {object} o
   * @param {number|null} o.radioTimeout  from the interlock status
   * @param {number} o.minutes            the rig's setting (0 = Off)
   * @param {boolean} o.isGuiClient       POTACAT holds the radio's GUI seat
   * @returns {{action:'set', ms:number, command:string, minutes:number}|{action:'none', why:string}}
   */
  function decideFill(o) {
    if (!o || !o.isGuiClient) return { action: 'none', why: 'not the GUI client' };
    if (o.radioTimeout === null || o.radioTimeout === undefined) return { action: 'none', why: 'not reported yet' };
    if (o.radioTimeout !== 0) return { action: 'none', why: 'the radio already has a timeout' };
    var m = Number(o.minutes);
    if (!(m > 0)) return { action: 'none', why: 'Off' };
    var ms = m * 60000;
    return { action: 'set', ms: ms, minutes: m, command: 'interlock timeout=' + ms };
  }

  /** The log line when the fill command goes out (sending is not success). */
  function sendLogText(command, minutes) {
    return '[Flex] the radio has no transmit timeout; asking it for ' + minutes + ' minutes with "' + command + '"';
  }

  /** Only a status-0 reply is an acceptance; an error code or no reply is not. */
  function replyAccepted(r) {
    return !!r && r.status === 0;
  }

  /**
   * The log line for the radio's reply to the fill command (R<seq>|<code>|<msg>).
   * 8600M 2026-11-18: the old code logged "set it" without reading this reply,
   * and the radio still read timeout=0, so the reply is always logged raw.
   * @param {{command:string, status:number|null, line:string|null}} r
   */
  function replyLogText(r) {
    var cmd = '"' + (r && r.command) + '"';
    if (!r || r.status === null || r.status === undefined) {
      return '[Flex] no reply from the radio to ' + cmd + ' within 5 seconds. The transmit timeout may still be off.';
    }
    if (r.status === 0) {
      return '[Flex] the radio accepted ' + cmd + ' (reply ' + r.line + '); waiting for its status to show the new timeout';
    }
    var msg = String(r.line || '').split('|').slice(2).join('|').trim();
    return '[Flex] the radio refused ' + cmd + ': error 0x' + (r.status >>> 0).toString(16) +
      (msg ? ', ' + msg : '') + ' (reply ' + r.line + '). The transmit timeout is still off.';
  }

  /**
   * After a fill was sent, what a later interlock status means.
   * @param {{pending:boolean, radioTimeout:number|null, replied?:boolean, accepted?:boolean}} o
   * @returns {{action:'confirmed'|'still-zero'|'wait'|'none'}}
   *   confirmed: the radio now reports a non-zero timeout (the only success).
   *   still-zero: the radio accepted the command but still reports 0.
   *   wait: a 0 that arrived before the reply, no verdict yet.
   */
  function decideConfirm(o) {
    if (!o || !o.pending) return { action: 'none' };
    if (typeof o.radioTimeout === 'number' && o.radioTimeout > 0) return { action: 'confirmed' };
    if (o.radioTimeout === 0 && o.replied && o.accepted) return { action: 'still-zero' };
    return { action: 'wait' };
  }

  /** The log line when the radio accepted the fill but still reports 0. */
  function stillZeroLogText(o) {
    return '[Flex] the radio accepted "' + (o && o.command) + '" but still reports timeout=0. The transmit timeout is not on.';
  }

  /** The log line once the radio's status shows the new timeout. */
  function fillLogText(minutes) {
    return '[Flex] the radio had no transmit timeout; set it to ' + minutes + ' minutes (Settings > My Rigs to change)';
  }

  /** The one-time notice after a fill. */
  function fillNoticeText(minutes) {
    return 'Your radio had no transmit timeout, so POTACAT set it to ' + minutes +
      ' minutes. A dropped connection can no longer leave it transmitting. This is a radio setting: SmartSDR and Maestro see it too. Change it in Settings > My Rigs.';
  }

  /** Commands that key the transmitter. Releases (xmit 0, tune 0 ...) never match. */
  function isKeyDownCommand(cmd) {
    var c = String(cmd || '').trim();
    return /^xmit\s+1\b/.test(c) ||
      /^transmit\s+tune\s+(1|on)\b/.test(c) ||
      /^transmit\s+set\b.*\bmox=1\b/.test(c) ||
      /^atu\s+start\b/.test(c) ||
      /^cw\s+(key|ptt)\s+1\b/.test(c) ||
      /^cwx\s+(send|macro\s+send)\b/.test(c);
  }

  /** Key-downs that need transmit audio from POTACAT (voice, JTCAT, SSTV, WSPR, Winlink). */
  function needsTxAudio(cmd) {
    var c = String(cmd || '').trim();
    return /^xmit\s+1\b/.test(c) || /^transmit\s+set\b.*\bmox=1\b/.test(c);
  }

  /**
   * The SmartLink backstop: the refusal sentence for a key-down, else null.
   *   1. Refused while the radio's timeout is 0 or not reported yet (GATE_TEXT).
   *   2. Transmit audio over SmartLink (remote_audio_tx) is not built, so a
   *      key-down that needs POTACAT's audio is refused (NO_TX_AUDIO_TEXT): it
   *      would put a carrier with no audio on the air. CW, Tune and the ATU,
   *      which need no audio, go out once the timeout is set.
   */
  function smartLinkTxRefusal(o) {
    if (!o || !o.smartLink) return null;
    var t = o.interlockTimeout;
    if (!(typeof t === 'number' && t > 0)) return GATE_TEXT;
    if (o.cmd && needsTxAudio(o.cmd)) return NO_TX_AUDIO_TEXT;
    return null;
  }

  return {
    CHOICES: CHOICES, DEFAULT_MINUTES: DEFAULT_MINUTES, OPTIONS: OPTIONS, GATE_TEXT: GATE_TEXT, NO_TX_AUDIO_TEXT: NO_TX_AUDIO_TEXT,
    minutesFor: minutesFor, radioTimeout: radioTimeout, decideFill: decideFill,
    fillLogText: fillLogText, fillNoticeText: fillNoticeText,
    sendLogText: sendLogText, replyAccepted: replyAccepted, replyLogText: replyLogText,
    decideConfirm: decideConfirm, stillZeroLogText: stillZeroLogText,
    isKeyDownCommand: isKeyDownCommand, needsTxAudio: needsTxAudio, smartLinkTxRefusal: smartLinkTxRefusal,
  };
});
