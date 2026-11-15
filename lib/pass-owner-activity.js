'use strict';

// Guest Pass hand-back rule (GitHub #200, #541 step 4): what counts as the
// owner using the radio.
//
// Casey 2026-11-14: the radio stays the owner's while the owner uses it.
// After 5 minutes with no owner activity the guest is told the radio is free
// (waiting/owner-idle) and may press "Take the radio". Nothing switches on its
// own. This file is the one list of what "owner activity" means; every call
// site names one of these kinds, and remote-server ignores any other.
//
// Only real use counts: something the owner does at the station, or from one
// of the owner's own paired devices. Never the guest (a guest is parked while
// the owner holds the radio and can send nothing that reaches here; the
// station also only listens while the owner holds the radio).
//
//   ptt       any key-down at the station: voice PTT, a voice macro, the VFO
//             window's PTT, and every data transmission keyed through
//             main.js handleRemotePtt (JTCAT FT8/FT4/FT2/JTTY/PSK, Winlink,
//             SSTV, the ATU tune carrier, a logger's CAT PTT)
//   cw        CW sent: the paddle, the straight key, CW text or a CW macro
//   tune      a frequency change asked for (a spot click, the VFO, a band
//             button, a VFO profile, the scan's manual step, a rig switch)
//   mode      a mode change asked for
//   jtcat-tx  a JTCAT transmission asked for (Call CQ, a reply, Enable TX,
//             the tune tone, a JTTY or PSK send) from an owner device
//   winlink   Winlink session activity: a connect, a QSY, a retry, and the
//             session's own traffic while it runs (main.js winlinkSessionTouch;
//             not a session the guest started before the owner took the radio)
//   data-tx   other data sent from an owner device: an SSTV photo, a JS8
//             message or heartbeat, FreeDV transmit
//
// Passive things never count (PASSIVE below, for the record and the tests):
// spots arriving, decodes, meter reads, CAT polling (the radio reporting its
// frequency, mode or TX state), the band scope, pings, an owner device that
// is merely connected or says it is "operating" (owner-presence). The
// idle-receive session (WSPR / PSK / JTTY / JS8 when the owner is away)
// drives the radio itself and does not count either. Pure.

const KINDS = Object.freeze(['ptt', 'cw', 'tune', 'mode', 'jtcat-tx', 'winlink', 'data-tx']);
const KIND_SET = new Set(KINDS);

const PASSIVE = Object.freeze([
  'spots', 'decode', 'meter', 'cat-poll', 'status', 'scope', 'ping', 'owner-presence', 'idle-rx',
]);

function isOwnerActivity(kind) {
  return KIND_SET.has(String(kind || ''));
}

// ECHOCAT C2S messages from an owner device that are owner activity. A
// function per type when only some values count (a key-up is not use).
const ECHOCAT_ACTIVITY = Object.freeze({
  ptt: (m) => (m.state ? 'ptt' : null),
  'voice-macro-play': () => 'ptt',
  'voice-macro-play-audio': () => 'ptt',
  'atu-tune': () => 'ptt',
  paddle: (m) => (m.state ? 'cw' : null),
  'cw-key': (m) => (m.down ? 'cw' : null),
  'cw-text': () => 'cw',
  tune: () => 'tune',
  'set-vfo': () => 'tune',
  'swap-vfo': () => 'tune',
  'switch-rig': () => 'tune',
  'apply-vfo-profile': () => 'tune',
  'scan-step': () => 'tune',
  'jtcat-set-band': () => 'tune',
  'js8-set-band': () => 'tune',
  'set-mode': () => 'mode',
  'jtcat-call-cq': () => 'jtcat-tx',
  'jtcat-reply': () => 'jtcat-tx',
  'jtcat-enable-tx': (m) => (m.enabled ? 'jtcat-tx' : null),
  'jtcat-tune-toggle': () => 'jtcat-tx',
  'jtcat-jtty-send': () => 'jtcat-tx',
  'jtcat-psk-send': () => 'jtcat-tx',
  'winlink-connect': () => 'winlink',
  'winlink-qsy': () => 'winlink',
  'winlink-retry': () => 'winlink',
  'sstv-photo': () => 'data-tx',
  'js8-send': () => 'data-tx',
  'js8-send-sms': () => 'data-tx',
  'js8-send-hb': () => 'data-tx',
  'freedv-set-tx': (m) => (m.enabled ? 'data-tx' : null),
});

/**
 * The activity kind of an ECHOCAT message from an owner device, or null when
 * the message is not use of the radio (a subscription, a read, a key-up).
 * The caller makes sure the socket is the owner's, not a guest's.
 */
function fromEchocatMessage(msg) {
  if (!msg || typeof msg.type !== 'string') return null;
  const f = Object.prototype.hasOwnProperty.call(ECHOCAT_ACTIVITY, msg.type) ? ECHOCAT_ACTIVITY[msg.type] : null;
  return f ? f(msg) : null;
}

module.exports = {
  KINDS,
  PASSIVE,
  ECHOCAT_TYPES: Object.freeze(Object.keys(ECHOCAT_ACTIVITY)),
  isOwnerActivity,
  fromEchocatMessage,
};
