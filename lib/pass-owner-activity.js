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
//   radio-tx  the radio itself reports transmitting (its CAT TX status, or
//             forward power above FWD_FLOOR_W where the meter reports it) for
//             at least RADIO_TX_MIN_MS: the owner on the hand mic or a key at
//             the radio. Only counts while the owner holds the radio, when a
//             guest cannot transmit, so it can only be the owner; a scan never
//             transmits, so automation cannot hold the radio this way.
//             createRadioTxWatch debounces it (a single meter glitch is not
//             use), repeats it every RADIO_TX_REPEAT_MS during a long over,
//             and stops after RADIO_TX_MAX_MS of one unbroken report (stuck).
//
// Passive things never count (PASSIVE below, for the record and the tests):
// spots arriving, decodes, meter reads other than radio-tx above, CAT polling
// of the frequency and mode (a knob turn seen only by polling is not counted:
// a scan looks the same), the band scope, pings, an owner device that
// is merely connected or says it is "operating" (owner-presence). The
// idle-receive session (WSPR / PSK / JTTY / JS8 when the owner is away)
// drives the radio itself and does not count either. Pure.

const KINDS = Object.freeze(['ptt', 'cw', 'tune', 'mode', 'jtcat-tx', 'winlink', 'data-tx', 'radio-tx']);
const KIND_SET = new Set(KINDS);

const PASSIVE = Object.freeze([
  'spots', 'decode', 'meter', 'cat-poll', 'status', 'scope', 'ping', 'owner-presence', 'idle-rx',
]);

function isOwnerActivity(kind) {
  return KIND_SET.has(String(kind || ''));
}

// radio-tx: how long the radio must report TX before it counts, how often a
// long over counts again, the forward power that is a transmission (watts,
// above the meter's noise floor), and how long a power reading stands when no
// newer one comes (meters only report during TX, often with no zero after).
const RADIO_TX_MIN_MS = 1000;
const RADIO_TX_REPEAT_MS = 30 * 1000;
const FWD_FLOOR_W = 0.5;
const FWD_STALE_MS = 2500;
// A TX report that never ends (a stuck status, a dropped radio) stops
// counting after this long: no real over lasts 10 minutes.
const RADIO_TX_MAX_MS = 10 * 60 * 1000;

/**
 * Debounces what the radio reports about its own transmitter into owner
 * activity (kind radio-tx). Two sources: 'cat' (the radio's TX status, on
 * every change: it counts once held for minMs) and 'fwd' (forward power
 * readings, watts: it counts once a reading above the floor comes minMs or
 * more after the first one, with no gap longer than staleMs; one glitch
 * reading never counts). Then every repeatMs while TX lasts. The clock and
 * timers are passed in for tests.
 * @param {object} o
 * @param {function} o.onActive called with 'radio-tx'
 * @returns {{cat: function(boolean), fwd: function(number), stop: function(), on: function(): boolean}}
 */
function createRadioTxWatch(o) {
  const x = o || {};
  const minMs = Number.isFinite(x.minMs) ? x.minMs : RADIO_TX_MIN_MS;
  const repeatMs = Number.isFinite(x.repeatMs) ? x.repeatMs : RADIO_TX_REPEAT_MS;
  const floorW = Number.isFinite(x.floorW) ? x.floorW : FWD_FLOOR_W;
  const staleMs = Number.isFinite(x.staleMs) ? x.staleMs : FWD_STALE_MS;
  const maxMs = Number.isFinite(x.maxMs) ? x.maxMs : RADIO_TX_MAX_MS;
  const now = typeof x.now === 'function' ? x.now : Date.now;
  const set = x.setTimeout || setTimeout;
  const clear = x.clearTimeout || clearTimeout;
  const onActive = typeof x.onActive === 'function' ? x.onActive : () => {};
  const src = { cat: false, fwd: false };
  let timer = null;
  let staleTimer = null;
  let fwdSince = null; // the first reading above the floor in this run
  let counted = 0; // ms of this continuous TX already counted
  const isOn = () => src.cat || src.fwd;
  const tick = (step) => {
    timer = null;
    if (!isOn()) return;
    counted += step;
    if (counted > maxMs) return; // stuck: stop counting until TX ends
    onActive('radio-tx');
    timer = set(() => tick(repeatMs), repeatMs);
  };
  const update = () => {
    if (isOn()) { if (!timer && counted === 0) timer = set(() => tick(minMs), minMs); }
    else { if (timer) clear(timer); timer = null; counted = 0; }
  };
  return {
    cat(on) { src.cat = !!on; update(); },
    fwd(watts) {
      const above = Number(watts) > floorW;
      if (staleTimer) { clear(staleTimer); staleTimer = null; }
      if (!above) { fwdSince = null; src.fwd = false; update(); return; }
      const t = now();
      if (fwdSince == null) fwdSince = t;
      staleTimer = set(() => { staleTimer = null; fwdSince = null; src.fwd = false; update(); }, staleMs);
      if (src.fwd || t - fwdSince < minMs) return;
      // Confirmed: power has been up for minMs. It counts now (it already
      // lasted minMs), unless the TX status got there first.
      src.fwd = true;
      if (!timer && counted === 0) tick(minMs);
    },
    stop() {
      if (timer) clear(timer);
      if (staleTimer) clear(staleTimer);
      timer = staleTimer = null;
      fwdSince = null;
      src.cat = src.fwd = false;
      counted = 0;
    },
    on: isOn,
  };
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
  RADIO_TX_MIN_MS,
  RADIO_TX_REPEAT_MS,
  FWD_FLOOR_W,
  RADIO_TX_MAX_MS,
  isOwnerActivity,
  fromEchocatMessage,
  createRadioTxWatch,
};
