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
    // Preserve Yaesu detection across auto-reconnects to the same target —
    // serial port can drop momentarily (e.g. Digirig on TX) and reconnect,
    // losing _isYaesu() which causes PTT release to use wrong syntax
    const sameTarget = this._target && target &&
      this._target.type === target.type &&
      (this._target.path === target.path || (this._target.host === target.host && this._target.port === target.port));
    this.disconnect();
    this._target = target;
    if (!sameTarget) {
      this._faDigits = 11;
      this._faDigitsDetected = false;
    }

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
      sock.setKeepAlive(true, 10000); // detect dead connections within ~10s
      this._log(`TCP connected to ${host}:${port}, noDelay=true, keepAlive=10s`);
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
      // Safety: force PTT off on reconnect — if the serial port dropped during TX
      // (e.g. Digirig/FT-891), the radio may be stuck transmitting
      if (this._faDigitsDetected) {
        // Already know the radio type from previous connection
        this.setTransmit(false);
      }
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
          const wasDetected = this._faDigitsDetected;
          this._faDigits = faPayload.length;
          this._faDigitsDetected = true;
          // Restart polling on first detection so MD command switches to Yaesu syntax
          if (!wasDetected && this._faDigits === 9 && this._pollTimer) {
            this._log(`Yaesu detected (${this._faDigits}-digit FA), switching to MD0 syntax`);
            this._startPolling();
          }
        }
        const hz = parseInt(faPayload, 10);
        if (!isNaN(hz)) this.emit('frequency', hz);
      } else if (msg.startsWith('PC')) {
        const watts = parseInt(msg.slice(2), 10);
        if (!isNaN(watts) && watts >= 0) this.emit('power', watts);
      } else if (msg.startsWith('MD')) {
        // Yaesu returns MD0x (with VFO selector), Kenwood returns MDx
        const mdPayload = msg.slice(2);
        const mdVal = parseInt(mdPayload.length > 1 ? mdPayload.slice(-1) : mdPayload, 10);
        const modeName = MD_TO_MODE[mdVal];
        if (modeName) {
          this._lastParsedMode = modeName;
          this.emit('mode', modeName);
        }
        this._log(`rx: ${msg} → mode=${modeName || '?'}`);
      } else if (msg.startsWith('NB')) {
        // Yaesu: NB0x (x=0 off, x=1 on), Kenwood: NBx
        const nbPayload = msg.slice(2);
        const nbVal = parseInt(nbPayload.slice(-1), 10);
        const nbOn = nbVal === 1;
        this.emit('nb', nbOn);
        this._log(`rx: ${msg} → nb=${nbOn}`);
      } else {
        this._log(`rx: ${msg}`);
      }
    }
  }

  _isYaesu() { return this._faDigitsDetected && this._faDigits === 9; }

  _startPolling() {
    this._stopPolling();
    this._pollCount = 0;
    this._pollTimer = setInterval(() => {
      this._write('FA;');
      // Yaesu requires VFO selector: MD0; (main VFO). Kenwood/Flex uses MD;
      this._write(this._isYaesu() ? 'MD0;' : 'MD;');
      // Poll power and NB every 5s (not every cycle — they change rarely)
      if (this._pollCount++ % 5 === 0) {
        this._write('PC;');
        this._write(this._isYaesu() ? 'NB0;' : 'NB;');
      }
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
    }, 2000);
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
    // current mode, so the radio must be in the correct mode before FA is sent.
    // Skip if radio is already in the target mode to avoid resetting filter bandwidth
    // (sending MD resets filter to radio default on Elecraft K3 and similar rigs).
    const targetModeName = mapped ? MD_TO_MODE[mapped.md] : null;
    const modeChanged = mapped && targetModeName !== this._lastParsedMode;
    if (mapped && modeChanged) {
      // Yaesu requires VFO selector: MD0x; (main VFO). Kenwood/Flex uses MDx;
      const mdCmd = this._isYaesu() ? `MD0${mapped.md};` : `MD${mapped.md};`;
      this._write(mdCmd);
      delay = Math.max(delay, 100);
    }
    // Kenwood DATA mode toggle (DA command) for FT8/FT4/FT2 on serial radios —
    // always send DA when specified, even if MD didn't change (USB→FT8 is same MD)
    if (mapped && mapped.da != null) {
      this._pendingTuneTimers.push(setTimeout(() => {
        if (this.connected) this._write(`DA${mapped.da};`);
      }, delay || 100));
      if (!modeChanged) delay = Math.max(delay, 100);
      delay += 100;
    }

    // Send frequency command after mode is set
    this._pendingTuneTimers.push(setTimeout(() => {
      if (this.connected) this._write(`FA${String(frequencyHz).padStart(this._faDigits, '0')};`);
    }, delay));
    delay += 100;

    // Send filter width after frequency (Kenwood/Flex only — Yaesu doesn't support FW)
    if (mapped && filterWidth > 0 && !this._isYaesu()) {
      this._pendingTuneTimers.push(setTimeout(() => {
        if (this.connected) this._write(`FW${String(filterWidth).padStart(4, '0')};`);
      }, delay));
      delay += 100;
    }

    // Explicitly set split state — FT1 enables (VFO B = TX), FT0 disables
    this._pendingTuneTimers.push(setTimeout(() => {
      if (this.connected) this._write(split ? 'FT1;' : 'FT0;');
    }, delay));
    delay += 100;
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

  setTransmit(state) {
    if (!this.connected) return;
    // Yaesu uses TX1;/TX0; (with VFO selector), Kenwood/Flex uses TX;/RX;
    if (this._isYaesu()) {
      this._write(state ? 'TX1;' : 'TX0;');
    } else {
      this._write(state ? 'TX;' : 'RX;');
    }
    this._log(`PTT: ${state ? 'TX' : 'RX'}`);
  }

  setFilterWidth(hz) {
    if (!this.connected || !hz) return;
    if (this._isYaesu()) {
      const idx = yaesuBwToIndex(hz, this._lastParsedMode || '');
      this._write(`SH0${String(idx).padStart(2, '0')};`);
      this._log(`setFilterWidth Yaesu SH0${String(idx).padStart(2, '0')} (${hz}Hz)`);
    } else {
      this._write(`FW${String(hz).padStart(4, '0')};`);
      this._log(`setFilterWidth Kenwood FW${String(hz).padStart(4, '0')}`);
    }
  }

  setNb(on) {
    if (!this.connected) return;
    if (this._isYaesu()) {
      this._write(`NB0${on ? 1 : 0};`);
    } else {
      this._write(`NB${on ? 1 : 0};`);
    }
    this._log(`setNb ${on ? 'ON' : 'OFF'}`);
  }

  /**
   * Start ATU tune cycle.
   * Yaesu AC command has model-dependent parameter counts:
   *   2-param (FT-891, FT-450): AC11; = tuner ON + TUNE
   *   3-param (FT-991A, FTDX101D): AC011; = external ATU/ATAS ON + TUNE
   * Send both — the radio accepts the one it understands, returns ? for the other.
   * ATAS-120A tuning is triggered by the same command when the radio menu is set to ATAS.
   * Kenwood/Elecraft: AC011; (antenna 1, tuner ON, start tune)
   */
  startTune() {
    if (!this.connected) return;
    if (this._isYaesu()) {
      this._write('AC11;');   // 2-param Yaesu (FT-891, FT-450)
      this._write('AC011;');  // 3-param Yaesu (FT-991A, FTDX101D)
    } else {
      this._write('AC011;');
    }
    this._log('ATU tune started');
  }

  setVfo(vfo) {
    if (!this.connected) return;
    const b = (vfo || 'A').toUpperCase() === 'B' ? 1 : 0;
    if (this._isYaesu()) {
      this._write(`VS${b};`);
    } else {
      this._write(`FR${b};`);
    }
    this._log(`setVfo ${b === 0 ? 'A' : 'B'}`);
  }

  swapVfo() {
    if (!this.connected) return;
    if (this._isYaesu()) {
      this._write('SV;');
      this._log('swapVfo Yaesu SV');
    } else {
      // Kenwood has no swap command — toggle FR0/FR1
      // Caller should track current VFO and call setVfo() with the opposite
      this._log('swapVfo Kenwood (no-op, use setVfo toggle)');
    }
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
        this.transport.end();
        const sock = this.transport;
        setTimeout(() => { try { sock.destroy(); } catch {} }, 500);
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

// Kenwood/Flex MD response → mode string
const MD_TO_MODE = { 1: 'LSB', 2: 'USB', 3: 'CW', 4: 'FM', 5: 'AM', 6: 'RTTY', 7: 'CW', 9: 'DIGU' };

// Yaesu SH0 bandwidth tables (1-based index → Hz)
const YAESU_SSB_BW = [200,400,600,850,1100,1350,1500,1650,1800,1950,2100,2250,2400,2500,2600,2700,2800,2900,3000,3200,3600];
const YAESU_CW_BW  = [50,100,150,200,250,300,350,400,450,500,600,800,1000,1200,1500,2400];

function yaesuBwToIndex(hz, mode) {
  const m = (mode || '').toUpperCase();
  const table = (m === 'CW') ? YAESU_CW_BW : YAESU_SSB_BW;
  let best = 0, bestDist = Infinity;
  for (let i = 0; i < table.length; i++) {
    const d = Math.abs(table[i] - hz);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best + 1; // 1-based index
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
  if (m === 'DIGU' || m === 'FT8' || m === 'FT4' || m === 'FT2') {
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
    this._expectPassband = false;
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
      // After a mode response, the next line is the passband width — skip it
      if (this._expectPassband) {
        this._expectPassband = false;
        continue;
      }
      // Frequency response is a plain integer (Hz) on its own line
      if (/^\d+$/.test(line)) {
        const hz = parseInt(line, 10);
        if (!isNaN(hz) && hz > 0) this.emit('frequency', hz);
      }
      // Mode response: e.g. "USB" or "CW" (followed by passband on next line)
      else if (/^[A-Z]{2,8}$/.test(line) && !line.startsWith('RPRT')) {
        this._expectPassband = true;
        this._lastMode = line;
        this.emit('mode', line);
      }
      // NB response from `u NB`: just "0" or "1" — disambiguated by _expectNb flag
      else if (this._expectNb && /^[01]$/.test(line)) {
        this._expectNb = false;
        this.emit('nb', line === '1');
      }
    }
  }

  _startPolling() {
    this._stopPolling();
    this._pollCount = 0;
    this._pollTimer = setInterval(() => {
      this._write('f\n'); // get frequency
      // Poll mode and NB every 5th cycle
      if (this._pollCount++ % 5 === 0) {
        this._write('m\n');
        this._expectNb = true;
        this._write('u NB\n');
      }
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
    }, 2000);
  }

  _write(data) {
    if (!this.connected || !this.transport) return;
    this.transport.write(data);
  }

  tune(frequencyHz, mode, { split, filterWidth } = {}) {
    if (!this.connected) return false;
    // Send mode BEFORE frequency — mode changes shift the passband/filter,
    // which moves the VFO position. Setting mode first ensures the subsequent
    // frequency command lands on the correct frequency.
    if (mode) {
      const token = mapModeRigctld(mode, frequencyHz);
      // Skip mode command if radio is already in the target mode to avoid
      // resetting filter bandwidth (passband 0 = radio default)
      if (token && token !== this._lastMode) {
        const passband = filterWidth > 0 ? filterWidth : 0;
        this._write(`M ${token} ${passband}\n`);
      }
    }
    this._write(`F ${frequencyHz}\n`);
    // Explicitly set split state via rigctld
    this._write(split ? 'S 1 VFOB\n' : 'S 0\n');
    return true;
  }

  setTransmit(state) {
    if (!this.connected) return;
    this._write(state ? 'T 1\n' : 'T 0\n');
  }

  setFilterWidth(hz) {
    if (!this.connected || !hz) return;
    const mode = this._lastMode || 'USB';
    this._write(`M ${mode} ${hz}\n`);
  }

  setNb(on) {
    if (!this.connected) return;
    this._write(`U NB ${on ? 1 : 0}\n`);
  }

  setVfo(vfo) {
    if (!this.connected) return;
    this._write(`V VFO${(vfo || 'A').toUpperCase()}\n`);
  }

  setRfGain(val) {
    if (!this.connected) return;
    this._write(`L RFGAIN ${val.toFixed(3)}\n`);
  }

  /**
   * Start ATU tune cycle via rigctld.
   * Uses the TUNER function: U TUNER 1
   */
  startTune() {
    if (!this.connected) return;
    this._write('U TUNER 1\n');
  }

  setTxPower(val) {
    if (!this.connected) return;
    this._write(`L RFPOWER ${val.toFixed(3)}\n`);
  }

  disconnect() {
    this._target = null; // Clear target first to prevent auto-reconnect from close event
    this._stopPolling();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.transport) {
      this.transport.end();
      const sock = this.transport;
      setTimeout(() => { try { sock.destroy(); } catch {} }, 500);
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
  if (m === 'DIGU' || m === 'FT8' || m === 'FT4' || m === 'FT2') return 'PKTUSB';
  if (m === 'DIGL') return 'PKTLSB';
  return null;
}

module.exports = { CatClient, RigctldClient, listSerialPorts };
