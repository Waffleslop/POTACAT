'use strict';
/**
 * TunerGeniusClient — controls FlexRadio TunerGenius 1x3 / XL
 * via direct TCP connection on port 9010.
 *
 * Protocol: same framing as SmartSDR
 *   Client sends: C<seq>|<command>\n
 *   Device responds: R<seq>|<code>|<body>\n
 *   Status pushes: S0|state key=val ...\n
 *   Handshake: device sends V<version>\n on connect
 *
 * Commands:
 *   activate ant=<1|2|3>  — select antenna port
 *   status                — query current status
 *   info                  — device info
 */
const net = require('net');
const { EventEmitter } = require('events');

class TunerGeniusClient extends EventEmitter {
  constructor() {
    super();
    this._sock = null;
    this._host = null;
    this._port = 9010;
    this._seq = 1;
    this._buf = '';
    this._reconnectTimer = null;
    this._version = null;
    this.connected = false;
    this.antenna = 0;      // current antenna port (1, 2, 3)
    this.operating = false;
    this.bypassed = false;
    this.tuning = false;
    this.oneByThree = false;
  }

  connect(host, port) {
    this.disconnect();
    this._host = host;
    this._port = port || 9010;
    this._doConnect();
  }

  disconnect() {
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    this._host = null;
    if (this._sock) {
      try { this._sock.end(); } catch {}
      const sock = this._sock;
      setTimeout(() => { try { sock.destroy(); } catch {} }, 500);
      this._sock = null;
    }
    this.connected = false;
  }

  _doConnect() {
    if (!this._host) return;
    const sock = new net.Socket();
    sock.setNoDelay(true);
    this._sock = sock;

    sock.on('connect', () => {
      this.connected = true;
      this.emit('connected');
      // Request status after brief handshake delay
      setTimeout(() => {
        if (this.connected) this._send('status');
      }, 300);
    });

    sock.on('data', (chunk) => {
      this._buf += chunk.toString();
      let nl;
      while ((nl = this._buf.indexOf('\n')) !== -1) {
        const line = this._buf.slice(0, nl).replace(/\r$/, '');
        this._buf = this._buf.slice(nl + 1);
        if (line) this._handleLine(line);
      }
    });

    sock.on('error', (err) => {
      this.emit('error', err);
    });

    sock.on('close', () => {
      const was = this.connected;
      this.connected = false;
      this._sock = null;
      if (was) this.emit('disconnected');
      this._scheduleReconnect();
    });

    sock.connect(this._port, this._host);
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || !this._host) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._host) this._doConnect();
    }, 5000);
  }

  _send(cmd) {
    if (!this._sock || !this.connected) return null;
    const seq = this._seq++;
    this._sock.write(`C${seq}|${cmd}\n`);
    this.emit('log', `tx: C${seq}|${cmd}`);
    return seq;
  }

  _handleLine(line) {
    // Version handshake
    if (line.startsWith('V')) {
      this._version = line.slice(1).trim();
      this.emit('log', `version: ${this._version}`);
      return;
    }

    // Response: R<seq>|<code>|<body>
    if (line.startsWith('R')) {
      const parts = line.split('|');
      const code = parts[1] || '';
      if (code !== '0' && code !== '00000000') {
        this.emit('log', `response error: ${line}`);
      }
      return;
    }

    // Status: S0|state key=val key=val ...
    if (line.startsWith('S')) {
      const pipeIdx = line.indexOf('|');
      if (pipeIdx < 0) return;
      const payload = line.slice(pipeIdx + 1);
      this._parseStatus(payload);
      return;
    }

    this.emit('log', `rx: ${line}`);
  }

  _parseStatus(payload) {
    // Remove leading "state " if present
    const text = payload.startsWith('state ') ? payload.slice(6) : payload;
    const kv = {};
    // Parse key=value pairs (values may be quoted)
    const re = /(\w+)=("[^"]*"|\S+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      kv[m[1]] = m[2].replace(/^"|"$/g, '');
    }

    if (kv.antA != null) {
      this.antenna = parseInt(kv.antA, 10) || 0;
    }
    if (kv.operate != null) {
      this.operating = kv.operate === '1';
    }
    if (kv.bypass != null) {
      this.bypassed = kv.bypass === '1';
    }
    if (kv.tuning != null) {
      this.tuning = kv.tuning === '1';
    }
    if (kv.one_by_three != null) {
      this.oneByThree = kv.one_by_three === '1';
    }

    this.emit('status', {
      antenna: this.antenna,
      operating: this.operating,
      bypassed: this.bypassed,
      tuning: this.tuning,
      oneByThree: this.oneByThree,
    });
  }

  // --- Public commands ---

  selectAntenna(port) {
    const p = Math.max(1, Math.min(3, parseInt(port, 10) || 1));
    this.emit('log', `Selecting antenna ${p}`);
    this._send(`activate ant=${p}`);
    // Optimistic update
    this.antenna = p;
    this.emit('status', {
      antenna: this.antenna,
      operating: this.operating,
      bypassed: this.bypassed,
      tuning: this.tuning,
      oneByThree: this.oneByThree,
    });
  }

  requestStatus() {
    this._send('status');
  }

  requestInfo() {
    this._send('info');
  }
}

module.exports = { TunerGeniusClient };
