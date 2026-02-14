// Reverse Beacon Network telnet client — streams CW/FT8/RTTY spots for a specific callsign
const net = require('net');
const { EventEmitter } = require('events');
const { freqToBand } = require('./bands');

const DEFAULT_HOST = 'telnet.reversebeacon.net';
const DEFAULT_PORT = 7000;

// Spot line regex: "DX de <spotter>: <freq> <callsign> <comment> <time>Z"
const SPOT_RE = /^DX\s+de\s+(\S+?):\s+(\d+\.?\d*)\s+(\S+)\s+(.*?)\s+(\d{4})Z/i;

// Comment parsing: "CW 24 dB 22 WPM CQ" or "FT8 -12 dB CQ"
const COMMENT_RE = /(\S+)\s+(-?\d+)\s*dB\s+(?:(\d+)\s*WPM\s*)?/i;

class RbnClient extends EventEmitter {
  constructor() {
    super();
    this._socket = null;
    this._buf = '';
    this._reconnectTimer = null;
    this._keepaliveTimer = null;
    this._target = null; // { host, port, callsign }
    this._filterCallsigns = new Set(); // uppercase callsigns to filter for
    this._loggedIn = false;
    this.connected = false;
  }

  connect({ host, port, callsign, watchlist }) {
    this.disconnect();
    this._target = { host: host || DEFAULT_HOST, port: port || DEFAULT_PORT, callsign: callsign || '', watchlist: watchlist || '' };
    // Build filter set from own callsign + watchlist entries
    this._filterCallsigns = new Set();
    if (callsign) this._filterCallsigns.add(callsign.toUpperCase());
    if (watchlist) {
      for (const cs of watchlist.split(',')) {
        const trimmed = cs.trim().toUpperCase();
        if (trimmed) this._filterCallsigns.add(trimmed);
      }
    }
    this._loggedIn = false;

    const sock = new net.Socket();
    this._socket = sock;

    sock.on('data', (chunk) => this._onData(chunk));

    sock.on('connect', () => {
      this.connected = true;
      this.emit('status', { connected: true, host: this._target.host, port: this._target.port });
    });

    sock.on('error', () => { /* handled in close */ });

    sock.on('close', () => {
      this.connected = false;
      this._loggedIn = false;
      this._stopKeepalive();
      this.emit('status', { connected: false, host: this._target.host, port: this._target.port });
      this._scheduleReconnect();
    });

    sock.connect(this._target.port, this._target.host);
  }

  disconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._stopKeepalive();
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
    this._buf = '';
    this._loggedIn = false;
    this.connected = false;
  }

  _onData(chunk) {
    this._buf += chunk.toString();
    let nl;
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl).replace(/\r$/, '');
      this._buf = this._buf.slice(nl + 1);
      this._processLine(line);
    }
    // Check buffer for login prompt (may not end with \n)
    if (!this._loggedIn) {
      this._handleLogin(this._buf);
    }
  }

  _processLine(line) {
    if (!this._loggedIn) {
      this._handleLogin(line);
      return;
    }
    this._parseSpotLine(line);
  }

  _handleLogin(line) {
    const lower = line.toLowerCase();
    if (lower.includes('login:') || lower.includes('call:') || lower.includes('callsign:') ||
        lower.includes('please enter your call') || />\s*$/.test(line)) {
      if (this._target.callsign && !this._loggedIn) {
        this._write(this._target.callsign + '\r\n');
        this._loggedIn = true;
        this._buf = '';
        this._startKeepalive();
      }
    }
  }

  _parseSpotLine(line) {
    const m = line.match(SPOT_RE);
    if (!m) return;

    const spotter = m[1].replace(/:$/, '');
    const freqKhz = parseFloat(m[2]);
    const dxCall = m[3];
    const comment = m[4].trim();
    const timeHHMM = m[5];

    // Client-side filter: only emit spots for our callsign or watchlist
    if (!this._filterCallsigns.has(dxCall.toUpperCase())) return;

    const freqMHz = freqKhz / 1000;
    const band = freqToBand(freqMHz);

    // Parse comment for mode, SNR, WPM
    let mode = '';
    let snr = null;
    let wpm = null;
    let type = '';
    const cm = comment.match(COMMENT_RE);
    if (cm) {
      mode = cm[1].toUpperCase();
      snr = parseInt(cm[2], 10);
      wpm = cm[3] ? parseInt(cm[3], 10) : null;
    }
    // Extract type (CQ, NCDXF, BEACON, etc.) from end of comment
    const typeMatch = comment.match(/\b(CQ|NCDXF|BEACON)\b/i);
    if (typeMatch) type = typeMatch[1].toUpperCase();

    // Build UTC ISO timestamp from HHMM
    const now = new Date();
    const hh = timeHHMM.slice(0, 2);
    const mm = timeHHMM.slice(2, 4);
    const spotTime = `${now.toISOString().slice(0, 10)}T${hh}:${mm}:00Z`;

    this.emit('spot', {
      spotter,
      callsign: dxCall,
      frequency: String(Math.round(freqKhz * 10) / 10),
      freqMHz,
      mode,
      band,
      snr,
      wpm,
      type,
      spotTime,
    });
  }

  _write(data) {
    if (this._socket && this.connected) {
      this._socket.write(data);
    }
  }

  _startKeepalive() {
    this._stopKeepalive();
    this._keepaliveTimer = setInterval(() => {
      this._write('\r\n');
    }, 5 * 60 * 1000);
  }

  _stopKeepalive() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || !this._target) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._target) this.connect(this._target);
    }, 10000);
  }
}

module.exports = { RbnClient, DEFAULT_HOST, DEFAULT_PORT };
