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
    this._target = null; // { type: 'tcp', host, port } or { type: 'serial', path }
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

  _connectTcp({ host = '127.0.0.1', port }) {
    const sock = new net.Socket();
    this.transport = sock;

    sock.on('connect', () => {
      this.connected = true;
      this.emit('status', { connected: true, target: this._target });
    });

    sock.on('error', () => { /* handled in close */ });

    sock.on('close', () => {
      this.connected = false;
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

    port.on('open', () => {
      this.connected = true;
      this.emit('status', { connected: true, target: this._target });
    });

    port.on('error', () => { /* handled in close */ });

    port.on('close', () => {
      this.connected = false;
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
    this._write(`FA${String(frequencyHz).padStart(11, '0')};`);
    if (mode) {
      const modeCode = mapMode(mode);
      if (modeCode !== null) {
        this._write(`MD${modeCode};`);
      }
    }
    return true;
  }

  disconnect() {
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

function mapMode(mode) {
  const m = (mode || '').toUpperCase();
  if (m === 'CW') return 3;
  if (m === 'USB' || m === 'SSB') return 2;
  if (m === 'LSB') return 1;
  if (m === 'FM') return 4;
  if (m === 'DIGU' || m === 'FT8' || m === 'FT4') return 9;
  if (m === 'DIGL') return 6;
  return null;
}

module.exports = { CatClient, listSerialPorts };
