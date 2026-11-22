// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS extra 1: the running activation in the beacon comment, for the
// internet beacon (phase 5) and the radio beacon (phase 7) alike.
//
//   POTA US-1234 14.062 CW
//   POTA US-1234,US-5678 SOTA W7W/LC-001 14.285 SSB
//
// Off by default ("Add my activation to the beacon comment",
// settings.aprsBeaconActivation). The text is the program word, the refs
// under it, the frequency in MHz and the mode, in the words a spot uses
// (lib/pota-email-spot.js spotMode / formatFreqMhz; data modes read DATA).
// It always fits the 43-character APRS comment (APRS 1.0.1 chapter 8; the
// limit is lib/aprs-beacon.js MAX_COMMENT): refs that do not fit become "+N"
// and the frequency and mode stay. The operator's own comment follows only
// when it fits whole, so nothing is cut mid-word.
//
// While "Listen on my radio" holds the dial, the radio sits on the APRS
// frequency, not the activation's: the frequency used is then the place the
// radio goes back to (settings.aprsListenReturn), or none. Pure.
'use strict';

const AprsBeacon = require('./aprs-beacon');
const { spotMode, formatFreqMhz } = require('./pota-email-spot');

const MAX = AprsBeacon.MAX_COMMENT;
const DATA_MODE = /^(DIG[UL]|PKT|PKTUSB|PKTLSB|PKT-?[UL]|DATA|DATA-?(USB|LSB|U|L|FM)|(USB|LSB|FM)-?D\d?)$/;

/** The mode in spot words: SSB, CW, FM, DATA, or the digital mode's own name (FT8). */
function modeWord(mode) {
  const m = String(mode || '').toUpperCase().trim();
  if (!m) return '';
  if (DATA_MODE.test(m)) return 'DATA';
  return spotMode(m).replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

/** Hz to MHz as a spot gives it: 14.062, 7.0305, 146.520. '' when unknown. */
function freqWord(hz) {
  const n = Number(hz);
  return n > 0 ? formatFreqMhz(n / 1000) : '';
}

function clean(s) { return String(s || '').toUpperCase().replace(/[^\x21-\x7e]|[|~]/g, ''); }

// "POTA US-1234,US-5678 SOTA W7W/LC-001": one program word per program, in order.
function refsWords(refs) {
  const groups = [];
  for (const r of refs) {
    const sig = clean(r.sig) || 'POTA';
    let g = groups.find((x) => x.sig === sig);
    if (!g) { g = { sig, refs: [] }; groups.push(g); }
    g.refs.push(clean(r.ref));
  }
  return groups.map((g) => g.sig + ' ' + g.refs.join(',')).join(' ');
}

/**
 * The activation text, at most 43 characters, or '' with no refs.
 * @param {{refs:{sig,ref}[], hz:number, mode:string}} a
 */
function activationText(a) {
  const refs = (a && Array.isArray(a.refs) ? a.refs : []).filter((r) => r && clean(r.ref));
  if (!refs.length) return '';
  const tailParts = [freqWord(a.hz), modeWord(a.mode)].filter(Boolean);
  const join = (head, tail) => [head].concat(tail).filter(Boolean).join(' ');
  for (let keep = refs.length; keep >= 1; keep--) {
    const more = refs.length - keep;
    const head = refsWords(refs.slice(0, keep)) + (more ? ' +' + more : '');
    const t = join(head, tailParts);
    if (t.length <= MAX) return t;
  }
  // One ref and the tail still too long (never with real refs): drop the mode, then the frequency, then cut.
  const head = refsWords(refs.slice(0, 1)) + (refs.length > 1 ? ' +' + (refs.length - 1) : '');
  for (let n = tailParts.length - 1; n >= 0; n--) {
    const t = join(head, tailParts.slice(0, n));
    if (t.length <= MAX) return t;
  }
  return head.slice(0, MAX);
}

/**
 * The comment both beacons send.
 * @param {{comment:string, on:boolean, activation:{refs,hz,mode}|null}} o
 * @returns {{comment:string, added:boolean, text:string, running:boolean}}
 *   added: the activation is in the comment; text: the activation part
 *   ('' with none running); running: an activation is running.
 */
function beaconComment({ comment, on, activation }) {
  const base = AprsBeacon.cleanComment(comment);
  const text = activationText(activation);
  const running = !!text;
  if (!on || !text) return { comment: base, added: false, text, running };
  const withBase = base && text.length + 1 + base.length <= MAX ? text + ' ' + base : text;
  return { comment: AprsBeacon.cleanComment(withBase), added: true, text, running };
}

/**
 * Where the activation is on the air.
 *  - Listening on the radio for APRS: the dial is the APRS frequency, so the
 *    place the radio goes back to (lib/aprs-radio-return.js marker), or none.
 *  - Otherwise the dial, with JTCAT's mode (FT8, FT4) while it runs.
 */
function activationFrequency({ dialHz, radioMode, jtcatMode, listening, returnTo }) {
  if (listening) {
    const r = returnTo && Number(returnTo.freqHz) > 0 ? returnTo : null;
    return r ? { hz: Number(r.freqHz), mode: String(r.mode || '') } : { hz: 0, mode: '' };
  }
  return { hz: Number(dialHz) > 0 ? Number(dialHz) : 0, mode: String(jtcatMode || radioMode || '') };
}

module.exports = { modeWord, freqWord, activationText, beaconComment, activationFrequency };
