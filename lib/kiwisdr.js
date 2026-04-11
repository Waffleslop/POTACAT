'use strict';
// KiwiSDR WebSocket client — connects to a public KiwiSDR receiver,
// tunes to a frequency/mode, and streams decoded PCM audio.

const { EventEmitter } = require('events');
const WebSocket = require('ws');

// IMA ADPCM step table and index adjustment
const STEP = [7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
const IDX_ADJ = [-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8];

class KiwiSdrClient extends EventEmitter {
  constructor() {
    super();
    this._ws = null;
    this._keepalive = null;
    this._connected = false;
    this._host = '';
    this._port = 8073;
    this._adpcmState = { predictor: 0, stepIndex: 0 };
  }

  get connected() { return this._connected; }

  /**
   * Connect to a KiwiSDR receiver.
   * @param {string} host — hostname or IP
   * @param {number} port — default 8073
   * @param {string} password — default '#' for public receivers
   */
  connect(host, port, password) {
    this.disconnect();
    this._host = host;
    this._port = port || 8073;
    const ts = Date.now();
    const url = `ws://${this._host}:${this._port}/kiwi/${ts}/SND`;
    console.log(`[KiwiSDR] Connecting to ${url}`);

    try {
      this._ws = new WebSocket(url, { handshakeTimeout: 10000 });
    } catch (err) {
      this.emit('error', err.message);
      return;
    }

    this._ws.on('open', () => {
      this._send(`SET auth t=kiwi p=${password || '#'}`);
      this._startKeepalive();
      this._connected = true;
      this.emit('connected');
    });

    this._ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      // KiwiSDR sends all messages as binary frames with a 3-byte marker
      const marker = buf.length >= 3 ? buf.slice(0, 3).toString('ascii') : '';
      if (marker === 'MSG') {
        this._parseText(buf.slice(4).toString('utf8')); // skip "MSG " (4 bytes)
      } else if (marker === 'SND') {
        this._parseBinary(buf);
      }
    });

    this._ws.on('close', (code, reason) => {
      console.log(`[KiwiSDR] WebSocket closed: code=${code} reason=${reason || 'none'}`);
      this._cleanup();
      this.emit('disconnected');
    });

    this._ws.on('error', (err) => {
      console.log(`[KiwiSDR] WebSocket error: ${err.message}`);
      this.emit('error', err.message || 'WebSocket error');
    });
  }

  disconnect() {
    if (this._ws) {
      try { this._ws.close(); } catch {}
    }
    this._cleanup();
  }

  /**
   * Tune to a frequency and mode.
   * @param {number} freqKhz — frequency in kHz (e.g. 7255)
   * @param {string} mode — 'usb', 'lsb', 'am', 'cw', 'nbfm'
   * @param {number} [bwLow] — lower passband edge in Hz
   * @param {number} [bwHigh] — upper passband edge in Hz
   */
  tune(freqKhz, mode, bwLow, bwHigh) {
    if (!this._connected) return;
    const m = (mode || 'usb').toLowerCase();
    let low, high;
    if (bwLow != null && bwHigh != null) {
      low = bwLow;
      high = bwHigh;
    } else {
      // Default passbands by mode
      switch (m) {
        case 'usb': low = 300; high = 2700; break;
        case 'lsb': low = -2700; high = -300; break;
        case 'am':  low = -4000; high = 4000; break;
        case 'cw':  low = 300; high = 800; break;
        case 'cwn': low = 400; high = 700; break;
        case 'nbfm': low = -6000; high = 6000; break;
        default:    low = 300; high = 2700; break;
      }
    }
    this._send(`SET mod=${m} low_cut=${low} high_cut=${high} freq=${(freqKhz / 1000).toFixed(3)}`);
    // Request uncompressed audio for simplicity
    this._send('SET compression=0');
    this._adpcmState = { predictor: 0, stepIndex: 0 };
  }

  /** Set AGC parameters */
  setAgc(on, manGain) {
    if (!this._connected) return;
    if (on) {
      this._send('SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50');
    } else {
      this._send(`SET agc=0 hang=0 thresh=-130 slope=6 decay=1000 manGain=${manGain || 50}`);
    }
  }

  // --- Internal ---

  _send(msg) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(msg);
    }
  }

  _startKeepalive() {
    this._stopKeepalive();
    this._keepalive = setInterval(() => this._send('SET keepalive'), 5000);
  }

  _stopKeepalive() {
    if (this._keepalive) { clearInterval(this._keepalive); this._keepalive = null; }
  }

  _cleanup() {
    this._stopKeepalive();
    this._connected = false;
    this._ws = null;
  }

  _parseText(msg) {
    console.log(`[KiwiSDR] MSG: ${msg.substring(0, 200)}`);
    if (msg.includes('too_busy')) {
      this.emit('error', 'KiwiSDR is full (no available channels)');
      this.disconnect();
    } else if (msg.includes('badp')) {
      // badp=x means auth status: badp=0 is OK, badp=1 is bad password
      if (msg.includes('badp=1')) {
        this.emit('error', 'KiwiSDR authentication failed (bad password)');
        this.disconnect();
      }
      // badp=0 means auth succeeded — continue
    } else if (msg.includes('audio_init')) {
      // KiwiSDR requires AR OK after audio_init before it sends audio
      this._send('SET AR OK in=12000 out=44100');
      const m = msg.match(/audio_rate=(\d+)/);
      if (m) this.emit('info', { sampleRate: parseInt(m[1], 10) });
    }
  }

  _parseBinary(buf) {
    if (buf.length < 3) return;
    // First 3 bytes: 'SND' marker
    const marker = buf.slice(0, 3).toString('ascii');
    if (marker !== 'SND') return;

    // Bytes 3-4: flags
    const flags = buf.readUInt8(3);
    const isCompressed = (flags & 0x10) !== 0;
    // Bytes 5-6: S-meter (big-endian, can be negative dBm)
    const smeter = buf.length > 6 ? buf.readInt16BE(4) : 0;

    // Audio data starts at byte 7
    if (buf.length <= 7) return;
    const audioData = buf.slice(7);

    let pcmFloat;
    if (isCompressed) {
      pcmFloat = this._decodeAdpcm(audioData);
    } else {
      // Raw 16-bit signed little-endian PCM
      const samples = audioData.length >> 1;
      pcmFloat = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        pcmFloat[i] = buf.readInt16LE(7 + i * 2) / 32768;
      }
    }

    if (pcmFloat.length > 0) {
      this.emit('audio', pcmFloat, 12000); // 12 kHz sample rate
      this.emit('smeter', smeter / 10); // dBm with 0.1 precision
    }
  }

  _decodeAdpcm(data) {
    const s = this._adpcmState;
    const out = new Float32Array(data.length * 2);
    let oi = 0;
    for (let i = 0; i < data.length; i++) {
      const byte = data[i];
      for (let nibIdx = 0; nibIdx < 2; nibIdx++) {
        const nib = nibIdx === 0 ? (byte & 0x0F) : ((byte >> 4) & 0x0F);
        const step = STEP[s.stepIndex];
        let delta = step >> 3;
        if (nib & 4) delta += step;
        if (nib & 2) delta += step >> 1;
        if (nib & 1) delta += step >> 2;
        if (nib & 8) delta = -delta;
        s.predictor = Math.max(-32768, Math.min(32767, s.predictor + delta));
        s.stepIndex = Math.max(0, Math.min(88, s.stepIndex + IDX_ADJ[nib]));
        out[oi++] = s.predictor / 32768;
      }
    }
    return out.subarray(0, oi);
  }
}

module.exports = { KiwiSdrClient };
