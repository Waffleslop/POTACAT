// WSJT-X UDP protocol client
// Implements the QDataStream-based binary protocol from NetworkMessage.hpp
// Reference: https://sourceforge.net/p/wsjt/wsjtx/ci/master/tree/Network/NetworkMessage.hpp

const dgram = require('dgram');
const { EventEmitter } = require('events');

const MAGIC = 0xADBCCBDA;
const SCHEMA = 3;

// Message types
const MSG = {
  HEARTBEAT: 0,
  STATUS: 1,
  DECODE: 2,
  CLEAR: 3,
  REPLY: 4,
  QSO_LOGGED: 5,
  CLOSE: 6,
  REPLAY: 7,
  HALT_TX: 8,
  FREE_TEXT: 9,
  WSPR_DECODE: 10,
  LOCATION: 11,
  LOGGED_ADIF: 12,
  HIGHLIGHT_CALLSIGN: 13,
  SWITCH_CONFIGURATION: 14,
  CONFIGURE: 15,
};

// --- Binary reader (big-endian QDataStream) ---

class BinaryReader {
  constructor(buf) {
    this.buf = buf;
    this.offset = 0;
  }

  remaining() { return this.buf.length - this.offset; }

  readUInt8() {
    const v = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readInt8() {
    const v = this.buf.readInt8(this.offset);
    this.offset += 1;
    return v;
  }

  readUInt16BE() {
    const v = this.buf.readUInt16BE(this.offset);
    this.offset += 2;
    return v;
  }

  readInt32BE() {
    const v = this.buf.readInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  readUInt32BE() {
    const v = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  readUInt64BE() {
    // Read as two 32-bit halves (no BigInt needed for frequencies < 2^53)
    const hi = this.buf.readUInt32BE(this.offset);
    const lo = this.buf.readUInt32BE(this.offset + 4);
    this.offset += 8;
    return hi * 0x100000000 + lo;
  }

  readInt64BE() {
    const hi = this.buf.readInt32BE(this.offset);
    const lo = this.buf.readUInt32BE(this.offset + 4);
    this.offset += 8;
    return hi * 0x100000000 + lo;
  }

  readDoubleBE() {
    const v = this.buf.readDoubleBE(this.offset);
    this.offset += 8;
    return v;
  }

  readBool() {
    return this.readUInt8() !== 0;
  }

  readUtf8() {
    const len = this.readUInt32BE();
    if (len === 0xFFFFFFFF) return ''; // null string
    if (len === 0) return '';
    const s = this.buf.toString('utf-8', this.offset, this.offset + len);
    this.offset += len;
    return s;
  }

  readQTime() {
    // QTime: quint32 milliseconds since midnight
    const ms = this.readUInt32BE();
    return ms;
  }

  readQDateTime() {
    // QDate: qint64 Julian day number
    const julianDay = this.readInt64BE();
    // QTime: quint32 ms since midnight
    const msOfDay = this.readUInt32BE();
    // Timespec: quint8 (0=local, 1=UTC, 2=offset, 3=timezone)
    const timespec = this.readUInt8();

    // Convert Julian day to JS Date
    // Julian day 2440588 = Jan 1 1970
    const unixDays = julianDay - 2440588;
    const ms = unixDays * 86400000 + msOfDay;
    return new Date(ms);
  }
}

// --- Binary writer (big-endian QDataStream) ---

class BinaryWriter {
  constructor() {
    this.parts = [];
  }

  writeUInt8(v) {
    const b = Buffer.alloc(1);
    b.writeUInt8(v, 0);
    this.parts.push(b);
  }

  writeInt8(v) {
    const b = Buffer.alloc(1);
    b.writeInt8(v, 0);
    this.parts.push(b);
  }

  writeUInt16BE(v) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(v, 0);
    this.parts.push(b);
  }

  writeInt32BE(v) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v, 0);
    this.parts.push(b);
  }

  writeUInt32BE(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v, 0);
    this.parts.push(b);
  }

  writeBool(v) {
    this.writeUInt8(v ? 1 : 0);
  }

  writeUtf8(s) {
    if (s == null) {
      this.writeUInt32BE(0xFFFFFFFF); // null string
      return;
    }
    const strBuf = Buffer.from(s, 'utf-8');
    this.writeUInt32BE(strBuf.length);
    this.parts.push(strBuf);
  }

  writeQTime(ms) {
    this.writeUInt32BE(ms);
  }

  writeUInt64BE(v) {
    const b = Buffer.alloc(8);
    const hi = Math.floor(v / 0x100000000);
    const lo = v >>> 0;
    b.writeUInt32BE(hi, 0);
    b.writeUInt32BE(lo, 4);
    this.parts.push(b);
  }

  writeInt64BE(v) {
    const b = Buffer.alloc(8);
    const hi = Math.floor(v / 0x100000000);
    const lo = v >>> 0;
    b.writeInt32BE(hi, 0);
    b.writeUInt32BE(lo, 4);
    this.parts.push(b);
  }

  writeDoubleBE(v) {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(v, 0);
    this.parts.push(b);
  }

  writeQDateTime(date) {
    // QDate: int64 Julian day number (Julian day 2440588 = Jan 1 1970)
    const unixMs = date.getTime();
    const unixDays = Math.floor(unixMs / 86400000);
    const julianDay = unixDays + 2440588;
    this.writeInt64BE(julianDay);
    // QTime: uint32 milliseconds since midnight UTC
    const msOfDay = unixMs - unixDays * 86400000;
    this.writeUInt32BE(msOfDay);
    // Timespec: 1 = UTC
    this.writeUInt8(1);
  }

  // QColor: colorSpec(int8) + alpha(uint16) + red(uint16) + green(uint16) + blue(uint16) + pad(uint16)
  writeQColor(color) {
    if (!color) {
      // Invalid/null color — colorSpec = -1
      this.writeInt8(-1);
      // Still need the 5 uint16 fields
      this.writeUInt16BE(0);
      this.writeUInt16BE(0);
      this.writeUInt16BE(0);
      this.writeUInt16BE(0);
      this.writeUInt16BE(0);
      return;
    }
    this.writeInt8(1); // colorSpec = 1 (RGB)
    this.writeUInt16BE(color.a != null ? color.a : 0xFFFF); // alpha
    this.writeUInt16BE(color.r != null ? color.r * 257 : 0); // red (0-255 → 0-65535)
    this.writeUInt16BE(color.g != null ? color.g * 257 : 0); // green
    this.writeUInt16BE(color.b != null ? color.b * 257 : 0); // blue
    this.writeUInt16BE(0); // pad
  }

  toBuffer() {
    return Buffer.concat(this.parts);
  }
}

// --- Message builders ---

function buildHeader(writer, msgType, id) {
  writer.writeUInt32BE(MAGIC);
  writer.writeUInt32BE(SCHEMA);
  writer.writeUInt32BE(msgType);
  writer.writeUtf8(id);
}

function encodeReply(id, decode, modifiers) {
  const w = new BinaryWriter();
  buildHeader(w, MSG.REPLY, id);
  w.writeQTime(decode.time);
  w.writeInt32BE(decode.snr);
  w.writeDoubleBE(decode.deltaTime);
  w.writeUInt32BE(decode.deltaFrequency);
  w.writeUtf8(decode.mode);
  w.writeUtf8(decode.message);
  w.writeBool(decode.lowConfidence || false);
  w.writeUInt8(modifiers || 0);
  return w.toBuffer();
}

function encodeHaltTx(id, autoTxOnly) {
  const w = new BinaryWriter();
  buildHeader(w, MSG.HALT_TX, id);
  w.writeBool(autoTxOnly !== false); // default true
  return w.toBuffer();
}

function encodeHighlightCallsign(id, callsign, bgColor, fgColor, highlightLast) {
  const w = new BinaryWriter();
  buildHeader(w, MSG.HIGHLIGHT_CALLSIGN, id);
  w.writeUtf8(callsign);
  w.writeQColor(bgColor);
  w.writeQColor(fgColor);
  w.writeBool(highlightLast || false);
  return w.toBuffer();
}

function encodeHeartbeat(id, maxSchema) {
  const w = new BinaryWriter();
  buildHeader(w, MSG.HEARTBEAT, id);
  w.writeUInt32BE(maxSchema || SCHEMA);
  w.writeUtf8('POTACAT');
  w.writeUtf8('');
  return w.toBuffer();
}

// --- Message parsers ---

function parseHeartbeat(r) {
  return {
    maxSchema: r.readUInt32BE(),
    version: r.readUtf8(),
    revision: r.remaining() >= 4 ? r.readUtf8() : '',
  };
}

function parseStatus(r) {
  const status = {
    dialFrequency: r.readUInt64BE(),
    mode: r.readUtf8(),
    dxCall: r.readUtf8(),
    report: r.readUtf8(),
    txMode: r.readUtf8(),
    txEnabled: r.readBool(),
    transmitting: r.readBool(),
    decoding: r.readBool(),
    rxDF: r.readInt32BE(),
    txDF: r.readInt32BE(),
    deCall: r.readUtf8(),
    deGrid: r.readUtf8(),
    dxGrid: r.readUtf8(),
    txWatchdog: r.readBool(),
    subMode: r.readUtf8(),
    fastMode: r.readBool(),
  };
  if (r.remaining() >= 1) status.specialOpMode = r.readUInt8();
  if (r.remaining() >= 4) status.frequencyTolerance = r.readUInt32BE();
  if (r.remaining() >= 4) status.trPeriod = r.readUInt32BE();
  if (r.remaining() >= 4) status.configName = r.readUtf8();
  return status;
}

function parseDecode(r) {
  return {
    isNew: r.readBool(),
    time: r.readQTime(),
    snr: r.readInt32BE(),
    deltaTime: r.readDoubleBE(),
    deltaFrequency: r.readUInt32BE(),
    mode: r.readUtf8(),
    message: r.readUtf8(),
    lowConfidence: r.readBool(),
    offAir: r.remaining() >= 1 ? r.readBool() : false,
  };
}

function parseClear(r) {
  return {
    window: r.remaining() >= 1 ? r.readUInt8() : 2,
  };
}

function parseQsoLogged(r) {
  return {
    dateTimeOff: r.readQDateTime(),
    dxCall: r.readUtf8(),
    dxGrid: r.readUtf8(),
    txFrequency: r.readUInt64BE(),
    mode: r.readUtf8(),
    reportSent: r.readUtf8(),
    reportReceived: r.readUtf8(),
    txPower: r.readUtf8(),
    comments: r.readUtf8(),
    name: r.readUtf8(),
    dateTimeOn: r.readQDateTime(),
    operatorCall: r.readUtf8(),
    myCall: r.readUtf8(),
    myGrid: r.readUtf8(),
    exchangeSent: r.remaining() >= 4 ? r.readUtf8() : '',
    exchangeReceived: r.remaining() >= 4 ? r.readUtf8() : '',
  };
}

function parseLoggedAdif(r) {
  return {
    adif: r.readUtf8(),
  };
}

// --- Extract callsign from FT8/FT4 decode message ---
// Messages look like:  "CQ K1ABC FN42"  or  "W2XYZ K1ABC -05"  or  "K1ABC W2XYZ R-12"
function extractCallsigns(message) {
  if (!message) return { dxCall: '', deCall: '' };
  const parts = message.trim().split(/\s+/);

  if (parts[0] === 'CQ') {
    // "CQ K1ABC FN42" or "CQ DX K1ABC FN42" or "CQ NA K1ABC FN42"
    // CQ modifiers are all-alpha, 2-4 chars, no digits (DX, NA, EU, POTA, etc.)
    const isCqModifier = parts[1] && /^[A-Z]{2,4}$/.test(parts[1]) && !/\d/.test(parts[1]);
    const callIdx = isCqModifier ? 2 : 1;
    return { dxCall: parts[callIdx] || '', deCall: '' };
  }

  // "W2XYZ K1ABC ..." — first is caller, second is being called
  return { deCall: parts[0] || '', dxCall: parts[1] || '' };
}

// --- WsjtxClient class ---

class WsjtxClient extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.connected = false;
    this.wsjtxId = null;        // WSJT-X instance ID (learned from heartbeat)
    this.wsjtxAddr = null;      // Remote address (IP)
    this.wsjtxPort = null;      // Remote port
    this.listenPort = 2237;
    this.heartbeatTimer = null;
    this.heartbeatTimeout = null;
    this._highlightedCalls = new Set(); // track what we've highlighted
  }

  connect(port) {
    this.listenPort = port || 2237;
    this.disconnect();

    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.socket.on('message', (msg, rinfo) => {
      try {
        this._handleMessage(msg, rinfo);
      } catch (err) {
        this.emit('error', err);
      }
    });

    this.socket.on('error', (err) => {
      this.emit('error', err);
    });

    this.socket.bind(this.listenPort, () => {
      this.emit('status', { connected: false, listening: true, port: this.listenPort });
    });
  }

  disconnect() {
    this.connected = false;
    this.wsjtxId = null;
    this.wsjtxAddr = null;
    this.wsjtxPort = null;
    this._highlightedCalls.clear();

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
    if (this.socket) {
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
    }
  }

  _send(buf) {
    if (!this.socket || !this.wsjtxAddr || !this.wsjtxPort) return;
    this.socket.send(buf, 0, buf.length, this.wsjtxPort, this.wsjtxAddr);
  }

  _resetHeartbeatTimeout() {
    if (this.heartbeatTimeout) clearTimeout(this.heartbeatTimeout);
    // If no heartbeat in 30s, consider WSJT-X disconnected
    this.heartbeatTimeout = setTimeout(() => {
      if (this.connected) {
        this.connected = false;
        this.wsjtxId = null;
        this._highlightedCalls.clear();
        this.emit('status', { connected: false, listening: true, port: this.listenPort });
      }
    }, 30000);
  }

  _handleMessage(buf, rinfo) {
    if (buf.length < 12) return;

    const r = new BinaryReader(buf);
    const magic = r.readUInt32BE();
    if (magic !== MAGIC) return;

    const schema = r.readUInt32BE();
    const msgType = r.readUInt32BE();
    const id = r.readUtf8();

    // Remember WSJT-X's address so we can send back to it
    if (!this.wsjtxAddr || this.wsjtxAddr !== rinfo.address || this.wsjtxPort !== rinfo.port) {
      this.wsjtxAddr = rinfo.address;
      this.wsjtxPort = rinfo.port;
    }

    try {
      switch (msgType) {
        case MSG.HEARTBEAT: {
          const hb = parseHeartbeat(r);
          this.wsjtxId = id;
          if (!this.connected) {
            this.connected = true;
            this.emit('status', { connected: true, version: hb.version, id });
          }
          this._resetHeartbeatTimeout();
          // Reply with our own heartbeat
          this._send(encodeHeartbeat(id, SCHEMA));
          break;
        }
        case MSG.STATUS: {
          const status = parseStatus(r);
          this.wsjtxId = id;
          this._resetHeartbeatTimeout();
          if (!this.connected) {
            this.connected = true;
            this.emit('status', { connected: true, id });
          }
          this.emit('wsjtx-status', status);
          break;
        }
        case MSG.DECODE: {
          const decode = parseDecode(r);
          decode.id = id;
          const calls = extractCallsigns(decode.message);
          decode.dxCall = calls.dxCall;
          decode.deCall = calls.deCall;
          this.emit('decode', decode);
          break;
        }
        case MSG.CLEAR: {
          const clear = parseClear(r);
          this.emit('clear', clear);
          break;
        }
        case MSG.QSO_LOGGED: {
          const qso = parseQsoLogged(r);
          this.emit('qso-logged', qso);
          break;
        }
        case MSG.CLOSE: {
          this.connected = false;
          this.wsjtxId = null;
          this._highlightedCalls.clear();
          this.emit('status', { connected: false, listening: true, port: this.listenPort });
          break;
        }
        case MSG.LOGGED_ADIF: {
          const adif = parseLoggedAdif(r);
          this.emit('logged-adif', adif);
          break;
        }
        default:
          // Ignore unknown message types
          break;
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  // --- Outbound commands ---

  /**
   * Reply to a decode — equivalent to double-clicking it in WSJT-X.
   * @param {object} decode - The decode object (from 'decode' event)
   * @param {number} [modifiers=0] - 0=none, 2=Shift, 4=Ctrl, 8=Alt
   */
  reply(decode, modifiers) {
    if (!this.wsjtxId) return;
    this._send(encodeReply(this.wsjtxId, decode, modifiers || 0));
  }

  /**
   * Halt transmission.
   * @param {boolean} [autoTxOnly=true] - If true, only disables auto-Tx
   */
  haltTx(autoTxOnly) {
    if (!this.wsjtxId) return;
    this._send(encodeHaltTx(this.wsjtxId, autoTxOnly));
  }

  /**
   * Highlight a callsign in WSJT-X's Band Activity window.
   * @param {string} callsign
   * @param {object|null} bgColor - {r, g, b} (0-255) or null to clear
   * @param {object|null} fgColor - {r, g, b} (0-255) or null to clear
   */
  highlightCallsign(callsign, bgColor, fgColor) {
    if (!this.wsjtxId) return;
    this._send(encodeHighlightCallsign(this.wsjtxId, callsign, bgColor, fgColor, false));
    if (bgColor || fgColor) {
      this._highlightedCalls.add(callsign);
    } else {
      this._highlightedCalls.delete(callsign);
    }
  }

  /**
   * Clear all highlights we've set.
   */
  clearHighlights() {
    if (!this.wsjtxId) return;
    for (const call of this._highlightedCalls) {
      this._send(encodeHighlightCallsign(this.wsjtxId, call, null, null, false));
    }
    this._highlightedCalls.clear();
  }
}

module.exports = { WsjtxClient, extractCallsigns, MSG, BinaryWriter, buildHeader, encodeHeartbeat, encodeLoggedAdif, encodeQsoLogged };

/**
 * Encode a LOGGED_ADIF message (type 12) — sends an ADIF record to listeners like HamRS.
 * @param {string} id - Application ID (e.g. 'POTACAT')
 * @param {string} adifText - Full ADIF text (header + record)
 * @returns {Buffer}
 */
function encodeLoggedAdif(id, adifText) {
  const w = new BinaryWriter();
  buildHeader(w, MSG.LOGGED_ADIF, id);
  w.writeUtf8(adifText);
  return w.toBuffer();
}

/**
 * Encode a QSO_LOGGED message (type 5) — structured QSO data for WSJT-X companion apps.
 * This is the primary message most apps (HamRS, JTAlert, GridTracker) listen for.
 * @param {string} id - Application ID
 * @param {object} qso - QSO fields
 * @returns {Buffer}
 */
function encodeQsoLogged(id, qso) {
  const w = new BinaryWriter();
  buildHeader(w, MSG.QSO_LOGGED, id);
  const now = qso.dateTimeOff || new Date();
  const dateOn = qso.dateTimeOn || now;
  w.writeQDateTime(now);                          // dateTimeOff
  w.writeUtf8(qso.dxCall || '');                   // dxCall
  w.writeUtf8(qso.dxGrid || '');                   // dxGrid
  w.writeUInt64BE(qso.txFrequency || 0);           // txFrequency (Hz)
  w.writeUtf8(qso.mode || '');                     // mode
  w.writeUtf8(qso.reportSent || '');               // reportSent
  w.writeUtf8(qso.reportReceived || '');           // reportReceived
  w.writeUtf8(qso.txPower || '');                  // txPower
  w.writeUtf8(qso.comments || '');                 // comments
  w.writeUtf8(qso.name || '');                     // name
  w.writeQDateTime(dateOn);                        // dateTimeOn
  w.writeUtf8(qso.operatorCall || '');             // operatorCall
  w.writeUtf8(qso.myCall || '');                   // myCall
  w.writeUtf8(qso.myGrid || '');                   // myGrid
  w.writeUtf8(qso.exchangeSent || '');             // exchangeSent
  w.writeUtf8(qso.exchangeReceived || '');         // exchangeReceived
  w.writeUtf8(qso.propMode || '');                 // ADIF propagation mode (schema >= 2)
  return w.toBuffer();
}
