// DX Cluster telnet client — streams live spots from a DX cluster node
const net = require('net');
const { EventEmitter } = require('events');
const { freqToBand } = require('./bands');

// Default cluster nodes (AR-Cluster)
const DEFAULT_HOST = 'w3lpl.net';
const DEFAULT_PORT = 7373;

// Mode inference from comment text
function inferMode(comment, freqKhz) {
  const c = (comment || '').toUpperCase();
  if (c.includes('FT8')) return 'FT8';
  if (c.includes('FT4')) return 'FT4';
  if (c.includes('CW'))  return 'CW';
  if (c.includes('RTTY')) return 'RTTY';
  if (c.includes('SSB') || c.includes('USB') || c.includes('LSB')) return 'SSB';
  if (c.includes('FM'))  return 'FM';
  return inferModeFromFreq(freqKhz);
}

// Frequency-based mode fallback using band plan conventions
function inferModeFromFreq(freqKhz) {
  const f = freqKhz / 1000; // MHz
  const band = freqToBand(f);
  if (!band) return '';

  // CW sub-bands (bottom of each band)
  const cwRanges = {
    '160m': [1800, 1850], '80m': [3500, 3600], '40m': [7000, 7050],
    '30m': [10100, 10150], '20m': [14000, 14070], '17m': [18068, 18110],
    '15m': [21000, 21070], '12m': [24890, 24930], '10m': [28000, 28070],
  };
  const cw = cwRanges[band];
  if (cw && freqKhz >= cw[0] && freqKhz <= cw[1]) return 'CW';

  // Digital sub-bands (just above CW)
  const digiRanges = {
    '80m': [3570, 3600], '40m': [7050, 7080], '20m': [14070, 14100],
    '17m': [18095, 18110], '15m': [21070, 21110], '12m': [24910, 24930],
    '10m': [28070, 28150],
  };
  const digi = digiRanges[band];
  if (digi && freqKhz >= digi[0] && freqKhz <= digi[1]) return 'FT8';

  // Everything else is phone
  return 'SSB';
}

// Spot line regex: "DX de <spotter>: <freq> <callsign> <comment> <time>Z"
const SPOT_RE = /^DX\s+de\s+(\S+?):\s+(\d+\.?\d*)\s+(\S+)\s+(.*?)\s+(\d{4})Z/i;

class DxClusterClient extends EventEmitter {
  constructor() {
    super();
    this._socket = null;
    this._buf = '';
    this._reconnectTimer = null;
    this._keepaliveTimer = null;
    this._target = null; // { host, port, callsign }
    this._loggedIn = false;
    this.connected = false;
    // Intent flag — true while the user wants us disconnected. Stops the
    // socket's 'close' handler from scheduling a reconnect after disconnect(),
    // which caused endless reconnect loops (compounded when 2+ feeds share a
    // callsign and the server kicks one of them).
    this._wantDisconnect = true;
    // Reconnect backoff — doubles on each failure (capped). Reset on a
    // successful socket 'connect'.
    this._reconnectAttempt = 0;
    this._reconnectBaseMs = 10000;
    this._reconnectMaxMs = 5 * 60 * 1000; // 5 min cap
  }

  connect({ host, port, callsign, postLogin } = {}) {
    this.disconnect();
    this._target = { host: host || DEFAULT_HOST, port: port || DEFAULT_PORT, callsign: callsign || '', postLogin };
    this._loggedIn = false;
    this._wantDisconnect = false;

    const sock = new net.Socket();
    this._socket = sock;

    sock.on('data', (chunk) => {
      // Guard against the old-socket race: if disconnect() ran between this
      // data arriving and the handler firing, ignore it.
      if (this._socket !== sock) return;
      this._onData(chunk);
    });

    sock.on('connect', () => {
      if (this._socket !== sock) return;
      this.connected = true;
      this._reconnectAttempt = 0; // reset backoff after a successful connection
      this.emit('status', { connected: true, host: this._target.host, port: this._target.port });
    });

    sock.on('error', () => { /* handled in close */ });

    sock.on('close', () => {
      // Only react if this is still the active socket — stale 'close' events
      // from the previous socket (after connect() replaced it) must not reach
      // scheduleReconnect or we'd fight ourselves.
      if (this._socket !== sock) return;
      this.connected = false;
      this._loggedIn = false;
      this._stopKeepalive();
      this.emit('status', { connected: false, host: this._target && this._target.host, port: this._target && this._target.port });
      // Don't reconnect if the user asked us to stop.
      if (this._wantDisconnect) return;
      this._scheduleReconnect();
    });

    sock.connect(this._target.port, this._target.host);
  }

  disconnect() {
    this._wantDisconnect = true;
    this._target = null;
    this._reconnectAttempt = 0;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._stopKeepalive();
    if (this._socket) {
      const sock = this._socket;
      this._socket = null; // drop the reference BEFORE destroy so stale
                           // event handlers above can bail via _socket !== sock.
      try { sock.removeAllListeners(); } catch {}
      try { sock.destroy(); } catch {}
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
    // Emit raw line for terminal display (before any parsing/filtering)
    this.emit('line', line);

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
        // Send post-login commands (e.g. set/clubs, set/nodupes for CW club spotters)
        if (this._target.postLogin && this._target.postLogin.length > 0) {
          setTimeout(() => {
            for (const cmd of this._target.postLogin) {
              this._write(cmd + '\r\n');
            }
          }, 500);
        }
      }
    } else if (lower.includes('password:')) {
      // DXSpider compat — send callsign again as password
      if (this._target.callsign) {
        this._write(this._target.callsign + '\r\n');
      }
    }
  }

  _parseSpotLine(line) {
    const m = line.match(SPOT_RE);
    if (!m) return;

    const spotter = m[1].replace(/:$/, '');
    const freqKhz = parseFloat(m[2]);
    const dxCallsign = m[3];
    const comment = m[4].trim();
    const timeHHMM = m[5];

    const freqMHz = freqKhz / 1000;
    const mode = inferMode(comment, freqKhz);
    const band = freqToBand(freqMHz);

    // Build UTC ISO timestamp from HHMM (use today's date)
    const now = new Date();
    const hh = timeHHMM.slice(0, 2);
    const mm = timeHHMM.slice(2, 4);
    const spotTime = `${now.toISOString().slice(0, 10)}T${hh}:${mm}:00Z`;

    this.emit('spot', {
      spotter,
      callsign: dxCallsign,
      frequency: String(Math.round(freqKhz * 10) / 10), // kHz string to match POTA format
      freqMHz,
      mode,
      band,
      comment,
      spotTime,
    });
  }

  sendSpot({ frequency, callsign, comment }) {
    if (!this.connected || !this._loggedIn) return false;
    this._write(`DX ${parseFloat(frequency).toFixed(1)} ${callsign} ${comment || ''}\r\n`);
    return true;
  }

  sendCommand(text) {
    if (!this.connected || !this._loggedIn) return false;
    this._write(text + '\r\n');
    return true;
  }

  _write(data) {
    if (this._socket && this.connected) {
      this._socket.write(data);
    }
  }

  _startKeepalive() {
    this._stopKeepalive();
    // Send newline every 5 minutes to prevent NAT timeout
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
    if (this._reconnectTimer || !this._target || this._wantDisconnect) return;
    // Exponential backoff — 10s, 20s, 40s, ... capped at 5 min. Prevents
    // hammering a server that's rejecting the connection (e.g. duplicate
    // callsign logins when multiple feeds are enabled).
    const delay = Math.min(this._reconnectBaseMs * Math.pow(2, this._reconnectAttempt), this._reconnectMaxMs);
    this._reconnectAttempt++;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._target && !this._wantDisconnect) this.connect(this._target);
    }, delay);
  }
}

module.exports = { DxClusterClient, DEFAULT_HOST, DEFAULT_PORT };
