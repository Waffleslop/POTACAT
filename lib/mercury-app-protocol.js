// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// Mercury app protocol — a tiny length-prefixed framing that POTACAT layers on
// top of Mercury's RAW ARQ data socket so a session can carry both interactive
// chat text and file transfers, and so the receiver can reassemble messages
// that TCP/ARQ split across arbitrary byte boundaries.
//
// This is POTACAT↔POTACAT for now (v1). Interop with VarAC/Pat, which use their
// own chat/file conventions on the data stream, is a later item.
//
// Frame: [type u8][length u32 BE][payload …length]
//   1 CHAT       payload = UTF-8 text
//   2 FILE_META  payload = UTF-8 JSON { name, size }
//   3 FILE_DATA  payload = raw file bytes (one chunk)
//   4 FILE_END   payload = empty

'use strict';

const TYPE = Object.freeze({ CHAT: 1, FILE_META: 2, FILE_DATA: 3, FILE_END: 4 });
const HEADER = 5;                       // type(1) + length(4)
const MAX_PAYLOAD = 16 * 1024 * 1024;   // 16 MiB desync guard

function encodeFrame(type, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload == null ? '' : payload), 'utf8');
  const out = Buffer.allocUnsafe(HEADER + body.length);
  out.writeUInt8(type, 0);
  out.writeUInt32BE(body.length, 1);
  body.copy(out, HEADER);
  return out;
}

const encodeChat = (text) => encodeFrame(TYPE.CHAT, Buffer.from(String(text == null ? '' : text), 'utf8'));
const encodeFileMeta = (meta) => encodeFrame(TYPE.FILE_META, Buffer.from(JSON.stringify(meta || {}), 'utf8'));
const encodeFileData = (buf) => encodeFrame(TYPE.FILE_DATA, Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []));
const encodeFileEnd = () => encodeFrame(TYPE.FILE_END, Buffer.alloc(0));

/** Interpret a decoded frame into a friendly object for the UI. */
function interpretFrame(frame) {
  switch (frame.type) {
    case TYPE.CHAT: return { kind: 'chat', text: frame.payload.toString('utf8') };
    case TYPE.FILE_META: {
      let meta = {};
      try { meta = JSON.parse(frame.payload.toString('utf8')); } catch { /* ignore */ }
      return { kind: 'file-meta', name: meta.name || 'file', size: meta.size || 0 };
    }
    case TYPE.FILE_DATA: return { kind: 'file-data', bytes: frame.payload };
    case TYPE.FILE_END: return { kind: 'file-end' };
    default: return { kind: 'unknown', type: frame.type, payload: frame.payload };
  }
}

/**
 * Stateful reassembler — feed it raw bytes as they arrive on the data socket;
 * it returns whatever complete frames are now available, buffering any partial
 * remainder for the next push.
 */
class FrameReassembler {
  constructor() { this._buf = Buffer.alloc(0); }

  push(chunk) {
    if (!chunk || !chunk.length) return [];
    this._buf = this._buf.length ? Buffer.concat([this._buf, Buffer.from(chunk)]) : Buffer.from(chunk);
    const frames = [];
    while (this._buf.length >= HEADER) {
      const type = this._buf.readUInt8(0);
      const len = this._buf.readUInt32BE(1);
      if (len > MAX_PAYLOAD) {
        // A bogus length means we lost frame sync — drop the buffer rather than
        // allocate wildly or block forever on a frame that will never complete.
        this._buf = Buffer.alloc(0);
        break;
      }
      if (this._buf.length < HEADER + len) break; // need more bytes
      frames.push({ type, payload: Buffer.from(this._buf.subarray(HEADER, HEADER + len)) });
      this._buf = Buffer.from(this._buf.subarray(HEADER + len));
    }
    return frames;
  }

  reset() { this._buf = Buffer.alloc(0); }
}

module.exports = {
  TYPE, HEADER, MAX_PAYLOAD,
  encodeFrame, encodeChat, encodeFileMeta, encodeFileData, encodeFileEnd,
  interpretFrame, FrameReassembler,
};
