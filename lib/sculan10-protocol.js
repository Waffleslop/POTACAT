'use strict';
/**
 * Yaesu SCU-LAN10 wire protocol: pure encode/decode, no sockets.
 *
 * Written from the published spec only (Waffleslop/sculan10-protocol SPEC.md,
 * a fork of CarrierWaveApp/sculan10-protocol, MIT; derived from FT-Control
 * captures and verified on a live FTDX10). No code from any other client.
 *
 * Every datagram: 5A 5A | LE u16 length (= body + 10) | 00 01 | 8-byte header
 * | body. The header carries a random per-packet key; each header byte except
 * the sequence is XOR'd with it, and the body is XOR'd with key ^ gTable[i].
 * It is obfuscation, not security: the unit's ports must never face the
 * internet (Tailscale or a VPN for use away from home).
 */

const CHANNEL = Object.freeze({ CTRL: 0xFC, CAT: 0xFD, AUDIO: 0xFE, SCOPE: 0xFA });
const CHANNEL_NAME = Object.freeze({ 0xFC: 'ctrl', 0xFD: 'cat', 0xFE: 'audio', 0xFA: 'scope' });
// Port offset from the base port, by channel.
const PORT_OFFSET = Object.freeze({ ctrl: 0, cat: 1, audio: 2, scope: 3 });

const MSG = Object.freeze({
  SETUP: 0x01, AUTH: 0x03, KEEPALIVE: 0x05, PORT_INIT: 0x06, DATA: 0x07,
  SETUP_ACK: 0x81, AUTH_RESP: 0x83, KEEPALIVE_ACK: 0x85, PORT_INIT_ACK: 0x86, DATA_IN: 0x87,
});

const AUTH_KEY = 0x3A;     // the auth packet's fixed key (spec Phase 2)
const AUTH_SEQ = 0x06;     // after the five init packets (seq 01-05)
const FIELD_LEN = 33;      // username / password: 32 ASCII + NUL padding
const DEFAULT_BASE_PORT = 50000;
const DEFAULT_USER = 'defaultuser';

// Phase 1: five fixed packets, sent byte for byte (spec: identical in every
// session). They decode, by the spec's own formulas, as CTRL keepalives with
// seq 01-05 and a 4-byte zero body (the spec's prose says 04 04 04 04; the
// bytes say 00 00 00 00 — we send the bytes, so it does not matter).
const INIT_PACKETS_HEX = Object.freeze([
  '5a5a0e00000101a0a15e585d595a5b585956',
  '5a5a0e000001024042bdbbbebab9b8bbbab5',
  '5a5a0e00000103e0e31c1a1f1b18191a1b14',
  '5a5a0e0000010480847b7d787c7f7e7d7c73',
  '5a5a0e000001052025dadcd9dddedfdcddd2',
]);
const INIT_PACKETS = Object.freeze(INIT_PACKETS_HEX.map((h) => Buffer.from(h, 'hex')));

// The scramble table, closed form: gTable[i] = (4*floor(i/4) + 6 + [0,-1,-2,+5][i%4]) & 0xFF.
// It repeats every 256 bytes, so 8192 entries cover any body with margin.
const GTABLE_SIZE = 8192;
function buildGTable(size = GTABLE_SIZE) {
  const offsets = [0, 0xFF, 0xFE, 5];
  const t = Buffer.alloc(size);
  for (let i = 0; i < size; i++) t[i] = (4 * Math.floor(i / 4) + 6 + offsets[i % 4]) & 0xFF;
  return t;
}
const GTABLE = buildGTable();

/** XOR a body with key ^ gTable[i]. Its own inverse (encrypt == decrypt). */
function xorBody(body, key) {
  const out = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i++) out[i] = body[i] ^ key ^ GTABLE[i % GTABLE_SIZE];
  return out;
}

function buildHeader(seq, channelId, msgType, bodyLen, key) {
  const k = key & 0xFF;
  const s = seq & 0xFF;
  return Buffer.from([
    s,
    k ^ s ^ 0xFC,
    k ^ channelId,
    k ^ 0x03,
    k ^ msgType,
    k,
    k ^ (bodyLen & 0xFF),
    k ^ (0x07 ^ ((bodyLen >> 8) & 0xFF)),
  ]);
}

/**
 * One framed datagram. `key` is random per packet unless given (the auth
 * packet's is fixed at 0x3A; tests pass one to get exact bytes).
 */
function buildPacket({ seq, channel, msgType, body = Buffer.alloc(0), key }) {
  const k = key == null ? Math.floor(Math.random() * 256) : key;
  const plain = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const header = buildHeader(seq, channel, msgType, plain.length, k);
  const enc = xorBody(plain, k);
  const out = Buffer.alloc(6 + 8 + enc.length);
  out[0] = 0x5A; out[1] = 0x5A;
  out.writeUInt16LE(enc.length + 10, 2);
  out[4] = 0x00; out[5] = 0x01;
  header.copy(out, 6);
  enc.copy(out, 14);
  return out;
}

/**
 * Parse one datagram. Returns null for anything that is not a well-formed,
 * self-consistent packet (the unit drops those too), else
 * { seq, channel, channelName, msgType, key, body (decrypted) }.
 */
function parsePacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 14) return null;
  if (buf[0] !== 0x5A || buf[1] !== 0x5A) return null;
  const len = buf.readUInt16LE(2);
  if (buf[4] !== 0x00 || buf[5] !== 0x01) return null;
  const h = buf.subarray(6, 14);
  const key = h[5];
  const seq = h[0];
  const bodyLen = (h[6] ^ key) | (((h[7] ^ key) ^ 0x07) << 8);
  if ((h[1] ^ key ^ seq) !== 0xFC) return null;
  if ((h[3] ^ key) !== 0x03) return null;
  if (buf.length - 14 < bodyLen) return null;
  if (len !== bodyLen + 10) return null;
  const channel = h[2] ^ key;
  const msgType = h[4] ^ key;
  const body = xorBody(buf.subarray(14, 14 + bodyLen), key);
  return { seq, channel, channelName: CHANNEL_NAME[channel] || `0x${channel.toString(16)}`, msgType, key, body };
}

function asciiField(s) {
  const b = Buffer.alloc(FIELD_LEN);
  // ASCII only, 32 characters at most: the 33rd byte stays NUL.
  const src = Buffer.from(String(s == null ? '' : s).replace(/[^\x20-\x7E]/g, '').slice(0, FIELD_LEN - 1), 'ascii');
  src.copy(b, 0);
  return b;
}

/** Phase 2 auth body: 01 00 | user (33) | password (33) = 68 bytes. */
function buildAuthBody(username, password) {
  return Buffer.concat([Buffer.from([0x01, 0x00]), asciiField(username), asciiField(password)]);
}

/** Phase 2 auth packet (fixed key 0x3A, seq 06). Never log this buffer. */
function buildAuthPacket(username, password) {
  return buildPacket({ seq: AUTH_SEQ, channel: CHANNEL.CTRL, msgType: MSG.AUTH, body: buildAuthBody(username, password), key: AUTH_KEY });
}

/** Phase 3: { sessionId, caps (hex) } from the auth response body, or null. */
function parseAuthResponse(body) {
  if (!body || body.length < 1) return null;
  const caps = body.length >= 14 ? body.subarray(9, 14).toString('hex') : '';
  return { sessionId: body[0], caps };
}

const sidPrefix = (sid) => [sid & 0xFF, 0, 0, 0];

/** Phase 4 continuation body (sent on CTRL with channel CAT). */
function continuationBody(sid) {
  return Buffer.from([...sidPrefix(sid), 0x51, 0xC3, 0x00, 0x96, 0x00, 0x00]);
}
/** Phase 5 port-init body (sent to the data port itself). */
function portInitBody(sid) { return Buffer.from(sidPrefix(sid)); }
/** Phase 5 setup body: 0x52 = CAT, 0x53 = AUDIO. */
function setupBody(sid, portId) { return Buffer.from([...sidPrefix(sid), portId, 0xC3]); }
const KEEPALIVE_BODY = Buffer.from([0, 0, 0, 0]);

/**
 * The Phase 4 / 5 sequence, in order: what to send, where, and what ack it
 * expects. The b2 channel of each CTRL setup packet names the NEXT channel
 * (a quirk of the wire protocol the spec records); scope has no setup packet.
 */
function setupSteps(sid) {
  return [
    { name: 'continuation', port: 'ctrl', channel: CHANNEL.CAT, msgType: MSG.SETUP, body: continuationBody(sid), ack: MSG.SETUP_ACK },
    { name: 'cat-init', port: 'cat', channel: CHANNEL.CAT, msgType: MSG.PORT_INIT, body: portInitBody(sid), ack: MSG.PORT_INIT_ACK },
    { name: 'cat-setup', port: 'ctrl', channel: CHANNEL.AUDIO, msgType: MSG.SETUP, body: setupBody(sid, 0x52), ack: MSG.SETUP_ACK },
    { name: 'audio-init', port: 'audio', channel: CHANNEL.AUDIO, msgType: MSG.PORT_INIT, body: portInitBody(sid), ack: MSG.PORT_INIT_ACK },
    { name: 'audio-setup', port: 'ctrl', channel: CHANNEL.SCOPE, msgType: MSG.SETUP, body: setupBody(sid, 0x53), ack: MSG.SETUP_ACK },
    { name: 'scope-init', port: 'scope', channel: CHANNEL.SCOPE, msgType: MSG.PORT_INIT, body: portInitBody(sid), ack: MSG.PORT_INIT_ACK },
  ];
}

/** CAT client->server body: sid 00 00 00 | cmd_seq 00 00 00 | ASCII. */
function catCommandBody(sid, cmdSeq, ascii) {
  return Buffer.concat([Buffer.from([...sidPrefix(sid), cmdSeq & 0xFF, 0, 0, 0]), Buffer.from(ascii, 'latin1')]);
}

/** CAT server->client body: resp_seq 00 00 00 | ASCII. */
function parseCatResponse(body) {
  if (!body || body.length < 4) return null;
  return { respSeq: body[0], text: body.subarray(4).toString('latin1') };
}

/** Split a codec write ("FA;MD0;") into single commands, each its own CAT packet pair. */
function splitCatCommands(text) {
  const s = String(text || '');
  const out = [];
  let cur = '';
  for (const ch of s) {
    cur += ch;
    if (ch === ';') { if (cur.trim() !== ';') out.push(cur.trim()); cur = ''; }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const RX_AUDIO_HEADER = 24;

/**
 * RX audio body: 24-byte inner header + interleaved stereo Int16 LE PCM at
 * the rate it names (16 kHz in every capture). Channel 0 is the speaker.
 * Returns { frameSeq, sampleRate, pcm: Float32Array (channel 0), right peak } or null.
 */
function parseRxAudio(body) {
  if (!body || body.length < RX_AUDIO_HEADER + 4) return null;
  const sampleRate = body.readUInt32LE(4) || 16000;
  const declared = body.readUInt16LE(22);
  const avail = body.length - RX_AUDIO_HEADER;
  const bytes = Math.min(declared > 0 ? declared : avail, avail) & ~3;
  const frames = bytes / 4;
  const pcm = new Float32Array(frames);
  for (let i = 0; i < frames; i++) pcm[i] = body.readInt16LE(RX_AUDIO_HEADER + i * 4) / 32768;
  return { frameSeq: body[0], sampleRate, pcm, payloadBytes: bytes, format: body.subarray(1, 4).toString('hex') };
}

const MODELS = Object.freeze(['FTDX10', 'FT-710', 'FTDX101D/MP']);
const FIRMWARE_MIN = Object.freeze({
  'FTDX101D/MP': 'MAIN V01-14, DISPLAY V01-06, SDR V02-03',
  FTDX10: 'MAIN V01-01, DISPLAY V01-01, SDR V01-00',
  'FT-710': 'MAIN V01-11, DISPLAY V01-08, SDR V01-04',
});

module.exports = {
  CHANNEL, CHANNEL_NAME, PORT_OFFSET, MSG, AUTH_KEY, AUTH_SEQ, DEFAULT_BASE_PORT, DEFAULT_USER,
  INIT_PACKETS, INIT_PACKETS_HEX, GTABLE, buildGTable, xorBody,
  buildHeader, buildPacket, parsePacket,
  buildAuthBody, buildAuthPacket, parseAuthResponse,
  continuationBody, portInitBody, setupBody, setupSteps, KEEPALIVE_BODY,
  catCommandBody, parseCatResponse, splitCatCommands,
  parseRxAudio, RX_AUDIO_HEADER, MODELS, FIRMWARE_MIN,
};
