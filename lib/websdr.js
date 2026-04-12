'use strict';
// WebSDR.org client — connects to a websdr.org receiver via its
// HTTP-like streaming protocol, tunes to a frequency/mode, and
// streams decoded PCM audio.

const { EventEmitter } = require('events');
const net = require('net');

class WebSdrClient extends EventEmitter {
  constructor() {
    super();
    this._socket = null;
    this._connected = false;
    this._host = '';
    this._port = 8901;
    this._freq = 0;
    this._mode = 0; // 0=SSB, 1=AM, 4=FM
    this._lo = -2700;
    this._hi = -300;
    this._buf = Buffer.alloc(0);
    this._headerDone = false;
    this._sampleRate = 8000; // WebSDR default
  }

  get connected() { return this._connected; }

  /**
   * Connect and start streaming.
   * @param {string} host
   * @param {number} port — default 8901
   * @param {number} freqKhz — frequency in kHz
   * @param {string} mode — 'usb', 'lsb', 'am', 'cw', 'fm'
   */
  connect(host, port, freqKhz, mode) {
    this.disconnect();
    this._host = host;
    this._port = port || 8901;
    this._freq = freqKhz || 7200;
    this._resolveMode(mode || 'usb');
    this._headerDone = false;
    this._buf = Buffer.alloc(0);

    const params = `f=${this._freq}&band=0&lo=${this._lo}&hi=${this._hi}&mode=${this._mode}&name=POTACAT`;
    const request = `GET /~~stream?${params} HTTP/1.0\r\nHost: ${this._host}:${this._port}\r\n\r\n`;

    console.log(`[WebSDR] Connecting to ${this._host}:${this._port} freq=${this._freq}kHz`);

    try {
      this._socket = net.connect(this._port, this._host, () => {
        if (!this._socket) return; // disconnected before connect completed
        this._connected = true;
        this._socket.write(request);
        this.emit('connected');
      });
    } catch (err) {
      this.emit('error', err.message);
      return;
    }

    this._socket.on('data', (data) => this._onData(data));
    this._socket.on('close', () => {
      const was = this._connected;
      this._cleanup();
      if (was) this.emit('disconnected');
    });
    this._socket.on('error', (err) => {
      this.emit('error', err.message || 'Connection error');
    });
  }

  disconnect() {
    if (this._socket) {
      try { this._socket.destroy(); } catch {}
    }
    this._cleanup();
  }

  /**
   * Tune to a new frequency. Reconnects with new params.
   */
  tune(freqKhz, mode) {
    if (!this._connected) return;
    this._freq = freqKhz;
    if (mode) this._resolveMode(mode);
    // WebSDR requires reconnect to change frequency
    this.connect(this._host, this._port, freqKhz, mode);
  }

  _resolveMode(mode) {
    const m = (mode || 'usb').toLowerCase();
    switch (m) {
      case 'usb': this._mode = 0; this._lo = 300; this._hi = 2700; break;
      case 'lsb': this._mode = 0; this._lo = -2700; this._hi = -300; break;
      case 'cw':  this._mode = 0; this._lo = 300; this._hi = 800; break;
      case 'am':  this._mode = 1; this._lo = -4000; this._hi = 4000; break;
      case 'fm':  this._mode = 4; this._lo = -6000; this._hi = 6000; break;
      default:    this._mode = 0; this._lo = 300; this._hi = 2700; break;
    }
  }

  _cleanup() {
    this._connected = false;
    this._socket = null;
    this._buf = Buffer.alloc(0);
    this._headerDone = false;
  }

  _onData(data) {
    this._buf = Buffer.concat([this._buf, data]);

    // Skip first 2-byte header if not done
    if (!this._headerDone) {
      if (this._buf.length < 2) return;
      this._buf = this._buf.slice(2); // skip initial 2-byte handshake
      this._headerDone = true;
    }

    // Process audio in chunks — WebSDR sends variable-size u-law encoded packets
    // Decode as u-law 8kHz mono and convert to Float32
    while (this._buf.length >= 128) {
      // Take up to 512 bytes at a time
      const chunkSize = Math.min(512, this._buf.length);
      const chunk = this._buf.slice(0, chunkSize);
      this._buf = this._buf.slice(chunkSize);

      const pcm = new Float32Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        pcm[i] = ulawDecode(chunk[i]) / 32768;
      }
      this.emit('audio', pcm, this._sampleRate);
    }
  }
}

// u-law to 16-bit linear PCM decode table
function ulawDecode(u) {
  u = ~u & 0xFF;
  const sign = (u & 0x80) ? -1 : 1;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0F;
  const sample = sign * ((mantissa << (exponent + 3)) + (1 << (exponent + 3)) - 132);
  return Math.max(-32768, Math.min(32767, sample));
}

module.exports = { WebSdrClient };
