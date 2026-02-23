// SmartSDR TCP API client — pushes spot markers to FlexRadio panadapter
const net = require('net');
const { EventEmitter } = require('events');

const SOURCE_COLORS = {
  pota: '#FF4ECCA3',
  sota: '#FFF0A500',
  dxc:  '#FFE040FB',
  rbn:  '#FF4FC3F7',
  pskr: '#FFFF6B6B',
};

const SOURCE_LIFETIMES = {
  pota: 600,
  sota: 600,
  dxc:  300,
  rbn:  120,
  pskr: 300,
};

class SmartSdrClient extends EventEmitter {
  constructor() {
    super();
    this._sock = null;
    this._seq = 1;
    this._buf = '';
    this._reconnectTimer = null;
    this.connected = false;
    this._host = null;
    this._activeSpots = new Set();   // callsigns added in current push cycle
    this._previousSpots = new Set(); // callsigns from last push cycle (for pruning)
    this._spotFreqs = new Map();     // callsign → last pushed freqMHz (for band-change dedup)
    this._clientHandle = null;       // our client handle from SmartSDR (H<hex>)
    this._persistentId = null;       // persistent client_id for client gui
    // CW state
    this._needsCw = false;           // true when CW keyer is active
    this._cwBound = false;           // true if client bind succeeded
    this._bindSeq = null;            // seq of client bind command
    this._discoveredGuiClients = []; // UUIDs of discovered GUI clients from status messages
    this._cwMoxActive = false;       // true when MOX is on for CW keying
    this._cwMoxTimer = null;         // holdoff timer to release MOX after keying stops
    this._cwMoxHoldoff = 500;        // ms to hold MOX after last key event
  }

  setPersistentId(id) {
    this._persistentId = id || null;
  }

  setNeedsCw(needs) {
    this._needsCw = !!needs;
    // If we're already connected and CW just became needed, try to bind
    if (this._needsCw && this.connected && !this._cwBound) {
      this._tryClientBind();
    }
  }

  connect(host) {
    this.disconnect();
    this._host = host || '127.0.0.1';
    this._doConnect();
  }

  _doConnect() {
    const sock = new net.Socket();
    sock.setNoDelay(true);
    this._sock = sock;

    sock.on('connect', () => {
      this.connected = true;
      this._cwBound = false;
      this._discoveredGuiClients = [];
      this._cwKeyIndex = 0;

      // Subscribe to client updates so we can discover GUI clients for binding
      this._send('sub client all');

      // If CW keyer is active, bind to existing GUI client after status messages arrive
      if (this._needsCw) {
        setTimeout(() => this._tryClientBind(), 500);
      }

      this.emit('connected');
    });

    sock.on('data', (chunk) => {
      this._buf += chunk.toString();
      let nl;
      while ((nl = this._buf.indexOf('\n')) !== -1) {
        const line = this._buf.slice(0, nl).replace(/\r$/, '');
        this._buf = this._buf.slice(nl + 1);
        this._handleLine(line);
      }
    });

    sock.on('error', (err) => {
      this.emit('error', err);
    });

    sock.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this._sock = null;
      this._cwBound = false;
      if (wasConnected) this.emit('disconnected');
      this._scheduleReconnect();
    });

    sock.connect(4992, this._host);
  }

  _tryClientBind() {
    if (this._cwBound) return;
    // Bind to an existing GUI client so CW key/speed/power work correctly
    if (this._discoveredGuiClients.length === 0) {
      console.log('[SmartSDR] No GUI clients discovered to bind to. CW key commands may still work.');
      this.emit('cw-auth', { method: 'unbound', ok: true });
      return;
    }
    const targetId = this._discoveredGuiClients[0];
    console.log(`[SmartSDR] Attempting client bind to GUI client ${targetId}...`);
    this._bindSeq = this._send(`client bind client_id=${targetId}`);
  }

  _handleLine(line) {
    // Parse client handle: H<hex>
    const hMatch = line.match(/^H([0-9A-Fa-f]+)/);
    if (hMatch) {
      this._clientHandle = hMatch[1];
      console.log(`[SmartSDR] handle: ${this._clientHandle}`);
      return;
    }

    // Version
    if (line.startsWith('V')) {
      console.log(`[SmartSDR] version: ${line.slice(1)}`);
      return;
    }

    // Parse status messages: S<handle>|<status content>
    if (line.startsWith('S')) {
      this._parseStatusMessage(line);
      return;
    }

    // Parse command responses: R<seq>|<status code>|<message>
    const rMatch = line.match(/^R(\d+)\|([0-9A-Fa-f]+)/);
    if (rMatch) {
      const seq = parseInt(rMatch[1]);
      const status = parseInt(rMatch[2], 16);

      // Check if this is the response to our client bind command
      if (this._bindSeq !== null && seq === this._bindSeq) {
        this._bindSeq = null;
        if (status === 0) {
          console.log('[SmartSDR] client bind succeeded — bound to GUI client for CW');
          this._cwBound = true;
          this.emit('cw-auth', { method: 'bind', ok: true });
        } else {
          console.log(`[SmartSDR] client bind failed (status 0x${status.toString(16)}). CW key commands may still work.`);
          this.emit('cw-auth', { method: 'unbound', ok: true });
        }
        return;
      }

      // Only log errors — suppress successful spot ACKs
      if (status !== 0 && status !== 0x50001000) {
        console.log(`[SmartSDR] cmd error: R${seq}|${status.toString(16)}|${line}`);
        this.emit('cmd-error', { seq, status, line });
      }
    }
  }

  _parseStatusMessage(line) {
    // Status messages look like:
    // S<handle>|client 0x4E1DDC50 connected local_ptt=1 client_id=FC77859A-... program=SmartSDR-Win station=...
    // We need the client_id UUID for `client bind client_id=<UUID>`
    const idMatch = line.match(/client_id=([0-9A-Fa-f-]+)/);
    if (idMatch) {
      const clientId = idMatch[1];
      // Only add if not our own persistent ID and not already discovered
      if (clientId !== this._persistentId && !this._discoveredGuiClients.includes(clientId)) {
        this._discoveredGuiClients.push(clientId);
        console.log(`[SmartSDR] Discovered GUI client_id: ${clientId} (total: ${this._discoveredGuiClients.length})`);
      }
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this.connected && this._host) {
        this._doConnect();
      }
    }, 5000);
  }

  _send(cmd) {
    if (!this._sock || !this.connected) return null;
    const seq = this._seq++;
    this._sock.write(`C${seq}|${cmd}\n`);
    return seq;
  }

  addSpot(spot) {
    const freqMHz = spot.freqMHz;
    if (!freqMHz || isNaN(freqMHz)) return;
    const callsign = (spot.callsign || '').replace(/\s/g, '');
    if (!callsign) return;
    const mode = spot.mode || '';
    const color = SOURCE_COLORS[spot.source] || SOURCE_COLORS.pota;
    const lifetime = SOURCE_LIFETIMES[spot.source] || 600;
    const comment = (spot.reference || spot.parkName || '').slice(0, 40).replace(/\s/g, '_');

    // If this callsign was previously at a different frequency, remove the old spot first
    const prevFreq = this._spotFreqs.get(callsign);
    if (prevFreq !== undefined && Math.abs(prevFreq - freqMHz) > 0.0005) {
      this._send(`spot remove callsign=${callsign} source=POTACAT`);
    }

    this._send(
      `spot add rx_freq=${freqMHz.toFixed(6)} callsign=${callsign} mode=${mode} color=${color} source=POTACAT trigger_action=tune lifetime_seconds=${lifetime}` +
      (comment ? ` comment=${comment}` : '')
    );
    this._activeSpots.add(callsign);
    this._spotFreqs.set(callsign, freqMHz);
  }

  /**
   * Remove spots that are no longer in the current spot list.
   * Call after adding all current spots to clean up stale ones.
   */
  pruneStaleSpots() {
    for (const call of this._previousSpots) {
      if (!this._activeSpots.has(call)) {
        this._send(`spot remove callsign=${call} source=POTACAT`);
        this._spotFreqs.delete(call);
      }
    }
    this._previousSpots = new Set(this._activeSpots);
    this._activeSpots.clear();
  }

  clearSpots() {
    this._send('spot clear');
    this._activeSpots.clear();
    this._previousSpots.clear();
    this._spotFreqs.clear();
  }

  /**
   * Tune a slice to a frequency and optionally set mode and filter.
   * @param {number} sliceIndex - 0=A, 1=B, 2=C, 3=D
   * @param {number} freqMhz - Frequency in MHz (e.g. 7.074000)
   * @param {string} [mode] - FlexRadio mode string (e.g. 'DIGU', 'USB', 'CW')
   * @param {number} [filterWidth] - Filter passband width in Hz (0 = radio default)
   */
  tuneSlice(sliceIndex, freqMhz, mode, filterWidth) {
    this._send(`slice tune ${sliceIndex} ${freqMhz.toFixed(6)} autopan=1`);
    if (mode) {
      this._send(`slice set ${sliceIndex} mode=${mode}`);
    }
    if (filterWidth > 0 && mode) {
      const m = (mode || '').toUpperCase();
      let lo, hi;
      if (m === 'CW') {
        lo = Math.max(0, 600 - Math.round(filterWidth / 2));
        hi = 600 + Math.round(filterWidth / 2);
      } else {
        lo = 100;
        hi = 100 + filterWidth;
      }
      this._send(`slice set ${sliceIndex} filter_lo=${lo} filter_hi=${hi}`);
    }
  }

  // --- CW keying methods ---
  // Direct key-down/key-up via `cw key 0|1` preserves operator's fist.
  // MOX (xmit) used for PTT with holdoff timer to auto-release after keying stops.

  /**
   * Direct CW key command — key down or up with operator's exact timing.
   * @param {boolean} down - true for key down, false for key up
   */
  cwKey(down) {
    this._send(`cw key ${down ? 1 : 0}`);
  }

  /**
   * Activate MOX (PTT) for CW transmission.
   * Call before first key-down; auto-released by cwMoxRelease() after keying stops.
   */
  cwMoxOn() {
    if (!this._cwMoxActive) {
      console.log('[SmartSDR] MOX on');
      this._send('xmit 1');
      this._cwMoxActive = true;
    }
    // Reset holdoff timer on every call
    if (this._cwMoxTimer) clearTimeout(this._cwMoxTimer);
    this._cwMoxTimer = setTimeout(() => this.cwMoxRelease(), this._cwMoxHoldoff);
  }

  cwMoxRelease() {
    if (this._cwMoxTimer) { clearTimeout(this._cwMoxTimer); this._cwMoxTimer = null; }
    if (this._cwMoxActive) {
      console.log('[SmartSDR] MOX off');
      this._send('xmit 0');
      this._cwMoxActive = false;
    }
  }

  setCwSpeed(wpm) {
    this._send(`cw wpm ${wpm}`);
  }

  cwStop() {
    this.cwKey(false);
    this.cwMoxRelease();
  }

  /**
   * Send text as CW through the radio's built-in software keyer (cwx).
   * Fallback method — use cwKey() for direct keying.
   */
  cwxSend(text) {
    if (!text) return;
    const escaped = text.replace(/ /g, '\x7F');
    this._send(`cwx send "${escaped}"`);
  }

  disconnect() {
    this.cwMoxRelease();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._host = null;
    if (this._sock) {
      try {
        this._sock.end();
        const sock = this._sock;
        setTimeout(() => { try { sock.destroy(); } catch {} }, 500);
      } catch { /* ignore */ }
      this._sock = null;
    }
    this.connected = false;
    this._cwBound = false;
  }
}

module.exports = { SmartSdrClient };
