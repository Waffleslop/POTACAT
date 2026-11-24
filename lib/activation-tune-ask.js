'use strict';
//
// GitHub #146: starting an activation from an ECHOCAT phone moved the home
// radio without asking. Casey's rule (2026-11-07): POTACAT never retunes the
// radio silently for a phone activation. It asks first, and with more than
// one rig it asks which one.
//
// This module is the rule, pure. lib/remote-server.js holds the wire (the
// question goes to the device that started the activation, the answer must
// come back from it), main.js supplies the rig facts and does the tune.
// Brief: docs/activation-ask-before-tune.md.

const FreqDots = require('./freq-dots');

/** Client hello capability (the device can show the question) and server
 *  hello capability (the shack asks, so the device sends tuneTo instead of a
 *  bare tune). One string for both directions. */
const CAP = 'activation-ask-tune';

/** How long a question stays answerable. No answer = the radio is not moved. */
const ASK_TTL_MS = 120 * 1000;

/** An older phone sends a bare `tune` a moment BEFORE set-activator-park
 *  (ECHOCAT ActScreen onStart). Its tunes are held this long so the shack can
 *  see whether an activation start follows, and drop the tune if it does. */
const HOLD_MS = 400;

/** An ECHOCAT phone (iOS or Android) that does not know the question.
 *  Desktop-to-desktop clients and ECHOCAT Web never sent a tune on start. */
function isLegacyPhone(platform, caps) {
  const p = String(platform || '').trim();
  if (!/^(ios|android)\b/i.test(p)) return false;
  return !(Array.isArray(caps) && caps.includes(CAP));
}

/** A tune from an older phone that could be its activation-start tune: a
 *  plain frequency (and mode). Channel taps, rotor bearings and band buttons
 *  are something else and are never held. */
function isHoldableTune(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.channelId || msg.pickSideband === true) return false;
  if (msg.bearing != null && msg.bearing !== '') return false;
  return Number(msg.freqKhz) > 0;
}

/** {freqKhz, mode} from the wire (a number or string kHz), or null. */
function normalizeWant(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const khz = Number(raw.freqKhz);
  if (!Number.isFinite(khz) || khz <= 0 || khz > 300e6) return null;
  const mode = typeof raw.mode === 'string' ? raw.mode.trim().toUpperCase().slice(0, 16) : '';
  return { freqKhz: Math.round(khz * 1000) / 1000, mode };
}

/** Mode family, so USB and SSB (or DIGU and FT8) are the same thing. */
function modeFamily(mode) {
  const m = String(mode || '').trim().toUpperCase();
  if (!m) return '';
  if (/^(USB|LSB|SSB)$/.test(m)) return 'SSB';
  if (/^CW/.test(m)) return 'CW';
  if (/^(FM|NFM|FMN|WFM|DFM|C4FM)$/.test(m)) return 'FM';
  if (/^(AM|SAM)$/.test(m)) return 'AM';
  if (/^(RTTY|RTTYR|FSK)/.test(m)) return 'RTTY';
  if (/^(DIGU|DIGL|PKTUSB|PKTLSB|PKT|DATA|FT8|FT4|FT2|JS8|PSK|JTTY|WSPR|USB-D|LSB-D)/.test(m)) return 'DATA';
  return m;
}

/** True when the radio is already where the device wants it. */
function alreadyThere(want, rig) {
  if (!want || !rig) return false;
  const khz = Number(rig.freqKhz);
  if (!Number.isFinite(khz) || khz <= 0) return false;
  if (Math.abs(khz - want.freqKhz) > 0.05) return false;
  return !want.mode || modeFamily(want.mode) === modeFamily(rig.mode);
}

function where(khz, mode) {
  return FreqDots.khzMhz(khz) + (mode ? ' ' + mode : '');
}

/** The rigs the device may choose from: [{id, name, active, connected}]. */
function rigChoices(rigs, activeRigId, activeConnected) {
  const out = [];
  for (const r of Array.isArray(rigs) ? rigs : []) {
    if (!r || !r.id) continue;
    const active = r.id === activeRigId;
    out.push({ id: String(r.id), name: String(r.name || 'Radio'), active, connected: active && !!activeConnected });
  }
  return out;
}

/**
 * What the shack does after an activation start that wants a frequency.
 *   input: { want, canAsk, rig: {connected, freqKhz, mode}, rigs, activeRigId, guestOnAir }
 *   -> { action: 'none' }                       nothing to ask (no frequency, or already there)
 *   -> { action: 'notice', text }               start it, do not tune, tell the device in words
 *   -> { action: 'ask', ask: {...} }            send activation-tune-ask
 * Every outcome leaves the radio where it is. Only a yes answer tunes.
 */
function decide(input) {
  const i = input || {};
  const want = normalizeWant(i.want);
  if (!want) return { action: 'none', log: 'no frequency asked for' };
  const rig = i.rig || {};
  const connected = !!rig.connected;
  if (connected && alreadyThere(want, rig)) return { action: 'none', log: 'the radio is already there' };
  const rigs = rigChoices(i.rigs, i.activeRigId, connected);
  const several = rigs.length > 1;
  const target = where(want.freqKhz, want.mode);
  const now = connected && Number(rig.freqKhz) > 0 ? where(Number(rig.freqKhz), String(rig.mode || '')) : '';

  if (!i.canAsk) {
    const text = connected
      ? `Your activation started. POTACAT did not move the radio: it stays on ${now || 'its frequency'}. To use ${target}, tune there from the VFO screen.`
      : `Your activation started. The radio is not connected, so POTACAT did not move it to ${target}.`;
    return { action: 'notice', text, log: 'an older device: started, radio not moved, told in words' };
  }
  if (!connected && !several) {
    return {
      action: 'notice',
      text: `Your activation started. The radio is not connected, so POTACAT did not move it to ${target}.`,
      log: 'the radio is not connected: started, radio not moved',
    };
  }
  let text = several
    ? `Move a radio to ${target} for this activation? Choose the radio.`
    : `Move the radio to ${target} for this activation?`;
  if (now) text += ` It is on ${now} now.`;
  if (i.guestOnAir) text += ' A Guest Pass operator is connected to this station.';
  return {
    action: 'ask',
    log: `asked the device${several ? ' (and which radio)' : ''}`,
    ask: {
      freqKhz: want.freqKhz,
      mode: want.mode,
      current: now ? { freqKhz: Number(rig.freqKhz), mode: String(rig.mode || '') } : null,
      rigs: several ? rigs : [],
      activeRigId: i.activeRigId ? String(i.activeRigId) : '',
      guestOnAir: !!i.guestOnAir,
      text,
      expiresInMs: ASK_TTL_MS,
    },
  };
}

/**
 * The device's answer to a pending question.
 *   pending: { want, rigs?, createdAt }   msg: { tune, rigId? }
 *   -> { tune: false, text? }                   no tune (no, or too late)
 *   -> { tune: true, freqKhz, mode, rigId }     rigId '' = the active radio
 */
function answer(pending, msg, now, rigIds) {
  if (!pending) return { tune: false, text: 'That question has expired. POTACAT did not move the radio.' };
  if (Number(now) - Number(pending.createdAt || 0) > ASK_TTL_MS) {
    return { tune: false, text: 'That question has expired. POTACAT did not move the radio.' };
  }
  if (!msg || msg.tune !== true) return { tune: false };
  const ids = Array.isArray(rigIds) ? rigIds.map(String) : [];
  const rigId = typeof msg.rigId === 'string' && ids.includes(msg.rigId) ? msg.rigId : '';
  return { tune: true, freqKhz: pending.want.freqKhz, mode: pending.want.mode, rigId };
}

/** Who asked, for as long as the question is open: the paired device's id,
 *  not its socket. A phone whose screen sleeps comes back on a new socket
 *  and must still see (and be able to answer) its question. '' = no stable
 *  identity (a shared-token or LAN-cookie session): the question then stays
 *  with that one socket, as before. */
function askerKey(pairedDeviceId) {
  const s = String(pairedDeviceId == null ? '' : pairedDeviceId).trim();
  return s ? 'dev:' + s : '';
}

/** True when this socket (or the same paired device on a new one) may answer. */
function isAsker(pending, ws, key) {
  if (!pending) return false;
  if (pending.ws === ws) return true;
  return !!(pending.askerKey && key && pending.askerKey === key);
}

/** The same question again, for the asking device after it reconnects: the
 *  same id and contents, and only the time that is left. null = nothing to
 *  re-send (never asked, or expired). */
function resendAsk(pending, id, now) {
  if (!pending || !pending.ask) return null;
  const left = ASK_TTL_MS - (Number(now) - Number(pending.createdAt || 0));
  if (!(left > 0)) return null;
  return { type: 'activation-tune-ask', id: String(id), ...pending.ask, expiresInMs: left };
}

module.exports = {
  CAP, ASK_TTL_MS, HOLD_MS,
  isLegacyPhone, isHoldableTune, normalizeWant, modeFamily, alreadyThere, rigChoices, decide, answer,
  askerKey, isAsker, resendAsk,
};
