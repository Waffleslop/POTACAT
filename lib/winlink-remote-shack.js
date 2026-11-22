// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Winlink on a remote shack from this desktop (#299). A POTACAT driving a shack
// (More > Remote Radios) opened its own Winlink Mail window against its OWN Pat,
// so every radio mode read "unavailable": the radio is at the shack. ECHOCAT
// already drives the shack's Winlink over the wire (the winlink-* messages in
// lib/echocat-protocol.js); the mail window now does the same, so it shows the
// shack's mailbox, the shack's modes and gateways, and Send / Receive starts
// the session on the shack's radio, under every rule the shack keeps.
//
// This file is the mapping and nothing else (pure, no Electron); main.js
// applies it in the bridge (lib/remote-bridge.js WINLINK_OUT / IN rows, and
// bridgeInvokeToShack for the window's invokes).
//
//   INVOKES[channel](args) -> one of
//     { send: wireMsg, ms }     ask the shack; main awaits the frame with the same reqId,
//                               then reply(channel, frame, args) is the window's answer
//     { answer: value }         answered here, no wire
//     { save: wireMsg, ms }     an attachment: main saves the shack's bytes on this PC
//     { cached: 'state' }       main answers with the shack's last winlink-state
//   reply(channel, frame, args)  the shack's frame (or null: no answer) as the window's return value
//   windowState(m)            the shack's winlink-state as the window's payload
//   magsFromWireBins(bins)    the shack's waterfall frame (128 bins, 0..255) as the window's 256 magnitudes
//   SHACK_CHANNELS            window channels the shack feeds while a shack is driven
//                             (this PC's own Winlink pushes on them are held back)
'use strict';

const s = (v, d = '') => (v == null ? d : String(v));
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);

const NO_ANSWER = 'The shack did not answer. Check the link to the shack and try again.';
const FORMS_NOT_REMOTE = 'Winlink forms run on the shack\'s Pat and are not on the remote link yet. Fill them in on the shack PC.';
const SHACK_SOUND = 'The radio\'s sound is set on the shack PC.';
const NOT_HERE = 'The mailbox is on the shack PC.';

// How long the window waits for the shack. Gateways can take a while: the
// shack may rank them by propagation first.
const MS = { default: 15000, gateways: 90000, connect: 30000, attachment: 30000, account: 30000, read: 20000, compose: 30000 };

/** Fields of a message body, without undefined ones (the wire validator checks declared fields only). */
function msg(type, fields) {
  const m = { type };
  for (const [k, v] of Object.entries(fields || {})) if (v !== undefined) m[k] = v;
  return m;
}

const INVOKES = {
  // The window's first paint: the shack's last winlink-state (main keeps it), or waitingState().
  'winlink-cmd-state': () => ({ cached: 'state' }),
  'winlink-cmd-list': ([box]) => ({ send: msg('winlink-list', { box: s(box, 'in') }) }),
  'winlink-cmd-read': ([o]) => ({ send: msg('winlink-read', { box: s(o && o.box, 'in'), mid: s(o && o.mid) }), ms: MS.read }),
  'winlink-cmd-delete': ([o]) => ({ send: msg('winlink-delete', { box: s(o && o.box, 'in'), mid: s(o && o.mid) }) }),
  'winlink-cmd-move': ([o]) => ({ send: msg('winlink-move', { box: s(o && o.box), mid: s(o && o.mid), to: s(o && o.to) }) }),
  'winlink-cmd-save-attachment': ([o]) => ({ save: msg('winlink-attachment-get', { box: s(o && o.box, 'in'), mid: s(o && o.mid), name: s(o && o.name) }), ms: MS.attachment }),
  'winlink-cmd-send': ([m]) => {
    m = m || {};
    const atts = (Array.isArray(m.attachments) ? m.attachments : [])
      .filter((a) => a && typeof a.name === 'string' && typeof a.dataBase64 === 'string')
      .map((a) => ({ name: a.name, dataBase64: a.dataBase64 }));
    // A filled Winlink form (formId) cannot ride the wire: forms are refused here before one exists.
    return { send: msg('winlink-compose', { to: s(m.to), cc: m.cc ? s(m.cc) : undefined, subject: s(m.subject), body: s(m.body), p2p: m.p2p ? true : undefined, attachments: atts.length ? atts : undefined }), ms: MS.compose };
  },
  'winlink-cmd-posreport': ([o]) => ({ send: msg('winlink-posreport', { lat: n(o && o.lat), lon: n(o && o.lon), comment: o && o.comment ? s(o.comment) : undefined }) }),
  'winlink-pota-spot-template': () => ({ send: msg('winlink-pota-spot-get', {}) }),
  'winlink-cmd-connect': ([o]) => ({ send: msg('winlink-connect', { mode: s(o && o.mode, 'telnet'), gateway: o && o.gateway ? s(o.gateway) : undefined, dialKhz: n(o && o.dialKhz), url: o && o.url ? s(o.url) : undefined }), ms: MS.connect }),
  'winlink-cmd-qsy': ([o]) => ({ send: msg('winlink-qsy', { dialKhz: n(o && o.dialKhz) || 0, mode: o && o.mode ? s(o.mode) : undefined }) }),
  'winlink-cmd-retry': ([op]) => ({ send: msg('winlink-retry', { op: s(op) }) }),
  'winlink-account-check': () => ({ send: msg('winlink-account-check', {}), ms: MS.account }),
  'winlink-register': ([o]) => ({ send: msg('winlink-register', { password: s(o && o.password), recoveryEmail: o && o.recoveryEmail ? s(o.recoveryEmail) : undefined }), ms: MS.account }),
  'winlink-cmd-set-password': ([pw]) => ({ send: msg('winlink-set-password', { password: s(pw) }), ms: MS.account }),
  'winlink-cmd-gateways': ([o]) => ({ send: msg('winlink-gateways-get', { mode: s(o && o.mode, 'ardop'), band: o && o.band ? s(o.band) : undefined }), ms: MS.gateways }),
  'winlink-cmd-history': () => ({ send: msg('winlink-history-get', {}) }),
  'winlink-cmd-template': ([o]) => {
    const t = (o && o.t) || {};
    return { send: msg('winlink-template', { op: s(o && o.op), id: t.id ? s(t.id) : undefined, name: t.name != null ? s(t.name) : undefined, to: t.to != null ? s(t.to) : undefined, cc: t.cc != null ? s(t.cc) : undefined, subject: t.subject != null ? s(t.subject) : undefined, body: t.body != null ? s(t.body) : undefined }) };
  },
  'winlink-cmd-contact': ([o]) => {
    const c = (o && o.c) || {};
    return { send: msg('winlink-contact', { op: s(o && o.op), id: c.id ? s(c.id) : undefined, name: c.name != null ? s(c.name) : undefined, address: c.address != null ? s(c.address) : undefined, note: c.note != null ? s(c.note) : undefined }) };
  },
  'winlink-cmd-contact-group': ([o]) => {
    const g = (o && o.g) || {};
    return { send: msg('winlink-contact-group', { op: s(o && o.op), id: g.id ? s(g.id) : undefined, name: g.name != null ? s(g.name) : undefined, members: Array.isArray(g.members) ? g.members.map(String) : undefined }) };
  },
  'winlink-cmd-favourite': ([o]) => ({ send: msg('winlink-favourite', { op: s(o && o.op), call: s(o && o.call), mode: s(o && o.mode), dialKhz: n(o && o.dialKhz) || 0, url: o && o.url ? s(o.url) : undefined }) }),
  'winlink-cmd-accept-notice': () => ({ send: msg('winlink-accept-notice', {}) }),
  // Forms are Pat's pages on the shack; the wire has no form messages yet.
  'winlink-forms-catalog': () => ({ answer: { ok: true, allowed: false, why: FORMS_NOT_REMOTE } }),
  'winlink-forms-update': () => ({ answer: { ok: false, text: FORMS_NOT_REMOTE } }),
  'winlink-form-open': () => ({ answer: { ok: false, error: FORMS_NOT_REMOTE } }),
  'winlink-form-info': () => ({ answer: { ok: false, error: FORMS_NOT_REMOTE } }),
  // The modem's sound devices and its mailbox folder are the shack's.
  'winlink-audio-rig': () => ({ answer: { ok: false, error: SHACK_SOUND } }),
  'winlink-audio-auto': () => ({ answer: { ok: false, error: SHACK_SOUND } }),
  'winlink-audio-save': () => ({ answer: { ok: false, error: SHACK_SOUND } }),
  'winlink-list-ardop-devices': () => ({ answer: { ok: false, error: SHACK_SOUND, devices: [] } }),
  'winlink-open-folder': () => ({ answer: { ok: false, error: NOT_HERE } }),
};

/** Every invoke the window makes that the shack answers (or this table answers for it). */
const WINLINK_INVOKES = Object.keys(INVOKES);

/** The {ok, error} every plain request answers with. */
function result(frame) {
  if (!frame) return { ok: false, error: NO_ANSWER };
  if (frame.type === 'winlink-refused') return { ok: false, error: frame.reason === 'guest-pass' ? 'Winlink is the shack owner\'s. A Guest Pass cannot use it.' : 'The shack refused: ' + s(frame.reason) };
  return frame.ok === false ? { ok: false, error: s(frame.error, 'The shack could not do that.') } : { ok: true };
}

/** The shack's answer (null = none in time) as what the window's invoke returns. */
function reply(channel, frame, args) {
  if (!frame || frame.type === 'winlink-refused' || frame.type === 'winlink-result') {
    // A request answered only by winlink-result is fine when it says ok.
    return result(frame);
  }
  switch (channel) {
    case 'winlink-cmd-list': return { ok: true, box: s(frame.box), messages: Array.isArray(frame.messages) ? frame.messages : [] };
    case 'winlink-cmd-read': return { ok: true, message: frame.message || {} };
    case 'winlink-account-check': return { ok: true, callsign: s(frame.callsign), exists: !!frame.exists };
    case 'winlink-cmd-gateways': return { ok: true, mode: s(frame.mode), band: s(frame.band), list: Array.isArray(frame.list) ? frame.list : [], predicted: !!frame.predicted, note: s(frame.note), leftOut: Number(frame.leftOut) || 0 };
    case 'winlink-cmd-history': return { ok: true, gateways: Array.isArray(frame.gateways) ? frame.gateways : [] };
    case 'winlink-pota-spot-template': {
      const { type, reqId, parks, ...rest } = frame;
      return { ...rest, refs: Array.isArray(parks) ? parks : [], parks: Array.isArray(parks) ? parks : [], missing: Array.isArray(frame.missing) ? frame.missing : [] };
    }
    case 'winlink-cmd-save-attachment': return { ok: true, name: s(frame.name), dataBase64: s(frame.dataBase64) };
    default: return result(frame);
  }
}

/**
 * The shack's winlink-state as the window renders it. Every field the window
 * reads is the shack's; `remoteShack` lets the window word what is not here.
 */
function windowState(m) {
  const { type, reqId, ...rest } = m || {};
  return { ...rest, remoteShack: true };
}

/** What the window shows before the shack's first winlink-state arrives. */
function waitingState() {
  return { enabled: true, patReady: false, patStarted: false, patError: 'Waiting for the shack...', modes: [], session: { state: 'idle' }, remoteShack: true };
}

// lib/winlink-spectrum.js wireBins: 0..255 over 50 dB above the frame's floor.
const WIRE_RANGE_DB = 50;
const LN_TO_DB = 10 / Math.LN10;
/**
 * The shack's waterfall frame as the window's own magnitudes (natural-log
 * power, 256 bins over 0..3000 Hz): each wire bin covers two window bins.
 */
function magsFromWireBins(bins, count = 256) {
  const out = new Array(count).fill(0);
  if (!Array.isArray(bins) || !bins.length) return out;
  for (let i = 0; i < count; i++) {
    const v = Number(bins[Math.min(bins.length - 1, Math.floor(i * bins.length / count))]) || 0;
    out[i] = (Math.max(0, Math.min(255, v)) / 255) * WIRE_RANGE_DB / LN_TO_DB;
  }
  return out;
}

const SHACK_CHANNELS = ['winlink-state', 'winlink-mailbox', 'winlink-session', 'winlink-remote-watch'];

module.exports = {
  INVOKES, WINLINK_INVOKES, reply, result, windowState, waitingState, magsFromWireBins, SHACK_CHANNELS,
  NO_ANSWER, FORMS_NOT_REMOTE, SHACK_SOUND, MS,
};
