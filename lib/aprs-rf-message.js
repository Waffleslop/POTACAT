// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS A3: messages over the radio. The rules that are not the messenger's
// (lib/aprs-messenger.js keeps the outbox, the retries and the acks owed) and
// not the radio run's (lib/aprs-rf-beacon.js createRfBeacon keys the radio,
// holds the cap and reports "sent" only when the radio transmitted). Pure.
//
//  - The frame. A message goes out exactly as the manual radio beacon does
//    (#760): the station's RF source (the Settings call, or "My APRS SSID"),
//    our tocall APZPCT, the band's path (2 m WIDE1-1,WIDE2-1; 30 m WIDE1-1),
//    and the APRS 1.0.1 chapter 14 information field
//    ":ADDRESSEE:text{ID}" (lib/aprs-message.js buildMessageInfo). The same
//    run, the same swap-in transmit config, the same 'aprs' owner, the same
//    gate (lib/aprs-rf-gate.js mayKey at every key-down) and the same cap.
//  - What transmits. Nothing unless the operator pressed Send (the first try),
//    pressed Try again (each later try), or turned on one of the two settings
//    below, both OFF by default (Casey 2026-11-21, "approve all"):
//      aprsRadioMsgAutoRetry  later tries go out by themselves on the
//                             messenger's schedule (30 s, 1, 2, 5 min; five
//                             tries in all)
//      aprsRadioMsgAutoAck    a numbered message heard on the radio is
//                             acknowledged on the radio
//    Bands (AUTO_BANDS): automatic retries on 2 m and 30 m (Casey
//    2026-11-21: "Automatic retries on 30m too"); automatic acks on 2 m only.
//    A retry follows a message the operator sent; an ack answers a stranger
//    unattended, which on HF waits for the FCC 97.221 check, the same reason
//    the radio beacon timer is 2 m only.
//  - Words. The gate and the run speak of a beacon; messageWords turns their
//    sentences into the message's words for the thread and the compose box.
//
// Dual-mode: require() in main and tests, window.AprsRfMessage in the window
// (messageWords and radioChoice only; buildRfFrame needs main's modules).
(function (root, factory) {
  const api = factory(typeof require === 'function' ? require : null);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AprsRfMessage = api;
})(typeof self !== 'undefined' ? self : this, function (req) {
  'use strict';

  const AUTO_BANDS = Object.freeze({ retry: Object.freeze(['2m', '30m']), ack: Object.freeze(['2m']) });

  /** May a default-off automatic radio transmission ('retry' or 'ack') run on this band? */
  function autoAllowed(settingOn, band, kind) {
    const bands = AUTO_BANDS[kind === 'retry' ? 'retry' : 'ack'];
    return settingOn === true && bands.indexOf(band) >= 0;
  }

  /** The gate's and the run's beacon sentences in a message's words. */
  function messageWords(sentence) {
    return String(sentence || '')
      .replace(/Beacons over the radio/g, 'Messages over the radio')
      .replace(/to beacon over the radio/g, 'to send over the radio')
      .replace(/\bbeacons\b/g, 'messages')
      .replace(/\bbeacon\b/g, 'message')
      .replace(/\bBeacon\b/g, 'Message');
  }

  /**
   * "Send over: Radio" in the compose box, from the radio beacon's state
   * (main's aprs-rf payload: allowed, reason, why). Enabled only while the
   * gate allows it; a packet already going out ('busy') still lets the
   * operator pick Radio: the message waits for the radio to be free.
   * @returns {{enabled:boolean, why:string}}
   */
  function radioChoice(rf) {
    if (!rf) return { enabled: false, why: 'Waiting for the radio state.' };
    if (rf.allowed || rf.reason === 'busy') return { enabled: true, why: '' };
    return { enabled: false, why: messageWords(rf.why || 'The radio cannot send now.') };
  }

  /**
   * The frame for the air, in the shape createRfBeacon's send takes:
   * { ok, packet, source, dest, path, info, band } or { ok:false, reason, sentence }.
   * info: the message or ack information field (lib/aprs-message.js).
   */
  function buildRfFrame({ settingsCall, band, ssid = null, info }) {
    const Beacon = req('./aprs-rf-beacon');
    const AprsBeacon = req('./aprs-beacon');
    const Igate = req('./aprs-igate');
    if (!Beacon.PATHS[band]) return { ok: false, reason: 'no-band', sentence: 'There is no APRS frequency for this band.' };
    const l = Igate.uplinkLogin(settingsCall);
    if (!l.ok) return { ok: false, reason: l.reason, sentence: l.sentence };
    const text = String(info || '');
    if (!text || text[0] !== ':' || text.length < 12) return { ok: false, reason: 'info', sentence: 'There is no message to send.' };
    const source = Beacon.rfSource(settingsCall, l.base, ssid);
    const path = Beacon.PATHS[band].slice();
    const packet = `${source}>${AprsBeacon.TOCALL},${path.join(',')}:${text}`;
    return { ok: true, packet, source, dest: AprsBeacon.TOCALL, path, info: text, band };
  }

  return { AUTO_BANDS, autoAllowed, messageWords, radioChoice, buildRfFrame };
});
