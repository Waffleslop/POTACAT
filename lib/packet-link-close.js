// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// How a packet (AX.25) Winlink link is ended, and how a link the gateway is
// still holding is recognised (#300, NA4DQ's IC-7100 on 2 m to KJ4AJP-10).
//
// What went wrong: a session finished its exchange, then Pat failed with its
// own "context deadline exceeded". POTACAT's Stop and its 3-minute stall both
// asked Pat for a DIRTY disconnect, and the session's end killed Dire Wolf and
// dropped PTT about 2 s later. No DISC went out (or none was answered), so the
// gateway kept the old link and went on polling it (RR P=1). Every new call
// within about 15 minutes, POTACAT's own 20 s automatic retry included, was
// answered with FRMR and then UA, and never with a greeting: the gateway was
// still in the old link. Pat waited for a greeting that never came, until the
// gateway's own idle timeout.
//
// So, for packet:
//  1. A session ends with a CLEAN disconnect (Pat closes the AX.25 link, Dire
//     Wolf sends DISC) and Dire Wolf, the PTT shim and the modem audio stay up
//     until the gateway answers that DISC (UA or DM, heard on Dire Wolf's AGW
//     monitor) or CLOSE_WAIT_MS passes. Only then is Dire Wolf stopped. A
//     second Stop, or POTACAT closing, ends it at once.
//  2. A call that opens on a link the gateway still holds (FRMR before any
//     greeting, or UA and no greeting within GREETING_WAIT_MS) is ended, says
//     so in plain words, and is never retried automatically.
//
// Pure: no sockets, no timers, no clock. main.js feeds it the AGW monitor's
// text for each frame (lib/direwolf-agw-monitor.js describeMonitorFrame:
// "rx 1:Fm KJ4AJP-10 To NA4DQ <UA pid=F0 Len=0 F=1 >[18:07:23]") with the time.

'use strict';

/** The longest POTACAT keeps Dire Wolf up waiting for the gateway to answer our DISC. */
const CLOSE_WAIT_MS = 10000;
/** After the gateway's own DISC, Dire Wolf still has to send its UA: this long. */
const DISC_LINGER_MS = 1500;
/** A link that came up (UA) and brought no greeting (an I frame) in this long is a link the gateway still holds. */
const GREETING_WAIT_MS = 20000;

/**
 * Causes after which nothing more may be transmitted, or nothing more can be:
 * the session ends at once, as before (Dire Wolf stopped with it). Every other
 * end of a packet session closes the link first.
 */
const END_AT_ONCE = Object.freeze(['closing', 'turned-off', 'pat-stopped', 'pat-lost', 'modem-stopped',
  'audio-device', 'audio-stopped', 'tx-failsafe', 'swr', 'ptt-refused', 'preempted']);

function _base(call) {
  return String(call || '').toUpperCase().trim().replace(/-\d+$/, '');
}

/**
 * One monitor line, taken apart. null for anything that is not a frame line.
 * @returns {{dir:'rx'|'tx', from:string, to:string, kind:string, rest:string}|null}
 */
function parseMonitorText(text) {
  const m = /^(rx|tx)\s+\d*:?\s*Fm\s+(\S+)\s+To\s+(\S+).*?<\s*([A-Za-z]+)([^>]*)>/.exec(String(text || ''));
  if (!m) return null;
  return { dir: m[1], from: m[2].toUpperCase(), to: m[3].toUpperCase(), kind: m[4].toUpperCase(), rest: m[5] || '' };
}

/**
 * Should this end of a packet session close the link before Dire Wolf stops?
 * @param {object} o
 * @param {string} o.mode
 * @param {{kind:string}|null} [o.cause]  the cause POTACAT noted (lib/winlink-outcome.js CAUSES)
 * @param {boolean} [o.force]  a second Stop: end at once
 * @returns {boolean}
 */
function closeFirst({ mode, cause, force } = {}) {
  if (mode !== 'packet' || force) return false;
  const k = cause && cause.kind;
  return !(k && END_AT_ONCE.includes(k));
}

/**
 * What the AGW monitor heard of the link between this station and the
 * gateway, for one session. Frames from other stations on the channel, or
 * from the gateway to someone else, are not this link and are left out.
 */
class PacketLinkWatch {
  /**
   * @param {object} o
   * @param {string} [o.gateway]  the gateway's call, SSID included (frames from it only)
   * @param {string} [o.mycall]   this station's call (frames to it only; the SSID is not compared)
   */
  constructor({ gateway = '', mycall = '', greetingWaitMs = GREETING_WAIT_MS, closeWaitMs = CLOSE_WAIT_MS, lingerMs = DISC_LINGER_MS } = {}) {
    this.gateway = String(gateway || '').toUpperCase().trim();
    this.mycall = _base(mycall);
    this.greetingWaitMs = greetingWaitMs; this.closeWaitMs = closeWaitMs; this.lingerMs = lingerMs;
    this.up = false; this.upAt = 0;        // the gateway's UA to our SABM
    this.greeting = false;                 // an I frame from the gateway after that
    this.frmr = false;                     // FRMR before any greeting
    this.down = null;                      // { by: 'UA'|'DM'|'DISC', at }: the link ended
    this.closingAt = 0;                    // when POTACAT asked for the clean disconnect
  }

  _ours(p) {
    if (!p || p.dir !== 'rx') return false;
    if (this.gateway && p.from !== this.gateway) return false;
    if (this.mycall && _base(p.to) !== this.mycall) return false;
    return true;
  }

  /** Feed one monitor line. @returns {string} the frame kind when it was this link's, else '' */
  noteFrame(text, now) {
    const p = parseMonitorText(text);
    if (!this._ours(p)) return '';
    const t = Number(now) || 0;
    switch (p.kind) {
      case 'UA':
        if (this.closingAt || this.up) { if (!this.down) this.down = { by: 'UA', at: t }; }
        else { this.up = true; this.upAt = t; }
        break;
      case 'DM':
        if ((this.closingAt || this.up) && !this.down) this.down = { by: 'DM', at: t };
        break;
      case 'DISC':
        if (!this.down) this.down = { by: 'DISC', at: t };
        break;
      case 'FRMR':
        if (!this.greeting) this.frmr = true;
        break;
      case 'I':
        if (this.up && !this.down) this.greeting = true;
        break;
      default:
        break;
    }
    return p.kind;
  }

  /**
   * Is this call on a link the gateway still holds?
   * @returns {{stuck:boolean, why:''|'frmr'|'no-greeting'}}
   */
  stuck(now) {
    if (this.greeting || this.down || this.closingAt) return { stuck: false, why: '' };
    if (this.frmr) return { stuck: true, why: 'frmr' };
    if (this.up && (Number(now) || 0) - this.upAt >= this.greetingWaitMs) return { stuck: true, why: 'no-greeting' };
    return { stuck: false, why: '' };
  }

  /**
   * Is there a link to close? It came up (the monitor heard the UA, or Pat
   * said it connected) and nothing has ended it yet.
   */
  needsClose({ patConnected } = {}) {
    return (this.up || !!patConnected) && !this.down;
  }

  /** POTACAT asked Pat for the clean disconnect now. */
  beginClose(now) {
    if (!this.closingAt) this.closingAt = Number(now) || 0;
  }

  /**
   * Can Dire Wolf be stopped yet?
   * @returns {{done:boolean, by:''|'UA'|'DM'|'DISC'|'timeout', ms:number}} ms: since the clean disconnect was asked
   */
  closeState(now) {
    const t = Number(now) || 0;
    const ms = this.closingAt ? Math.max(0, t - this.closingAt) : 0;
    if (this.down) {
      if (this.down.by === 'DISC' && t - this.down.at < this.lingerMs && ms < this.closeWaitMs) return { done: false, by: '', ms };
      return { done: true, by: this.down.by, ms };
    }
    if (this.closingAt && ms >= this.closeWaitMs) return { done: true, by: 'timeout', ms };
    return { done: false, by: '', ms };
  }
}

/** The log line for a link that was closed (or was not) before Dire Wolf stopped. */
function closeLogText({ by, ms, gateway } = {}) {
  const g = String(gateway || '').toUpperCase() || 'the gateway';
  const s = (Math.max(0, Number(ms) || 0) / 1000).toFixed(1);
  if (by === 'UA') return `packet: ${g} answered our disconnect (UA) after ${s} s: the link is closed, Dire Wolf stops now`;
  if (by === 'DM') return `packet: ${g} answered our disconnect (DM) after ${s} s: the link is closed, Dire Wolf stops now`;
  if (by === 'DISC') return `packet: ${g} ended the link itself (DISC) and Dire Wolf answered it: Dire Wolf stops now`;
  if (by === 'forced') return `packet: stopped at once (a second Stop) after ${s} s: ${g} may hold the link for a while`;
  return `packet: ${g} did not answer our disconnect in ${s} s: Dire Wolf stops anyway, and ${g} may hold the link for a while`;
}

/** The log line for a call that opened on a held link. */
function stuckLogText({ why, gateway } = {}) {
  const g = String(gateway || '').toUpperCase() || 'the gateway';
  if (why === 'frmr') return `packet: ${g} answered the call with FRMR: it is still holding the last link to this station`;
  return `packet: ${g} answered the call (UA) but sent no greeting in ${Math.round(GREETING_WAIT_MS / 1000)} s: it is still holding the last link to this station`;
}

module.exports = {
  CLOSE_WAIT_MS, DISC_LINGER_MS, GREETING_WAIT_MS, END_AT_ONCE,
  parseMonitorText, closeFirst, PacketLinkWatch, closeLogText, stuckLogText,
};
