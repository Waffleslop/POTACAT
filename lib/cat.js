// SmartSDR CAT client — supports both TCP and COM (serial) connections
const net = require('net');
const { EventEmitter } = require('events');
const { SerialPort } = require('serialport');

class CatClient extends EventEmitter {
  constructor() {
    super();
    this.transport = null; // net.Socket or SerialPort
    this.connected = false;
    this._reconnectTimer = null;
    this._pollTimer = null;
    this._target = null; // { type: 'tcp', host, port } or { type: 'serial', path }
    this._buf = '';
    this._debug = false; // set to true to emit 'log' events
  }

  connect(target) {
    this.disconnect();
    this._target = target;

    if (target.type === 'tcp') {
      this._connectTcp(target);
    } else if (target.type === 'serial') {
      this._connectSerial(target);
    }
  }

  _log(msg) {
    if (this._debug) this.emit('log', msg);
  }

  _connectTcp({ host = '127.0.0.1', port }) {
    const sock = new net.Socket();
    this.transport = sock;

    sock.on('data', (chunk) => this._onData(chunk));

    sock.on('connect', () => {
      sock.setNoDelay(true); // disable Nagle — must be set after connect on Windows
      this._log(`TCP connected to ${host}:${port}, noDelay=true`);
      this.connected = true;
      this.emit('status', { connected: true, target: this._target });
      this._startPolling();
    });

    sock.on('error', () => { /* handled in close */ });

    sock.on('close', () => {
      this.connected = false;
      this._stopPolling();
      this.emit('status', { connected: false, target: this._target });
      this._scheduleReconnect();
    });

    sock.connect(port, host);
  }

  _connectSerial({ path }) {
    const port = new SerialPort({
      path,
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      autoOpen: false,
    });
    this.transport = port;

    port.on('data', (chunk) => this._onData(chunk));

    port.on('open', () => {
      this.connected = true;
      this.emit('status', { connected: true, target: this._target });
      this._startPolling();
    });

    port.on('error', () => { /* handled in close */ });

    port.on('close', () => {
      this.connected = false;
      this._stopPolling();
      this.emit('status', { connected: false, target: this._target });
      this._scheduleReconnect();
    });

    port.open((err) => {
      if (err) {
        this.connected = false;
        this.emit('status', { connected: false, target: this._target });
        this._scheduleReconnect();
      }
    });
  }

  _onData(chunk) {
    this._buf += chunk.toString();
    let semi;
    while ((semi = this._buf.indexOf(';')) !== -1) {
      const msg = this._buf.slice(0, semi);
      this._buf = this._buf.slice(semi + 1);
      if (msg.startsWith('FA')) {
        const hz = parseInt(msg.slice(2), 10);
        if (!isNaN(hz)) this.emit('frequency', hz);
      } else {
        this._log(`rx: ${msg}`);
      }
    }
  }

  _startPolling() {
    this._stopPolling();
    this._pollTimer = setInterval(() => {
      this._write('FA;');
    }, 500);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || !this._target) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._target) this.connect(this._target);
    }, 5000);
  }

  _write(data) {
    if (!this.connected || !this.transport) {
      this._log(`_write DROPPED (connected=${this.connected}): ${data.replace(/\n/g, '\\n')}`);
      return;
    }
    const ok = this.transport.write(data);
    this._log(`_write(${data.replace(/\n/g, '\\n')}) buffered=${!ok}`);
  }

  tune(frequencyHz, mode) {
    this._log(`tune() called: freq=${frequencyHz} mode=${mode} connected=${this.connected}`);
    if (!this.connected) return false;
    // Pause polling so tune commands aren't interleaved with FA; queries
    this._stopPolling();
    // Build a single buffer with all commands to send in one TCP packet
    let cmd = `FA${String(frequencyHz).padStart(11, '0')};`;
    if (mode) {
      const modeCode = mapMode(mode, frequencyHz);
      if (modeCode !== null) {
        cmd += `MD${modeCode};`;
      }
    }
    this._write(cmd);
    // Resume polling after the radio has time to process
    if (this._tuneResumeTimer) clearTimeout(this._tuneResumeTimer);
    this._tuneResumeTimer = setTimeout(() => {
      this._tuneResumeTimer = null;
      if (this.connected) this._startPolling();
    }, 1000);
    return true;
  }

  disconnect() {
    this._stopPolling();
    if (this._tuneResumeTimer) {
      clearTimeout(this._tuneResumeTimer);
      this._tuneResumeTimer = null;
    }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.transport) {
      if (this.transport instanceof net.Socket) {
        this.transport.destroy();
      } else {
        // SerialPort
        if (this.transport.isOpen) this.transport.close();
      }
      this.transport = null;
    }
    this.connected = false;
  }
}

// Scan for available COM ports
async function listSerialPorts() {
  const ports = await SerialPort.list();
  return ports.map((p) => ({
    path: p.path,
    manufacturer: p.manufacturer || '',
    friendlyName: p.friendlyName || p.path,
  }));
}

function ssbSideband(freqHz) {
  // 60m (5 MHz band) is USB by convention; all other bands below 10 MHz are LSB
  if (freqHz >= 5300000 && freqHz <= 5410000) return 'USB';
  return freqHz >= 10000000 ? 'USB' : 'LSB';
}

function mapMode(mode, freqHz) {
  const m = (mode || '').toUpperCase();
  if (m === 'CW') return 3;
  if (m === 'USB') return 2;
  if (m === 'LSB') return 1;
  if (m === 'SSB') return ssbSideband(freqHz) === 'USB' ? 2 : 1;
  if (m === 'FM') return 4;
  if (m === 'DIGU' || m === 'FT8' || m === 'FT4') return 9;
  if (m === 'DIGL') return 6;
  return null;
}

// --- rigctld (Hamlib) client ---
// Connects to rigctld over TCP using its simple ASCII protocol.
// Same EventEmitter interface as CatClient: emits 'connect', 'status', 'frequency'.

class RigctldClient extends EventEmitter {
  constructor() {
    super();
    this.transport = null;
    this.connected = false;
    this._reconnectTimer = null;
    this._pollTimer = null;
    this._target = null;
    this._buf = '';
  }

  connect(target) {
    this.disconnect();
    this._target = target;
    const host = target.host || '127.0.0.1';
    const port = target.port || 4532;

    const sock = new net.Socket();
    this.transport = sock;

    sock.on('data', (chunk) => this._onData(chunk));

    sock.on('connect', () => {
      this.connected = true;
      this.emit('status', { connected: true, target: this._target });
      this._startPolling();
    });

    sock.on('error', () => { /* handled in close */ });

    sock.on('close', () => {
      this.connected = false;
      this._stopPolling();
      this.emit('status', { connected: false, target: this._target });
      this._scheduleReconnect();
    });

    sock.connect(port, host);
  }

  _onData(chunk) {
    this._buf += chunk.toString();
    let nl;
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      // Frequency response is a plain integer (Hz) on its own line
      if (/^\d+$/.test(line)) {
        const hz = parseInt(line, 10);
        if (!isNaN(hz) && hz > 0) this.emit('frequency', hz);
      }
    }
  }

  _startPolling() {
    this._stopPolling();
    this._pollTimer = setInterval(() => {
      this._write('f\n'); // get frequency
    }, 500);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || !this._target) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._target) this.connect(this._target);
    }, 5000);
  }

  _write(data) {
    if (!this.connected || !this.transport) return;
    this.transport.write(data);
  }

  tune(frequencyHz, mode) {
    if (!this.connected) return false;
    this._write(`F ${frequencyHz}\n`);
    if (mode) {
      const token = mapModeRigctld(mode, frequencyHz);
      if (token) {
        this._write(`M ${token} 0\n`); // 0 = default passband
      }
    }
    return true;
  }

  disconnect() {
    this._stopPolling();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.transport) {
      this.transport.destroy();
      this.transport = null;
    }
    this.connected = false;
  }
}

function mapModeRigctld(mode, freqHz) {
  const m = (mode || '').toUpperCase();
  if (m === 'CW') return 'CW';
  if (m === 'USB') return 'USB';
  if (m === 'LSB') return 'LSB';
  if (m === 'SSB') return ssbSideband(freqHz);
  if (m === 'FM') return 'FM';
  if (m === 'AM') return 'AM';
  if (m === 'DIGU' || m === 'FT8' || m === 'FT4') return 'PKTUSB';
  if (m === 'DIGL') return 'PKTLSB';
  return null;
}

module.exports = { CatClient, RigctldClient, listSerialPorts };
