// SPDX-License-Identifier: Apache-2.0
/**
 * Receive audio from a Flex over FlexRadio SmartLink: Opus, on the GUI
 * connection.
 *
 * Over SmartLink POTACAT gets one connection to the radio (a second `application
 * connect` is not granted), and only the GUI client may create audio (a non-GUI
 * client's `stream create type=remote_audio_rx` is refused 500000AA). So the DAX
 * path of lib/smartsdr-audio.js (a second, bound connection) cannot run, and this
 * takes its place with the same events and the same frame shape:
 *   'audio-frame' { pcm: Float32Array mono, sampleRate: 24000 }, 'log',
 *   'audio-fallback' { reason }, 'stall' { silentMs }, 'recovered'.
 * main.js feeds those frames into the same paths DAX RX feeds (VFO monitor,
 * JTCAT at 12 kHz, ECHOCAT's track) without knowing which one runs.
 *
 * Verified 2026-11-17 on an 8600M (v4.2.20): `stream create type=remote_audio_rx
 * compression=opus` answers a stream id; packets are VITA-49 class 0x8005 with a
 * 28-byte header, one every 10 ms, Opus payloads of 50-100 bytes (~54 kbit/s),
 * decoding at 24 kHz stereo with no errors. While the radio transmits the stream
 * is digital silence and returns by itself within about a second of unkey.
 *
 * Transmit audio (remote_audio_tx) is NOT built here: every TX method refuses.
 */
'use strict';

const { EventEmitter } = require('events');

const OPUS_CLASS = 0x8005;
const HEADER_BYTES = 28;
const SAMPLE_RATE = 24000;
const CHANNELS = 2;
const WATCHDOG_MS = 5000;
const STALL_MS = 2500;

/**
 * A VITA-49 Opus packet's stream id and Opus payload, or null.
 * Header: word 0 (type, C bit, TSI/TSF, count, size in 32-bit words), stream id,
 * OUI, information/packet class, integer and fractional timestamps: 28 bytes.
 */
function parseOpusPacket(buf) {
  if (!buf || buf.length <= HEADER_BYTES) return null;
  if ((buf[0] & 0xF8) !== 0x38) return null;
  if (buf.readUInt16BE(14) !== OPUS_CLASS) return null;
  const sizeBytes = buf.readUInt16BE(2) * 4;
  const trailer = (buf[0] & 0x04) ? 4 : 0;
  const end = Math.min(buf.length, sizeBytes || buf.length) - trailer;
  if (end <= HEADER_BYTES) return null;
  return { streamId: buf.readUInt32BE(4) >>> 0, payload: buf.subarray(HEADER_BYTES, end) };
}

/** Interleaved 16-bit stereo (little-endian, libopus' output) to mono float, left channel. */
function stereoS16ToMonoFloat(pcmBuf) {
  const frames = Math.floor(pcmBuf.length / 4);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = pcmBuf.readInt16LE(i * 4) / 32768;
  return out;
}

/** A libopus decoder at 24 kHz stereo (the shipped @discordjs/opus). */
function defaultDecoder() {
  const { OpusEncoder } = require('@discordjs/opus');
  const enc = new OpusEncoder(SAMPLE_RATE, CHANNELS);
  return { decode: (payload) => enc.decode(payload) };
}

class SmartLinkOpusAudio extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.client       the SmartSdrClient holding the GUI seat over SmartLink
   * @param {function} [o.makeDecoder] () => { decode(payload) => Buffer s16le stereo }
   */
  constructor(o) {
    super();
    this._client = o.client;
    this._makeDecoder = o.makeDecoder || defaultDecoder;
    this._decoder = null;
    this._streamId = null;
    this._onPacket = (buf) => this._packet(buf);
    this._watchdog = null;
    this._liveness = null;
    this._lastFrameMs = 0;
    this._stalled = false;
    this._frames = 0;
    this._badFrames = 0;
    this._running = false;
  }

  get connected() { return this._running; }
  get txReady() { return false; }
  get txDaxOn() { return null; }
  get streamId() { return this._streamId; }

  /** Same signature as SmartSdrAudio.start; host and DAX channel are not used. */
  start() {
    this.stop();
    const c = this._client;
    if (!c || !c.connected || !c.guiReady) {
      this._fallback('POTACAT is not the radio\'s GUI client yet');
      return;
    }
    try { this._decoder = this._makeDecoder(); } catch (err) {
      this._fallback('no Opus decoder: ' + err.message);
      return;
    }
    this._running = true;
    c.on('opus-packet', this._onPacket);
    this.emit('log', 'Opus: stream create type=remote_audio_rx compression=opus');
    c._sendAwait('stream create type=remote_audio_rx compression=opus').then(({ status, payload }) => {
      if (!this._running) return;
      if (status !== 0) {
        const hex = (status >>> 0).toString(16).toUpperCase();
        this._fallback(hex === '500000AA'
          ? 'the radio refused audio to a non-GUI client (500000AA)'
          : `the radio refused the audio stream (${hex})`);
        return;
      }
      const id = parseInt(String(payload).split('|')[0].replace(/^0x/i, ''), 16);
      if (!Number.isFinite(id)) { this._fallback('no stream id in the reply'); return; }
      this._streamId = id >>> 0;
      this.emit('log', `Opus stream 0x${this._streamId.toString(16)}`);
      this._watchdog = setTimeout(() => {
        if (!this._frames) this._fallback('no Opus packets in 5 s (is the UDP path open?)');
      }, WATCHDOG_MS);
    }, (err) => this._fallback('no reply to stream create: ' + err.message));
  }

  _packet(buf) {
    const p = parseOpusPacket(buf);
    if (!p || this._streamId == null || p.streamId !== this._streamId) return;
    let pcm;
    try { pcm = this._decoder.decode(p.payload); } catch { this._badFrames++; return; }
    const mono = stereoS16ToMonoFloat(pcm);
    this._lastFrameMs = Date.now();
    if (!this._frames++) {
      if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; }
      this.emit('log', `First Opus frame: ${p.payload.length} bytes -> ${mono.length} samples at 24 kHz`);
      this._liveness = setInterval(() => this._checkStall(), 1000);
    }
    if (this._stalled) { this._stalled = false; this.emit('recovered'); }
    this.emit('audio-frame', { pcm: mono, sampleRate: SAMPLE_RATE });
  }

  _checkStall() {
    const silent = Date.now() - this._lastFrameMs;
    if (silent >= STALL_MS && !this._stalled) { this._stalled = true; this.emit('stall', { silentMs: silent }); }
  }

  _fallback(reason) {
    this.emit('log', 'Opus audio unavailable: ' + reason);
    this.stop();
    this.emit('audio-fallback', { reason });
  }

  stop() {
    const c = this._client;
    if (this._watchdog) { clearTimeout(this._watchdog); this._watchdog = null; }
    if (this._liveness) { clearInterval(this._liveness); this._liveness = null; }
    if (c) c.removeListener('opus-packet', this._onPacket);
    if (this._running && this._streamId != null && c && c.connected) {
      try { c._send(`stream remove 0x${this._streamId.toString(16)}`); } catch {}
    }
    this._running = false;
    this._streamId = null;
    this._frames = 0;
    this._stalled = false;
  }

  // Transmit audio over SmartLink is not built: every TX entry refuses.
  sendTxAudio() { return Promise.reject(new Error('transmit audio over FlexRadio SmartLink is not available yet')); }
  pushTxAudioChunk() { return false; }
  claimTxStream() { return false; }
  returnTxStream() { return false; }
  cancelTx() {}
  setTxDax() { return false; }
}

module.exports = { OPUS_CLASS, HEADER_BYTES, SAMPLE_RATE, parseOpusPacket, stereoS16ToMonoFloat, SmartLinkOpusAudio };
