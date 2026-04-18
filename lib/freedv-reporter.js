'use strict';
/**
 * FreeDV Reporter Client — connects to qso.freedv.org via raw WebSocket
 * (Engine.IO v4 / Socket.IO v4 protocol) to receive real-time FreeDV activity.
 *
 * Auth is sent in the Socket.IO namespace connect packet (40{...}).
 * Server uses Socket.IO v4 but the auth goes in the connect payload, not an event.
 *
 * Emits:
 *   'spot'       { callsign, grid, frequency, mode, snr, transmitting }
 *   'remove'     { callsign }
 *   'connected'
 *   'disconnected'
 *   'error'      Error
 */
const { EventEmitter } = require('events');
const WebSocket = require('ws');

class FreedvReporterClient extends EventEmitter {
  constructor() {
    super();
    this._ws = null;
    this._stations = new Map(); // sid -> station data
    this._pingTimer = null;
    this._reconnectTimer = null;
    this.connected = false;
  }

  connect() {
    this.disconnect();
    this._doConnect();
  }

  disconnect() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    if (this._ws) {
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
    this._stations.clear();
    this.connected = false;
  }

  _doConnect() {
    const ws = new WebSocket('wss://qso.freedv.org/socket.io/?EIO=4&transport=websocket');
    this._ws = ws;

    ws.on('open', () => {
      // Wait for Engine.IO open packet before sending auth
    });

    ws.on('message', (data) => {
      const str = data.toString();
      this._handleMessage(str);
    });

    ws.on('error', (err) => {
      this.emit('error', err);
    });

    ws.on('close', () => {
      const was = this.connected;
      this.connected = false;
      if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
      this._ws = null;
      if (was) this.emit('disconnected');
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._doConnect();
    }, 5000);
  }

  _handleMessage(str) {
    // Engine.IO open: send Socket.IO namespace connect with auth
    if (str.startsWith('0{')) {
      const auth = JSON.stringify({ role: 'view', protocol_version: 2 });
      this._ws.send('40' + auth);
      // Start ping timer (server expects pings every 5s)
      this._pingTimer = setInterval(() => {
        if (this._ws && this._ws.readyState === WebSocket.OPEN) this._ws.send('2');
      }, 4000);
      return;
    }

    // Socket.IO connect success
    if (str.startsWith('40{')) {
      this.connected = true;
      this.emit('connected');
      return;
    }

    // Socket.IO disconnect
    if (str === '41' || str.startsWith('41{')) {
      this.connected = false;
      this.emit('disconnected');
      return;
    }

    // Engine.IO ping -> pong
    if (str === '2') {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) this._ws.send('3');
      return;
    }

    // Socket.IO event (type 42)
    if (str.startsWith('42[')) {
      try {
        const arr = JSON.parse(str.slice(2));
        this._handleEvent(arr[0], arr[1]);
      } catch {}
      return;
    }
  }

  _handleEvent(event, data) {
    switch (event) {
      case 'connection_successful':
        // Initial handshake confirmed
        break;

      case 'bulk_update':
        if (Array.isArray(data)) {
          for (const [ev, d] of data) {
            this._handleEvent(ev, d);
          }
        }
        break;

      case 'new_connection':
      case 'freq_change':
      case 'tx_report':
        this._updateStation(data);
        break;

      case 'rx_report':
        if (data && data.callsign) {
          this.emit('spot', {
            callsign: data.callsign,
            grid: '',
            frequency: 0,
            mode: data.mode || 'FREEDV',
            snr: data.snr != null ? data.snr : null,
            transmitting: true,
            receiverCallsign: data.receiver_callsign,
            receiverGrid: data.receiver_grid_square,
          });
        }
        break;

      case 'remove_connection':
        if (data && data.sid) this._stations.delete(data.sid);
        if (data && data.callsign) this.emit('remove', { callsign: data.callsign });
        break;

      // Ignore chat messages, message_update, chat_login, etc.
    }
  }

  _updateStation(data) {
    if (!data || !data.sid) return;
    const existing = this._stations.get(data.sid) || {};
    const station = { ...existing, ...data };
    this._stations.set(data.sid, station);

    if (station.callsign && station.freq) {
      this.emit('spot', {
        callsign: station.callsign,
        grid: station.grid_square || '',
        frequency: station.freq, // Hz
        mode: station.mode || 'FREEDV',
        snr: station.snr != null ? station.snr : null,
        transmitting: !!station.transmitting,
        rxOnly: !!station.rx_only,
      });
    }
  }

  /** Get all currently active stations */
  getStations() {
    return [...this._stations.values()];
  }
}

module.exports = { FreedvReporterClient };
