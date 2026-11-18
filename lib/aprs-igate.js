// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// The receive-only iGate (APRS phase 4): which packets heard on the radio go
// to APRS-IS, and how. Pure: no socket, no timers, no settings. main.js hands
// it each TNC2 line Dire Wolf heard (lib/aprs-rf-frames.js) and a send
// function (the one APRS-IS uplink, lib/aprs-is.js).
//
// Every rule, and the page it comes from (each read 2026-11-18):
//
//  1. Receive only: radio to internet, never internet to radio. This module
//     takes RF lines and nothing else; lines APRS-IS sends back are never read
//     (main.js gives the uplink no line listener; test/aprs-igate-test.js
//     checks that). Dire Wolf's APRS config has no PTT line at all
//     (lib/direwolf-process.js), so the radio cannot be keyed.
//  2. Only AX.25 UI frames with PID F0. aprs-is.net/IGateDetails.aspx:
//     "Gate all packets heard on RF to the Internet EXCEPT if ... The packet
//     does not have a control field of 0x03 or a PID of 0xf0." Already done
//     upstream: lib/aprs-rf-frames.js keeps only UI frames with pid=F0.
//  3. Not gated: "packets with TCPIP, TCPXX, NOGATE, or RFONLY in the header
//     (last 2 are optional)" (IGateDetails.aspx). POTACAT applies all four.
//     A path that already holds a q construct came off APRS-IS too:
//     aprs-is.net/q.aspx, "q constructs will only appear on APRS-IS".
//  4. Not gated: "generic queries (data type ? )" (IGateDetails.aspx);
//     IGating.aspx: "An IGate should not gate generic queries (data type ?)
//     to or from APRS-IS."
//  5. Third party (data type }): IGating.aspx, "An IGate should not gate
//     third-party packets (data type }) with TCPIP or TCPXX in the third-party
//     header to APRS-IS", and "Third-party packets without TCPIP in the header
//     are to be gated to APRS-IS" after "stripping the RF header and
//     third-party data type". The inner packet then meets every rule here.
//  6. The q construct. IGateDetails.aspx: "IGates must not modify paths of
//     packets gated to APRS-IS except to append ,qAR,IGATECALL" and "qAO
//     should be used instead of qAR if the IGate is receive-only (cannot
//     transmit)." q.aspx, qAO: "Packet is placed on APRS-IS by an IGate from
//     RF which the IGate cannot gate messages to ... Receive-only IGates will
//     use this exclusively for all packets gated to APRS-IS." POTACAT never
//     transmits, so it appends ,qAO,<igate call> and changes nothing else.
//     IGating.aspx: "The data portion of the packet should never be
//     modified", so a packet whose data holds a CR, LF or NUL is not gated
//     (it cannot be sent as one line without changing it).
//  7. Duplicates. aprs-is.net/ServerDesign.aspx: "Duplicate checking is based
//     on the origin call and SSID, destination call (SSID ignored), data
//     length, and data content ... the path is ignored ... The origin and
//     destination calls are case-sensitive ... Duplicate checking is done
//     over a 30 second sliding window for each packet." The iGate pages set
//     no window of their own, so POTACAT uses the servers' rule: a packet
//     equal to one it gated in the last 30 s is not sent again (a
//     digipeated copy of a packet it already gated, for one).
//  8. The login. aprs-is.net/Connecting.aspx: "user mycall[-ss] pass passcode
//     [ vers softwarename softwarevers ...]", "softwarename=one word name of
//     the client software. Do not use spaces." and the same for the version;
//     "Only verified (valid passcode) clients may send data to APRS-IS".
//     IGating.aspx: "Only stations with a validated login can to gate to
//     APRS-IS." The passcode is lib/aprs-passcode.js, for the Settings
//     callsign only.
//  9. The iGate's call. The APRS SSID recommendations (aprs.org/aprs11/
//     SSIDs.txt): "-10 internet, Igates, echolink, winlink, AVRS, APRN, etc".
//     POTACAT logs in as the Settings callsign with -10, which also keeps it
//     apart from the read-only feed's login (the bare callsign, pass -1).

'use strict';

const { aprsPasscode, passcodeBase } = require('./aprs-passcode');

const DIRECTION = 'rf-to-is';
const Q_CONSTRUCT = 'qAO';
const DUPE_WINDOW_MS = 30000;
const IGATE_SSID = 10;
const MAX_THIRD_PARTY = 2;

const CALL_RE = /^[A-Za-z0-9-]{1,9}$/;
const HOP_RE = /^[A-Za-z0-9-]{1,9}\*?$/;

/** The callsign APRS-IS sends under: the Settings call's base with -10, or a refusal. */
function uplinkLogin(settingsCall) {
  const raw = String(settingsCall || '').trim().toUpperCase();
  const base = passcodeBase(raw);
  if (!base) return { ok: false, reason: 'no-call', sentence: 'Set your callsign in Settings first.' };
  if (/^(N0CALL|NOCALL)$/.test(base) || /^PCAT\d*$/.test(base)) {
    return { ok: false, reason: 'placeholder', sentence: `${base} is a placeholder. Set your own callsign in Settings.` };
  }
  if (!/^[A-Z0-9]{3,6}$/.test(base) || !/\d/.test(base) || !/[A-Z]/.test(base)) {
    return { ok: false, reason: 'invalid', sentence: `${raw} is not a callsign APRS can use (three to six letters and digits, no /).` };
  }
  return { ok: true, call: `${base}-${IGATE_SSID}`, base };
}

/** "user CALL pass N vers POTACAT 1.2.3": the passcode is for this call's base, the name and version one word each. */
function loginLine({ call, version }) {
  const v = String(version || '0.0.0').replace(/\s+/g, '');
  return `user ${call} pass ${aprsPasscode(call)} vers POTACAT ${v}`;
}

/** The server's answer to our login: verified for this call, and not "unverified". */
function logrespVerified(line, call) {
  const m = /^#\s*logresp\s+(\S+)\s+(\S+?),?(\s|$)/i.exec(String(line || ''));
  if (!m) return false;
  return m[1].toUpperCase() === String(call || '').toUpperCase() && m[2].toLowerCase() === 'verified';
}

/** {from, dest, path[], data} or null. */
function splitTnc2(line) {
  const s = String(line || '');
  const colon = s.indexOf(':');
  if (colon < 3) return null;
  const head = s.slice(0, colon);
  const data = s.slice(colon + 1);
  const gt = head.indexOf('>');
  if (gt < 1) return null;
  const from = head.slice(0, gt);
  const parts = head.slice(gt + 1).split(',');
  const dest = parts.shift();
  if (!CALL_RE.test(from) || !dest || !CALL_RE.test(dest)) return null;
  for (const p of parts) if (!HOP_RE.test(p)) return null;
  if (!data) return null;
  return { from, dest, path: parts, data };
}

const hopName = (h) => String(h).replace(/\*$/, '').toUpperCase();

/**
 * One line heard on the radio → { ok: true, out, from } (the line to send) or
 * { ok: false, reason }. Reasons: bad-header, bad-data, from-internet, nogate,
 * query.
 */
function gateLine(line, igateCall, depth = 0) {
  const p = splitTnc2(line);
  if (!p) return { ok: false, reason: 'bad-header' };
  const hops = p.path.map(hopName);
  if (hops.some((h) => h === 'TCPIP' || h === 'TCPXX' || /^QA.$/.test(h))) return { ok: false, reason: 'from-internet' };
  if (hops.some((h) => h === 'NOGATE' || h === 'RFONLY')) return { ok: false, reason: 'nogate' };
  if (/[\r\n\0]/.test(p.data)) return { ok: false, reason: 'bad-data' };
  const type = p.data[0];
  if (type === '?') return { ok: false, reason: 'query' };
  if (type === '}') {
    if (depth >= MAX_THIRD_PARTY) return { ok: false, reason: 'bad-header' };
    return gateLine(p.data.slice(1), igateCall, depth + 1);
  }
  const head = p.from + '>' + p.dest + (p.path.length ? ',' + p.path.join(',') : '');
  return { ok: true, out: `${head},${Q_CONSTRUCT},${igateCall}:${p.data}`, from: p.from };
}

/** The duplicate key: source (as sent), destination without SSID, data. */
function dupeKey(line) {
  const p = splitTnc2(line);
  if (!p) return null;
  return p.from + '>' + p.dest.split('-')[0] + ':' + p.data;
}

/**
 * The iGate: offer(line) gates one RF line through send(out) → boolean
 * (false when the uplink is not verified). stats() gives the counts the
 * window and Settings show.
 */
function createIgate({ call, send, now, dupeMs } = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  const windowMs = dupeMs || DUPE_WINDOW_MS;
  const recent = new Map(); // dupe key -> when gated
  const s = { gated: 0, lastAt: 0, lastFrom: '', dropped: {} };
  const drop = (reason) => { s.dropped[reason] = (s.dropped[reason] || 0) + 1; return { ok: false, reason }; };
  return {
    offer(line) {
      const r = gateLine(line, call);
      if (!r.ok) return drop(r.reason);
      const t = clock();
      for (const [k, at] of recent) if (t - at >= windowMs) recent.delete(k);
      const key = dupeKey(r.out);
      if (recent.has(key)) return drop('duplicate');
      if (!send(r.out)) return drop('not-sent');
      recent.set(key, t);
      s.gated++;
      s.lastAt = t;
      s.lastFrom = r.from;
      return { ok: true, out: r.out };
    },
    stats() { return { gated: s.gated, lastAt: s.lastAt, lastFrom: s.lastFrom, dropped: Object.assign({}, s.dropped) }; },
  };
}

module.exports = {
  DIRECTION, Q_CONSTRUCT, DUPE_WINDOW_MS, IGATE_SSID,
  uplinkLogin, loginLine, logrespVerified, gateLine, dupeKey, createIgate, splitTnc2,
};
