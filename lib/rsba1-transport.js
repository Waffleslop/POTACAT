'use strict';

// ===========================================================================
// RsBa1Transport — RS-BA1-style UDP transport for IP-native Icom radios
// (and wfserver, the GPLv3 headless wfview server which speaks the same
// protocol against USB-attached radios). Same external interface as
// SerialTransport / TcpTransport so RigController + CivCodec attach
// unchanged.
//
// Protocol facts in this file are clean-room re-implemented from public
// sources (wfview's GPLv3 source acts as a protocol-spec reference; we
// describe and re-implement the wire format, no GPL code is copied).
// POTACAT remains MIT-licensed.
//
// Protocol summary
// ---------------------------------------------------------------------------
// Icom's network protocol uses two parallel UDP socket pairs between
// client and radio (or wfserver):
//
//   * control stream — port 50001 by default. Carries handshake, login,
//     token renewal, periodic ping + idle, and a final ConnInfo / Status
//     exchange that opens the data streams.
//
//   * civ stream — port 50002 by default. Same handshake pattern, then
//     carries CI-V bytes wrapped in a 21-byte data-packet header
//     (datalen + sendseq fields). The bytes after the header are the
//     same CI-V frames POTACAT's CivCodec already produces and parses.
//
// (Audio runs on a third socket pair, port 50003 by default; not in
// this transport — Phase 2.)
//
// Per-stream handshake
//   1. Client → AreYouThere (control packet, type 0x03), retried every
//      AYT_PERIOD until reply.
//   2. Radio → IAmHere (type 0x04). The radio's `sentid` is now our
//      `remoteId` for this stream. Stop AYT timer.
//   3. Client begins ping (type 0x07) every PING_PERIOD and idle
//      (type 0x00) every IDLE_PERIOD as keep-alives.
//   4. (control only) Radio → IAmReady (type 0x06) → Client → Login
//      (128-byte packet with passcode-obfuscated username + password).
//   5. (control only) Radio → LoginResponse (96 bytes) → Client →
//      Token request (64 bytes, magic 0x02). Status (80 bytes) reply
//      contains civPort + audioPort to use for the data streams.
//   6. (civ only) Radio → IAmReady → Client → OpenClose request →
//      Radio starts streaming CI-V data packets.
//
// passcode() obfuscation
//   The login packet's username/password fields go through a 256-byte
//   lookup table. For each input byte at index i:
//     p = byte + i; if p > 126: p = 32 + p % 127;
//     out[i] = TABLE[p];
//   The table is constant; it's a fact about the protocol, not code.
//
// Byte order
//   Most fields are little-endian (length, type, seq, sentid, rcvdid).
//   Big-endian (network byte order) is used for: payloadsize, innerseq,
//   civport, audioport, sample rates, the civ data-packet sendseq, and
//   the conninfo guid/macaddress. Annotated below.
// ===========================================================================

const dgram = require('dgram');
const { EventEmitter } = require('events');

// --- Packet sizes (from wfview's packettypes.h) ---
const CONTROL_SIZE = 0x10;
const PING_SIZE    = 0x15;
const OPENCLOSE_SIZE = 0x16;
const TOKEN_SIZE   = 0x40;
const STATUS_SIZE  = 0x50;
const LOGIN_RESPONSE_SIZE = 0x60;
const LOGIN_SIZE   = 0x80;
const CONNINFO_SIZE = 0x90;
const CIV_HEADER_SIZE = 0x15;

// --- Type codes (control packet `type` field at offset 0x04) ---
const TYPE_RETRANSMIT = 0x00;
const TYPE_AYT        = 0x03;
const TYPE_IAMHERE    = 0x04;
const TYPE_DISCONNECT = 0x05;
const TYPE_AYR_IAR    = 0x06;
const TYPE_PING       = 0x07;

// --- Periods (ms) ---
const AYT_PERIOD     = 500;
const PING_PERIOD    = 500;
const IDLE_PERIOD    = 100;
const TOKEN_RENEWAL  = 60000;
const HANDSHAKE_TIMEOUT = 10000; // give up if not authenticated after 10s

// --- passcode lookup table (256 bytes, indices 0-255) ---
// Indices 0-31 and 127-255 are zero (unused). Indices 32-126 are the
// scrambled mapping. Values pulled directly from the protocol specification.
const PASSCODE_TABLE = (() => {
  const t = new Uint8Array(256);
  const seq = [
    0x47, 0x5d, 0x4c, 0x42, 0x66, 0x20, 0x23, 0x46, 0x4e, 0x57, 0x45, 0x3d, 0x67, 0x76, 0x60, 0x41,
    0x62, 0x39, 0x59, 0x2d, 0x68, 0x7e, 0x7c, 0x65, 0x7d, 0x49, 0x29, 0x72, 0x73, 0x78, 0x21, 0x6e,
    0x5a, 0x5e, 0x4a, 0x3e, 0x71, 0x2c, 0x2a, 0x54, 0x3c, 0x3a, 0x63, 0x4f, 0x43, 0x75, 0x27, 0x79,
    0x5b, 0x35, 0x70, 0x48, 0x6b, 0x56, 0x6f, 0x34, 0x32, 0x6c, 0x30, 0x61, 0x6d, 0x7b, 0x2f, 0x4b,
    0x64, 0x38, 0x2b, 0x2e, 0x50, 0x40, 0x3f, 0x55, 0x33, 0x37, 0x25, 0x77, 0x24, 0x26, 0x74, 0x6a,
    0x28, 0x53, 0x4d, 0x69, 0x22, 0x5c, 0x44, 0x31, 0x36, 0x58, 0x3b, 0x7a, 0x51, 0x5f, 0x52,
  ];
  for (let i = 0; i < seq.length; i++) t[32 + i] = seq[i];
  return t;
})();

function passcodeBytes(input, maxLen = 16) {
  const out = Buffer.alloc(maxLen, 0);
  if (!input) return out;
  for (let i = 0; i < input.length && i < maxLen; i++) {
    let p = input.charCodeAt(i) + i;
    if (p > 126) p = 32 + (p % 127);
    out[i] = PASSCODE_TABLE[p];
  }
  return out;
}

// 32-bit random ID — must be non-zero and (per wfview) typically has the
// high bit set so it doesn't collide with the radio's id space.
function randomId() {
  return ((Math.floor(Math.random() * 0x7fffffff) | 0x10000000) >>> 0);
}

// --- Header builders ---

function buildControl(type, seq, sentid, rcvdid) {
  const buf = Buffer.alloc(CONTROL_SIZE, 0);
  buf.writeUInt32LE(CONTROL_SIZE, 0);
  buf.writeUInt16LE(type,          4);
  buf.writeUInt16LE(seq,           6);
  buf.writeUInt32LE(sentid,        8);
  buf.writeUInt32LE(rcvdid,       12);
  return buf;
}

function buildPing(seq, sentid, rcvdid, time, reply) {
  const buf = Buffer.alloc(PING_SIZE, 0);
  buf.writeUInt32LE(PING_SIZE, 0);
  buf.writeUInt16LE(TYPE_PING, 4);
  buf.writeUInt16LE(seq,       6);
  buf.writeUInt32LE(sentid,    8);
  buf.writeUInt32LE(rcvdid,   12);
  buf.writeUInt8(reply ? 0x01 : 0x00, 0x10);
  buf.writeUInt32LE(time >>> 0, 0x11);
  return buf;
}

function buildLogin(seq, sentid, rcvdid, innerSeq, tokRequest, username, password, compName) {
  const buf = Buffer.alloc(LOGIN_SIZE, 0);
  buf.writeUInt32LE(LOGIN_SIZE, 0x00);
  buf.writeUInt16LE(0,          0x04); // type 0
  buf.writeUInt16LE(seq,        0x06);
  buf.writeUInt32LE(sentid,     0x08);
  buf.writeUInt32LE(rcvdid,     0x0c);
  buf.writeUInt32BE(LOGIN_SIZE - 0x10, 0x10); // payloadsize, BIG-ENDIAN
  buf.writeUInt8(0x01,    0x14); // requestreply
  buf.writeUInt8(0x00,    0x15); // requesttype
  buf.writeUInt16BE(innerSeq, 0x16); // innerseq, BIG-ENDIAN
  buf.writeUInt16LE(tokRequest, 0x1a);
  // token field (4 bytes at 0x1c) stays zero on initial login
  passcodeBytes(username, 16).copy(buf, 0x40);
  passcodeBytes(password, 16).copy(buf, 0x50);
  Buffer.from(String(compName || 'POTACAT').slice(0, 16), 'ascii').copy(buf, 0x60);
  return buf;
}

function buildToken(seq, sentid, rcvdid, innerSeq, tokRequest, token, magic) {
  const buf = Buffer.alloc(TOKEN_SIZE, 0);
  buf.writeUInt32LE(TOKEN_SIZE, 0x00);
  buf.writeUInt16LE(0,           0x04);
  buf.writeUInt16LE(seq,         0x06);
  buf.writeUInt32LE(sentid,      0x08);
  buf.writeUInt32LE(rcvdid,      0x0c);
  buf.writeUInt32BE(TOKEN_SIZE - 0x10, 0x10);
  buf.writeUInt8(0x01,    0x14); // requestreply
  buf.writeUInt8(magic,   0x15); // requesttype: 0x02 = renew/confirm
  buf.writeUInt16BE(innerSeq,    0x16);
  buf.writeUInt16LE(tokRequest,  0x1a);
  buf.writeUInt32LE(token >>> 0, 0x1c);
  return buf;
}

function buildConnInfo(seq, sentid, rcvdid, innerSeq, tokRequest, token, username, devName, civPort, audioPort) {
  const buf = Buffer.alloc(CONNINFO_SIZE, 0);
  buf.writeUInt32LE(CONNINFO_SIZE, 0x00);
  buf.writeUInt16LE(0,            0x04);
  buf.writeUInt16LE(seq,          0x06);
  buf.writeUInt32LE(sentid,       0x08);
  buf.writeUInt32LE(rcvdid,       0x0c);
  buf.writeUInt32BE(CONNINFO_SIZE - 0x10, 0x10);
  buf.writeUInt8(0x01,    0x14); // requestreply
  buf.writeUInt8(0x03,    0x15); // requesttype: stream-request
  buf.writeUInt16BE(innerSeq,     0x16);
  buf.writeUInt16LE(tokRequest,   0x1a);
  buf.writeUInt32LE(token >>> 0,  0x1c);
  buf.writeUInt16LE(0x8010,       0x27); // commoncap
  // macaddress is left zero — we're not pretending to be a specific NIC
  Buffer.from(String(devName || 'POTACAT-Radio').slice(0, 32), 'ascii').copy(buf, 0x40);
  passcodeBytes(username, 16).copy(buf, 0x60);
  buf.writeUInt8(0x01,         0x70); // rxenable
  buf.writeUInt8(0x00,         0x71); // txenable (Phase 1: no TX audio)
  buf.writeUInt8(0x00,         0x72); // rxcodec  (Phase 1: no audio)
  buf.writeUInt8(0x00,         0x73); // txcodec
  buf.writeUInt32BE(0,         0x74); // rxsample
  buf.writeUInt32BE(0,         0x78); // txsample
  buf.writeUInt32BE(civPort,   0x7c);
  buf.writeUInt32BE(audioPort, 0x80);
  buf.writeUInt32BE(50,        0x84); // txbuffer (latency hint)
  buf.writeUInt8(0x01,         0x88); // convert
  return buf;
}

function buildOpenClose(seq, sentid, rcvdid, close, magic) {
  const buf = Buffer.alloc(OPENCLOSE_SIZE, 0);
  buf.writeUInt32LE(OPENCLOSE_SIZE, 0x00);
  buf.writeUInt16LE(0,              0x04);
  buf.writeUInt16LE(seq,            0x06);
  buf.writeUInt32LE(sentid,         0x08);
  buf.writeUInt32LE(rcvdid,         0x0c);
  buf.writeUInt16LE(close ? 0x0005 : 0x0001, 0x10); // 0x10: 0x0001 open / 0x0005 close
  // 0x12 unused, 0x13 sendseq (we don't track), 0x15 magic byte
  buf.writeUInt8(magic | 0,         0x15);
  return buf;
}

// CI-V data wrapper for civ stream.
// Header: [len][type=0][seq][sentid][rcvdid][reply=0xc1][datalen LE][sendseq BE]
// Payload: raw CI-V frame(s)
function buildCivData(seq, sentid, rcvdid, sendSeqB, civPayload) {
  const total = CIV_HEADER_SIZE + civPayload.length;
  const buf = Buffer.alloc(total, 0);
  buf.writeUInt32LE(total,       0x00);
  buf.writeUInt16LE(0,           0x04);
  buf.writeUInt16LE(seq,         0x06);
  buf.writeUInt32LE(sentid,      0x08);
  buf.writeUInt32LE(rcvdid,      0x0c);
  buf.writeUInt8(0xc1,           0x10);
  buf.writeUInt16LE(civPayload.length, 0x11);
  buf.writeUInt16BE(sendSeqB,    0x13);
  civPayload.copy(buf, CIV_HEADER_SIZE);
  return buf;
}

// ---------------------------------------------------------------------------
// IcomUdpStream — manages one UDP socket and its handshake.
// Used twice: once for control, once for civ. Different state machines for
// each (control does login+token, civ just AYT+OpenClose), but the timer +
// send/receive plumbing is shared.
// ---------------------------------------------------------------------------
class IcomUdpStream extends EventEmitter {
  constructor({ name, host, port, log }) {
    super();
    this.name = name;
    this.host = host;
    this.port = port;
    this._log = log || (() => {});
    this.socket = null;
    this.myId = randomId();
    this.remoteId = 0;
    this.seq = 0;
    this.aytTimer = null;
    this.pingTimer = null;
    this.idleTimer = null;
    this.connected = false;
    this.gotIAmHere = false;
  }

  open() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      sock.on('error', (err) => {
        this._log(`[rsba1/${this.name}] socket error: ${err.message}`);
        this.emit('error', err);
      });
      sock.on('message', (msg) => this._onMessage(msg));
      sock.bind(0, () => {
        this.socket = sock;
        this._log(`[rsba1/${this.name}] bound on local port ${sock.address().port}`);
        resolve();
      });
      sock.once('error', reject);
    });
  }

  close() {
    this._stopTimers();
    if (this.socket) {
      try {
        // Best-effort disconnect packet so the radio releases the session.
        this._sendControl(TYPE_DISCONNECT, 0);
      } catch { /* ignore */ }
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
    }
    this.connected = false;
    this.gotIAmHere = false;
  }

  _stopTimers() {
    if (this.aytTimer)  { clearInterval(this.aytTimer);  this.aytTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
  }

  _send(buf) {
    if (!this.socket) return;
    this.socket.send(buf, this.port, this.host, (err) => {
      if (err) this._log(`[rsba1/${this.name}] send error: ${err.message}`);
    });
  }

  _sendControl(type, seq) {
    this._send(buildControl(type, seq, this.myId, this.remoteId));
  }

  _sendPing() {
    const t = (Date.now() & 0xffffffff) >>> 0;
    this._send(buildPing(this.seq++, this.myId, this.remoteId, t, false));
  }

  _sendIdle() {
    this._sendControl(TYPE_RETRANSMIT, this.seq++);
  }

  startHandshake() {
    // Spam AYT every AYT_PERIOD until IAmHere arrives.
    const sendAyt = () => {
      this._log(`[rsba1/${this.name}] -> AreYouThere`);
      this._sendControl(TYPE_AYT, 0);
    };
    sendAyt();
    this.aytTimer = setInterval(sendAyt, AYT_PERIOD);
  }

  startKeepAlive() {
    if (this.pingTimer || this.idleTimer) return;
    this.pingTimer = setInterval(() => this._sendPing(), PING_PERIOD);
    this.idleTimer = setInterval(() => this._sendIdle(), IDLE_PERIOD);
  }

  // Subclasses implement.
  _onMessage(msg) { /* override */ }
}

// ---------------------------------------------------------------------------
// ControlStream — handles login, token, and ConnInfo. Once authenticated,
// emits 'streams-ready' with civPort + audioPort so the parent can start
// the CivStream. After that, just keeps the session alive with pings.
// ---------------------------------------------------------------------------
class ControlStream extends IcomUdpStream {
  constructor(opts) {
    super({ ...opts, name: 'control' });
    this.username = opts.username || '';
    this.password = opts.password || '';
    this.compName = opts.compName || 'POTACAT';
    this.devName  = opts.devName  || 'POTACAT-Radio';
    this.tokRequest = (Math.random() * 0xffff) & 0xffff;
    this.token = 0;
    this.innerSeq = 0;
    this.authStage = 'AYT';
  }

  _onMessage(msg) {
    if (msg.length < 4) return;
    const len = msg.readUInt32LE(0);
    if (len !== msg.length) {
      this._log(`[rsba1/${this.name}] length mismatch: header=${len} actual=${msg.length}`);
    }
    switch (msg.length) {
      case CONTROL_SIZE: this._onControl(msg); break;
      case PING_SIZE:    this._onPing(msg); break;
      case TOKEN_SIZE:   this._onToken(msg); break;
      case STATUS_SIZE:  this._onStatus(msg); break;
      case LOGIN_RESPONSE_SIZE: this._onLoginResponse(msg); break;
      case CONNINFO_SIZE: this._onConnInfoIn(msg); break;
      default:
        this._log(`[rsba1/${this.name}] <- unknown packet size ${msg.length}`);
    }
  }

  _onControl(msg) {
    const type = msg.readUInt16LE(4);
    const sentId = msg.readUInt32LE(8);
    if (type === TYPE_IAMHERE) {
      if (!this.gotIAmHere) {
        this.gotIAmHere = true;
        this.remoteId = sentId;
        this._log(`[rsba1/${this.name}] <- IAmHere (remoteId=0x${this.remoteId.toString(16)})`);
        if (this.aytTimer) { clearInterval(this.aytTimer); this.aytTimer = null; }
        this.startKeepAlive();
        // Trigger AreYouReady to advance the state machine — radio responds
        // with IAmReady, which is our cue to send Login.
        this._sendControl(TYPE_AYR_IAR, this.seq++);
        this.authStage = 'AYR_SENT';
      }
    } else if (type === TYPE_AYR_IAR) {
      this._log(`[rsba1/${this.name}] <- IAmReady — sending Login`);
      this.authStage = 'LOGIN_SENT';
      this._send(buildLogin(this.seq++, this.myId, this.remoteId,
        this.innerSeq++, this.tokRequest, this.username, this.password, this.compName));
    } else {
      this._log(`[rsba1/${this.name}] <- control type 0x${type.toString(16)}`);
    }
  }

  _onPing(msg) {
    const type = msg.readUInt16LE(4);
    const reply = msg.readUInt8(0x10);
    if (type === TYPE_PING && reply === 0) {
      // Radio probing us — echo back with reply=1
      const seq = msg.readUInt16LE(6);
      const time = msg.readUInt32LE(0x11);
      this._send(buildPing(seq, this.myId, this.remoteId, time, true));
    }
    // reply=1 is a response to our ping; we don't track latency here
  }

  _onLoginResponse(msg) {
    const tokRequest = msg.readUInt16LE(0x1a);
    const token = msg.readUInt32LE(0x1c);
    const errCode = msg.readUInt32LE(0x30);
    if (errCode === 0xfeffffff) {
      this._log(`[rsba1/${this.name}] !! Login REJECTED (invalid username/password)`);
      this.emit('auth-failed', 'invalid-credentials');
      return;
    }
    if (tokRequest !== this.tokRequest) {
      this._log(`[rsba1/${this.name}] login response token mismatch (sent=0x${this.tokRequest.toString(16)} got=0x${tokRequest.toString(16)})`);
      return;
    }
    this.token = token;
    this._log(`[rsba1/${this.name}] <- LoginResponse OK (token=0x${this.token.toString(16)})`);
    this.authStage = 'TOKEN_CONFIRM_SENT';
    // Confirm token (magic 0x02) then expect Status with stream ports.
    this._send(buildToken(this.seq++, this.myId, this.remoteId,
      this.innerSeq++, this.tokRequest, this.token, 0x02));
    // Schedule periodic token renewal.
    if (this.tokenTimer) clearInterval(this.tokenTimer);
    this.tokenTimer = setInterval(() => {
      this._send(buildToken(this.seq++, this.myId, this.remoteId,
        this.innerSeq++, this.tokRequest, this.token, 0x05));
    }, TOKEN_RENEWAL);
  }

  _onToken(msg) {
    const requestReply = msg.readUInt8(0x14);
    const requestType  = msg.readUInt8(0x15);
    const innerType    = msg.readUInt16LE(0x04);
    const response     = msg.readUInt32LE(0x30);
    this._log(`[rsba1/${this.name}] <- Token (reqReply=${requestReply} reqType=0x${requestType.toString(16)} response=0x${response.toString(16)})`);
    if (response === 0xffffffff) {
      // Radio asked us to (re)send ConnInfo to (re)establish streams.
      this._sendConnInfo();
    } else if (response === 0x00000000 && this.authStage === 'TOKEN_CONFIRM_SENT') {
      // Token confirmation accepted — now request streams.
      this._sendConnInfo();
    }
  }

  _sendConnInfo() {
    this.authStage = 'CONNINFO_SENT';
    // We don't bind specific civ/audio local ports yet — let the radio
    // pick whatever it advertises in the Status reply.
    this._send(buildConnInfo(this.seq++, this.myId, this.remoteId,
      this.innerSeq++, this.tokRequest, this.token, this.username, this.devName, 0, 0));
  }

  _onStatus(msg) {
    const error = msg.readUInt32LE(0x30);
    const civPort   = msg.readUInt16BE(0x42); // big-endian
    const audioPort = msg.readUInt16BE(0x46);
    this._log(`[rsba1/${this.name}] <- Status (error=0x${error.toString(16)} civPort=${civPort} audioPort=${audioPort})`);
    if (error === 0xffffffff) {
      this.emit('auth-failed', 'connection-rejected');
      return;
    }
    if (civPort > 0) {
      this.authStage = 'AUTHED';
      this.connected = true;
      this.emit('streams-ready', { civPort, audioPort });
    }
  }

  _onConnInfoIn(msg) {
    // Inbound conninfo notifies us of other clients' state. We ignore for
    // Phase 1 — POTACAT just connects as a single client.
    this._log(`[rsba1/${this.name}] <- ConnInfo (ignored)`);
  }

  close() {
    if (this.tokenTimer) { clearInterval(this.tokenTimer); this.tokenTimer = null; }
    super.close();
  }
}

// ---------------------------------------------------------------------------
// CivStream — handshakes on the civ port, then tunnels CI-V bytes in/out.
// Emits 'civ-data' with extracted CI-V payloads on each receive.
// ---------------------------------------------------------------------------
class CivStream extends IcomUdpStream {
  constructor(opts) {
    super({ ...opts, name: 'civ' });
    this.sendSeqB = 0;
  }

  _onMessage(msg) {
    if (msg.length < 4) return;
    if (msg.length === CONTROL_SIZE) {
      const type = msg.readUInt16LE(4);
      const sentId = msg.readUInt32LE(8);
      if (type === TYPE_IAMHERE && !this.gotIAmHere) {
        this.gotIAmHere = true;
        this.remoteId = sentId;
        if (this.aytTimer) { clearInterval(this.aytTimer); this.aytTimer = null; }
        this._log(`[rsba1/${this.name}] <- IAmHere (remoteId=0x${this.remoteId.toString(16)})`);
        this.startKeepAlive();
      } else if (type === TYPE_AYR_IAR) {
        this._log(`[rsba1/${this.name}] <- IAmReady — sending OpenClose to start CI-V flow`);
        this.remoteId = sentId; // wfview re-saves remoteId here too
        this._send(buildOpenClose(this.seq++, this.myId, this.remoteId, false, 0x01));
        this.connected = true;
        this.emit('ready');
      } else {
        this._log(`[rsba1/${this.name}] <- control type 0x${type.toString(16)}`);
      }
      return;
    }
    if (msg.length === PING_SIZE) {
      // Ping reply or radio probe. Same logic as control stream.
      const type = msg.readUInt16LE(4);
      const reply = msg.readUInt8(0x10);
      if (type === TYPE_PING && reply === 0) {
        const seq = msg.readUInt16LE(6);
        const time = msg.readUInt32LE(0x11);
        this._send(buildPing(seq, this.myId, this.remoteId, time, true));
      }
      return;
    }
    if (msg.length > CIV_HEADER_SIZE) {
      // CI-V data frame. Header is 21 bytes; payload follows.
      const innerType = msg.readUInt16LE(0x04);
      if (innerType === 0x01) return; // retransmit request, ignore
      const reply = msg.readUInt8(0x10);
      const datalen = msg.readUInt16LE(0x11);
      if (reply !== 0xc1) {
        this._log(`[rsba1/${this.name}] <- non-CIV reply byte 0x${reply.toString(16)}`);
        return;
      }
      if (CIV_HEADER_SIZE + datalen > msg.length) {
        this._log(`[rsba1/${this.name}] <- truncated CIV frame`);
        return;
      }
      const civ = msg.slice(CIV_HEADER_SIZE, CIV_HEADER_SIZE + datalen);
      this.emit('civ-data', civ);
    }
  }

  // Send raw CI-V bytes (already a complete CI-V frame) to the radio.
  sendCiv(buf) {
    if (!this.connected || !buf || !buf.length) return;
    this._send(buildCivData(this.seq++, this.myId, this.remoteId, this.sendSeqB++, buf));
  }
}

// ---------------------------------------------------------------------------
// RsBa1Transport — public class. Same API surface as SerialTransport:
//   .connect({ host, controlPort, civPort, username, password })
//   .disconnect()
//   .write(buf)        — feed CI-V bytes; routed to civ stream
//   .setPin(...)       — no-op (UDP transport has no DTR/RTS)
//   events: 'connect', 'data' (CI-V bytes), 'close', 'error', 'log'
// ---------------------------------------------------------------------------
class RsBa1Transport extends EventEmitter {
  constructor() {
    super();
    this.control = null;
    this.civ = null;
    this._target = null;
    this._connected = false;
    this._handshakeDeadline = null;
  }

  get connected() { return this._connected; }
  get isOpen()    { return this._connected; }

  connect({ host, controlPort = 50001, civPort, username = '', password = '', compName = 'POTACAT' } = {}) {
    if (!host) {
      this.emit('error', new Error('rsba1: host is required'));
      return;
    }
    this.disconnect();
    this._target = { host, controlPort, civPort: civPort || null, username, password, compName };
    const log = (msg) => this.emit('log', msg);

    this.control = new ControlStream({ host, port: controlPort, username, password, compName, log });

    this.control.on('error', (e) => this.emit('error', e));
    this.control.on('auth-failed', (reason) => {
      this.emit('error', new Error(`rsba1 authentication failed: ${reason}`));
      this.disconnect();
    });
    this.control.on('streams-ready', ({ civPort: assignedCivPort }) => {
      // Open civ stream on the port the radio assigned (or the override).
      const targetCivPort = this._target.civPort || assignedCivPort || (controlPort + 1);
      this._openCivStream(host, targetCivPort, log);
    });

    this.control.open()
      .then(() => this.control.startHandshake())
      .catch((err) => this.emit('error', err));

    // Handshake watchdog: if we don't authenticate within HANDSHAKE_TIMEOUT,
    // give up and emit error so the upstream connector can show a useful
    // message (rather than hang silently).
    this._handshakeDeadline = setTimeout(() => {
      if (!this._connected) {
        this.emit('error', new Error('rsba1 handshake timed out (no IAmHere/Login response from radio)'));
        this.disconnect();
      }
    }, HANDSHAKE_TIMEOUT);
  }

  _openCivStream(host, port, log) {
    this.civ = new CivStream({ host, port, log });
    this.civ.on('error', (e) => this.emit('error', e));
    this.civ.on('ready', () => {
      this._connected = true;
      if (this._handshakeDeadline) {
        clearTimeout(this._handshakeDeadline);
        this._handshakeDeadline = null;
      }
      this.emit('connect');
    });
    this.civ.on('civ-data', (civBuf) => {
      this.emit('data', civBuf);
    });
    this.civ.open()
      .then(() => this.civ.startHandshake())
      .catch((err) => this.emit('error', err));
  }

  disconnect() {
    if (this._handshakeDeadline) {
      clearTimeout(this._handshakeDeadline);
      this._handshakeDeadline = null;
    }
    if (this.civ)     { this.civ.close();     this.civ = null; }
    if (this.control) { this.control.close(); this.control = null; }
    if (this._connected) {
      this._connected = false;
      this.emit('close');
    }
  }

  write(buf) {
    if (!this._connected || !this.civ) return false;
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    this.civ.sendCiv(buf);
    return true;
  }

  // SerialTransport-compatible no-ops — RS-BA1 has no DTR/RTS/baud.
  setPin(_pins, cb) { if (cb) cb(null); }
  set(_pins, cb)    { if (cb) cb(null); }
}

module.exports = { RsBa1Transport, passcodeBytes, PASSCODE_TABLE };
