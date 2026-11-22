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
//  2. A call that opens on a link the gateway still holds (FRMR after its UA
//     and before any greeting, or UA and no greeting within GREETING_WAIT_MS)
//     is ended, says so in plain words, and is never retried automatically.
//     An FRMR BEFORE the UA is not counted (#867): it is how an AX.25 2.0 node
//     answers Dire Wolf's first SABME (v2.2), and Dire Wolf then falls back to
//     SABM. NA4DQ's held link still ends: its UA came with no greeting, which
//     the GREETING_WAIT_MS rule catches.
//
// And the other side of rule 2 (#791, the same station on 19 Nov 2026): after
// SABM and UA the gateway sends its greeting (I S0). When this station misses
// that frame, the gateway's timer runs out and it polls: RR with P=1 and
// N(R)=0, "you have had nothing from me yet, answer". Dire Wolf answers and the
// gateway sends the greeting again. The 20 s rule above aborted 7 of 9 such
// links, 6 of them while the gateway was polling. So, before the greeting:
//  - an RR command poll (P=1) with N(R)=0 from the gateway is a FRESH link: it
//    fits a link that has carried no I frame of ours, which is every new link
//    (in Winlink the gateway speaks first). The wait runs on to GREETING_WAIT_MS
//    after the latest such poll: the gateway polled about 10 s apart in that
//    log, so 20 s leaves room for its next poll or its resent greeting. Never
//    past GREETING_MAX_MS after the UA, so a link that only ever polls still ends.
//  - a supervisory frame (RR, RNR, REJ, SREJ) with N(R) not 0 acknowledges I
//    frames this new link never carried: the gateway is still in the old link.
//    That ends the call at once, as an FRMR does.
//  - silence (no poll of this link) for GREETING_WAIT_MS ends it, as before.
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
 * The gateway polling the new link (RR R0 P=1) keeps the wait going, GREETING_WAIT_MS from
 * its latest poll, but never past this long after the UA (#791). About 8 of the gateway's
 * ~10 s poll cycles: a greeting that has not decoded by then is a receive problem, not a wait.
 */
const GREETING_MAX_MS = 90000;
/** AX.25 supervisory frames: they carry N(R), what the sender has received from us. */
const SUPERVISORY = Object.freeze(['RR', 'RNR', 'REJ', 'SREJ']);

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
 * N(R) and the poll bit of a frame, from the rest of Dire Wolf's monitor text
 * ("<RR R0 P=1 >": rest " R0 P=1 "). Dire Wolf writes P= on a command and F= on a response.
 * @returns {{nr:number|null, poll:boolean}}
 */
function frameBits(rest) {
  const r = /(?:^|\s)R(\d)(?=\s|$)/.exec(String(rest || ''));
  return { nr: r ? Number(r[1]) : null, poll: /(?:^|\s)P=1(?=\s|$)/.test(String(rest || '')) };
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
  constructor({ gateway = '', mycall = '', greetingWaitMs = GREETING_WAIT_MS, greetingMaxMs = GREETING_MAX_MS, closeWaitMs = CLOSE_WAIT_MS, lingerMs = DISC_LINGER_MS } = {}) {
    this.gateway = String(gateway || '').toUpperCase().trim();
    this.mycall = _base(mycall);
    this.greetingWaitMs = greetingWaitMs; this.greetingMaxMs = greetingMaxMs; this.closeWaitMs = closeWaitMs; this.lingerMs = lingerMs;
    this.pollAt = 0;                       // the gateway's latest poll of the fresh link (RR R0 P=1) before the greeting (#791)
    this.oldLink = null;                   // { kind, nr, at }: a frame before the greeting that only fits the old link
    this._news = '';                       // one log line for main.js (takeNews)
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
        // Only after the gateway's UA (#867). Before it, an FRMR is the normal
        // answer of an AX.25 2.0 node to Dire Wolf's first SABME: Dire Wolf
        // falls back to SABM and the link comes up (KQ4VPW, K4WOF-10, 2026-11-21:
        // FRMR, then UA and "*** KQ4VPW Connected to CMS", which POTACAT hung up on).
        if (this.up && !this.greeting) this.frmr = true;
        break;
      case 'I':
        if (this.up && !this.down) this.greeting = true;
        break;
      default:
        if (SUPERVISORY.includes(p.kind)) this._supervisory(p, t);
        break;
    }
    return p.kind;
  }

  /** An RR, RNR, REJ or SREJ from the gateway, between its UA and its greeting (#791). */
  _supervisory(p, t) {
    if (!this.up || this.greeting || this.down || this.closingAt) return;
    const { nr, poll } = frameBits(p.rest);
    if (nr !== null && nr !== 0) {
      if (!this.oldLink) this.oldLink = { kind: p.kind, nr, at: t };
      return;
    }
    if (p.kind !== 'RR' || !poll || nr !== 0 || this.oldLink) return;
    const end = this.upAt + this.greetingMaxMs;
    if (t >= end) return;
    this.pollAt = t;
    const waitS = Math.round((Math.min(t + this.greetingWaitMs, end) - t) / 1000);
    const g = this.gateway || 'the gateway';
    this._news = `packet: ${g} is polling the new link (RR R0 P=1): the link is fresh and the gateway is asking again for a greeting that did not decode here, so POTACAT keeps waiting ${waitS} s more (${Math.round(this.greetingMaxMs / 1000)} s at most after its UA)`;
  }

  /** The log line the last frame earned (a poll that keeps the link), once; '' when none. */
  takeNews() {
    const n = this._news; this._news = '';
    return n;
  }

  /**
   * Is this call on a link the gateway still holds, or one whose greeting never decodes here?
   *  frmr        the gateway answered with FRMR after its UA and before any greeting (#300, #867)
   *  old-link    it acknowledged frames this new link never carried (N(R) not 0); nr is that N(R)
   *  no-greeting UA, then silence for GREETING_WAIT_MS (from the UA, or from its latest poll)
   *  poll-limit  it kept polling the fresh link and no greeting decoded in GREETING_MAX_MS after the UA (#791)
   * @returns {{stuck:boolean, why:''|'frmr'|'old-link'|'no-greeting'|'poll-limit', nr?:number}}
   */
  stuck(now) {
    if (this.greeting || this.down || this.closingAt) return { stuck: false, why: '' };
    if (this.frmr) return { stuck: true, why: 'frmr' };
    if (this.oldLink) return { stuck: true, why: 'old-link', nr: this.oldLink.nr };
    if (!this.up) return { stuck: false, why: '' };
    const t = Number(now) || 0;
    if (this.pollAt) {
      if (t - this.upAt >= this.greetingMaxMs) return { stuck: true, why: 'poll-limit' };
      if (t - this.pollAt >= this.greetingWaitMs) return { stuck: true, why: 'no-greeting' };
      return { stuck: false, why: '' };
    }
    if (t - this.upAt >= this.greetingWaitMs) return { stuck: true, why: 'no-greeting' };
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

/** The log line for a call that opened on a held link, or whose greeting never decoded here. */
function stuckLogText({ why, gateway, nr } = {}) {
  const g = String(gateway || '').toUpperCase() || 'the gateway';
  if (why === 'frmr') return `packet: ${g} answered the call with FRMR: it is still holding the last link to this station`;
  if (why === 'old-link') return `packet: ${g} answered the call (UA) but then acknowledged frames from an earlier link (N(R)=${nr}): it is still holding the last link to this station`;
  if (why === 'poll-limit') return `packet: ${g} kept polling the link for ${Math.round(GREETING_MAX_MS / 1000)} s but its greeting never decoded here: ending the call (check the receive level)`;
  return `packet: ${g} answered the call (UA) but sent no greeting in ${Math.round(GREETING_WAIT_MS / 1000)} s: it is still holding the last link to this station`;
}

/** Why the session was stopped, for its error line: a held link, or (poll-limit) a greeting that never decoded here. */
function stuckAbortWhy(why) {
  return why === 'poll-limit' ? 'the gateway\'s greeting never decoded here' : 'the gateway is still holding the last link';
}

module.exports = {
  CLOSE_WAIT_MS, DISC_LINGER_MS, GREETING_WAIT_MS, GREETING_MAX_MS, END_AT_ONCE,
  parseMonitorText, frameBits, closeFirst, PacketLinkWatch, closeLogText, stuckLogText, stuckAbortWhy,
};
