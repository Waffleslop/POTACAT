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
// Icom's network protocol uses three parallel UDP socket pairs between
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
//   * audio stream — port 50003 by default. Same handshake pattern, then
//     carries RX/TX audio in a 24-byte data-packet header plus codec payload.
//     POTACAT uses LPCM16 mono for the first production TX path because it is
//     the simplest wfview/RS-BA1 audio mode and works for generated FT8/SSTV
//     tones without requiring an Opus/uLAW encoder.
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
const dns = require('dns').promises;
const os = require('os');
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
const CAPABILITIES_SIZE = 0x42;
const RADIO_CAP_SIZE = 0x66;
const CIV_HEADER_SIZE = 0x15;
const AUDIO_HEADER_SIZE = 0x18;
const AUDIO_CODEC_LPCM16_MONO = 0x04;
const AUDIO_CODEC_LPCM16_STEREO = 0x10;
const AUDIO_TX_MAX_PAYLOAD = 1364; // wfview splits outbound audio at this size
const ICOM_AUDIO_TX_SAMPLE_RATE = 48000;
const DEFAULT_TX_AUDIO_BUFFER_MS = 250;
const AUDIO_FRAME_PERIOD_MS = 20; // wfview AUDIO_PERIOD: one real-time audio block per 20ms
const TX_BUFFER_SAFETY_MS = 50;
const TX_MAX_PACE_LEAD_MS = 150;
const MAX_TX_FRAMES_PER_PUMP = 3;
const TX_SLOT_AUDIO_START_MS = 500; // WSJT-X FT8 convention; FT4 callers can override to 300ms.
const TX_TAIL_SILENCE_MS = 0;
// Voice TX streaming constants.
// Frame samples = one 20 ms block at 48 kHz, same cadence as batch TX.
const VOICE_TX_FRAME_SAMPLES = 960;  // 20 ms @ 48 kHz
// Ring buffer holds 3 seconds of audio to absorb IPC/WebRTC jitter.
const VOICE_TX_RING_SAMPLES = 48000 * 3;

// --- Type codes (control packet `type` field at offset 0x04) ---
const TYPE_IDLE       = 0x00;
const TYPE_RETRANSMIT_REQUEST = 0x01;
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
const TX_BUFFER_LIMIT = 4096;
const RX_RETRANSMIT_PERIOD = 100;
const RX_RETRANSMIT_MAX_ATTEMPTS = 4;
const RX_MISSING_LIMIT = 50;
const TX_RETRANSMIT_DEDUPE_MS = 35;

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

function streamIdFromLocalAddress(address, localPort) {
  const parts = String(address || '').split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return randomId();
  }
  const port = Number(localPort) & 0xffff;
  return (((parts[2] & 0xff) << 24) | ((parts[3] & 0xff) << 16) | port) >>> 0;
}

function ipv4ToInt(address) {
  const parts = String(address || '').split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

function popcount32(value) {
  let n = value >>> 0;
  let count = 0;
  while (n) {
    count += n & 1;
    n >>>= 1;
  }
  return count;
}

function isTunnelInterface(name) {
  return /^(utun|tun|tap|tailscale|wg|awdl|llw)/i.test(String(name || ''));
}

function isPreferredLanInterface(name) {
  return /^(en|eth|wlan|wl|bridge)/i.test(String(name || ''));
}

function selectLocalAddressForTarget(remoteHost, routedAddress = null, interfaces = os.networkInterfaces()) {
  const target = ipv4ToInt(remoteHost);
  const routed = routedAddress ? String(routedAddress) : null;
  if (target == null) return { address: routed, source: routed ? 'route' : 'none', routedAddress: routed };

  const routedInt = ipv4ToInt(routed);
  let routedMatches = false;
  const candidates = [];
  for (const [name, addrs] of Object.entries(interfaces || {})) {
    for (const addr of addrs || []) {
      const family = addr && (addr.family === 4 || addr.family === 'IPv4');
      if (!family || !addr.address) continue;
      const addrInt = ipv4ToInt(addr.address);
      const maskInt = ipv4ToInt(addr.netmask || '255.255.255.255');
      if (addrInt == null || maskInt == null) continue;
      if (((addrInt & maskInt) >>> 0) !== ((target & maskInt) >>> 0)) continue;
      const prefix = popcount32(maskInt);
      if (routedInt != null && addrInt === routedInt) routedMatches = true;
      candidates.push({
        name,
        address: addr.address,
        prefix,
        internal: addr.internal === true,
        tunnel: isTunnelInterface(name),
        lan: isPreferredLanInterface(name),
        routed: routedInt != null && addrInt === routedInt,
      });
    }
  }

  if (routed && routedMatches) {
    return { address: routed, source: 'route', routedAddress: routed };
  }
  if (!candidates.length) {
    return { address: routed, source: routed ? 'route' : 'none', routedAddress: routed };
  }

  candidates.sort((a, b) => {
    const score = (c) =>
      (c.lan ? 1000 : 0) +
      (!c.tunnel ? 300 : -300) +
      (!c.internal ? 100 : -100) +
      (c.routed ? 50 : 0) +
      c.prefix;
    return score(b) - score(a);
  });
  const best = candidates[0];
  return {
    address: best.address,
    source: routed && best.address !== routed ? 'same-subnet' : (best.routed ? 'route' : 'same-subnet'),
    routedAddress: routed,
    interfaceName: best.name,
  };
}

function findLocalAddressForTarget(remoteHost, remotePort) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let settled = false;
    const done = (address) => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch { /* ignore */ }
      const routed = address && address !== '0.0.0.0' ? address : null;
      resolve(selectLocalAddressForTarget(remoteHost, routed));
    };
    const timer = setTimeout(() => done(null), 1000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    sock.once('error', () => {
      clearTimeout(timer);
      done(null);
    });
    try {
      sock.connect(Number(remotePort) || 9, remoteHost, () => {
        clearTimeout(timer);
        let address = null;
        try {
          const info = sock.address();
          address = info && info.address;
        } catch { /* ignore */ }
        done(address);
      });
    } catch {
      clearTimeout(timer);
      done(null);
    }
  });
}

function makeRsba1Error(message, code, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.details = details;
  return err;
}

function cString(buf, offset, len) {
  const end = Math.min(buf.length, offset + len);
  let stop = offset;
  while (stop < end && buf[stop] !== 0) stop++;
  return buf.slice(offset, stop).toString('ascii').trim();
}

function isCapabilitiesPacket(buf) {
  if (!buf || buf.length < CAPABILITIES_SIZE) return false;
  const len = buf.readUInt32LE(0);
  if (len !== buf.length) return false;
  return (buf.length - CAPABILITIES_SIZE) % RADIO_CAP_SIZE === 0;
}

function parseCapabilities(buf) {
  if (!isCapabilitiesPacket(buf)) return [];
  const declared = buf.readUInt16LE(0x40);
  const available = Math.floor((buf.length - CAPABILITIES_SIZE) / RADIO_CAP_SIZE);
  const count = Math.min(declared || available, available);
  const radios = [];
  for (let i = 0; i < count; i++) {
    const base = CAPABILITIES_SIZE + i * RADIO_CAP_SIZE;
    const commoncap = buf.readUInt16LE(base + 0x07);
    const macAddress = Buffer.from(buf.slice(base + 0x0a, base + 0x10));
    const guid = Buffer.from(buf.slice(base, base + 0x10));
    const name = cString(buf, base + 0x10, 32);
    const audio = cString(buf, base + 0x30, 32);
    radios.push({
      commoncap,
      macAddress,
      guid,
      useGuid: commoncap !== 0x8010,
      name,
      audio,
      conntype: buf.readUInt16LE(base + 0x50),
      civAddress: buf.readUInt8(base + 0x52),
      rxSampleMask: buf.readUInt16LE(base + 0x53),
      txSampleMask: buf.readUInt16LE(base + 0x55),
      baudrate: buf.readUInt32BE(base + 0x5a),
      capf: buf.readUInt16LE(base + 0x5e),
    });
  }
  return radios;
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

function buildRetransmitRange(seq, sentid, rcvdid, missingSeqs) {
  const seqs = Array.isArray(missingSeqs) ? missingSeqs : [];
  const buf = Buffer.alloc(CONTROL_SIZE + seqs.length * 4, 0);
  buf.writeUInt32LE(buf.length, 0);
  buf.writeUInt16LE(TYPE_RETRANSMIT_REQUEST, 4);
  buf.writeUInt16LE(seq & 0xffff, 6);
  buf.writeUInt32LE(sentid >>> 0, 8);
  buf.writeUInt32LE(rcvdid >>> 0, 12);
  let off = CONTROL_SIZE;
  for (const raw of seqs) {
    const s = Number(raw) & 0xffff;
    // wfview places each missing sequence twice in the variable-length
    // retransmit request. Radios and wfserver accept the duplicate pair.
    buf.writeUInt16LE(s, off);
    buf.writeUInt16LE(s, off + 2);
    off += 4;
  }
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
  buf.writeUInt16BE(0x0798,      0x24); // resetcap; wfview sends this on token confirm/renewal
  return buf;
}

function buildConnInfo(seq, sentid, rcvdid, innerSeq, tokRequest, token, username, devName, civPort, audioPort, audio = {}, radioInfo = null) {
  const enableRxAudio = audio.enableRx === true;
  const enableTxAudio = audio.enableTx === true;
  const rxCodec = enableRxAudio ? (audio.rxCodec || AUDIO_CODEC_LPCM16_MONO) : 0x00;
  const txCodec = enableTxAudio ? (audio.txCodec || AUDIO_CODEC_LPCM16_MONO) : 0x00;
  const rxSampleRate = enableRxAudio ? (audio.rxSampleRate || 48000) : 0;
  const txSampleRate = enableTxAudio ? (audio.txSampleRate || ICOM_AUDIO_TX_SAMPLE_RATE) : 0;
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
  if (radioInfo && radioInfo.useGuid && radioInfo.guid && radioInfo.guid.length >= 16) {
    radioInfo.guid.copy(buf, 0x20, 0, 16);
  } else {
    buf.writeUInt16LE((radioInfo && radioInfo.commoncap) || 0x8010, 0x27);
    if (radioInfo && radioInfo.macAddress && radioInfo.macAddress.length >= 6) {
      radioInfo.macAddress.copy(buf, 0x2a, 0, 6);
    }
  }
  Buffer.from(String((radioInfo && radioInfo.name) || devName || 'POTACAT-Radio').slice(0, 32), 'ascii').copy(buf, 0x40);
  passcodeBytes(username, 16).copy(buf, 0x60);
  buf.writeUInt8(enableRxAudio ? 0x01 : 0x00, 0x70); // rxenable
  buf.writeUInt8(enableTxAudio ? 0x01 : 0x00, 0x71); // txenable
  buf.writeUInt8(rxCodec,      0x72); // rxcodec
  buf.writeUInt8(txCodec,      0x73); // txcodec
  buf.writeUInt32BE(rxSampleRate, 0x74); // rxsample
  buf.writeUInt32BE(txSampleRate, 0x78); // txsample
  buf.writeUInt32BE(civPort,   0x7c);
  buf.writeUInt32BE(audioPort, 0x80);
  buf.writeUInt32BE(audio.txBufferMs || DEFAULT_TX_AUDIO_BUFFER_MS, 0x84); // txbuffer (latency hint)
  buf.writeUInt8(0x01,         0x88); // convert
  return buf;
}

function buildOpenClose(seq, sentid, rcvdid, close, magic = 0x04, sendSeqB = 0) {
  const buf = Buffer.alloc(OPENCLOSE_SIZE, 0);
  buf.writeUInt32LE(OPENCLOSE_SIZE, 0x00);
  buf.writeUInt16LE(0,              0x04);
  buf.writeUInt16LE(seq & 0xffff,   0x06);
  buf.writeUInt32LE(sentid,         0x08);
  buf.writeUInt32LE(rcvdid,         0x0c);
  buf.writeUInt16LE(close ? 0x05c0 : 0x01c0, 0x10);
  buf.writeUInt16BE(sendSeqB & 0xffff, 0x13);
  // 0x14 unused, 0x15 magic byte
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
  buf.writeUInt16LE(seq & 0xffff, 0x06);
  buf.writeUInt32LE(sentid,      0x08);
  buf.writeUInt32LE(rcvdid,      0x0c);
  buf.writeUInt8(0xc1,           0x10);
  buf.writeUInt16LE(civPayload.length, 0x11);
  buf.writeUInt16BE(sendSeqB & 0xffff, 0x13);
  civPayload.copy(buf, CIV_HEADER_SIZE);
  return buf;
}

// Audio data wrapper for the audio stream.
// wfview sends outbound audio with len/type/seq/sentid/rcvdid in native LE,
// sendseq + datalen in BE, and an LE ident field (usually 0x0080).
function buildAudioData(seq, sentid, rcvdid, sendSeqB, payload) {
  const total = AUDIO_HEADER_SIZE + payload.length;
  const buf = Buffer.alloc(total, 0);
  buf.writeUInt32LE(total,       0x00);
  buf.writeUInt16LE(0,           0x04);
  buf.writeUInt16LE(seq & 0xffff, 0x06);
  buf.writeUInt32LE(sentid,      0x08);
  buf.writeUInt32LE(rcvdid,      0x0c);
  buf.writeUInt16LE(payload.length === 0xa0 ? 0x9781 : 0x0080, 0x10);
  buf.writeUInt16BE(sendSeqB & 0xffff, 0x12);
  buf.writeUInt16BE(payload.length, 0x16);
  payload.copy(buf, AUDIO_HEADER_SIZE);
  return buf;
}

function decodeLpcm16Mono(payload) {
  const frames = payload.length >> 1;
  const pcm = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    pcm[i] = payload.readInt16LE(i * 2) / 32768;
  }
  return pcm;
}

function coerceFloat32(input) {
  if (input instanceof Float32Array) return input;
  if (ArrayBuffer.isView(input)) {
    return new Float32Array(input.buffer, input.byteOffset, Math.floor(input.byteLength / Float32Array.BYTES_PER_ELEMENT));
  }
  if (input instanceof ArrayBuffer) return new Float32Array(input);
  if (Array.isArray(input)) return new Float32Array(input);
  return new Float32Array(0);
}

function clampTailSilenceMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return TX_TAIL_SILENCE_MS;
  return Math.max(0, Math.min(1000, n));
}

function clampStartDelayMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return TX_SLOT_AUDIO_START_MS;
  return Math.max(0, Math.min(1500, n));
}

function resampleMonoFloat32(input, fromRate, toRate) {
  const src = coerceFloat32(input);
  if (!src.length) return src;
  const from = Number(fromRate) || toRate;
  const to = Number(toRate) || from;
  if (!from || !to || from === to) return src;

  // TX audio is usually JTCAT's 12 kHz FT8/FT4 waveform expanded to the
  // radio's 48 kHz RS-BA1 stream. Linear interpolation leaves audible/image
  // energy around narrow digital tones; wfview uses a real converter path, so
  // use a compact windowed-sinc reconstruction here for the direct-radio path.
  return resampleMonoFloat32Sinc(src, from, to);
}

function sinc(x) {
  if (Math.abs(x) < 1e-8) return 1;
  const pix = Math.PI * x;
  return Math.sin(pix) / pix;
}

function blackmanWindow(index, length) {
  if (length <= 1) return 1;
  const x = 2 * Math.PI * index / (length - 1);
  return 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
}

function resampleMonoFloat32Sinc(src, fromRate, toRate) {
  const from = Number(fromRate) || toRate;
  const to = Number(toRate) || from;
  const outLen = Math.max(1, Math.round(src.length * to / from));
  const out = new Float32Array(outLen);
  const ratio = from / to;
  const cutoff = Math.min(1, to / from);
  const radius = 16;
  const taps = radius * 2;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const center = Math.floor(pos);
    let sum = 0;
    let weightSum = 0;
    for (let tap = -radius + 1; tap <= radius; tap++) {
      const idx = center + tap;
      if (idx < 0 || idx >= src.length) continue;
      const distance = pos - idx;
      const window = blackmanWindow(tap + radius - 1, taps);
      const weight = cutoff * sinc(distance * cutoff) * window;
      sum += src[idx] * weight;
      weightSum += weight;
    }
    out[i] = weightSum ? (sum / weightSum) : 0;
  }
  return out;
}

function encodeLpcm16Mono(input) {
  const pcm = coerceFloat32(input);
  const out = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, Number.isFinite(pcm[i]) ? pcm[i] : 0));
    const s = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i * 2);
  }
  return out;
}

function encodeLpcm16DuplicatedStereo(input) {
  const pcm = coerceFloat32(input);
  const out = Buffer.alloc(pcm.length * 4);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, Number.isFinite(pcm[i]) ? pcm[i] : 0));
    const s = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
    const sample = Math.max(-32768, Math.min(32767, s));
    const off = i * 4;
    out.writeInt16LE(sample, off);
    out.writeInt16LE(sample, off + 2);
  }
  return out;
}

function lpcm16ChannelCount(codec) {
  return codec === AUDIO_CODEC_LPCM16_STEREO ? 2 : 1;
}

function analyzePcmFloat32(samples) {
  const pcm = coerceFloat32(samples);
  let peak = 0;
  let sumSq = 0;
  let nonZero = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = Number.isFinite(pcm[i]) ? pcm[i] : 0;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a > 1e-6) nonZero++;
    sumSq += v * v;
  }
  return {
    peak,
    rms: pcm.length ? Math.sqrt(sumSq / pcm.length) : 0,
    nonZero,
  };
}

function hex(buf) {
  return Array.from(buf || []).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

// ---------------------------------------------------------------------------
// IcomUdpStream — manages one UDP socket and its handshake.
// Used twice: once for control, once for civ. Different state machines for
// each (control does login+token, civ just AYT+OpenClose), but the timer +
// send/receive plumbing is shared.
// ---------------------------------------------------------------------------
class IcomUdpStream extends EventEmitter {
  constructor({ name, host, port, localPort = 0, localAddress = null, deriveStreamId = true, trackedIdle = true, displayHost, log }) {
    super();
    this.name = name;
    this.host = host;
    this.displayHost = displayHost || host;
    this.port = port;
    this.localPort = localPort || 0;
    this.localAddress = localAddress || null;
    this.deriveStreamId = deriveStreamId !== false;
    this.trackedIdle = trackedIdle !== false;
    this._log = log || (() => {});
    this.socket = null;
    this.myId = randomId();
    this.remoteId = 0;
    this.seq = 0;
    this.pingSeq = 0;
    this.txSeqBuf = new Map();
    this.txRetransmitResentAt = new Map();
    this.aytTimer = null;
    this.pingTimer = null;
    this.idleTimer = null;
    this.connected = false;
    this.gotIAmHere = false;
    this.aytCount = 0;
    this.lastSendError = null;
  }

  open() {
    if (this.socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      let settled = false;
      const fail = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      sock.on('error', (err) => {
        this._log(`[rsba1/${this.name}] socket error: ${err.message}`);
        this.emit('error', err);
      });
      sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
      sock.bind(this.localPort, () => {
        if (settled) return;
        settled = true;
        this.socket = sock;
        const bound = sock.address();
        this.localPort = bound.port;
        if (this.deriveStreamId) {
          const idAddress = this.localAddress || (bound.address && bound.address !== '0.0.0.0' ? bound.address : null);
          this.myId = streamIdFromLocalAddress(idAddress, this.localPort);
        }
        this._log(`[rsba1/${this.name}] bound on ${bound.address}:${this.localPort}; myId=0x${this.myId.toString(16)}; target ${this.displayHost}:${this.port}`);
        resolve();
      });
      sock.once('error', fail);
    });
  }

  close() {
    this._stopTimers();
    if (this.socket) {
      const sock = this.socket;
      this.socket = null;
      try {
        // Best-effort release packets. Keep the UDP socket alive briefly so
        // the kernel can actually put them on the wire before close().
        this._sendOnSocket(sock, buildControl(TYPE_DISCONNECT, 0, this.myId, this.remoteId));
        this._sendOnSocket(sock, buildControl(TYPE_DISCONNECT, 0, this.myId, this.remoteId));
      } catch { /* ignore */ }
      setTimeout(() => {
        try { sock.close(); } catch { /* ignore */ }
      }, 80);
    }
    this.connected = false;
    this.gotIAmHere = false;
    this.txSeqBuf.clear();
    this.txRetransmitResentAt.clear();
  }

  _stopTimers() {
    if (this.aytTimer)  { clearInterval(this.aytTimer);  this.aytTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
  }

  _send(buf) {
    if (!this.socket) return;
    this._sendOnSocket(this.socket, buf);
  }

  _sendOnSocket(sock, buf) {
    if (!sock) return;
    const port = Number(this.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      this.lastSendError = `invalid remote UDP port ${this.port}`;
      this._log(`[rsba1/${this.name}] send skipped: ${this.lastSendError} for ${this.displayHost}`);
      return;
    }
    try {
      sock.send(buf, port, this.host, (err) => {
        if (err) {
          this.lastSendError = err.message || String(err);
          this._log(`[rsba1/${this.name}] send error to ${this.displayHost}:${this.port}: ${this.lastSendError}`);
        }
      });
    } catch (err) {
      this.lastSendError = err.message || String(err);
      this._log(`[rsba1/${this.name}] send error to ${this.displayHost}:${this.port}: ${this.lastSendError}`);
    }
  }

  _learnRemoteEndpoint(rinfo) {
    if (!rinfo || !Number.isInteger(rinfo.port) || rinfo.port <= 0 || rinfo.port > 65535) return;
    if (Number(this.port) > 0 && Number(this.port) <= 65535) return;
    this.port = rinfo.port;
    if (rinfo.address) this.host = rinfo.address;
    this._log(`[rsba1/${this.name}] learned remote UDP endpoint ${rinfo.address || this.displayHost}:${rinfo.port}`);
  }

  _sendTracked(buf) {
    if (!buf || buf.length < 8) return;
    const seq = this.seq & 0xffff;
    const packet = Buffer.from(buf);
    packet.writeUInt16LE(seq, 0x06);
    this.seq = (this.seq + 1) & 0xffff;
    this.txSeqBuf.set(seq, packet);
    while (this.txSeqBuf.size > TX_BUFFER_LIMIT) {
      const oldest = this.txSeqBuf.keys().next().value;
      this.txSeqBuf.delete(oldest);
    }
    this._send(packet);
    return seq;
  }

  _handleRetransmitRequest(msg) {
    if (!msg || msg.length < CONTROL_SIZE) return false;
    const type = msg.readUInt16LE(4);
    if (type !== 0x01) return false;
    const seqs = [];
    if (msg.length === CONTROL_SIZE) {
      seqs.push(msg.readUInt16LE(6));
    } else {
      for (let off = CONTROL_SIZE; off + 1 < msg.length; off += 2) {
        seqs.push(msg.readUInt16LE(off));
      }
    }
    seqs.forEach((seq) => {
      const packet = this.txSeqBuf.get(seq);
      if (packet) {
        const now = Date.now();
        const last = this.txRetransmitResentAt.get(seq) || 0;
        if (now - last < TX_RETRANSMIT_DEDUPE_MS) return;
        this.txRetransmitResentAt.set(seq, now);
        while (this.txRetransmitResentAt.size > TX_BUFFER_LIMIT) {
          const oldest = this.txRetransmitResentAt.keys().next().value;
          this.txRetransmitResentAt.delete(oldest);
        }
        this._log(`[rsba1/${this.name}] <- retransmit request for seq ${seq}; resending`);
        this._send(packet);
      } else {
        this._log(`[rsba1/${this.name}] <- retransmit request for unknown seq ${seq}; sending idle`);
        this._send(buildControl(TYPE_IDLE, seq, this.myId, this.remoteId));
      }
    });
    return true;
  }

  _sendControl(type, seq) {
    this._send(buildControl(type, seq, this.myId, this.remoteId));
  }

  _sendPing() {
    const t = (Date.now() & 0xffffffff) >>> 0;
    this._send(buildPing(this.pingSeq++, this.myId, this.remoteId, t, false));
  }

  _sendIdle() {
    if (this.trackedIdle) {
      this._sendTracked(buildControl(TYPE_IDLE, 0, this.myId, this.remoteId));
    } else {
      this._sendControl(TYPE_IDLE, this.seq++);
    }
  }

  startHandshake() {
    this._stopTimers();
    this.gotIAmHere = false;
    // Spam AYT every AYT_PERIOD until IAmHere arrives.
    const sendAyt = () => {
      this.aytCount++;
      this._log(`[rsba1/${this.name}] -> AreYouThere #${this.aytCount}`);
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
  _onMessage(msg, rinfo) { this._learnRemoteEndpoint(rinfo); /* override */ }
}

// ---------------------------------------------------------------------------
// ControlStream — handles login, token, and ConnInfo. Once authenticated,
// emits 'streams-ready' with civPort + audioPort so the parent can start
// the CivStream. After that, just keeps the session alive with pings.
// ---------------------------------------------------------------------------
class ControlStream extends IcomUdpStream {
  constructor(opts) {
    super({ ...opts, name: 'control' });
    this.owner = opts.owner || null;
    this.username = opts.username || '';
    this.password = opts.password || '';
    this.compName = opts.compName || 'POTACAT';
    this.devName  = opts.devName  || 'POTACAT-Radio';
    this.enableRxAudio = opts.enableRxAudio === true;
    this.enableTxAudio = opts.enableTxAudio === true;
    this.rxAudioCodec = opts.rxAudioCodec || AUDIO_CODEC_LPCM16_MONO;
    this.rxAudioSampleRate = opts.rxAudioSampleRate || 48000;
    this.txAudioCodec = opts.txAudioCodec || AUDIO_CODEC_LPCM16_MONO;
    this.txAudioSampleRate = opts.txAudioSampleRate || ICOM_AUDIO_TX_SAMPLE_RATE;
    this.txAudioBufferMs = opts.txAudioBufferMs || DEFAULT_TX_AUDIO_BUFFER_MS;
    this.civLocalPort = opts.civLocalPort || 0;
    this.audioLocalPort = opts.audioLocalPort || 0;
    this.tokRequest = (Math.random() * 0xffff) & 0xffff;
    this.token = 0;
    this.innerSeq = 0;
    this.authStage = 'AYT';
    this.radioInfo = null;
    this.authMode = opts.authMode || 'direct';
    this.authRetryTimer = null;
    this.authRetryCount = 0;
    this.lastAuth = null;
    this.txAudioNegotiated = false;
  }

  _onMessage(msg, rinfo) {
    this._learnRemoteEndpoint(rinfo);
    if (msg.length < 4) return;
    if (msg.length >= CONTROL_SIZE && this._handleRetransmitRequest(msg)) return;
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
        if (isCapabilitiesPacket(msg)) {
          this._onCapabilities(msg);
          return;
        }
        this._log(`[rsba1/${this.name}] <- unknown packet size ${msg.length}`);
    }
  }

  _clearAuthRetry() {
    if (this.authRetryTimer) {
      clearInterval(this.authRetryTimer);
      this.authRetryTimer = null;
    }
    this.authRetryCount = 0;
  }

  _trackAuthResend(stage, packet, label, seq, intervalMs = 1000, maxRetries = 8) {
    this._clearAuthRetry();
    const stored = Buffer.from(packet || []);
    this.authRetryTimer = setInterval(() => {
      if (this.authStage !== stage) {
        this._clearAuthRetry();
        return;
      }
      this.authRetryCount++;
      if (this.lastAuth && this.lastAuth.stage === stage) {
        this.lastAuth.retryCount = this.authRetryCount;
      }
      if (this.authRetryCount > maxRetries) {
        this._log(`[rsba1/${this.name}] auth retry limit reached for ${label}`);
        this._clearAuthRetry();
        return;
      }
      this._log(`[rsba1/${this.name}] -> retry ${label} seq=${seq} #${this.authRetryCount}`);
      this._send(stored);
    }, intervalMs);
  }

  _sendAuthPacket(stage, label, buildPacket, meta = {}) {
    this.authStage = stage;
    let seq;
    let packet;
    if (this.authMode === 'tracked') {
      seq = this._sendTracked(buildPacket(0));
      packet = this.txSeqBuf.get(seq);
    } else {
      seq = this.seq & 0xffff;
      packet = buildPacket(seq);
      this.seq = (this.seq + 1) & 0xffff;
      this._send(packet);
    }
    this.lastAuth = {
      stage,
      label,
      mode: this.authMode,
      seq,
      innerSeq: meta.innerSeq,
      tokRequest: this.tokRequest,
      myId: this.myId,
      remoteId: this.remoteId,
      usernameLength: String(this.username || '').length,
      passwordLength: String(this.password || '').length,
      retryCount: 0,
    };
    this._log(`[rsba1/${this.name}] -> ${label} mode=${this.authMode} seq=${seq} innerSeq=${meta.innerSeq == null ? '-' : meta.innerSeq} myId=0x${this.myId.toString(16)} remoteId=0x${this.remoteId.toString(16)} tokReq=0x${this.tokRequest.toString(16)} userLen=${this.lastAuth.usernameLength} passLen=${this.lastAuth.passwordLength}`);
    this._trackAuthResend(stage, packet, label, seq);
    return seq;
  }

  _sendProtocolPacket(buildPacket) {
    if (this.authMode === 'tracked') {
      this._sendTracked(buildPacket(0));
    } else {
      const seq = this.seq & 0xffff;
      this.seq = (this.seq + 1) & 0xffff;
      this._send(buildPacket(seq));
    }
  }

  _onControl(msg) {
    const type = msg.readUInt16LE(4);
    const sentId = msg.readUInt32LE(8);
    if (this._handleRetransmitRequest(msg)) return;
    if (type === TYPE_IAMHERE) {
      if (!this.gotIAmHere) {
        this.gotIAmHere = true;
        this.remoteId = sentId;
        this._log(`[rsba1/${this.name}] <- IAmHere (remoteId=0x${this.remoteId.toString(16)})`);
        if (this.aytTimer) { clearInterval(this.aytTimer); this.aytTimer = null; }
        this.startKeepAlive();
        // Trigger AreYouReady to advance the state machine — radio responds
        // with IAmReady, which is our cue to send Login.
        const ayrSeq = this.authMode === 'tracked' ? 1 : this.seq++;
        this._sendControl(TYPE_AYR_IAR, ayrSeq);
        this._log(`[rsba1/${this.name}] -> AreYouReady mode=${this.authMode} seq=${ayrSeq}`);
        this.authStage = 'AYR_SENT';
      }
    } else if (type === TYPE_AYR_IAR) {
      this._log(`[rsba1/${this.name}] <- IAmReady — sending Login`);
      const innerSeq = this.innerSeq++;
      this._sendAuthPacket('LOGIN_SENT', 'Login', (seq) => buildLogin(seq, this.myId, this.remoteId,
        innerSeq, this.tokRequest, this.username, this.password, this.compName), { innerSeq });
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
    this._clearAuthRetry();
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
    // Confirm token (magic 0x02) then expect Status with stream ports.
    const innerSeq = this.innerSeq++;
    this._sendAuthPacket('TOKEN_CONFIRM_SENT', 'TokenConfirm', (seq) => buildToken(seq, this.myId, this.remoteId,
      innerSeq, this.tokRequest, this.token, 0x02), { innerSeq });
    // Schedule periodic token renewal.
    if (this.tokenTimer) clearInterval(this.tokenTimer);
    this.tokenTimer = setInterval(() => {
      const renewInnerSeq = this.innerSeq++;
      this._sendProtocolPacket((seq) => buildToken(seq, this.myId, this.remoteId,
        renewInnerSeq, this.tokRequest, this.token, 0x05));
    }, TOKEN_RENEWAL);
  }

  _onToken(msg) {
    this._clearAuthRetry();
    const requestReply = msg.readUInt8(0x14);
    const requestType  = msg.readUInt8(0x15);
    const response     = msg.readUInt32LE(0x30);
    this._log(`[rsba1/${this.name}] <- Token (reqReply=${requestReply} reqType=0x${requestType.toString(16)} response=0x${response.toString(16)})`);
    if (response === 0xffffffff) {
      this.remoteId = msg.readUInt32LE(0x08);
      this.tokRequest = msg.readUInt16LE(0x1a);
      this.token = msg.readUInt32LE(0x1c);
      // Radio asked us to (re)send ConnInfo to (re)establish streams.
      this._sendConnInfo();
    } else if (response === 0x00000000 && this.authStage === 'TOKEN_CONFIRM_SENT') {
      // Token confirmation accepted — now request streams.
      this._sendConnInfo();
    }
  }

  _onCapabilities(msg) {
    this._clearAuthRetry();
    const radios = parseCapabilities(msg);
    if (!radios.length) {
      this._log(`[rsba1/${this.name}] <- Capabilities packet contained no radios`);
      return;
    }
    this.radioInfo = radios[0];
    const civ = `0x${this.radioInfo.civAddress.toString(16).toUpperCase().padStart(2, '0')}`;
    const mac = Array.from(this.radioInfo.macAddress || []).map((b) => b.toString(16).padStart(2, '0')).join(':');
    this._log(`[rsba1/${this.name}] <- Capabilities (${radios.length} radio(s)); selected ${this.radioInfo.name || 'radio'} CIV=${civ} commoncap=0x${this.radioInfo.commoncap.toString(16)} rxMask=0x${this.radioInfo.rxSampleMask.toString(16)} txMask=0x${this.radioInfo.txSampleMask.toString(16)} mac=${mac}`);
    if (this.authStage === 'TOKEN_CONFIRM_SENT') {
      this._sendConnInfo();
    }
  }

  _sendConnInfo() {
    // RS-BA1 needs to know the client-side ports before it assigns the
    // matching radio-side stream ports in the Status reply.
    const innerSeq = this.innerSeq++;
    const txSupported = !this.radioInfo || this.radioInfo.txSampleMask > 1;
    this.txAudioNegotiated = this.enableTxAudio && txSupported;
    if (this.enableTxAudio && !txSupported) {
      this._log(`[rsba1/${this.name}] radio capabilities report no TX audio sample rates; requesting RX-only audio`);
    } else if (this.enableTxAudio) {
      this._log(`[rsba1/${this.name}] requesting TX audio codec=0x${this.txAudioCodec.toString(16)} sampleRate=${this.txAudioSampleRate} bufferMs=${this.txAudioBufferMs}`);
    }
    this._sendAuthPacket('CONNINFO_SENT', 'ConnInfo', (seq) => buildConnInfo(seq, this.myId, this.remoteId,
      innerSeq, this.tokRequest, this.token, this.username, this.devName, this.civLocalPort, this.audioLocalPort, {
        enableRx: this.enableRxAudio,
        enableTx: this.txAudioNegotiated,
        rxCodec: this.rxAudioCodec,
        rxSampleRate: this.rxAudioSampleRate,
        txCodec: this.txAudioCodec,
        txSampleRate: this.txAudioSampleRate,
        txBufferMs: this.txAudioBufferMs,
      }, this.radioInfo), { innerSeq });
  }

  _onStatus(msg) {
    this._clearAuthRetry();
    const error = msg.readUInt32LE(0x30);
    const civPort   = msg.readUInt16BE(0x42); // big-endian
    const audioPort = msg.readUInt16BE(0x46);
    this._log(`[rsba1/${this.name}] <- Status (error=0x${error.toString(16)} civPort=${civPort} audioPort=${audioPort})`);
    if (error === 0xffffffff) {
      this.emit('auth-failed', 'connection-rejected');
      return;
    }
    if (error !== 0 && civPort <= 0) {
      this.emit('error', makeRsba1Error(
        `rsba1 radio rejected stream request: status error=0x${(error >>> 0).toString(16)} with no CI-V port assigned`,
        'RSBA1_STATUS_REJECTED',
        { ...(this.owner ? this.owner._handshakeDiagnostics() : {}), statusError: error >>> 0, statusErrorHex: `0x${(error >>> 0).toString(16)}` }
      ));
      return;
    }
    if (civPort > 0) {
      this.authStage = 'AUTHED';
      this.connected = true;
      this._log(`[rsba1/${this.name}] stream request accepted; TX audio ${this.txAudioNegotiated ? 'enabled' : 'disabled'}`);
      this.emit('streams-ready', { civPort, audioPort, txAudioEnabled: this.txAudioNegotiated });
    }
  }

  _onConnInfoIn(msg) {
    // Inbound conninfo notifies us of other clients' state. We ignore for
    // Phase 1 — POTACAT just connects as a single client.
    this._log(`[rsba1/${this.name}] <- ConnInfo (ignored)`);
  }

  close() {
    this._clearAuthRetry();
    if (this.tokenTimer) { clearInterval(this.tokenTimer); this.tokenTimer = null; }
    this._sendTokenRemoval();
    super.close();
  }

  _sendTokenRemoval() {
    if (!this.socket || !this.gotIAmHere || !this.remoteId || !this.token) return;
    for (let i = 0; i < 2; i++) {
      const seq = this.seq & 0xffff;
      const innerSeq = this.innerSeq++ & 0xffff;
      const packet = buildToken(seq, this.myId, this.remoteId, innerSeq, this.tokRequest, this.token, 0x01);
      this.seq = (this.seq + 1) & 0xffff;
      this.txSeqBuf.set(seq, packet);
      while (this.txSeqBuf.size > TX_BUFFER_LIMIT) {
        const oldest = this.txSeqBuf.keys().next().value;
        this.txSeqBuf.delete(oldest);
      }
      this._log(`[rsba1/${this.name}] -> TokenRemoval seq=${seq} innerSeq=${innerSeq}`);
      this._sendOnSocket(this.socket, packet);
    }
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
    this.openTimer = null;
    this.dataStarted = false;
  }

  close() {
    this._stopOpenTimer();
    super.close();
  }

  _stopOpenTimer() {
    if (this.openTimer) {
      clearInterval(this.openTimer);
      this.openTimer = null;
    }
  }

  _sendOpenCloseStart() {
    this._sendTracked(buildOpenClose(0, this.myId, this.remoteId, false, 0x04, this.sendSeqB++));
  }

  _startOpenFlow() {
    this._sendOpenCloseStart();
    if (!this.openTimer) {
      this.openTimer = setInterval(() => this._sendOpenCloseStart(), 100);
    }
  }

  _onMessage(msg, rinfo) {
    this._learnRemoteEndpoint(rinfo);
    if (msg.length < 4) return;
    if (msg.length >= CONTROL_SIZE && this._handleRetransmitRequest(msg)) return;
    if (msg.length === CONTROL_SIZE) {
      const type = msg.readUInt16LE(4);
      const sentId = msg.readUInt32LE(8);
      if (type === TYPE_IAMHERE && !this.gotIAmHere) {
        this.gotIAmHere = true;
        this.remoteId = sentId;
        if (this.aytTimer) { clearInterval(this.aytTimer); this.aytTimer = null; }
        this._log(`[rsba1/${this.name}] <- IAmHere (remoteId=0x${this.remoteId.toString(16)})`);
        this.startKeepAlive();
        this._sendControl(TYPE_AYR_IAR, 1);
      } else if (type === TYPE_AYR_IAR) {
        this._log(`[rsba1/${this.name}] <- IAmReady — opening CI-V flow`);
        this.remoteId = sentId; // wfview re-saves remoteId here too
        this._startOpenFlow();
        if (!this.connected) {
          this.connected = true;
          this.emit('ready');
        }
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
      this.dataStarted = true;
      this._stopOpenTimer();
      this._log(`[rsba1/${this.name}] <- CI-V ${hex(civ)}`);
      this.emit('civ-data', civ);
    }
  }

  // Send raw CI-V bytes (already a complete CI-V frame) to the radio.
  sendCiv(buf) {
    if (!this.connected || !buf || !buf.length) return;
    this._log(`[rsba1/${this.name}] -> CI-V ${hex(buf)}`);
    this._sendTracked(buildCivData(0, this.myId, this.remoteId, this.sendSeqB++, buf));
  }
}

// ---------------------------------------------------------------------------
// AudioStream — handshakes on the audio port, emits decoded RX PCM, and can
// pace generated LPCM16 mono TX audio into the radio.
// ---------------------------------------------------------------------------
class AudioStream extends IcomUdpStream {
  constructor(opts) {
    super({ ...opts, name: 'audio' });
    this.rxCodec = opts.rxCodec || AUDIO_CODEC_LPCM16_MONO;
    this.rxSampleRate = opts.rxSampleRate || 48000;
    this.enableTxAudio = opts.enableTxAudio === true;
    this.txCodec = opts.txCodec || AUDIO_CODEC_LPCM16_MONO;
    this.txSampleRate = opts.txSampleRate || ICOM_AUDIO_TX_SAMPLE_RATE;
    this.txAudioBufferMs = opts.txAudioBufferMs || DEFAULT_TX_AUDIO_BUFFER_MS;
    this.sendSeqB = 0;
    this.txAudioSeq = 0;
    this.openTimer = null;
    this.dataStarted = false;
    this._txInFlight = null;
    this._txTimer = null;
    this._txDrainTimer = null;
    // Streaming voice TX state (for real-time phone-mic → RS-BA1 audio).
    // Separate from the batch _txInFlight path so both can be checked
    // independently for "TX already in flight" guards.
    this._voiceTxBuf = null;          // Float32Array ring buffer
    this._voiceTxWriteIdx = 0;
    this._voiceTxReadIdx = 0;
    this._voiceTxAvail = 0;           // samples available to read
    this._voiceTxActive = false;      // voice TX session running
    this._voiceTxPttHeld = false;     // PTT is still held; false → drain and stop
    this._voiceTxTimer = null;        // pacing setTimeout handle
    this._voiceTxStartMs = 0;         // wall-clock when session started
    this._voiceTxSamplesSent = 0;     // total samples sent (for pacing math)
    this._voiceTxPauseIdleOnStop = false; // resume idle keepalive after voice TX
    this.rxHighestSeq = null;
    this.rxMissing = new Map();
    this.rxRetransmitTimer = null;
    this.rxMissingTotal = 0;
    this.rxDuplicateTotal = 0;
    this.rxLargeGapTotal = 0;
    this.rxOlderSeqStreak = 0;
  }

  close() {
    this.cancelTx();
    this._stopOpenTimer();
    this._stopRxRetransmitTimer();
    super.close();
  }

  get txReady() {
    return this.connected && this.enableTxAudio &&
      (this.txCodec === AUDIO_CODEC_LPCM16_MONO || this.txCodec === AUDIO_CODEC_LPCM16_STEREO);
  }

  setTxEnabled(enabled) {
    this.enableTxAudio = enabled === true;
  }

  _stopOpenTimer() {
    if (this.openTimer) {
      clearInterval(this.openTimer);
      this.openTimer = null;
    }
  }

  _stopRxRetransmitTimer() {
    if (this.rxRetransmitTimer) {
      clearInterval(this.rxRetransmitTimer);
      this.rxRetransmitTimer = null;
    }
  }

  _startRxRetransmitTimer() {
    if (this.rxRetransmitTimer) return;
    this.rxRetransmitTimer = setInterval(() => this._sendRxRetransmitRequests(), RX_RETRANSMIT_PERIOD);
  }

  _sendOpenCloseStart() {
    this._sendTracked(buildOpenClose(0, this.myId, this.remoteId, false, 0x04, this.sendSeqB++));
  }

  _startOpenFlow() {
    this._sendOpenCloseStart();
    if (!this.openTimer) {
      this.openTimer = setInterval(() => this._sendOpenCloseStart(), 100);
    }
    this._startRxRetransmitTimer();
  }

  _seqDistance(from, to) {
    return ((to - from + 0x10000) & 0xffff);
  }

  _trackRxAudioPacket(seq) {
    const packetSeq = Number(seq) & 0xffff;
    const info = {
      seq: packetSeq,
      duplicate: false,
      missingAdded: 0,
      missingRecovered: false,
      largeGap: false,
      pendingMissing: this.rxMissing.size,
      missingTotal: this.rxMissingTotal,
      duplicateTotal: this.rxDuplicateTotal,
      largeGapTotal: this.rxLargeGapTotal,
    };

    if (this.rxMissing.has(packetSeq)) {
      this.rxMissing.delete(packetSeq);
      info.missingRecovered = true;
      this.rxOlderSeqStreak = 0;
      info.pendingMissing = this.rxMissing.size;
      info.missingTotal = this.rxMissingTotal;
      info.duplicateTotal = this.rxDuplicateTotal;
      info.largeGapTotal = this.rxLargeGapTotal;
      return info;
    }

    if (this.rxHighestSeq == null) {
      this.rxHighestSeq = packetSeq;
      this.rxOlderSeqStreak = 0;
      info.pendingMissing = this.rxMissing.size;
      return info;
    }

    const forward = this._seqDistance(this.rxHighestSeq, packetSeq);
    if (forward === 0) {
      info.duplicate = true;
      this.rxDuplicateTotal++;
      this.rxOlderSeqStreak = 0;
    } else if (forward < 0x8000) {
      this.rxOlderSeqStreak = 0;
      if (forward > RX_MISSING_LIMIT) {
        info.largeGap = true;
        this.rxLargeGapTotal++;
        this.rxMissing.clear();
      } else if (forward > 1) {
        for (let i = 1; i < forward; i++) {
          const missingSeq = (this.rxHighestSeq + i) & 0xffff;
          if (!this.rxMissing.has(missingSeq)) {
            this.rxMissing.set(missingSeq, 0);
            info.missingAdded++;
            this.rxMissingTotal++;
          }
        }
      }
      this.rxHighestSeq = packetSeq;
    } else {
      // Older packet outside the pending-missing map. It may be a late
      // retransmission after we gave up; count it as a duplicate/late arrival.
      // If this happens repeatedly immediately after connect/reopen, the
      // radio likely started us near a wrapped/stale sequence. Resync rather
      // than poisoning diagnostics and retransmit tracking for the whole run.
      info.duplicate = true;
      this.rxDuplicateTotal++;
      this.rxOlderSeqStreak++;
      if (this.rxOlderSeqStreak >= 4) {
        info.duplicate = false;
        this.rxDuplicateTotal = Math.max(0, this.rxDuplicateTotal - 1);
        info.largeGap = true;
        this.rxLargeGapTotal++;
        this.rxHighestSeq = packetSeq;
        this.rxMissing.clear();
        this.rxOlderSeqStreak = 0;
      }
    }

    if (this.rxMissing.size > RX_MISSING_LIMIT) {
      info.largeGap = true;
      this.rxLargeGapTotal++;
      this.rxMissing.clear();
    }

    info.pendingMissing = this.rxMissing.size;
    info.missingTotal = this.rxMissingTotal;
    info.duplicateTotal = this.rxDuplicateTotal;
    info.largeGapTotal = this.rxLargeGapTotal;
    return info;
  }

  _sendRxRetransmitRequests() {
    if (!this.connected || !this.socket || !this.rxMissing.size) return;
    const requestSeqs = [];
    for (const [seq, attempts] of this.rxMissing) {
      if (attempts >= RX_RETRANSMIT_MAX_ATTEMPTS) {
        this._log(`[rsba1/${this.name}] no response for missing RX packet seq=${seq}; giving up`);
        this.rxMissing.delete(seq);
        continue;
      }
      requestSeqs.push(seq);
      this.rxMissing.set(seq, attempts + 1);
      if (requestSeqs.length >= 12) break;
    }
    if (!requestSeqs.length) return;
    if (requestSeqs.length === 1) {
      this._log(`[rsba1/${this.name}] requesting missing RX packet seq=${requestSeqs[0]}`);
      this._send(buildControl(TYPE_RETRANSMIT_REQUEST, requestSeqs[0], this.myId, this.remoteId));
    } else {
      this._log(`[rsba1/${this.name}] requesting ${requestSeqs.length} missing RX packet(s): ${requestSeqs.join(',')}`);
      this._send(buildRetransmitRange(0, this.myId, this.remoteId, requestSeqs));
    }
  }

  restartAudioFlow(reason = 'audio stall') {
    if (!this.socket) return false;
    this._log(`[rsba1/${this.name}] restarting audio flow: ${reason}`);
    this.cancelTx();
    this._stopOpenTimer();
    this._stopRxRetransmitTimer();
    this._stopTimers();
    this.connected = false;
    this.gotIAmHere = false;
    this.dataStarted = false;
    this.rxHighestSeq = null;
    this.rxMissing.clear();
    this.rxOlderSeqStreak = 0;
    this.startHandshake();
    return true;
  }

  _onMessage(msg, rinfo) {
    this._learnRemoteEndpoint(rinfo);
    if (msg.length < 4) return;
    if (msg.length >= CONTROL_SIZE && this._handleRetransmitRequest(msg)) return;
    if (msg.length === CONTROL_SIZE) {
      const type = msg.readUInt16LE(4);
      const sentId = msg.readUInt32LE(8);
      if (type === TYPE_IAMHERE && !this.gotIAmHere) {
        this.gotIAmHere = true;
        this.remoteId = sentId;
        if (this.aytTimer) { clearInterval(this.aytTimer); this.aytTimer = null; }
        this._log(`[rsba1/${this.name}] <- IAmHere (remoteId=0x${this.remoteId.toString(16)})`);
        this.startKeepAlive();
        this._sendControl(TYPE_AYR_IAR, 1);
      } else if (type === TYPE_AYR_IAR) {
        this.remoteId = sentId;
        this._log(`[rsba1/${this.name}] <- IAmReady — opening audio stream${this.enableTxAudio ? ' (RX/TX)' : ' (RX)'}`);
        this._startOpenFlow();
        if (!this.connected) {
          this.connected = true;
          this.emit('ready');
        }
      } else {
        this._log(`[rsba1/${this.name}] <- control type 0x${type.toString(16)}`);
      }
      return;
    }
    if (msg.length === PING_SIZE) {
      const type = msg.readUInt16LE(4);
      const reply = msg.readUInt8(0x10);
      if (type === TYPE_PING && reply === 0) {
        const seq = msg.readUInt16LE(6);
        const time = msg.readUInt32LE(0x11);
        this._send(buildPing(seq, this.myId, this.remoteId, time, true));
      }
      return;
    }
    if (msg.length <= AUDIO_HEADER_SIZE) return;
    const innerType = msg.readUInt16LE(0x04);
    if (innerType === 0x01) return; // retransmit request, ignore for now
    const declaredLen = msg.readUInt32LE(0x00);
    if (declaredLen && declaredLen > msg.length) {
      this._log(`[rsba1/${this.name}] <- truncated audio packet`);
      return;
    }
    const datalen = msg.readUInt16BE(0x16);
    const end = AUDIO_HEADER_SIZE + datalen;
    if (end > msg.length) {
      this._log(`[rsba1/${this.name}] <- truncated audio payload`);
      return;
    }
    const packetSeq = msg.readUInt16LE(0x06);
    const ident = msg.readUInt16LE(0x10);
    const audioSeq = msg.readUInt16BE(0x12);
    const rxTrack = this._trackRxAudioPacket(packetSeq);
    const payload = msg.slice(AUDIO_HEADER_SIZE, end);
    if (this.rxCodec !== AUDIO_CODEC_LPCM16_MONO) {
      this._log(`[rsba1/${this.name}] <- unsupported RX audio codec 0x${this.rxCodec.toString(16)}`);
      return;
    }
    if (payload.length < 2) return;
    this.dataStarted = true;
    this._stopOpenTimer();
    this.emit('audio-frame', {
      pcm: decodeLpcm16Mono(payload),
      sampleRate: this.rxSampleRate,
      packetSeq,
      audioSeq,
      ident,
      payloadBytes: payload.length,
      recvMs: Date.now(),
      rxTrack,
    });
  }

  sendTxAudio(samples, offsetMs = 0, inputSampleRate = 12000) {
    let tailSilenceMs = TX_TAIL_SILENCE_MS;
    let startDelayMs = TX_SLOT_AUDIO_START_MS;
    if (offsetMs && typeof offsetMs === 'object') {
      const opts = offsetMs;
      offsetMs = opts.offsetMs || 0;
      inputSampleRate = opts.inputSampleRate || opts.sampleRate || inputSampleRate;
      if (opts.tailSilenceMs != null) tailSilenceMs = opts.tailSilenceMs;
      if (opts.startDelayMs != null) startDelayMs = opts.startDelayMs;
    }
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.socket) {
        return reject(new Error('RS-BA1 audio stream is not connected'));
      }
      if (!this.enableTxAudio) {
        return reject(new Error('RS-BA1 TX audio was not negotiated with the radio'));
      }
      if (this.txCodec !== AUDIO_CODEC_LPCM16_MONO && this.txCodec !== AUDIO_CODEC_LPCM16_STEREO) {
        return reject(new Error(`RS-BA1 TX codec 0x${this.txCodec.toString(16)} is not supported by this build`));
      }
      if (this._txInFlight) {
        return reject(new Error('RS-BA1 TX audio already in flight'));
      }
      if (this._voiceTxActive) {
        return reject(new Error('RS-BA1 voice TX is active — stop voice TX before sending batch audio'));
      }
      const src = coerceFloat32(samples);
      if (!src.length) {
        return reject(new Error('samples must be a non-empty Float32Array'));
      }
      const txRate = this.txSampleRate || ICOM_AUDIO_TX_SAMPLE_RATE;
      const negotiatedBufferMs = Math.max(0, Number(this.txAudioBufferMs) || DEFAULT_TX_AUDIO_BUFFER_MS);
      const paceLeadMs = Math.max(0, Math.min(TX_MAX_PACE_LEAD_MS, negotiatedBufferMs - TX_BUFFER_SAFETY_MS));
      const resampled = resampleMonoFloat32(src, inputSampleRate || txRate, txRate);
      const leadSamples = Math.max(0, Math.round((clampStartDelayMs(startDelayMs) - (Number(offsetMs) || 0)) / 1000 * txRate));
      const tailSamples = Math.max(0, Math.round(clampTailSilenceMs(tailSilenceMs) / 1000 * txRate));
      let txPcm = resampled;
      if (leadSamples > 0 || tailSamples > 0) {
        txPcm = new Float32Array(leadSamples + resampled.length + tailSamples);
        txPcm.set(resampled, leadSamples);
      }
      const srcStats = analyzePcmFloat32(src);
      const resampledStats = analyzePcmFloat32(resampled);
      const txChannels = lpcm16ChannelCount(this.txCodec);
      const payload = txChannels === 2 ? encodeLpcm16DuplicatedStereo(txPcm) : encodeLpcm16Mono(txPcm);
      const bytesPerAudioFrame = 2 * txChannels;
      const frameBytes = Math.max(bytesPerAudioFrame, Math.round(txRate * AUDIO_FRAME_PERIOD_MS / 1000) * bytesPerAudioFrame);
      const totalFrames = Math.ceil(payload.length / frameBytes);
      let totalPackets = 0;
      for (let pos = 0; pos < payload.length; pos += frameBytes) {
        totalPackets += Math.ceil(Math.min(frameBytes, payload.length - pos) / AUDIO_TX_MAX_PAYLOAD);
      }
      this._log(`[rsba1/${this.name}] TX audio start: ${src.length} samples @${inputSampleRate || txRate} Hz -> ${txPcm.length} samples @${txRate} Hz, ${totalFrames} frame(s) @${AUDIO_FRAME_PERIOD_MS}ms split into ${totalPackets} UDP audio packet(s), lead=${leadSamples}, tail=${tailSamples}, startDelay=${clampStartDelayMs(startDelayMs)}ms, buffer=${negotiatedBufferMs}ms, paceLead=${paceLeadMs}ms, srcPeak=${srcStats.peak.toFixed(4)} srcRms=${srcStats.rms.toFixed(4)} srcNonZero=${srcStats.nonZero}, txPeak=${resampledStats.peak.toFixed(4)} txRms=${resampledStats.rms.toFixed(4)} txNonZero=${resampledStats.nonZero}`);
      const pausedIdleTimer = this.idleTimer;
      if (pausedIdleTimer) {
        clearInterval(pausedIdleTimer);
        this.idleTimer = null;
        this._log(`[rsba1/${this.name}] pausing idle keepalive during TX audio`);
      }
      const audioMs = txPcm.length / txRate * 1000;
      this._txInFlight = {
        payload,
        bytePos: 0,
        samplesSent: 0,
        framesSent: 0,
        packetsSent: 0,
        totalFrames,
        totalPackets,
        frameBytes,
        bytesPerAudioFrame,
        txChannels,
        sampleRate: txRate,
        paceLeadMs,
        startMs: Date.now(),
        lastPumpMs: Date.now(),
        maxPumpGapMs: 0,
        drainTimer: null,
        hardTimer: null,
        resumeIdleAfterTx: !!pausedIdleTimer,
        resolve,
        reject,
      };
      this._txInFlight.hardTimer = setTimeout(() => {
        const q = this._txInFlight;
        if (!q) return;
        this._txInFlight = null;
        if (this._txTimer) {
          clearTimeout(this._txTimer);
          this._txTimer = null;
        }
        if (this._txDrainTimer) {
          clearTimeout(this._txDrainTimer);
          this._txDrainTimer = null;
        }
        this._log(`[rsba1/${this.name}] TX audio watchdog fired at frame ${q.framesSent}/${q.totalFrames}, packet ${q.packetsSent}/${q.totalPackets}`);
        this._resumeIdleAfterTx(q);
        try { q.reject(new Error('RS-BA1 TX audio watchdog timeout')); } catch { /* ignore */ }
      }, Math.max(5000, Math.ceil(audioMs + paceLeadMs + 3000)));
      this._pumpTxAudio();
    });
  }

  cancelTx() {
    if (this._txTimer) {
      clearTimeout(this._txTimer);
      this._txTimer = null;
    }
    if (this._txDrainTimer) {
      clearTimeout(this._txDrainTimer);
      this._txDrainTimer = null;
    }
    if (this._txInFlight) {
      const q = this._txInFlight;
      if (q.drainTimer) {
        clearTimeout(q.drainTimer);
        q.drainTimer = null;
      }
      if (q.hardTimer) {
        clearTimeout(q.hardTimer);
        q.hardTimer = null;
      }
      this._txInFlight = null;
      this._log(`[rsba1/${this.name}] TX audio cancelled at frame ${q.framesSent}/${q.totalFrames}, packet ${q.packetsSent}/${q.totalPackets}`);
      this._resumeIdleAfterTx(q);
      try { q.reject(new Error('TX cancelled')); } catch { /* ignore */ }
    }
    // Also cancel any in-progress voice TX (e.g. operator switch during phone voice TX).
    this._stopVoiceTx('cancelled');
  }

  _resumeIdleAfterTx(q) {
    if (!q || !q.resumeIdleAfterTx || this.idleTimer || !this.socket || !this.gotIAmHere) return;
    this.idleTimer = setInterval(() => this._sendIdle(), IDLE_PERIOD);
    this._log(`[rsba1/${this.name}] resumed idle keepalive after TX audio`);
  }

  // ---------------------------------------------------------------------------
  // Streaming voice TX — for real-time phone-mic audio over ECHOCAT.
  // Unlike sendTxAudio() (which takes a pre-rendered buffer), this path keeps
  // a ring buffer that main.js fills with IPC chunks from the phone's mic
  // WorkLet while PTT is held.  The same pacing model as batch TX applies:
  // frames are sent up to paceLeadMs ms ahead of real-time so the radio's
  // internal TX buffer never runs empty.
  // ---------------------------------------------------------------------------

  /**
   * Start a streaming voice TX session.  Must be called before pushVoiceChunk().
   * Throws synchronously if TX is not ready or another TX is already in flight.
   */
  startVoiceTx() {
    if (!this.connected || !this.socket) throw new Error('RS-BA1 audio stream not connected');
    if (!this.enableTxAudio)              throw new Error('RS-BA1 TX audio was not negotiated');
    if (this._txInFlight)                 throw new Error('RS-BA1 batch TX is in flight');
    if (this._voiceTxActive)              throw new Error('RS-BA1 voice TX already active');

    // Pause idle keepalive for the duration of TX.
    const hadIdle = !!this.idleTimer;
    if (hadIdle) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
      this._log(`[rsba1/${this.name}] pausing idle keepalive during voice TX`);
    }

    this._voiceTxBuf    = new Float32Array(VOICE_TX_RING_SAMPLES);
    this._voiceTxWriteIdx  = 0;
    this._voiceTxReadIdx   = 0;
    this._voiceTxAvail     = 0;
    this._voiceTxActive    = true;
    this._voiceTxPttHeld   = true;
    this._voiceTxStartMs   = Date.now();
    this._voiceTxSamplesSent = 0;
    this._voiceTxPauseIdleOnStop = hadIdle;

    const txRate = this.txSampleRate || ICOM_AUDIO_TX_SAMPLE_RATE;
    this._log(`[rsba1/${this.name}] voice TX start — streaming at ${txRate} Hz, ${VOICE_TX_FRAME_SAMPLES} samples/frame (${VOICE_TX_FRAME_SAMPLES / txRate * 1000} ms)`);

    this._voiceTxPump();
  }

  /**
   * Append samples to the voice TX ring buffer.  Silently dropped if voice TX
   * is not active or if the ring buffer overflows (oldest samples discarded).
   * @param {Float32Array} samples — 48 kHz mono float32 mic audio
   */
  pushVoiceChunk(samples) {
    if (!this._voiceTxActive || !this._voiceTxBuf) return;
    const buf    = this._voiceTxBuf;
    const bufLen = buf.length;
    const len    = samples.length;
    for (let i = 0; i < len; i++) {
      buf[this._voiceTxWriteIdx] = samples[i];
      this._voiceTxWriteIdx = (this._voiceTxWriteIdx + 1) % bufLen;
      if (this._voiceTxAvail < bufLen) {
        this._voiceTxAvail++;
      } else {
        // Overflow — advance read pointer, discard oldest sample.
        this._voiceTxReadIdx = (this._voiceTxReadIdx + 1) % bufLen;
      }
    }
  }

  /**
   * Signal that the phone's PTT has been released.  The pump will drain any
   * remaining buffered audio then stop and resume the idle keepalive.
   */
  stopVoiceTx() {
    if (!this._voiceTxActive) return;
    this._voiceTxPttHeld = false;
    this._log(`[rsba1/${this.name}] voice TX PTT released — draining ${this._voiceTxAvail} remaining samples`);
    // Pump notices _voiceTxPttHeld===false and stops when buffer empty.
  }

  /** Internal: pacing pump for voice TX. Mirrors _pumpTxAudio() cadence. */
  _voiceTxPump() {
    if (!this._voiceTxActive) return;
    if (!this.connected || !this.socket) {
      this._stopVoiceTx('disconnected');
      return;
    }

    const txRate   = this.txSampleRate || ICOM_AUDIO_TX_SAMPLE_RATE;
    const txCh     = lpcm16ChannelCount(this.txCodec);
    const negotiatedBufferMs = Math.max(0, Number(this.txAudioBufferMs) || DEFAULT_TX_AUDIO_BUFFER_MS);
    const paceLeadMs = Math.max(0, Math.min(TX_MAX_PACE_LEAD_MS, negotiatedBufferMs - TX_BUFFER_SAFETY_MS));

    // Send as many frames as the pacing window allows.
    while (true) {
      const scheduledMs = this._voiceTxSamplesSent / txRate * 1000;
      const elapsedMs   = Date.now() - this._voiceTxStartMs;
      if (scheduledMs > elapsedMs + paceLeadMs) break; // ahead of real-time

      if (this._voiceTxAvail < VOICE_TX_FRAME_SAMPLES) {
        // Buffer underrun.
        if (!this._voiceTxPttHeld) {
          // PTT released and buffer drained — done.
          this._log(`[rsba1/${this.name}] voice TX drain complete (${this._voiceTxSamplesSent} samples sent)`);
          this._stopVoiceTx('done');
          return;
        }
        // Still holding PTT; send a silence frame to keep the radio's
        // TX buffer from starving during brief IPC jitter.
        const silence = new Float32Array(VOICE_TX_FRAME_SAMPLES);
        this._sendVoiceFrame(silence, txCh);
        this._voiceTxSamplesSent += VOICE_TX_FRAME_SAMPLES;
        continue;
      }

      // Dequeue one frame from the ring buffer.
      const frame  = new Float32Array(VOICE_TX_FRAME_SAMPLES);
      const buf    = this._voiceTxBuf;
      const bufLen = buf.length;
      for (let i = 0; i < VOICE_TX_FRAME_SAMPLES; i++) {
        frame[i] = buf[this._voiceTxReadIdx];
        this._voiceTxReadIdx = (this._voiceTxReadIdx + 1) % bufLen;
      }
      this._voiceTxAvail -= VOICE_TX_FRAME_SAMPLES;
      this._sendVoiceFrame(frame, txCh);
      this._voiceTxSamplesSent += VOICE_TX_FRAME_SAMPLES;
    }

    // Schedule next pump tick to fire when the next frame is due.
    const scheduledMs  = this._voiceTxSamplesSent / txRate * 1000;
    const sleepMs      = Math.max(1, scheduledMs - (Date.now() - this._voiceTxStartMs) - paceLeadMs);
    this._voiceTxTimer = setTimeout(() => this._voiceTxPump(), sleepMs);
  }

  /** Encode + send one voice frame (Float32 mono → LPCM16, split into UDP chunks). */
  _sendVoiceFrame(frame, txChannels) {
    const payload = txChannels === 2
      ? encodeLpcm16DuplicatedStereo(frame)
      : encodeLpcm16Mono(frame);
    let bytePos = 0;
    while (bytePos < payload.length) {
      const len     = Math.min(AUDIO_TX_MAX_PAYLOAD, payload.length - bytePos);
      const chunk   = payload.slice(bytePos, bytePos + len);
      const audioSeq = this.txAudioSeq & 0xffff;
      this.txAudioSeq = (this.txAudioSeq + 1) & 0xffff;
      this._sendTracked(buildAudioData(0, this.myId, this.remoteId, audioSeq, chunk));
      bytePos += len;
    }
  }

  /** Internal: tear down the voice TX session unconditionally. */
  _stopVoiceTx(reason = 'stop') {
    if (!this._voiceTxActive) return;
    this._voiceTxActive   = false;
    this._voiceTxPttHeld  = false;
    if (this._voiceTxTimer) {
      clearTimeout(this._voiceTxTimer);
      this._voiceTxTimer = null;
    }
    const secSent = (this._voiceTxSamplesSent / (this.txSampleRate || ICOM_AUDIO_TX_SAMPLE_RATE)).toFixed(2);
    this._log(`[rsba1/${this.name}] voice TX stopped (${reason}) — ${this._voiceTxSamplesSent} samples / ${secSent}s sent`);
    this._voiceTxBuf   = null;
    const hadIdle      = this._voiceTxPauseIdleOnStop;
    this._voiceTxPauseIdleOnStop = false;
    if (hadIdle) this._resumeIdleAfterTx({ resumeIdleAfterTx: true });
  }

  _sendTxAudioFrame(q) {
    const frameStart = q.bytePos;
    const frameEnd = Math.min(q.payload.length, frameStart + q.frameBytes);

    while (q.bytePos < frameEnd) {
      const len = Math.min(AUDIO_TX_MAX_PAYLOAD, frameEnd - q.bytePos);
      const chunk = q.payload.slice(q.bytePos, q.bytePos + len);
      const audioSeq = this.txAudioSeq & 0xffff;
      this.txAudioSeq = (this.txAudioSeq + 1) & 0xffff;
      this._sendTracked(buildAudioData(0, this.myId, this.remoteId, audioSeq, chunk));
      q.bytePos += len;
      q.packetsSent++;
    }

    q.samplesSent += (frameEnd - frameStart) / q.bytesPerAudioFrame;
    q.framesSent++;
  }

  _pumpTxAudio() {
    const q = this._txInFlight;
    if (!q) return;
    if (!this.connected || !this.socket) {
      this._txInFlight = null;
      if (q.hardTimer) {
        clearTimeout(q.hardTimer);
        q.hardTimer = null;
      }
      try { q.reject(new Error('RS-BA1 audio disconnected mid-TX')); } catch { /* ignore */ }
      return;
    }

    let framesThisTick = 0;
    const now = Date.now();
    if (q.lastPumpMs) q.maxPumpGapMs = Math.max(q.maxPumpGapMs || 0, now - q.lastPumpMs);
    q.lastPumpMs = now;

    while (q.bytePos < q.payload.length) {
      const scheduledMs = q.samplesSent / q.sampleRate * 1000;
      const elapsedMs = Date.now() - q.startMs;
      if (framesThisTick >= MAX_TX_FRAMES_PER_PUMP) break;
      if (q.framesSent > 0 && scheduledMs > elapsedMs + q.paceLeadMs) break;

      // wfview gathers one AUDIO_PERIOD-sized audio block, then splits that
      // block into 1364-byte UDP chunks immediately. Keep the 20ms cadence at
      // the frame level rather than spacing individual UDP chunks apart.
      this._sendTxAudioFrame(q);
      framesThisTick++;
    }

    if (q.bytePos >= q.payload.length) {
      const elapsed = Date.now() - q.startMs;
      const audioMs = q.samplesSent / q.sampleRate * 1000;
      const drainMs = Math.max(0, Math.round(audioMs - elapsed));
      this._log(`[rsba1/${this.name}] TX audio queued ${q.framesSent} frame(s), ${q.packetsSent} packet(s) in ${elapsed} ms; drain=${drainMs}ms maxPumpGap=${Math.round(q.maxPumpGapMs || 0)}ms`);
      this._txTimer = null;
      this._txDrainTimer = q.drainTimer = setTimeout(() => {
        if (this._txInFlight !== q) return;
        this._txInFlight = null;
        this._txDrainTimer = null;
        if (q.hardTimer) {
          clearTimeout(q.hardTimer);
          q.hardTimer = null;
        }
        q.drainTimer = null;
        this._resumeIdleAfterTx(q);
        try { q.resolve(); } catch { /* ignore */ }
      }, drainMs);
      return;
    }

    const nextScheduledMs = q.samplesSent / q.sampleRate * 1000;
    const sleepMs = Math.max(0, nextScheduledMs - (Date.now() - q.startMs) - q.paceLeadMs);
    this._txTimer = setTimeout(() => this._pumpTxAudio(), sleepMs);
  }
}

// ---------------------------------------------------------------------------
// RsBa1Transport — public class. Same API surface as SerialTransport:
//   .connect({ host, controlPort, civPort, username, password })
//   .disconnect()
//   .write(buf)        — feed CI-V bytes; routed to civ stream
//   .setPin(...)       — no-op (UDP transport has no DTR/RTS)
//   events: 'connect', 'data' (CI-V bytes), 'audio-frame', 'close', 'error',
//           'log'
// ---------------------------------------------------------------------------
class RsBa1Transport extends EventEmitter {
  constructor() {
    super();
    this.control = null;
    this.civ = null;
    this.audio = null;
    this._target = null;
    this._connected = false;
    this._handshakeDeadline = null;
    this._connectToken = 0;
    this._handshakeStage = 'idle';
    this._civFallbackTimer = null;
    this._assignedCivPort = null;
    this._triedCivFallback = false;
  }

  get connected()      { return this._connected; }
  get isOpen()         { return this._connected; }
  get txReady()        { return !!(this.audio && this.audio.txReady); }
  get voiceTxActive()  { return !!(this.audio && this.audio._voiceTxActive); }

  /** Start streaming voice TX.  Throws if TX not ready or another TX in flight. */
  startVoiceTx() {
    if (!this.audio) throw new Error('RS-BA1 audio stream not connected');
    this.audio.startVoiceTx();
  }
  /** Push Float32 mic samples into the voice TX ring buffer. */
  pushVoiceChunk(samples) {
    if (this.audio) this.audio.pushVoiceChunk(samples);
  }
  /** Release voice TX PTT — pump drains remaining buffer then stops. */
  stopVoiceTx() {
    if (this.audio) this.audio.stopVoiceTx();
  }

  connect({ host, controlPort = 50001, civPort, username = '', password = '', compName = 'POTACAT', enableRxAudio = false, enableTxAudio = false, rxAudioCodec = AUDIO_CODEC_LPCM16_MONO, rxAudioSampleRate = 48000, txAudioCodec = AUDIO_CODEC_LPCM16_MONO, txAudioSampleRate = ICOM_AUDIO_TX_SAMPLE_RATE, txAudioBufferMs = DEFAULT_TX_AUDIO_BUFFER_MS, controlAuthMode = 'direct', timeoutMs = HANDSHAKE_TIMEOUT } = {}) {
    if (!host) {
      this.emit('error', new Error('rsba1: host is required'));
      return;
    }
    this.disconnect();
    const connectToken = ++this._connectToken;
    const rawHost = String(host || '').trim();
    this._target = {
      host: rawHost,
      resolvedHost: null,
      controlPort,
      civPort: civPort || null,
      username,
      password,
      compName,
      enableRxAudio: enableRxAudio === true,
      enableTxAudio: enableTxAudio === true,
      rxAudioCodec,
      rxAudioSampleRate,
      txAudioCodec,
      txAudioSampleRate,
      txAudioBufferMs,
      controlAuthMode,
      timeoutMs,
      civLocalPort: 0,
      audioLocalPort: 0,
      localAddress: null,
    };
    const log = (msg) => this.emit('log', msg);

    this._handshakeStage = 'resolving-host';
    this._startHandshakeWatchdog(timeoutMs);

    dns.lookup(rawHost, { family: 4 })
      .then(async ({ address, family }) => {
        if (connectToken !== this._connectToken) return;
        const targetHost = address || rawHost;
        this._target.resolvedHost = targetHost;
        log(`[rsba1] resolved ${rawHost} -> ${targetHost} (IPv${family || 4})`);
        const displayHost = rawHost === targetHost ? targetHost : `${rawHost} (${targetHost})`;
        const localSelection = await findLocalAddressForTarget(targetHost, controlPort);
        if (connectToken !== this._connectToken) return;
        const localAddress = localSelection && localSelection.address ? localSelection.address : null;
        this._target.localAddress = localAddress;
        if (localAddress) {
          const source = localSelection.source === 'same-subnet' ? 'same-subnet' : 'routed';
          const iface = localSelection.interfaceName ? ` on ${localSelection.interfaceName}` : '';
          const routed = localSelection.routedAddress && localSelection.routedAddress !== localAddress
            ? ` (OS route was ${localSelection.routedAddress})`
            : '';
          log(`[rsba1] using ${source} local IPv4 ${localAddress}${iface} for wfview-style stream IDs${routed}`);
        } else {
          log('[rsba1] could not determine routed local IPv4; using OS default UDP bind');
        }
        try {
          this._handshakeStage = 'opening-data-streams';
          this._prepareCivStream(targetHost, displayHost, localAddress, log);
          await this.civ.open();
          this._target.civLocalPort = this.civ.localPort;
          if (this._target.enableRxAudio || this._target.enableTxAudio) {
            this._prepareAudioStream(targetHost, displayHost, 0, localAddress, log);
            await this.audio.open();
            this._target.audioLocalPort = this.audio.localPort;
          }
        } catch (err) {
          if (connectToken !== this._connectToken) return;
          this.emit('error', makeRsba1Error(`rsba1 could not open local UDP stream sockets: ${err.message || err}`, 'RSBA1_LOCAL_PORT_FAILED', this._handshakeDiagnostics()));
          this.disconnect();
          return;
        }
        if (connectToken !== this._connectToken) return;
        log(`[rsba1] opened client stream ports: civ=${this._target.civLocalPort} audio=${this._target.audioLocalPort || 0}`);
        this._handshakeStage = 'opening-control';

        this.control = new ControlStream({
          host: targetHost,
          displayHost,
          port: controlPort,
          localAddress,
          deriveStreamId: false,
          trackedIdle: controlAuthMode === 'tracked',
          authMode: controlAuthMode,
          username,
          password,
          compName,
          owner: this,
          log,
          enableRxAudio,
          enableTxAudio,
          rxAudioCodec,
          rxAudioSampleRate,
          txAudioCodec,
          txAudioSampleRate,
          txAudioBufferMs,
          civLocalPort: this._target.civLocalPort,
          audioLocalPort: this._target.audioLocalPort,
        });

        this.control.on('error', (e) => this.emit('error', e));
        this.control.on('auth-failed', (reason) => {
          this.emit('error', makeRsba1Error(`rsba1 authentication failed: ${reason}`, 'RSBA1_AUTH_FAILED', {
            reason,
            ...this._handshakeDiagnostics(),
          }));
          this.disconnect();
        });
        this.control.on('streams-ready', ({ civPort: assignedCivPort, audioPort: assignedAudioPort, txAudioEnabled }) => {
          if (connectToken !== this._connectToken) return;
          this._target.enableTxAudio = txAudioEnabled === true;
          if (this.audio) this.audio.setTxEnabled(this._target.enableTxAudio);
          if (enableTxAudio && !this._target.enableTxAudio) {
            log('[rsba1/audio] TX audio requested but not negotiated; direct TX audio will be unavailable');
          }
          // Open civ stream on the port the radio assigned (or the override).
          const targetCivPort = this._target.civPort || assignedCivPort || (controlPort + 1);
          this._startCivStream(targetCivPort, assignedCivPort || null);
          if (this._target.enableRxAudio || this._target.enableTxAudio) {
            const targetAudioPort = assignedAudioPort || 0;
            if (targetAudioPort > 0) {
              this._startAudioStream(targetAudioPort);
            } else {
              log('[rsba1/audio] radio did not advertise an audio port; waiting to learn it from inbound audio packets');
              this._startAudioStream(0);
            }
          }
        });

        this.control.open()
          .then(() => {
            if (connectToken !== this._connectToken || !this.control) return;
            this._handshakeStage = 'waiting-control-IAmHere';
            this.control.startHandshake();
          })
          .catch((err) => this.emit('error', err));
      })
      .catch((err) => {
        if (connectToken !== this._connectToken) return;
        this.emit('error', makeRsba1Error(`rsba1 could not resolve host "${rawHost}" to an IPv4 address: ${err.message || err}`, 'RSBA1_DNS_FAILED', {
          host: rawHost,
          controlPort,
        }));
        this.disconnect();
      });
  }

  _prepareCivStream(host, displayHost, localAddress, log) {
    if (this.civ) return;
    this.civ = new CivStream({ host, displayHost, port: 0, localAddress, log });
    this.civ.on('error', (e) => this.emit('error', e));
    this.civ.on('ready', () => {
      this._connected = true;
      if (this._civFallbackTimer) {
        clearTimeout(this._civFallbackTimer);
        this._civFallbackTimer = null;
      }
      if (this._handshakeDeadline) {
        clearTimeout(this._handshakeDeadline);
        this._handshakeDeadline = null;
      }
      this.emit('connect');
    });
    this.civ.on('civ-data', (civBuf) => {
      this.emit('data', civBuf);
    });
  }

  _startCivStream(port, assignedPort = null) {
    if (!this.civ) {
      this.emit('error', makeRsba1Error('rsba1 CI-V stream was not prepared before stream start', 'RSBA1_CIV_NOT_PREPARED', this._handshakeDiagnostics()));
      return;
    }
    if (this._civFallbackTimer) {
      clearTimeout(this._civFallbackTimer);
      this._civFallbackTimer = null;
    }
    this._assignedCivPort = assignedPort || port;
    this._triedCivFallback = false;
    this.civ.port = port;
    this._handshakeStage = 'waiting-civ-IAmHere';
    this.civ.startHandshake();
    this._scheduleCivFallback();
  }

  _prepareAudioStream(host, displayHost, port, localAddress, log) {
    if (this.audio) return;
    this.audio = new AudioStream({
      host,
      displayHost,
      port,
      localAddress,
      log,
      rxCodec: this._target.rxAudioCodec,
      rxSampleRate: this._target.rxAudioSampleRate,
      enableTxAudio: this._target.enableTxAudio,
      txCodec: this._target.txAudioCodec,
      txSampleRate: this._target.txAudioSampleRate,
      txAudioBufferMs: this._target.txAudioBufferMs,
    });
    this.audio.on('error', (e) => this.emit('error', e));
    this.audio.on('ready', () => this.emit('audio-ready'));
    this.audio.on('audio-frame', (frame) => this.emit('audio-frame', frame));
  }

  _startAudioStream(port) {
    if (!this.audio) {
      this.emit('error', makeRsba1Error('rsba1 audio stream was not prepared before stream start', 'RSBA1_AUDIO_NOT_PREPARED', this._handshakeDiagnostics()));
      return;
    }
    this.audio.port = port;
    this.audio.startHandshake();
  }

  restartAudioStream(reason = 'audio stall') {
    if (!this.audio) return false;
    const ok = this.audio.restartAudioFlow(reason);
    if (ok) this.emit('log', `[rsba1/audio] restart requested: ${reason}`);
    return ok;
  }

  disconnect() {
    this._connectToken++;
    if (this._handshakeDeadline) {
      clearTimeout(this._handshakeDeadline);
      this._handshakeDeadline = null;
    }
    if (this._civFallbackTimer) {
      clearTimeout(this._civFallbackTimer);
      this._civFallbackTimer = null;
    }
    if (this.audio)   { this.audio.close();   this.audio = null; }
    if (this.civ)     { this.civ.close();     this.civ = null; }
    if (this.control) { this.control.close(); this.control = null; }
    if (this._connected) {
      this._connected = false;
      this.emit('close');
    }
    this._handshakeStage = 'idle';
    this._assignedCivPort = null;
    this._triedCivFallback = false;
  }

  _scheduleCivFallback() {
    if (!this.civ || this._target.civPort || this._triedCivFallback) return;
    const fallbackPort = (this._target.controlPort || 50001) + 1;
    if (!fallbackPort || this.civ.port === fallbackPort) return;
    this._civFallbackTimer = setTimeout(() => {
      this._civFallbackTimer = null;
      if (this._connected || !this.civ || this.civ.gotIAmHere || this._target.civPort || this._triedCivFallback) return;
      this._triedCivFallback = true;
      const originalPort = this.civ.port;
      if (this.civ.aytTimer) {
        clearInterval(this.civ.aytTimer);
        this.civ.aytTimer = null;
      }
      this.civ.port = fallbackPort;
      this.civ.aytCount = 0;
      this.emit('log', `[rsba1/civ] no IAmHere on advertised port ${originalPort}; retrying fallback port ${fallbackPort}`);
      this._handshakeStage = 'waiting-civ-IAmHere';
      this.civ.startHandshake();
    }, 3000);
  }

  _startHandshakeWatchdog(timeoutMs) {
    if (this._handshakeDeadline) clearTimeout(this._handshakeDeadline);
    this._handshakeDeadline = setTimeout(() => {
      if (!this._connected) {
        const details = this._handshakeDiagnostics();
        const err = this._makeTimeoutError(details);
        this.emit('error', err);
        this.disconnect();
      }
    }, Math.max(100, Number(timeoutMs) || HANDSHAKE_TIMEOUT));
  }

  _handshakeDiagnostics() {
    let stage = this._handshakeStage || 'unknown';
    if (this.control && !this.control.connected) {
      stage = this.control.gotIAmHere ? `control-${this.control.authStage || 'unknown'}` : 'waiting-control-IAmHere';
    } else if (this.civ && !this.civ.connected) {
      stage = this.civ.gotIAmHere ? 'waiting-civ-IAmReady' : 'waiting-civ-IAmHere';
    }
    return {
      stage,
      host: this._target ? this._target.host : null,
      resolvedHost: this._target ? this._target.resolvedHost : null,
      localAddress: this._target ? this._target.localAddress : null,
      controlPort: this._target ? this._target.controlPort : null,
      civPort: this.civ ? this.civ.port : (this._target ? this._target.civPort : null),
      assignedCivPort: this._assignedCivPort,
      triedCivFallback: this._triedCivFallback,
      civLocalPort: this.civ ? this.civ.localPort : (this._target ? this._target.civLocalPort : null),
      audioLocalPort: this.audio ? this.audio.localPort : (this._target ? this._target.audioLocalPort : null),
      controlId: this.control ? this.control.myId : null,
      civId: this.civ ? this.civ.myId : null,
      audioId: this.audio ? this.audio.myId : null,
      selectedRadio: this.control && this.control.radioInfo ? {
        name: this.control.radioInfo.name,
        civAddress: this.control.radioInfo.civAddress,
        commoncap: this.control.radioInfo.commoncap,
      } : null,
      controlAuthMode: this.control ? this.control.authMode : (this._target ? this._target.controlAuthMode : null),
      controlLastAuth: this.control && this.control.lastAuth ? { ...this.control.lastAuth } : null,
      controlAuthRetryCount: this.control ? this.control.authRetryCount : 0,
      controlAytCount: this.control ? this.control.aytCount : 0,
      civAytCount: this.civ ? this.civ.aytCount : 0,
      controlSendError: this.control ? this.control.lastSendError : null,
      civSendError: this.civ ? this.civ.lastSendError : null,
    };
  }

  _makeTimeoutError(details) {
    const target = `${details.host || 'radio'}:${details.controlPort || 50001}`;
    const resolved = details.resolvedHost && details.resolvedHost !== details.host
      ? ` (resolved to ${details.resolvedHost})`
      : '';
    if (details.stage === 'waiting-control-IAmHere') {
      return makeRsba1Error(
        `rsba1 handshake timed out before IAmHere: sent ${details.controlAytCount} AreYouThere UDP packet(s) to ${target}${resolved}; no reply from the radio. This is before username/password validation.`,
        'RSBA1_NO_IAMHERE',
        details
      );
    }
    if (details.stage === 'waiting-civ-IAmHere') {
      return makeRsba1Error(
        `rsba1 CI-V stream timed out before IAmHere: control login succeeded, but the radio did not answer ${details.civAytCount} CI-V AreYouThere UDP packet(s) on port ${details.civPort}.`,
        'RSBA1_NO_CIV_IAMHERE',
        details
      );
    }
    if (String(details.stage || '').startsWith('control-')) {
      const last = details.controlLastAuth || {};
      const id = (value) => Number.isFinite(value) ? `0x${(value >>> 0).toString(16)}` : 'n/a';
      const tok = Number.isFinite(last.tokRequest) ? `0x${(last.tokRequest & 0xffff).toString(16)}` : 'n/a';
      const authDetails = last.label
        ? ` Last auth packet: ${last.label} mode=${last.mode || details.controlAuthMode || 'unknown'} seq=${last.seq ?? 'n/a'} innerSeq=${last.innerSeq ?? 'n/a'} myId=${id(last.myId)} remoteId=${id(last.remoteId)} tokReq=${tok} retries=${last.retryCount ?? details.controlAuthRetryCount ?? 0}.`
        : '';
      return makeRsba1Error(
        `rsba1 handshake timed out at stage ${details.stage || 'unknown'} for ${target}${resolved}.${authDetails}`,
        'RSBA1_CONTROL_AUTH_TIMEOUT',
        details
      );
    }
    return makeRsba1Error(
      `rsba1 handshake timed out at stage ${details.stage || 'unknown'} for ${target}${resolved}.`,
      'RSBA1_HANDSHAKE_TIMEOUT',
      details
    );
  }

  write(buf) {
    if (!this._connected || !this.civ) return false;
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    this.civ.sendCiv(buf);
    return true;
  }

  sendTxAudio(samples, offsetMs = 0, inputSampleRate = 12000) {
    if (!this.audio) return Promise.reject(new Error('RS-BA1 audio stream is not open'));
    return this.audio.sendTxAudio(samples, offsetMs, inputSampleRate);
  }

  cancelTx() {
    if (this.audio) this.audio.cancelTx();
  }

  // SerialTransport-compatible no-ops — RS-BA1 has no DTR/RTS/baud.
  setPin(_pins, cb) { if (cb) cb(null); }
  set(_pins, cb)    { if (cb) cb(null); }
}

module.exports = {
  RsBa1Transport,
  passcodeBytes,
  PASSCODE_TABLE,
  AUDIO_CODEC_LPCM16_MONO,
  AUDIO_CODEC_LPCM16_STEREO,
  resampleMonoFloat32,
  streamIdFromLocalAddress,
  selectLocalAddressForTarget,
};
