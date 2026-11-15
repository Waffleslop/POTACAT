// TCI (Transceiver Control Interface) WebSocket client
// Pushes spot markers to Thetis/ExpertSDR3/SunSDR panadapter
const WebSocket = require('ws');
const { EventEmitter } = require('events');

// ARGB uint32 colors (fully opaque, 0xFF prefix)
const TCI_SOURCE_COLORS_NORMAL = {
  pota: 0xFF4ECCA3,
  sota: 0xFFF0A500,
  dxc:  0xFFE040FB,
  rbn:  0xFF4FC3F7,
  pskr: 0xFFFF6B6B,
  net:  0xFFFFD740,
};
const TCI_SOURCE_COLORS_CB = {
  pota: 0xFF4FC3F7,
  sota: 0xFFFFB300,
  dxc:  0xFFE040FB,
  rbn:  0xFF81D4FA,
  pskr: 0xFFFFA726,
  net:  0xFFFFD740,
};
let TCI_SOURCE_COLORS = { ...TCI_SOURCE_COLORS_NORMAL };

class TciClient extends EventEmitter {
  constructor() {
    super();
    this._ws = null;
    this._ready = false;
    this._reconnectTimer = null;
    this.connected = false;
    this._host = null;
    this._port = null;
    this._activeSpots = new Set();
    this._previousSpots = new Set();
    this._spotFreqs = new Map();
    this._pendingCmds = []; // buffered until ready;
  }

  connect(host, port) {
    this.disconnect();
    this._host = host || '127.0.0.1';
    this._port = port || 50001;
    this._doConnect();
  }

  _doConnect() {
    const url = `ws://${this._host}:${this._port}`;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.emit('error', err);
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.emit('connected');
    });

    ws.on('message', (data) => {
      this._onMessage(data.toString());
    });

    ws.on('error', (err) => {
      this.emit('error', err);
    });

    ws.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this._ready = false;
      this._ws = null;
      if (wasConnected) this.emit('disconnected');
      this._scheduleReconnect();
    });
  }

  _onMessage(msg) {
    // TCI sends semicolon-terminated commands, possibly multiple per message
    const parts = msg.split(';').filter(Boolean);
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed === 'ready' && !this._ready) {
        this._ready = true;
        // Flush any buffered commands
        for (const cmd of this._pendingCmds) {
          this._wsSend(cmd);
        }
        this._pendingCmds = [];
        this.emit('ready');
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

  _wsSend(cmd) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(cmd);
    }
  }

  _send(cmd) {
    if (!this.connected) return;
    if (!this._ready) {
      this._pendingCmds.push(cmd);
      return;
    }
    this._wsSend(cmd);
  }

  addSpot(spot) {
    const freqKHz = parseFloat(spot.frequency);
    if (!Number.isFinite(freqKHz) || freqKHz <= 0) return false;
    const callsign = (spot.callsign || '').replace(/\s/g, '');
    if (!callsign) return false;
    const mode = spot.mode || 'USB';
    const color = TCI_SOURCE_COLORS[spot.source] || TCI_SOURCE_COLORS.pota;
    const freqHz = Math.round(freqKHz * 1000);
    const desc = (spot.reference || spot.parkName || '').slice(0, 40);

    // If callsign moved frequency, delete old spot first
    const prevFreq = this._spotFreqs.get(callsign);
    if (prevFreq !== undefined && Math.abs(prevFreq - freqHz) > 50) {
      this._send(`spot_delete:${callsign};`);
    }

    // Thetis JSON tag format for text color (basic TCI doesn't support textcolor parameter)
    // textcolor -16777216 = 0xFF000000 (black) as signed int32, matching .NET Color.ToArgb()
    const jsonTag = `[json]{"comment":"${desc.replace(/"/g, '\\"')}","textcolor":"-16777216"}`;
    this._send(`spot:${callsign},${mode},${freqHz},${color},${jsonTag};`);
    this._activeSpots.add(callsign);
    this._spotFreqs.set(callsign, freqHz);
    return true;
  }

  pruneStaleSpots() {
    for (const call of this._previousSpots) {
      if (!this._activeSpots.has(call)) {
        this._send(`spot_delete:${call};`);
        this._spotFreqs.delete(call);
      }
    }
    this._previousSpots = new Set(this._activeSpots);
    this._activeSpots.clear();
  }

  clearSpots() {
    for (const call of this._previousSpots) {
      this._send(`spot_delete:${call};`);
    }
    for (const call of this._activeSpots) {
      this._send(`spot_delete:${call};`);
    }
    this._activeSpots.clear();
    this._previousSpots.clear();
    this._spotFreqs.clear();
  }

  disconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._host = null;
    this._port = null;
    this._ready = false;
    this._pendingCmds = [];
    if (this._ws) {
      try { this._ws.close(); } catch { /* ignore */ }
      this._ws = null;
    }
    this.connected = false;
  }
}

function setTciColorblindMode(enabled) {
  Object.assign(TCI_SOURCE_COLORS, enabled ? TCI_SOURCE_COLORS_CB : TCI_SOURCE_COLORS_NORMAL);
}

module.exports = { TciClient, setTciColorblindMode };
