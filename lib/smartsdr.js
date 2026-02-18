// SmartSDR TCP API client — pushes spot markers to FlexRadio panadapter
const net = require('net');
const { EventEmitter } = require('events');

const SOURCE_COLORS = {
  pota: '#FF4ECCA3',
  sota: '#FFF0A500',
  dxc:  '#FFE040FB',
  rbn:  '#FF4FC3F7',
};

const SOURCE_LIFETIMES = {
  pota: 600,
  sota: 600,
  dxc:  300,
  rbn:  120,
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
      this.emit('connected');
    });

    sock.on('data', (chunk) => {
      this._buf += chunk.toString();
      // Consume complete lines
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
      if (wasConnected) this.emit('disconnected');
      this._scheduleReconnect();
    });

    sock.connect(4992, this._host);
  }

  _handleLine(line) {
    // We don't need to act on responses or status messages for now.
    // SmartSDR sends version info on connect and R<seq> responses.
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
    if (!this._sock || !this.connected) return;
    const seq = this._seq++;
    this._sock.write(`C${seq}|${cmd}\n`);
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

    this._send(
      `spot add rx_freq=${freqMHz.toFixed(6)} callsign=${callsign} mode=${mode} color=${color} source=POTA-CAT trigger_action=tune lifetime_seconds=${lifetime}` +
      (comment ? ` comment=${comment}` : '')
    );
    this._activeSpots.add(callsign);
  }

  /**
   * Remove spots that are no longer in the current spot list.
   * Call after adding all current spots to clean up stale ones.
   */
  pruneStaleSpots() {
    for (const call of this._previousSpots) {
      if (!this._activeSpots.has(call)) {
        this._send(`spot remove callsign=${call} source=POTA-CAT`);
      }
    }
    this._previousSpots = new Set(this._activeSpots);
    this._activeSpots.clear();
  }

  clearSpots() {
    this._send('spot clear');
    this._activeSpots.clear();
    this._previousSpots.clear();
  }

  /**
   * Tune a slice to a frequency and optionally set mode.
   * @param {number} sliceIndex - 0=A, 1=B, 2=C, 3=D
   * @param {number} freqMhz - Frequency in MHz (e.g. 7.074000)
   * @param {string} [mode] - FlexRadio mode string (e.g. 'DIGU', 'USB', 'CW')
   */
  tuneSlice(sliceIndex, freqMhz, mode) {
    this._send(`slice tune ${sliceIndex} ${freqMhz.toFixed(6)} autopan=1`);
    if (mode) {
      this._send(`slice set ${sliceIndex} mode=${mode}`);
    }
  }

  disconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._host = null;
    if (this._sock) {
      try { this._sock.destroy(); } catch { /* ignore */ }
      this._sock = null;
    }
    this.connected = false;
  }
}

module.exports = { SmartSdrClient };
