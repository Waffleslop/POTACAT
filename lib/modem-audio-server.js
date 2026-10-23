// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Casey Stanton
//
// ModemAudioServer — the loopback audio port an external modem (ardopcf with
// POTACAT's socket backend; Dire Wolf / Mercury later) connects to instead of
// opening a sound card.
//
// Wire: one TCP connection on 127.0.0.1, raw 16-bit signed little-endian mono
// PCM at the modem's rate in BOTH directions, no framing — 12000 samples/s for
// ardopcf (its fixed rate), 48000 for Dire Wolf (its ARATE; 9600-baud packet
// needs at least 4x the baud rate), one server per modem (`modemRate`).
// POTACAT writes the radio's receive audio as it arrives (so the stream is
// paced by the radio); the modem writes its transmit audio paced by its own
// clock (both backends emulate a sound card's buffer, so a frame never arrives
// as one burst).
//
// Why: on a Flex with Flex Direct, or an Icom over Icom Network, there is no
// sound device for a modem to open, and the Windows DAX endpoints that exist
// on paper took no audio at all (K3SBP 2026-10-22, 0 W on every ARDOP call).
// POTACAT already has the radio's audio in main for FT8 — the VITA-49 dax_rx
// frames and dax_tx stream, or the RS-BA1 paced frames — so the modem rides
// the same paths and DAX stays out of the picture.
//
// Pure apart from the socket: resampling to/from the radio's rate is the
// caller's StreamingResampler, handed in so this module needs no DSP of its own.

'use strict';

const net = require('net');
const { EventEmitter } = require('events');

const MODEM_RATE = 12000;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function floatToInt16(f32) {
  const out = Buffer.allocUnsafe(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    let v = f32[i];
    if (v > 1) v = 1; else if (v < -1) v = -1;
    out.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return out;
}

function int16ToFloat(buf, bytes) {
  const n = bytes >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

class ModemAudioServer extends EventEmitter {
  /**
   * @param {object} o
   * @param {(inRate:number, outRate:number)=>{process:(x:Float32Array)=>Float32Array}} o.makeResampler
   * @param {number} [o.txOutRate=24000]  rate the caller wants transmit audio at ('tx' event)
   * @param {number} [o.modemRate=12000]  the rate on the wire, both directions (the modem's)
   * @param {(m:string)=>void} [o.log]
   */
  constructor({ makeResampler, txOutRate = 24000, modemRate = MODEM_RATE, log } = {}) {
    super();
    if (typeof makeResampler !== 'function') throw new Error('ModemAudioServer needs makeResampler');
    if (!Number.isInteger(modemRate) || modemRate < 8000 || modemRate > 96000) throw new Error(`ModemAudioServer: modemRate ${modemRate} is not a sample rate`);
    this._makeResampler = makeResampler;
    this._txOutRate = txOutRate;
    this._modemRate = modemRate;
    this._log = log || (() => {});
    this._server = null;
    this._sock = null;
    this._rxResampler = null;
    this._rxRate = 0;
    this._txResampler = null;
    this._txCarry = Buffer.alloc(0);
    this.stats = { rxFrames: 0, rxDropped: 0, txChunks: 0 };
  }

  /** Listen on a loopback port (0 = any free). Resolves the port. */
  listen(port = 0, host = '127.0.0.1') {
    if (!LOOPBACK.has(host)) throw new Error(`modem audio server refuses to bind ${host} — loopback only`);
    this._server = net.createServer((sock) => this._accept(sock));
    this._server.on('error', (e) => this._log(`modem audio: ${e.message}`));
    return new Promise((resolve, reject) => {
      this._server.once('error', reject);
      this._server.listen(port, host, () => resolve(this._server.address().port));
    });
  }

  get port() { return this._server && this._server.address() ? this._server.address().port : 0; }
  get connected() { return !!(this._sock && !this._sock.destroyed); }
  get modemRate() { return this._modemRate; }

  _accept(sock) {
    if (this._sock && !this._sock.destroyed) {
      // One modem at a time: a second connection is a stale modem or a mistake.
      this._log('modem audio: a second modem connected — replacing the first');
      try { this._sock.destroy(); } catch {}
    }
    this._sock = sock;
    this._txResampler = this._modemRate === this._txOutRate ? null : this._makeResampler(this._modemRate, this._txOutRate);
    this._txCarry = Buffer.alloc(0);
    sock.setNoDelay(true);
    sock.on('data', (chunk) => this._onTx(chunk));
    sock.on('error', () => {});
    sock.on('close', () => { if (this._sock === sock) { this._sock = null; this.emit('modem-gone'); } });
    this.emit('modem-connected');
  }

  /**
   * The radio's receive audio, any rate, mono Float32. Resampled to the
   * modem's rate and written to it. Dropped (counted) when the socket is
   * backed up — a modem that stops reading must never stall POTACAT's audio path.
   */
  feedRx(pcm, sampleRate) {
    if (!this.connected || !pcm || !pcm.length) return;
    const f32 = pcm instanceof Float32Array ? pcm : new Float32Array(pcm);
    if (sampleRate !== this._rxRate) {
      this._rxRate = sampleRate;
      this._rxResampler = sampleRate === this._modemRate ? null : this._makeResampler(sampleRate, this._modemRate);
    }
    const out = this._rxResampler ? this._rxResampler.process(f32) : f32;
    if (!out.length) return;
    if (this._sock.writableLength > this._modemRate * 4) { this.stats.rxDropped++; return; } // > 2 s unread: the modem is stuck
    this.stats.rxFrames++;
    this._sock.write(floatToInt16(out));
  }

  _onTx(chunk) {
    const buf = this._txCarry.length ? Buffer.concat([this._txCarry, chunk]) : chunk;
    const even = buf.length & ~1;
    this._txCarry = buf.subarray(even);
    if (!even) return;
    const atModemRate = int16ToFloat(buf, even);
    const out = this._txResampler ? this._txResampler.process(atModemRate) : atModemRate;
    if (!out.length) return;
    this.stats.txChunks++;
    this.emit('tx', out);
  }

  close() {
    if (this._sock) { try { this._sock.destroy(); } catch {} this._sock = null; }
    return new Promise((resolve) => {
      if (!this._server) return resolve();
      this._server.close(() => resolve());
      this._server = null;
    });
  }
}

module.exports = { ModemAudioServer, MODEM_RATE, floatToInt16, int16ToFloat };
