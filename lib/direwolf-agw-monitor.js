// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Dire Wolf's AGW monitor — what the modem HEARD, frame by frame.
//
// POTACAT reads Dire Wolf's stdout for "audio level" lines, but on Windows
// those never arrived (N5XHI's 1.13.10/1.14.0 logs: Pat connected to the
// gateway, so frames were decoded, yet not one Dire Wolf receive line reached
// the log), so "decoded nothing" could not be told from "printed nothing".
// Its LOGDIR/LOGFILE is no help either: log_write runs only for APRS (UI,
// PID F0) frames, and a Winlink session is connected-mode SABM/UA/I/RR.
//
// The AGWPE port Pat already talks to (server.c) accepts up to three
// clients, and a client that sends the one-letter 'm' command is sent every
// received frame as a monitor record: datakind 'I' (I frames), 'S' (every
// supervisory and unnumbered frame: RR, UA, SABM, DISC...), 'U' (UI), and
// 'T' for Dire Wolf's OWN UI transmissions (own I/S frames are not sent).
// The payload is Dire Wolf's monitor text — " 1:Fm W5AUY-10 To N5XHI <UA
// pid=F0 Len=0 F=1 >[18:07:23]\r" followed by the information bytes and
// "\r", then a NUL. 'm' is a TOGGLE, sent once per connection.
//
// Pure apart from createAgwMonitor's socket. The 36-byte header:
//   0 port, 4 datakind, 6 pid, 8 call_from[10], 18 call_to[10],
//   28 data_len (u32 LITTLE endian), 32 user. See direwolf server.c.

'use strict';

const AGW_HEADER_LEN = 36;
const MONITOR_KINDS = new Set(['I', 'S', 'U', 'T']);

/** One AGW frame as bytes (header + data). */
function encodeAgwFrame({ port = 0, datakind, pid = 0, callFrom = '', callTo = '', data } = {}) {
  const kind = String(datakind || '');
  if (kind.length !== 1) throw new Error('AGW datakind is one character');
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data == null ? '' : String(data), 'latin1');
  const h = Buffer.alloc(AGW_HEADER_LEN);
  h[0] = port & 0xff;
  h[4] = kind.charCodeAt(0);
  h[6] = pid & 0xff;
  h.write(String(callFrom).slice(0, 9), 8, 'latin1');
  h.write(String(callTo).slice(0, 9), 18, 'latin1');
  h.writeUInt32LE(body.length, 28);
  return Buffer.concat([h, body]);
}

function _cstr(buf, off, len) {
  const s = buf.subarray(off, off + len);
  const nul = s.indexOf(0);
  return s.subarray(0, nul === -1 ? len : nul).toString('latin1');
}

/** Chunk-safe AGW frame splitter: push bytes, get whole frames. */
class AgwFrameParser {
  constructor({ maxDataLen = 1 << 20 } = {}) {
    this._buf = Buffer.alloc(0);
    this._max = maxDataLen;
  }

  /** @returns {Array<{port:number, datakind:string, pid:number, callFrom:string, callTo:string, data:Buffer}>} */
  push(chunk) {
    const out = [];
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : Buffer.from(chunk);
    for (;;) {
      if (this._buf.length < AGW_HEADER_LEN) break;
      const len = this._buf.readUInt32LE(28);
      if (len > this._max) { this._buf = Buffer.alloc(0); break; } // not AGW: resync by dropping everything
      if (this._buf.length < AGW_HEADER_LEN + len) break;
      const h = this._buf;
      out.push({
        port: h[0],
        datakind: String.fromCharCode(h[4]),
        pid: h[6],
        callFrom: _cstr(h, 8, 10),
        callTo: _cstr(h, 18, 10),
        data: Buffer.from(h.subarray(AGW_HEADER_LEN, AGW_HEADER_LEN + len)),
      });
      this._buf = this._buf.subarray(AGW_HEADER_LEN + len);
    }
    if (!this._buf.length) this._buf = Buffer.alloc(0);
    return out;
  }
}

function _printable(s) {
  return /^[\x20-\x7e]*$/.test(s);
}

/**
 * One log line for a monitor frame, or null for anything else (replies to
 * 'R'/'G', data frames of a connection, ...). The header text Dire Wolf wrote
 * is kept as is; the information field follows quoted when it is printable,
 * else as a byte count.
 */
function describeMonitorFrame(frame, { infoMax = 60 } = {}) {
  if (!frame || !MONITOR_KINDS.has(frame.datakind)) return null;
  let text = frame.data.toString('latin1');
  if (text.endsWith('\0')) text = text.slice(0, -1);
  const cr = text.indexOf('\r');
  const head = (cr === -1 ? text : text.slice(0, cr)).trim();
  let info = cr === -1 ? '' : text.slice(cr + 1);
  if (info.endsWith('\r')) info = info.slice(0, -1);
  const dir = frame.datakind === 'T' ? 'tx' : 'rx';
  let tail = '';
  if (info.length) {
    tail = _printable(info) ? ` "${info.length > infoMax ? info.slice(0, infoMax) + '…' : info}"` : ` [${info.length} bytes]`;
  }
  return `${dir} ${head}${tail}`;
}

/** Is this frame one the radio received (not Dire Wolf's own transmission)? */
function isReceivedFrame(frame) {
  return !!frame && (frame.datakind === 'I' || frame.datakind === 'S' || frame.datakind === 'U');
}

/**
 * Connect to Dire Wolf's AGW port and turn monitoring on. `onFrame(frame,
 * text)` for every monitor frame; `onLog` for the connection's own events;
 * `onClose(code)` once, when the socket is gone (the caller decides whether
 * to try again). Never throws.
 */
function createAgwMonitor({ host = '127.0.0.1', port, net = require('net'), onFrame, onLog, onClose } = {}) {
  const parser = new AgwFrameParser();
  const log = typeof onLog === 'function' ? onLog : () => {};
  let closed = false;
  let sock = null;
  let connected = false;
  const finish = (code) => {
    if (closed) return;
    closed = true;
    try { if (sock) sock.destroy(); } catch {}
    if (typeof onClose === 'function') onClose(code || 'closed');
  };
  try {
    sock = net.connect({ host, port });
  } catch (e) {
    finish((e && e.code) || 'ERROR');
    return { close: () => {}, get connected() { return false; } };
  }
  sock.once('connect', () => {
    connected = true;
    try { sock.write(encodeAgwFrame({ datakind: 'm' })); } catch {}
    log(`direwolf monitor: listening to what Dire Wolf hears on 127.0.0.1:${port}`);
  });
  sock.on('data', (chunk) => {
    let frames;
    try { frames = parser.push(chunk); } catch { return; }
    for (const f of frames) {
      const text = describeMonitorFrame(f);
      if (text && typeof onFrame === 'function') onFrame(f, text);
    }
  });
  sock.on('error', (e) => { finish((e && e.code) || 'ERROR'); });
  sock.on('close', () => finish('closed'));
  return {
    close() { finish('stopped'); },
    get connected() { return connected && !closed; },
  };
}

/**
 * What the monitor says about a packet link, for the session summary line
 * (#300): how many frames were heard, of which kinds, whether the gateway
 * ever acknowledged a data frame of ours, and whether it ended the link.
 * Fed the monitor text of each frame
 * ("rx 1:Fm KJ4AJP-10 To NA4DQ <RR R0 P=1 >[16:17:00]").
 * Dire Wolf's monitor does not report its own I and S frames, so what THIS
 * station sent is not counted here.
 * The gateway's N(R) is the count of our data frames it has taken: a link
 * that connects and then sits at R0 while the gateway polls is a gateway
 * that decodes our short frames and none of our long ones.
 * But only once WE have sent data: in Winlink the gateway speaks first (its
 * greeting, as I frames), and Pat answers only after it has decoded that.
 * A link that connected (UA) and then brought no I frame here never sent a
 * data frame of ours, and R0 says nothing about our transmit (#455): the
 * greeting is what went missing, on the receive side or the path. (Unless
 * the gateway's count rose above R0: then it took our data, and Pat heard a
 * greeting the monitor missed.)
 * snapshot() has the shape of WinlinkDiag.ArdopLinkStory's.
 */
class PacketLinkStory {
  constructor() { this.heard = 0; this.kinds = {}; this.maxNr = -1; this.polls = 0; this.last = ''; this.end = null; this.connected = false; this.dataAfterConnect = 0; }

  noteFrame(text) {
    const m = /^rx\b.*?<\s*([A-Za-z]+)([^>]*)>/.exec(String(text || ''));
    if (!m) return;
    const kind = m[1].toUpperCase();
    const rest = m[2] || '';
    this.heard++;
    this.kinds[kind] = (this.kinds[kind] || 0) + 1;
    this.last = `${kind}${rest.replace(/\s+/g, ' ').trimEnd()}`.slice(0, 40);
    const nr = /\bR(\d)\b/.exec(rest);
    if (nr && (kind === 'I' || kind === 'RR' || kind === 'RNR' || kind === 'REJ' || kind === 'SREJ')) this.maxNr = Math.max(this.maxNr, Number(nr[1]));
    if (kind === 'RR' && /\bP=1\b/.test(rest)) this.polls++;
    if (kind === 'I' && this.connected) this.dataAfterConnect++;
    if (kind === 'UA' && !this.connected) { this.connected = true; this.end = null; return; }
    if (kind === 'DM' || kind === 'DISC') this.end = { by: 'gateway', text: `it sent ${kind}`, state: '' };
    else if (this.end) this.end = null; // the link went on after it
  }

  stateText() {
    if (!this.heard) return 'Dire Wolf heard no frame from the gateway';
    const kinds = Object.keys(this.kinds).sort().map((k) => `${this.kinds[k]} ${k}`).join(', ');
    // A count above R0 means the gateway took data of ours, so Pat did hear a greeting.
    const acked = this.connected && !this.dataAfterConnect && this.maxNr <= 0
      ? "the gateway's greeting never decoded here (heard only short frames), so no data frame of ours was sent: look at the receive level and the path"
      : this.maxNr < 0 ? 'no frame carried an acknowledgement count'
      : this.maxNr === 0 ? 'the gateway acknowledged none of our data frames (its count stayed at R0)'
      : `the gateway's acknowledgement count reached R${this.maxNr}`;
    return `heard ${this.heard} frame${this.heard === 1 ? '' : 's'} (${kinds}); ${acked}${this.polls ? `; it polled ${this.polls} time${this.polls === 1 ? '' : 's'}` : ''}; last heard ${this.last}`;
  }

  snapshot() { return { state: '', stateText: this.stateText(), end: this.end ? { ...this.end } : null, connected: this.connected, fault: '' }; }
}

module.exports = { PacketLinkStory, AGW_HEADER_LEN, encodeAgwFrame, AgwFrameParser, describeMonitorFrame, isReceivedFrame, createAgwMonitor };
