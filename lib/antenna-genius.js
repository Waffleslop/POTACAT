// 4O3A Antenna Genius TCP client
// Protocol: https://github.com/4o3a/genius-api-docs/wiki/Antenna-Genius-TCPIP-API
const net = require('net');
const { EventEmitter } = require('events');

const DEFAULT_PORT = 9007;

class AntennaGeniusClient extends EventEmitter {
  constructor() {
    super();
    this._socket = null;
    this._buf = '';
    this._reconnectTimer = null;
    this._target = null; // { host, port }
    this._seq = 0;
    this._ready = false;
    this._antennaNames = []; // indexed 1-8
    this.connected = false;
  }

  connect(host, port) {
    this.disconnect();
    this._target = { host: host || '127.0.0.1', port: port || DEFAULT_PORT };
    this._doConnect();
  }

  _doConnect() {
    if (!this._target) return;
    const { host, port } = this._target;
    const sock = new net.Socket();
    this._socket = sock;
    this._buf = '';
    this._ready = false;

    sock.connect(port, host, () => {
      // Wait for prologue before marking ready
      // Timeout: if no prologue received within 10s, something is wrong
      this._prologueTimer = setTimeout(() => {
        if (!this._ready && this._socket === sock) {
          this.emit('error', new Error('No prologue received within 10s — check AG firmware/network'));
          try { sock.destroy(); } catch { /* ignore */ }
        }
      }, 10000);
    });

    sock.on('data', (chunk) => {
      this._buf += chunk.toString();
      this._processBuffer();
    });

    sock.on('error', (err) => {
      this.emit('error', err);
    });

    sock.on('close', () => {
      if (this._prologueTimer) { clearTimeout(this._prologueTimer); this._prologueTimer = null; }
      const wasConnected = this.connected;
      this.connected = false;
      this._ready = false;
      this._socket = null;
      if (wasConnected) this.emit('disconnected');
      this._scheduleReconnect();
    });
  }

  _processBuffer() {
    // Messages are CR or CRLF terminated
    let idx;
    while ((idx = this._buf.indexOf('\r')) !== -1) {
      let line = this._buf.slice(0, idx).trim();
      // Skip LF after CR
      this._buf = this._buf.slice(idx + 1);
      if (this._buf.startsWith('\n')) this._buf = this._buf.slice(1);
      if (!line) continue;
      this._onLine(line);
    }
  }

  _onLine(line) {
    // Prologue: "V4.0.22 AG" or "V4.0.22 AG AUTH"
    if (line.startsWith('V') && line.includes('AG')) {
      if (this._prologueTimer) { clearTimeout(this._prologueTimer); this._prologueTimer = null; }
      this.connected = true;
      this._ready = true;
      this.emit('connected');
      // Query antenna names on connect
      this._sendCmd('antenna list');
      return;
    }

    // Response: R<seq>|<status>|<data>
    if (line.startsWith('R')) {
      const parts = line.slice(1).split('|');
      if (parts.length >= 2) {
        const status = parts[1];
        const data = parts.slice(2).join('|');
        this._onResponse(status, data);
      }
      return;
    }

    // Async status: S0|<message>
    if (line.startsWith('S')) {
      const pipeIdx = line.indexOf('|');
      if (pipeIdx !== -1) {
        const data = line.slice(pipeIdx + 1);
        this._onStatus(data);
      }
      return;
    }
  }

  _onResponse(status, data) {
    // Parse antenna list response
    if (data.startsWith('antenna ') && data.includes('name=')) {
      this._parseAntennaEntry(data);
      return;
    }

    // Parse port status response
    if (data.startsWith('port ')) {
      this._parsePortStatus(data);
      return;
    }
  }

  _onStatus(data) {
    // Async port status update
    if (data.startsWith('port ')) {
      this._parsePortStatus(data);
    }
  }

  _parseAntennaEntry(data) {
    // "antenna 1 name=Hex_Beam tx=0x03FF rx=0x03FF inband=0x0000"
    const numMatch = data.match(/antenna\s+(\d+)/);
    const nameMatch = data.match(/name=(\S+)/);
    if (numMatch && nameMatch) {
      const num = parseInt(numMatch[1], 10);
      const name = nameMatch[1].replace(/_/g, ' ');
      this._antennaNames[num] = name;
      this.emit('antenna-list', this.getAntennaNames());
    }
  }

  _parsePortStatus(data) {
    // "port 1 auto=1 source=AUTO band=5 rxant=3 txant=3 tx=0 inhibit=0"
    const portMatch = data.match(/port\s+(\d+)/);
    const rxMatch = data.match(/rxant=(\d+)/);
    const txMatch = data.match(/txant=(\d+)/);
    const bandMatch = data.match(/band=(\d+)/);
    if (portMatch) {
      this.emit('port-status', {
        port: parseInt(portMatch[1], 10),
        rxant: rxMatch ? parseInt(rxMatch[1], 10) : 0,
        txant: txMatch ? parseInt(txMatch[1], 10) : 0,
        band: bandMatch ? parseInt(bandMatch[1], 10) : 0,
      });
    }
  }

  _nextSeq() {
    this._seq = (this._seq % 255) + 1;
    return this._seq;
  }

  _sendCmd(cmd) {
    if (!this._socket || !this._ready) return;
    const seq = this._nextSeq();
    this._socket.write(`C${seq}|${cmd}\r`);
  }

  /**
   * Select antenna for a radio port.
   * @param {number} port - Radio port (1=A, 2=B)
   * @param {number} antenna - Antenna number (1-8)
   */
  selectAntenna(port, antenna) {
    this._sendCmd(`port set ${port} auto=0 rxant=${antenna} txant=${antenna}`);
  }

  /**
   * Query current antenna for a radio port.
   * @param {number} port - Radio port (1=A, 2=B)
   */
  queryPort(port) {
    this._sendCmd(`port get ${port}`);
  }

  /**
   * Subscribe to real-time port status updates.
   */
  subscribePortStatus() {
    this._sendCmd('sub port all');
  }

  /**
   * Get antenna names map { 1: "Hex Beam", 2: "Dipole", ... }
   */
  getAntennaNames() {
    const names = {};
    for (let i = 1; i <= 8; i++) {
      if (this._antennaNames[i]) names[i] = this._antennaNames[i];
    }
    return names;
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this.connected && this._target) {
        this.emit('reconnecting');
        this._doConnect();
      }
    }, 5000);
  }

  disconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._prologueTimer) {
      clearTimeout(this._prologueTimer);
      this._prologueTimer = null;
    }
    this._target = null;
    this._ready = false;
    if (this._socket) {
      try { this._socket.destroy(); } catch { /* ignore */ }
      this._socket = null;
    }
    this.connected = false;
  }
}

module.exports = { AntennaGeniusClient };
