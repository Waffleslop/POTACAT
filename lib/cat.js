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
    this._pendingTuneTimers = []; // setTimeout IDs for mode/split/filter after tune
    this._faDigits = 11; // FA frequency digit count (auto-detected from radio response; 11=Kenwood/Flex, 9=Yaesu)
    this._faDigitsDetected = false; // true once we've received at least one FA response from the radio
  }

  connect(target) {
    this.disconnect();
    this._target = target;
    this._faDigits = 11;
    this._faDigitsDetected = false;

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

  _connectSerial({ path, baudRate, dtrOff }) {
    const port = new SerialPort({
      path,
      baudRate: baudRate || 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      autoOpen: false,
      // Prevent DTR/RTS from keying PTT on radios like the QMX
      rtscts: false,
      hupcl: false,
    });
    this.transport = port;

    port.on('data', (chunk) => this._onData(chunk));

    port.on('open', () => {
      // Guard: if disconnect() was called while the port was opening, bail out
      if (this.transport !== port) {
        this._log('Serial open fired on stale port, closing');
        try { port.close(); } catch { /* ignore */ }
        return;
      }
      // Force DTR/RTS low if requested (prevents TX on radios that use DTR for PTT)
      if (dtrOff) {
        try {
          port.set({ dtr: false, rts: false });
        } catch { /* some drivers don't support set() */ }
      }
      this._log(`Serial connected to ${path} @ ${baudRate || 9600} baud, dtrOff=${!!dtrOff}`);
      this.connected = true;
      this.emit('status', { connected: true, target: this._target });
      // Delay before polling — some radios (e.g. Yaesu FT-710) need time after
      // port open before they're ready to accept commands
      setTimeout(() => {
        if (this.connected && this.transport === port) {
          this._startPolling();
        }
      }, 300);
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
    // Strip error responses ('?') that don't end with ';' — prevents buffer corruption
    this._buf = this._buf.replace(/\?/g, () => {
      this._log('rx: ? (command error)');
      return '';
    });
    // Strip stray CR/LF that some radios send
    this._buf = this._buf.replace(/[\r\n]/g, '');
    let semi;
    while ((semi = this._buf.indexOf(';')) !== -1) {
      const msg = this._buf.slice(0, semi);
      this._buf = this._buf.slice(semi + 1);
      if (msg.startsWith('FA')) {
        const faPayload = msg.slice(2);
        if (faPayload.length >= 9) {
          this._faDigits = faPayload.length;
          this._faDigitsDetected = true;
        }
        const hz = parseInt(faPayload, 10);
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
    }, 1000);
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

  tune(frequencyHz, mode, { split, filterWidth } = {}) {
    this._log(`tune() called: freq=${frequencyHz} mode=${mode} split=${!!split} filter=${filterWidth || 0} connected=${this.connected}`);
    if (!this.connected) return false;
    // Cancel any pending mode/split/filter commands from a previous rapid tune call
    for (const t of this._pendingTuneTimers) clearTimeout(t);
    this._pendingTuneTimers = [];
    // Pause polling so tune commands aren't interleaved with FA; queries
    this._stopPolling();

    const isSerial = this._target && this._target.type === 'serial';
    const mapped = mode ? mapMode(mode, frequencyHz, isSerial) : null;
    let delay = 0;

    // If we haven't received an FA response yet, we don't know the radio's digit
    // count.  Send an FA; probe first and give the radio time to reply so _faDigits
    // is calibrated before the frequency command goes out.
    if (!this._faDigitsDetected) {
      this._write('FA;');
      delay = 500;
    }

    // Send mode BEFORE frequency — Kenwood radios apply CW pitch offset based on
    // current mode, so the radio must be in the correct mode before FA is sent
    if (mapped) {
      this._write(`MD${mapped.md};`);
      delay = Math.max(delay, 100);
      // Kenwood DATA mode toggle (DA command) for FT8/FT4 on serial radios
      if (mapped.da != null) {
        this._pendingTuneTimers.push(setTimeout(() => {
          if (this.connected) this._write(`DA${mapped.da};`);
        }, delay));
        delay += 100;
      }
    }

    // Send frequency command after mode is set
    this._pendingTuneTimers.push(setTimeout(() => {
      if (this.connected) this._write(`FA${String(frequencyHz).padStart(this._faDigits, '0')};`);
    }, delay));
    delay += 100;

    // Send filter width after frequency
    if (mapped && filterWidth > 0) {
      this._pendingTuneTimers.push(setTimeout(() => {
        if (this.connected) this._write(`FW${String(filterWidth).padStart(4, '0')};`);
      }, delay));
      delay += 100;
    }

    // Enable split mode if requested (don't touch split state otherwise)
    if (split) {
      this._pendingTuneTimers.push(setTimeout(() => {
        if (this.connected) this._write('FT1;');
      }, delay));
      delay += 100;
    }
    // Query frequency shortly after tune to confirm change quickly (drives the click sound)
    this._pendingTuneTimers.push(setTimeout(() => {
      if (this.connected) this._write('FA;');
    }, delay + 50));
    // Resume polling after the radio has time to process
    if (this._tuneResumeTimer) clearTimeout(this._tuneResumeTimer);
    this._tuneResumeTimer = setTimeout(() => {
      this._tuneResumeTimer = null;
      this._pendingTuneTimers = [];
      if (this.connected) this._startPolling();
    }, delay + 1000);
    return true;
  }

  disconnect() {
    this._target = null; // Clear target first to prevent auto-reconnect from close event
    this._stopPolling();
    for (const t of this._pendingTuneTimers) clearTimeout(t);
    this._pendingTuneTimers = [];
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

function mapMode(mode, freqHz, isSerial) {
  const m = (mode || '').toUpperCase();
  if (m === 'CW') return { md: 3 };
  if (m === 'USB') return { md: 2, da: isSerial ? 0 : null };
  if (m === 'LSB') return { md: 1, da: isSerial ? 0 : null };
  if (m === 'SSB') return { md: ssbSideband(freqHz) === 'USB' ? 2 : 1, da: isSerial ? 0 : null };
  if (m === 'FM') return { md: 4, da: isSerial ? 0 : null };
  if (m === 'DIGU' || m === 'FT8' || m === 'FT4') {
    // Kenwood serial: MD2 (USB) + DA1 (data mode on)
    // Flex TCP: MD9 (DIGU)
    return isSerial ? { md: 2, da: 1 } : { md: 9 };
  }
  if (m === 'DIGL') {
    return isSerial ? { md: 1, da: 1 } : { md: 6 };
  }
  if (m === 'RTTY') return { md: 6 };
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

  tune(frequencyHz, mode, { split, filterWidth } = {}) {
    if (!this.connected) return false;
    this._write(`F ${frequencyHz}\n`);
    if (mode) {
      const token = mapModeRigctld(mode, frequencyHz);
      if (token) {
        const passband = filterWidth > 0 ? filterWidth : 0;
        this._write(`M ${token} ${passband}\n`);
      }
    }
    // rigctld split: only send if enabled (don't touch radio's split state otherwise)
    if (split) this._write('S 1 VFOB\n');
    return true;
  }

  disconnect() {
    this._target = null; // Clear target first to prevent auto-reconnect from close event
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
