// DX Cluster telnet client — streams live spots from a DX cluster node
const net = require('net');
const { EventEmitter } = require('events');
const { freqToBand } = require('./bands');

// No DEFAULT_HOST any more. POTACAT used to ship w3lpl.net as the default
// node, so every install that switched the cluster on without choosing one
// piled onto a single volunteer's machine — and when that node was rebuilt as
// DXSpider and started refusing logins, the reconnect bug below turned the
// whole user base into a retry storm (KD4D, 2026-08-04). A node is now an
// explicit choice: connect() refuses without a host.
const DEFAULT_PORT = 7373;

// Reconnect policy. The backoff is the ONLY thing standing between a node
// that refuses us and thousands of connections a day, so the reset rule is
// deliberately strict: see _markHealthy().
const RECONNECT_BASE_MS = 10000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;
const RECONNECT_JITTER = 0.2;   // ±20% so multiple instances don't march in lockstep
const MAX_FAILED_SESSIONS = 5;  // then stop entirely until the user changes something
const HEALTHY_AFTER_MS = 60000; // logged in this long without a drop = a real session

// Node responses that mean "you are not getting in" — retrying these at any
// rate is pointless and rude. Checked only on NON-spot lines: a spot comment
// can legitimately contain words like "not registered" and must never be
// mistaken for a rejection.
const REJECT_RE = /(not\s+a\s+valid|invalid\s+call|unknown\s+call|not\s+registered|please\s+register|access\s+denied|permission\s+denied|not\s+allowed|login\s+(?:failed|incorrect)|too\s+many\s+connections|already\s+connected|bad\s+call)/i;

// Mode inference from comment text
function inferMode(comment, freqKhz) {
  const c = (comment || '').toUpperCase();
  if (c.includes('FT8')) return 'FT8';
  if (c.includes('FT4')) return 'FT4';
  if (c.includes('JS8')) return 'JS8';
  if (c.includes('CW'))  return 'CW';
  if (c.includes('RTTY')) return 'RTTY';
  // Order matters: PSK31 must be checked before bare PSK so the more
  // specific token wins. PSK without a digit is rare in cluster spots
  // but worth a fallback.
  if (c.includes('PSK31')) return 'PSK31';
  if (c.includes(' PSK') || c.startsWith('PSK')) return 'PSK31';
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
    this._target = null; // { host, port, callsign, password }
    this._loggedIn = false;
    this._sentLogin = false;
    this._loginFallbackTimer = null;
    this.connected = false;
    // Intent flag — true while the user wants us disconnected. Stops the
    // socket's 'close' handler from scheduling a reconnect after disconnect(),
    // which caused endless reconnect loops (compounded when 2+ feeds share a
    // callsign and the server kicks one of them).
    this._wantDisconnect = true;
    // Reconnect backoff — doubles on each FAILED session (capped). Reset only
    // by _markHealthy(); see the comment there for why "socket connected" is
    // not good enough.
    this._reconnectAttempt = 0;
    this._reconnectBaseMs = RECONNECT_BASE_MS;
    this._reconnectMaxMs = RECONNECT_MAX_MS;
    this._failedSessions = 0;   // consecutive sessions that never went healthy
    this._sessionHealthy = false;
    this._healthyTimer = null;
    this._gaveUp = false;       // hard stop after MAX_FAILED_SESSIONS
    this._rejectReason = '';    // last rejection text the node sent us
  }

  connect({ host, port, callsign, password, postLogin } = {}) {
    // Internal teardown — must NOT reset the backoff. disconnect() did, and
    // connect() called it, so every automatic reconnect zeroed the counter
    // and the backoff could never grow past its 10 s floor even with the
    // 'connect'-handler reset fixed. Two independent resets, one loop.
    this._teardown();
    if (!host) {
      // No node configured. Refuse rather than defaulting onto someone's
      // machine (see the DEFAULT_HOST note above).
      this._target = null;
      this.emit('status', { connected: false, error: 'No cluster node configured — choose one in Settings > Spots.' });
      return;
    }
    this._target = { host, port: port || DEFAULT_PORT, callsign: callsign || '', password: password || '', postLogin };
    this._loggedIn = false;
    this._sentLogin = false;
    this._wantDisconnect = false;
    this._sessionHealthy = false;
    this._rejectReason = '';

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
      // NOTE: the backoff is deliberately NOT reset here. A node that accepts
      // the TCP connection and then refuses us at login fires this event on
      // every single attempt, so resetting here pinned the retry interval at
      // the 10 s floor forever — the bug that had POTACAT opening ~8,600
      // connections a day per instance at KD4D's node (2026-08-04).
      this.emit('status', { connected: true, host: this._target.host, port: this._target.port });
    });

    // Socket errors were swallowed entirely, which is why a refusing node
    // produced a retry storm with NOT ONE line in the log. Surface it.
    sock.on('error', (err) => {
      if (this._socket !== sock) return;
      this.emit('log', `[cluster] ${this._target ? this._target.host : 'node'}: ${err && err.message ? err.message : err}`);
    });

    sock.on('close', () => {
      // Only react if this is still the active socket — stale 'close' events
      // from the previous socket (after connect() replaced it) must not reach
      // scheduleReconnect or we'd fight ourselves.
      if (this._socket !== sock) return;
      this.connected = false;
      this._loggedIn = false;
      this._sentLogin = false;
      if (this._loginFallbackTimer) {
        clearTimeout(this._loginFallbackTimer);
        this._loginFallbackTimer = null;
      }
      this._stopHealthyTimer();
      this._stopKeepalive();
      const host = this._target && this._target.host;
      this.emit('status', { connected: false, host, port: this._target && this._target.port });
      // Don't reconnect if the user asked us to stop.
      if (this._wantDisconnect) return;
      // A session that never proved healthy counts as a failure. Enough of
      // those in a row and we stop for good rather than retrying a node that
      // clearly isn't going to have us.
      if (!this._sessionHealthy) {
        this._failedSessions++;
        if (this._failedSessions >= MAX_FAILED_SESSIONS) {
          this._gaveUp = true;
          const why = this._rejectReason
            ? `the node said: ${this._rejectReason}`
            : `${MAX_FAILED_SESSIONS} connections in a row ended before any spots arrived`;
          const call = (this._target && this._target.callsign) || '(no callsign)';
          const msg = `Gave up on ${host} — ${why}. Check the callsign (${call}) and node settings, then re-enable the cluster to try again.`;
          this.emit('log', `[cluster] ${msg}`);
          this.emit('status', { connected: false, host, gaveUp: true, error: msg });
          return;
        }
      }
      this._scheduleReconnect();
    });

    sock.connect(this._target.port, this._target.host);
  }

  /**
   * User intent: stop, and forget the retry history. Safe to reset the
   * backoff here — the operator asked for this, so the next connect() is a
   * fresh decision rather than a continuation of a failing loop.
   */
  disconnect() {
    this._wantDisconnect = true;
    this._target = null;
    this._reconnectAttempt = 0;
    this._failedSessions = 0;
    this._gaveUp = false;
    this._teardown();
  }

  /**
   * Drop the socket and per-session state WITHOUT touching the retry
   * history. Used by connect() so an automatic reconnect can't launder its
   * own failure count (this was the second of the two backoff resets).
   */
  _teardown() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._stopKeepalive();
    this._stopHealthyTimer();
    if (this._socket) {
      const sock = this._socket;
      this._socket = null; // drop the reference BEFORE destroy so stale
                           // event handlers above can bail via _socket !== sock.
      try { sock.removeAllListeners(); } catch {}
      try { sock.destroy(); } catch {}
    }
    this._buf = '';
    this._loggedIn = false;
    this._sentLogin = false;
    if (this._loginFallbackTimer) {
      clearTimeout(this._loginFallbackTimer);
      this._loginFallbackTimer = null;
    }
    this.connected = false;
  }

  /**
   * This connection is real: reset the retry history. "Real" means the node
   * actually gave us something — a parsed spot, or a full minute logged in
   * without being dropped. Deliberately NOT "the socket opened" and NOT "we
   * sent our callsign": a node that refuses us does both of those on every
   * attempt, which is exactly how the retry storm stayed invisible.
   */
  _markHealthy() {
    if (this._sessionHealthy) return;
    this._sessionHealthy = true;
    this._reconnectAttempt = 0;
    this._failedSessions = 0;
    this._stopHealthyTimer();
  }

  _startHealthyTimer() {
    this._stopHealthyTimer();
    this._healthyTimer = setTimeout(() => {
      this._healthyTimer = null;
      if (this.connected && this._loggedIn) this._markHealthy();
    }, HEALTHY_AFTER_MS);
    // Never hold the process open just to declare a connection healthy.
    if (typeof this._healthyTimer.unref === 'function') this._healthyTimer.unref();
  }

  _stopHealthyTimer() {
    if (this._healthyTimer) {
      clearTimeout(this._healthyTimer);
      this._healthyTimer = null;
    }
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

    // Rejection check runs on non-spot lines only — a spot COMMENT can carry
    // words like "not registered" and must never be read as the node
    // refusing us. A rejection ends the session immediately so the backoff
    // (and eventually the give-up latch) can do their job.
    if (!SPOT_RE.test(line) && REJECT_RE.test(line)) {
      this._rejectReason = line.trim().slice(0, 120);
      this.emit('log', `[cluster] ${this._target ? this._target.host : 'node'} refused the login: ${this._rejectReason}`);
      this._sessionHealthy = false;
      this._stopHealthyTimer();
      if (this._socket) { try { this._socket.destroy(); } catch {} }
      return;
    }

    if (!this._loggedIn) {
      this._handleLogin(line);
      return;
    }
    this._parseSpotLine(line);
  }

  _handleLogin(line) {
    const lower = line.toLowerCase();
    if (lower.includes('password:')) {
      // A configured password answers the prompt — HamAlert's telnet feed
      // (hamalert.org:7300) authenticates username + password (G5HOW).
      // Without one, keep the old DXSpider compat of re-sending the callsign
      // and let the login-prompt branch finish the handshake.
      if (this._target.password) {
        this._write(this._target.password + '\r\n');
        this._finishLogin();
      } else if (this._target.callsign) {
        this._write(this._target.callsign + '\r\n');
      }
      return;
    }
    if (lower.includes('login:') || lower.includes('call:') || lower.includes('callsign:') ||
        lower.includes('please enter your call') || />\s*$/.test(line)) {
      if (this._target.callsign && !this._sentLogin && !this._loggedIn) {
        this._sentLogin = true;
        this._write(this._target.callsign + '\r\n');
        this._buf = '';
        if (this._target.password) {
          // Stay in login mode so the upcoming password: prompt is answered.
          // Fallback finishes the handshake anyway if this server never asks
          // (password configured on a node that doesn't want one).
          this._loginFallbackTimer = setTimeout(() => this._finishLogin(), 8000);
        } else {
          this._finishLogin();
        }
      }
    }
  }

  _finishLogin() {
    if (this._loggedIn) return;
    if (this._loginFallbackTimer) {
      clearTimeout(this._loginFallbackTimer);
      this._loginFallbackTimer = null;
    }
    this._loggedIn = true;
    this._buf = '';
    this._startKeepalive();
    // Being logged in is NOT proof of anything — we set this flag ourselves
    // after sending the callsign, whether or not the node accepted it. Start
    // the clock instead: survive a minute and the session counts as real.
    this._startHealthyTimer();
    // Send post-login commands (e.g. set/clubs, set/nodupes for CW club spotters)
    if (this._target && this._target.postLogin && this._target.postLogin.length > 0) {
      setTimeout(() => {
        for (const cmd of this._target.postLogin) {
          this._write(cmd + '\r\n');
        }
      }, 500);
    }
  }

  _parseSpotLine(line) {
    const m = line.match(SPOT_RE);
    if (!m) return;
    // A parsed spot is proof the node is actually feeding us — the strongest
    // possible signal that this session is real.
    this._markHealthy();

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
    if (this._reconnectTimer || !this._target || this._wantDisconnect || this._gaveUp) return;
    // Exponential backoff — 10s, 20s, 40s, ... capped at 5 min, ±20% jitter
    // so several instances (or several nodes) don't retry in lockstep and
    // arrive at a struggling server as a burst.
    const base = Math.min(this._reconnectBaseMs * Math.pow(2, this._reconnectAttempt), this._reconnectMaxMs);
    const delay = Math.round(base * (1 + (Math.random() * 2 - 1) * RECONNECT_JITTER));
    this._reconnectAttempt++;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._target && !this._wantDisconnect) this.connect(this._target);
    }, delay);
  }
}

/**
 * Structural callsign check — is this even shaped like an amateur callsign?
 * A public cluster login is not the place to send whatever happens to be in
 * the callsign box: POTACAT dialed KD4D's node as "POTACAT-DEMO-1" and got
 * (correctly) refused on every attempt. Deliberately permissive about real
 * callsigns (1x1s, portable/prefix slashes, up to a 4-char suffix) and only
 * strict enough to catch things that plainly are not callsigns.
 */
function looksLikeCallsign(call) {
  const c = String(call || '').trim().toUpperCase();
  if (!c || c.length > 16) return false;
  // Optional prefix (VE3/), the call itself, optional suffix (/P, /QRP, -7)
  return /^(?:[A-Z0-9]{1,4}\/)?[A-Z0-9]{0,2}\d[A-Z]{1,4}(?:\/[A-Z0-9]{1,4})?(?:-\d{1,2})?$/.test(c);
}

module.exports = { DxClusterClient, DEFAULT_PORT, REJECT_RE, looksLikeCallsign };
