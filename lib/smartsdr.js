// SmartSDR TCP API client — pushes spot markers to FlexRadio panadapter
const net = require('net');
const dgram = require('dgram');
const { EventEmitter } = require('events');

const SOURCE_COLORS_NORMAL = {
  pota: '#FF4ECCA3',
  sota: '#FFF0A500',
  dxc:  '#FFE040FB',
  rbn:  '#FF4FC3F7',
  pskr: '#FFFF6B6B',
  net:  '#FFFFD740',
};
const SOURCE_COLORS_CB = {
  pota: '#FF4FC3F7',
  sota: '#FFFFB300',
  dxc:  '#FFE040FB',
  rbn:  '#FF81D4FA',
  pskr: '#FFFFA726',
  net:  '#FFFFD740',
};
let SOURCE_COLORS = { ...SOURCE_COLORS_NORMAL };

const SOURCE_LIFETIMES = {
  pota: 600,
  sota: 600,
  dxc:  300,
  rbn:  120,
  pskr: 300,
  net:  3600,
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
    this._guiClientHandle = null;    // hex handle of GUI client (e.g. '4E1DDC50') for cw key
    this._cwKeyIndex = 0;            // incrementing index for cw key dedup
    this._cwPttActive = false;       // true when cw ptt is active
    this._cwPttTimer = null;         // holdoff timer to release cw ptt
    this._cwPttHoldoff = 1500;       // ms to hold PTT after last key event (avoids re-keying between words)
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

  setNeedsBind(needs) {
    this._needsBind = !!needs;
    if (this._needsBind && this.connected && !this._cwBound) {
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
      // Subscribe to ATU so atu set commands work
      this._send('sub atu all');
      // Subscribe to slice meters and set up UDP for binary meter data
      this._send('sub meter all');
      this._setupMeterUdp();
      // Re-request meter list after a delay to ensure definitions are parsed
      setTimeout(() => {
        if (this.connected) this._send('meter list');
      }, 1500);

      // If CW keyer or rig controls need binding, bind to existing GUI client
      if (this._needsCw || this._needsBind) {
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

      // Parse meter definitions from 'meter list' response
      if (status === 0 && line.includes('.src=') && line.includes('.nam=')) {
        this._parseStatusMessage(line);
      }

      // Only log errors — suppress successful spot ACKs
      if (status !== 0 && status !== 0x50001000) {
        console.log(`[SmartSDR] cmd error: R${seq}|${status.toString(16)}|${line}`);
        this.emit('cmd-error', { seq, status, line });
      }
    }
  }

  // --- UDP meter binary stream ---
  _setupMeterUdp() {
    if (this._meterSock) return;
    this._meterIds = {}; // id → { src, num, nam, unit }
    this._smeterMeterId = null;
    this._swrMeterId = null;

    const sock = dgram.createSocket('udp4');
    this._meterSock = sock;

    sock.on('message', (buf) => this._parseMeterPacket(buf));
    sock.on('error', (err) => console.error('[SmartSDR] Meter UDP error:', err.message));

    sock.bind(0, () => {
      const port = sock.address().port;
      console.log(`[SmartSDR] Meter UDP listening on port ${port}`);
      this._send(`client udpport ${port}`);
    });
  }

  _closeMeterUdp() {
    if (this._meterSock) {
      try { this._meterSock.close(); } catch {}
      this._meterSock = null;
    }
  }

  _parseMeterPacket(buf) {
    if (buf.length < 28) return;
    // Verify vita49: packet type 0x03 (ExtDataWithStream), class present
    if ((buf[0] & 0xF8) !== 0x38) return;
    // Verify stream ID = 0x00000700 (meter)
    const streamId = buf.readUInt32BE(4);
    if (streamId !== 0x00000700) return;
    // Verify packet class = 0x8002 (meter)
    const packetClass = buf.readUInt16BE(14);
    if (packetClass !== 0x8002) return;

    // Payload starts at byte 28, each meter entry is 4 bytes
    const payloadStart = 28;
    const numMeters = Math.floor((buf.length - payloadStart) / 4);

    for (let i = 0; i < numMeters; i++) {
      const offset = payloadStart + i * 4;
      const meterId = buf.readUInt16BE(offset);
      const rawValue = buf.readInt16BE(offset + 2);

      if (meterId === this._smeterMeterId) {
        // S-meter: dBm, divide by 128
        const dbm = rawValue / 128.0;
        // Convert dBm to 0-255: -120 dBm = 0, S9 (-73) ≈ 109, 0 dBm = 255
        const scaled = Math.max(0, Math.min(255, Math.round((dbm + 120) * 255 / 110)));
        this.emit('smeter', scaled);
      } else if (meterId === this._swrMeterId) {
        // SWR: divide by 128
        const swr = rawValue / 128.0;
        if (swr >= 1.0) {
          this.emit('swr-ratio', swr);
        }
      }
    }
  }

  _parseStatusMessage(line) {
    // Parse meter definitions to find S-meter and SWR meter IDs
    if (line.includes('.src=') && line.includes('.nam=')) {
      const entries = line.split('#').filter(s => s.includes('='));
      const meters = {};
      for (const entry of entries) {
        const m = entry.match(/^(\d+)\.(\w+)=(.*)$/);
        if (m) {
          const id = m[1];
          if (!meters[id]) meters[id] = {};
          meters[id][m[2]] = m[3];
        }
      }
      for (const [id, m] of Object.entries(meters)) {
        if (m.src && m.nam) {
          const numId = parseInt(id, 10);
          this._meterIds[numId] = m;
          // Find S-meter: src=SLC, nam=LEVEL, num=0 (slice A)
          if (m.src === 'SLC' && m.nam === 'LEVEL' && (m.num === '0' || !this._smeterMeterId)) {
            this._smeterMeterId = numId;
            console.log(`[SmartSDR] S-meter: meter id ${numId} (${m.desc || 'LEVEL'})`);
          }
          // Find SWR: src=TX-, nam=SWR (or src starts with TX)
          if (m.nam === 'SWR' && !this._swrMeterId) {
            this._swrMeterId = numId;
            console.log(`[SmartSDR] SWR meter: meter id ${numId} (src=${m.src})`);
          }
        }
      }
    }

    // Status messages look like:
    // S<handle>|client 0x4E1DDC50 connected local_ptt=1 client_id=FC77859A-... program=SmartSDR-Win station=...
    // We need both the client_id UUID (for client bind) and the hex handle (for cw key client_handle=)
    const idMatch = line.match(/client_id=([0-9A-Fa-f-]+)/);
    const handleMatch = line.match(/\|client\s+0x([0-9A-Fa-f]+)/);
    if (idMatch) {
      const clientId = idMatch[1];
      if (clientId !== this._persistentId && !this._discoveredGuiClients.includes(clientId)) {
        this._discoveredGuiClients.push(clientId);
        // Capture the hex handle for cw key client_handle= parameter
        if (handleMatch && !this._guiClientHandle) {
          this._guiClientHandle = handleMatch[1];
          console.log(`[SmartSDR] Discovered GUI client: id=${clientId} handle=0x${this._guiClientHandle}`);
        } else {
          console.log(`[SmartSDR] Discovered GUI client_id: ${clientId} (total: ${this._discoveredGuiClients.length})`);
        }
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
    const freqMHz = typeof spot.freqMHz === 'number' ? spot.freqMHz : parseFloat(spot.freqMHz);
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
    this._send(`slice tune ${sliceIndex} ${freqMhz.toFixed(6)}`);
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
  // Direct key-down/key-up via `cw key 0|1` with timestamps and client_handle.
  // The radio uses timestamps to measure network jitter and buffer appropriately,
  // reproducing the operator's exact fist timing on air.
  // Format: cw key <0|1> time=0x<NNNN> index=<N> client_handle=0x<HANDLE>

  /**
   * Direct CW key command — preserves operator's exact fist timing.
   * Timestamps let the radio compensate for network jitter.
   * @param {boolean} down - true for key down, false for key up
   */
  cwKey(down) {
    const ts = Date.now() & 0xFFFF;
    const tsHex = ts.toString(16).toUpperCase().padStart(4, '0');
    const idx = this._cwKeyIndex++;
    let cmd = `cw key ${down ? 1 : 0} time=0x${tsHex} index=${idx}`;
    if (this._guiClientHandle) {
      cmd += ` client_handle=0x${this._guiClientHandle}`;
    }
    this._send(cmd);
  }

  /**
   * CW PTT — activate/deactivate transmit for CW keying.
   * Uses `cw ptt` (not `xmit`) which works with the CW keying system.
   * Auto-releases after holdoff period of no key activity.
   */
  cwPttOn() {
    if (!this._cwPttActive) {
      const ts = Date.now() & 0xFFFF;
      const tsHex = ts.toString(16).toUpperCase().padStart(4, '0');
      const idx = this._cwKeyIndex++;
      let cmd = `cw ptt 1 time=0x${tsHex} index=${idx}`;
      if (this._guiClientHandle) {
        cmd += ` client_handle=0x${this._guiClientHandle}`;
      }
      console.log(`[SmartSDR] CW PTT on`);
      this._send(cmd);
      this._cwPttActive = true;
    }
    // Reset holdoff timer on every call
    if (this._cwPttTimer) clearTimeout(this._cwPttTimer);
    this._cwPttTimer = setTimeout(() => this.cwPttRelease(), this._cwPttHoldoff);
  }

  cwPttRelease() {
    if (this._cwPttTimer) { clearTimeout(this._cwPttTimer); this._cwPttTimer = null; }
    if (this._cwPttActive) {
      const ts = Date.now() & 0xFFFF;
      const tsHex = ts.toString(16).toUpperCase().padStart(4, '0');
      const idx = this._cwKeyIndex++;
      let cmd = `cw ptt 0 time=0x${tsHex} index=${idx}`;
      if (this._guiClientHandle) {
        cmd += ` client_handle=0x${this._guiClientHandle}`;
      }
      console.log(`[SmartSDR] CW PTT off`);
      this._send(cmd);
      this._cwPttActive = false;
    }
  }

  /**
   * Voice PTT — activate/deactivate transmit for SSB/AM/FM (not CW).
   * Uses `xmit` which is the proper voice transmit command.
   */
  setTransmit(state) {
    if (!this.connected) return;
    this._send(`xmit ${state ? 1 : 0}`);
    console.log(`[SmartSDR] Voice PTT ${state ? 'on' : 'off'}`);
  }

  setSliceFilter(idx, lo, hi) {
    this._send(`slice set ${idx} filter_lo=${lo} filter_hi=${hi}`);
  }

  setSliceNb(idx, on) {
    this._send(`slice set ${idx} nb=${on ? 1 : 0}`);
  }

  setActiveSlice(idx) {
    this._send(`slice set ${idx} active=1`);
  }

  setTxSlice(idx) {
    this._send(`slice set ${idx} tx=1`);
  }

  setSliceXit(idx, on, freqHz) {
    if (on && freqHz != null) {
      this._send(`slice set ${idx} xit_on=1 xit_freq=${Math.round(freqHz)}`);
    } else {
      this._send(`slice set ${idx} xit_on=0`);
    }
  }

  setAtu(on) {
    this._send(on ? 'atu start' : 'atu bypass');
  }

  setRfGain(idx, dB) {
    this._send(`slice set ${idx} rfgain=${Math.round(dB)}`);
  }

  setTxPower(pct) {
    this._send(`transmit set rfpower=${Math.round(pct)}`);
  }

  setCwSpeed(wpm) {
    this._send(`cw wpm ${wpm}`);
  }

  cwStop() {
    this.cwKey(false);
    this.cwPttRelease();
  }

  /**
   * Send CW text via SmartSDR `cw send` command.
   * The radio's internal keyer plays the text at the current CW speed.
   * @param {string} text - CW text to send (uppercase, spaces between words)
   */
  sendCwText(text) {
    if (!this.connected || !text) return;
    // SmartSDR accepts: cw send "CQ CQ DE K3SBP"
    const clean = text.replace(/"/g, '').toUpperCase();
    this._send(`cw send "${clean}"`);
    console.log(`[SmartSDR] CW send: ${clean}`);
  }

  /**
   * Set CW keyer speed via SmartSDR.
   * @param {number} wpm - words per minute
   */
  setCwSpeed(wpm) {
    if (!this.connected) return;
    this._send(`cw wpm ${Math.max(5, Math.min(100, wpm || 20))}`);
  }

  disconnect() {
    this.cwPttRelease();
    this._closeMeterUdp();
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

function setColorblindMode(enabled) {
  Object.assign(SOURCE_COLORS, enabled ? SOURCE_COLORS_CB : SOURCE_COLORS_NORMAL);
}

module.exports = { SmartSdrClient, setColorblindMode };
