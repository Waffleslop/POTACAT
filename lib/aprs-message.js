// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// APRS messages (A1): the packet formats, pure. No socket, no timers. The
// messenger (lib/aprs-messenger.js) keeps the conversations and the retries;
// main.js sends the lines through the one APRS-IS uplink (lib/aprs-is.js).
// Internet only: nothing here keys a radio.
//
// Every rule and where it comes from:
//
//  - The message. APRS Protocol Reference 1.0.1, chapter 14 "Messages,
//    Bulletins and Announcements": the data type ':', the addressee in a
//    fixed 9-character field padded with spaces, a second ':', the text
//    (0 to 67 characters, printable ASCII except |, ~ and {), and an optional
//    message identifier: '{' followed by 1 to 5 alphanumeric characters.
//      K3SBP-10>APZPCT,TCPIP*::KC3ZZZ-7 :Thanks for the QSO{12
//  - Acknowledgement and rejection (same chapter): a message to the sender
//    whose text is "ack" or "rej" followed by the identifier, with no
//    identifier of its own.
//      K3SBP-10>APZPCT,TCPIP*::KC3ZZZ-7 :ack12
//  - Reply-acks (aprs.org/aprs11/replyacks.txt): a station that takes them
//    numbers its messages "{MM}AA", where AA is a free ack for our message AA
//    (or empty), and "the ack is just the exact copy" ("ackMM}AA"). POTACAT
//    does not ask for reply-acks (it numbers its own messages "{MM}"), but it
//    reads them: the AA counts as an ack, and its ack copies the whole number.
//  - The source and the path: the uplink's login (the Settings callsign with
//    -10, lib/aprs-igate.js uplinkLogin), the experimental tocall APZPCT and
//    TCPIP*, as the internet beacon (lib/aprs-beacon.js) sends. APRS-IS
//    documents a verified client's packets for FROMCALL = login
//    (aprs-is.net/q.aspx, qAC).
//  - Which messages are ours: the addressee is the Settings callsign's base
//    with any SSID (or none). The read-only feed asks for them with the group
//    message filter "g/BASE/BASE-*" (aprs-is.net/javAPRSFilter.aspx: "passes
//    all message packets with the specified callsign-SSID(s) as the addressee
//    of the message. Supports * wildcard.").
//
// Dual-mode: require() in main and tests, window.AprsMessage in the APRS
// window (the compose box's counter and checks).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AprsMessage = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TOCALL = 'APZPCT';
  const PATH = 'TCPIP*';
  const ADDRESSEE_LEN = 9;
  const MAX_TEXT = 67;
  const MAX_ID = 99999; // 1 to 5 digits, alphanumeric per the spec; POTACAT counts in decimal
  const ADDRESSEE_RE = /^[A-Z0-9]{1,6}(-[A-Z0-9]{1,2})?$|^[A-Z0-9-]{1,9}$/;
  const ID_RE = /^[A-Za-z0-9]{1,5}$/;

  /** The addressee field: capitals, exactly 9 characters, padded with spaces. */
  function padAddressee(call) {
    return String(call || '').toUpperCase().trim().slice(0, ADDRESSEE_LEN).padEnd(ADDRESSEE_LEN, ' ');
  }

  /** A To field as typed -> { ok, call } or { ok: false, sentence }. */
  function checkAddressee(to) {
    const c = String(to || '').toUpperCase().trim();
    if (!c) return { ok: false, sentence: 'Type who the message is to.' };
    if (c.length > ADDRESSEE_LEN) return { ok: false, sentence: `${c} is too long: APRS calls are at most 9 characters.` };
    if (!ADDRESSEE_RE.test(c) || /^-|-$|--/.test(c)) return { ok: false, sentence: `${c} is not a call APRS can send to (letters, digits and one -).` };
    return { ok: true, call: c };
  }

  /** The text with the characters APRS reserves (| ~ {) and anything not printable ASCII taken out. */
  function cleanText(text) {
    return String(text == null ? '' : text).replace(/[^\x20-\x7e]/g, ' ').replace(/[|~{]/g, '');
  }

  /** The text as it will go out -> { ok, text } or { ok: false, sentence }. */
  function checkText(text) {
    const t = cleanText(text).trim();
    if (!t) return { ok: false, sentence: 'Type a message first.' };
    if (t.length > MAX_TEXT) return { ok: false, sentence: `The message is ${t.length} characters; APRS takes at most ${MAX_TEXT}.` };
    return { ok: true, text: t };
  }

  /** "48 / 67" for the compose box, and whether it is over. */
  function counter(text) {
    const n = cleanText(text).trim().length;
    return { n, max: MAX_TEXT, over: n > MAX_TEXT, label: `${n} / ${MAX_TEXT}` };
  }

  /** The next message number after n: 1..99999, then 1 again. */
  function nextMessageId(n) {
    const v = Math.floor(Number(n));
    return (!isFinite(v) || v < 1 || v >= MAX_ID) ? 1 : v + 1;
  }

  function head(from) { return `${String(from || '').toUpperCase()}>${TOCALL},${PATH}:`; }

  /**
   * The information field of a message, ":ADDRESSEE:text{ID}", or null when a
   * part is missing or wrong. A3: the radio sends this field under its own
   * source and path (lib/aprs-rf-message.js); the internet line adds the head.
   */
  function buildMessageInfo({ to, text, id }) {
    const a = checkAddressee(to);
    const t = checkText(text);
    if (!a.ok || !t.ok) return null;
    const sid = id == null || id === '' ? '' : String(id);
    if (sid && !ID_RE.test(sid)) return null;
    return ':' + padAddressee(a.call) + ':' + t.text + (sid ? '{' + sid : '');
  }

  /** A message line, or null when a part is missing or wrong. */
  function buildMessage({ from, to, text, id }) {
    const src = String(from || '').toUpperCase().trim();
    const info = buildMessageInfo({ to, text, id });
    if (!src || !info) return null;
    return head(src) + info;
  }

  /** The information field of an ack or rej, ":ADDRESSEE:ackID", or null. */
  function buildAckInfo({ to, id, kind = 'ack' }) {
    const a = checkAddressee(to);
    const sid = String(id || '');
    if (!a.ok || !/^[A-Za-z0-9]{1,5}(\}[A-Za-z0-9]{0,5})?$/.test(sid)) return null;
    return ':' + padAddressee(a.call) + ':' + (kind === 'rej' ? 'rej' : 'ack') + sid;
  }

  /** An ack (kind 'ack') or rej (kind 'rej') for a message number we received, copied exactly. */
  function buildAckLine({ from, to, id, kind = 'ack' }) {
    const src = String(from || '').toUpperCase().trim();
    const info = buildAckInfo({ to, id, kind });
    if (!src || !info) return null;
    return head(src) + info;
  }

  /**
   * One APRS-IS line -> null (not a message) or
   * { from, addressee, kind: 'message'|'ack'|'rej', text, id, ackId, replyAck }
   *  - message: text, id (as received, for the ack: "12" or "12}AB"), ackId null,
   *    replyAck the free ack inside a reply-ack number ("AB") or null.
   *  - ack / rej: ackId, the number of OUR message it answers.
   */
  function parseMessageLine(line) {
    const s = String(line || '').replace(/[\r\n]+$/, '');
    const colon = s.indexOf(':');
    if (colon < 3) return null;
    const hdr = s.slice(0, colon);
    let info = s.slice(colon + 1);
    const gt = hdr.indexOf('>');
    if (gt < 1) return null;
    const from = hdr.slice(0, gt).toUpperCase();
    if (!/^[A-Z0-9-]{1,9}$/.test(from)) return null;
    // A third-party packet (data type '}') carries the original inside it.
    if (info[0] === '}') return parseMessageLine(info.slice(1));
    if (info[0] !== ':' || info.length < 11 || info[10] !== ':') return null;
    const addressee = info.slice(1, 10).trim().toUpperCase();
    if (!addressee) return null;
    info = info.slice(11).replace(/\s+$/, '');
    const ar = /^(ack|rej)([A-Za-z0-9]{1,5})(\}[A-Za-z0-9]{0,5})?$/.exec(info);
    if (ar) return { from, addressee, kind: ar[1], text: '', id: null, ackId: ar[2], replyAck: null };
    let text = info, id = null, replyAck = null;
    const m = /\{([A-Za-z0-9]{1,5})(?:\}([A-Za-z0-9]{0,5}))?$/.exec(info);
    if (m) {
      text = info.slice(0, m.index);
      id = m[1] + (m[2] !== undefined ? '}' + m[2] : '');
      replyAck = m[2] ? m[2] : null;
    }
    return { from, addressee, kind: 'message', text: text.trim(), id, ackId: null, replyAck };
  }

  /** The base of a callsign: no SSID, capitals. */
  function baseCall(call) { return String(call || '').toUpperCase().trim().split('-')[0]; }

  /** Is this addressee one of ours: the base with any SSID, or none (K3SBP, K3SBP-7; never K3SBPX). */
  function isForMe(addressee, myBase) {
    const b = baseCall(myBase);
    if (!b) return false;
    const a = String(addressee || '').toUpperCase().trim();
    return a === b || (a.startsWith(b + '-') && /^[A-Z0-9]{1,2}$/.test(a.slice(b.length + 1)));
  }

  /** The read-only feed's filter for our messages: "g/K3SBP/K3SBP-*", or null with no callsign. */
  function messageFilter(myCall) {
    const b = baseCall(myCall);
    if (!/^[A-Z0-9]{3,7}$/.test(b) || !/\d/.test(b)) return null;
    return `g/${b}/${b}-*`;
  }

  return {
    TOCALL, PATH, ADDRESSEE_LEN, MAX_TEXT, MAX_ID,
    padAddressee, checkAddressee, cleanText, checkText, counter, nextMessageId,
    buildMessage, buildMessageInfo, buildAckLine, buildAckInfo, parseMessageLine, baseCall, isForMe, messageFilter,
  };
});
