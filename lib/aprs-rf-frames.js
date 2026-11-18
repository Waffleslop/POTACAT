// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// What Dire Wolf heard on the radio, as an APRS packet (phase 2).
//
// Dire Wolf's AGW monitor (lib/direwolf-agw-monitor.js) sends each received
// UI frame as datakind 'U' with its own text:
//   " 1:Fm K3SBP-7 To APDR16 Via KB1XYZ-1*,WIDE2-1 <UI pid=F0 Len=42 PF=0 >[00:03:30]\r<info>\r\0"
// (recorded from Dire Wolf 1.8.1: test/fixtures/aprs/direwolf-agw-monitor-frames.json).
// That becomes the TNC2 line the phase 1 parser reads,
//   "K3SBP-7>APDR16,KB1XYZ-1*,WIDE2-1:<info>",
// and how the packet reached this radio:
//   direct  no digipeater repeated it (no '*' in the path),
//   digi    a digipeater did: Dire Wolf marks the LAST one that repeated it
//           with '*'. A named call before the '*' (or carrying it) is that
//           digipeater; an alias alone (WIDE1*, WIDE2*) names none.
// Only APRS: UI frames with PID F0. Dire Wolf's own transmissions ('T'),
// connected-mode frames and other PIDs are not packets here.

'use strict';

// Path aliases, not stations.
const IS_ALIAS = (c) => /^(WIDE|TRACE|RELAY|ECHO|GATE|TEMP)\d*(-\d+)?$/i.test(c);

/** How a packet with this TNC2 path reached the radio. */
function viaOf(path) {
  const p = Array.isArray(path) ? path : [];
  let last = -1;
  for (let i = 0; i < p.length; i++) if (String(p[i]).endsWith('*')) last = i;
  if (last < 0) return { kind: 'direct', digi: '' };
  // The starred hop, or the nearest named call before it (a digipeater that
  // inserted its call ahead of the alias it used: "W3XYZ-1,WIDE2*").
  for (let i = last; i >= 0; i--) {
    const c = String(p[i]).replace(/\*$/, '');
    if (!IS_ALIAS(c)) return { kind: 'digi', digi: c.toUpperCase() };
  }
  return { kind: 'digi', digi: '' };
}

/** The info field without its trailing CR, LF and NUL characters (only those, only at the end). */
const trimFrameEnd = (s) => String(s).replace(/[\r\n\0]+$/, '');

const HEAD = /^\s*\d+:Fm (\S+) To (\S+)(?: Via (\S+))? <UI\b[^>]*\bpid=([0-9A-Fa-f]{2})\b[^>]*>/;

/**
 * One AGW monitor frame → {line, via} or null. Never throws.
 * @param {{datakind:string, data:Buffer}} frame
 */
function fromMonitorFrame(frame) {
  try {
    if (!frame || frame.datakind !== 'U' || !frame.data) return null;
    const text = Buffer.isBuffer(frame.data) ? frame.data.toString('latin1') : String(frame.data);
    const cr = text.indexOf('\r');
    if (cr < 0) return null;
    const m = HEAD.exec(text.slice(0, cr));
    if (!m || m[4].toUpperCase() !== 'F0') return null;
    // The frame ends in any run of CR, LF and NUL: Dire Wolf's own "\r\0",
    // after the packet's own trailing CR when it sent one ("\r\r\0", seen on
    // air 2026-11-18). All of it goes, nothing before it, so the parser, the
    // station list and the iGate read the same line.
    const info = trimFrameEnd(text.slice(cr + 1));
    if (!info) return null;
    const path = m[3] ? m[3].split(',').filter(Boolean) : [];
    const line = m[1] + '>' + m[2] + (path.length ? ',' + path.join(',') : '') + ':' + info;
    return { line, via: viaOf(path) };
  } catch {
    return null;
  }
}

/** The parser's packet for a monitor frame, marked `rf: {kind, digi}`, or null. */
function packet(frame, parse) {
  const h = fromMonitorFrame(frame);
  if (!h) return null;
  let p = null;
  try { p = parse(h.line); } catch { p = null; }
  if (!p) return null;
  p.rf = h.via;
  return p;
}

module.exports = { fromMonitorFrame, packet, viaOf, trimFrameEnd, IS_ALIAS };
