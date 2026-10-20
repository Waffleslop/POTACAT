// Reverse Beacon Network telnet client — streams CW/FT8/RTTY spots for a specific callsign
const net = require('net');
const { EventEmitter } = require('events');
const { freqToBand } = require('./bands');

const DEFAULT_HOST = 'telnet.reversebeacon.net';
const DEFAULT_PORT = 7000;

// Reconnect policy — see lib/dxcluster.js for the incident that produced it.
const RECONNECT_BASE_MS = 10000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;
const RECONNECT_JITTER = 0.2;

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
    this._watchdogTimer = null;
    this._lastDataAt = 0;
    this._target = null; // { host, port, callsign }
    this._filterCallsigns = new Set(); // uppercase callsigns to filter for
    this._loggedIn = false;
    this.connected = false;
    // Intent flag + backoff, mirroring DxClusterClient. Without these,
    // disconnect() destroyed the socket while leaving its 'close' listener
    // attached, so turning RBN OFF still scheduled a reconnect 10 s later —
    // and a refusing/unreachable server was retried at a flat 10 s forever
    // (reversebeacon.net, same class of bug as the cluster storm 2026-08-04).
    this._wantDisconnect = true;
    this._reconnectAttempt = 0;
    this._sessionHealthy = false;
  }

  connect({ host, port, callsign, watchlist }) {
    this._teardown();
    this._wantDisconnect = false;
    this._sessionHealthy = false;
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
    // TCP keepalive lets the OS detect half-open connections (NAT timeout,
    // server crash without FIN) — without it a stale socket can sit forever
    // showing "connected" while no spots arrive. 60s idle, then probes.
    sock.setKeepAlive(true, 60000);
    sock.setNoDelay(true);

    sock.on('data', (chunk) => {
      if (this._socket !== sock) return; // stale socket after a reconnect
      this._onData(chunk);
    });

    sock.on('connect', () => {
      if (this._socket !== sock) return;
      this.connected = true;
      this._lastDataAt = Date.now();
      this._startWatchdog();
      this.emit('status', { connected: true, host: this._target.host, port: this._target.port });
    });

    sock.on('error', (err) => {
      if (this._socket !== sock) return;
      this.emit('log', `[RBN] ${this._target ? this._target.host : 'server'}: ${err && err.message ? err.message : err}`);
    });

    sock.on('close', () => {
      if (this._socket !== sock) return;
      this.connected = false;
      this._loggedIn = false;
      this._stopKeepalive();
      this._stopWatchdog();
      this.emit('status', { connected: false, host: this._target.host, port: this._target.port });
      if (this._wantDisconnect) return; // the user asked us to stop
      this._scheduleReconnect();
    });

    sock.connect(this._target.port, this._target.host);
  }

  /** User intent: stop, and forget the retry history. */
  disconnect() {
    this._wantDisconnect = true;
    this._reconnectAttempt = 0;
    this._teardown();
  }

  /** Drop the socket without laundering the retry history (see dxcluster.js). */
  _teardown() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._stopKeepalive();
    this._stopWatchdog();
    if (this._socket) {
      const sock = this._socket;
      this._socket = null; // clear BEFORE destroy so stale handlers bail out
      try { sock.removeAllListeners(); } catch {}
      try { sock.destroy(); } catch {}
    }
    this._buf = '';
    this._loggedIn = false;
    this.connected = false;
  }

  _onData(chunk) {
    this._lastDataAt = Date.now();
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
    this._markHealthy(); // real data — this session counts

    const spotter = m[1].replace(/:$/, '');
    const freqKhz = parseFloat(m[2]);
    const dxCall = m[3];
    const comment = m[4].trim();
    const timeHHMM = m[5];

    // Every skimmed CW speed, before the filter: POTACAT shows it on the CW
    // spots that carry none (POTA/SOTA/WWFF — lib/cw-speed.js). One cheap
    // event per CW line; the spot itself is still filtered below.
    if (comment.indexOf('WPM') >= 0 && this.listenerCount('cw-speed')) {
      const sm = comment.match(COMMENT_RE);
      if (sm && sm[3] && /^CW$/i.test(sm[1])) this.emit('cw-speed', { callsign: dxCall, freqKhz, wpm: parseInt(sm[3], 10) });
    }

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

  // RBN is a firehose — any healthy connection sees data every few seconds.
  // If we go ~3 min with no bytes (no spots, no banner, no keepalive echo),
  // assume the connection is wedged and tear it down so the close handler
  // schedules a reconnect.
  _startWatchdog() {
    this._stopWatchdog();
    this._watchdogTimer = setInterval(() => {
      if (!this._socket || !this.connected) return;
      const idleMs = Date.now() - this._lastDataAt;
      if (idleMs > 3 * 60 * 1000) {
        this.emit('status', { connected: false, host: this._target.host, port: this._target.port, reason: 'idle-watchdog' });
        try { this._socket.destroy(); } catch {}
      }
    }, 30 * 1000);
  }

  _stopWatchdog() {
    if (this._watchdogTimer) {
      clearInterval(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || !this._target || this._wantDisconnect) return;
    // Exponential backoff with jitter, capped — was a flat 10 s retry with no
    // ceiling, which pounds reversebeacon.net when it's refusing or down.
    // Reset only once a session actually delivers a spot (_markHealthy).
    const base = Math.min(RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempt), RECONNECT_MAX_MS);
    const delay = Math.round(base * (1 + (Math.random() * 2 - 1) * RECONNECT_JITTER));
    this._reconnectAttempt++;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._target && !this._wantDisconnect) this.connect(this._target);
    }, delay);
  }

  /** A parsed spot proves the feed is real — only then clear the backoff. */
  _markHealthy() {
    if (this._sessionHealthy) return;
    this._sessionHealthy = true;
    this._reconnectAttempt = 0;
  }
}

module.exports = { RbnClient, DEFAULT_HOST, DEFAULT_PORT };
