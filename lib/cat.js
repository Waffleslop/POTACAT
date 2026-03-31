// SmartSDR CAT client — supports both TCP and COM (serial) connections
const net = require('net');
const { EventEmitter } = require('events');
const { SerialPort } = require('serialport');
const {
  MD_TO_MODE, CIV_MODE_TO_NAME, YAESU_SSB_BW, YAESU_CW_BW,
  ssbSideband, yaesuBwToIndex, mapMode, mapModeRigctld, mapModeCiv,
} = require('./rig-utils');

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
    this._digiMd = null; // rig-model override for digital mode MD code (e.g. 6 for QMX)
    this._requestedMd = null; // last mode sent during tune (for post-reconnect enforcement)
    this._requestedDa = null; // last DA value sent during tune
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
      this._dtrFailed = false;
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
          // Post-reconnect mode enforcement — Yaesu serial can drop during band
          // changes, causing the post-tune mode command to be lost. Re-send the
          // last requested mode after reconnect so the radio doesn't stay in a
          // recalled mode (e.g. SSB instead of DATA-USB).
          if (this._requestedMd != null) {
            // Wait for Yaesu re-detection (happens after first poll round-trip ~1.3s)
            // then re-send the last requested mode
            setTimeout(() => {
              if (!this.connected || this._requestedMd == null) return;
              const md = this._requestedMd;
              if (this._isYaesu()) {
                this._write(`MD0${md.toString(16).toUpperCase()};`);
                this._log(`post-reconnect mode enforcement: MD0${md.toString(16).toUpperCase()}`);
              } else if (this._faDigitsDetected) {
                // Non-Yaesu Kenwood: send MDx; + DA if needed
                this._write(`MD${md};`);
                this._log(`post-reconnect mode enforcement: MD${md}`);
              }
              if (this._requestedDa != null && this._faDigitsDetected) {
                setTimeout(() => {
                  if (this.connected) this._write(`DA${this._requestedDa};`);
                }, 100);
              }
            }, 1500); // 1.5s: enough for one poll cycle + Yaesu re-detection
          }
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
        const mdVal = parseInt(mdPayload.length > 1 ? mdPayload.slice(-1) : mdPayload, 16);
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
      } else if (msg.startsWith('SM')) {
        // S-meter: SM0xxx (Yaesu/Flex) or SMxxx (Kenwood)
        const smDigits = msg.replace(/^SM0?/, '');
        const smVal = parseInt(smDigits, 10) || 0;
        this.emit('smeter', smVal);
      } else if (msg.startsWith('RM')) {
        // SWR/ALC meter: RM1xxxx (SWR), RM2xxxx (COMP), RM3xxxx (ALC)
        const rmType = msg.charAt(2);
        const rmVal = parseInt(msg.slice(3), 10) || 0;
        if (rmType === '1') this.emit('swr', rmVal);
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
      // Poll S-meter and SWR every cycle (skip for Flex — not supported in CAT emulation)
      if (!this._skipMeters) {
        this._write(this._isYaesu() ? 'SM0;' : 'SM;');
        this._write('RM1;');
      }
      // Poll power and NB every 5s (they change rarely)
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

  /** Pause polling during CW keying so TX;/RX; aren't delayed by FA;/MD; polls */
  pausePolling() {
    if (this._pollTimer && !this._pollPaused) {
      this._pollPaused = true;
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /** Resume polling after CW keying stops */
  resumePolling() {
    if (this._pollPaused) {
      this._pollPaused = false;
      if (this.connected) this._startPolling();
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

  /** Send a raw command string to the transport (for custom CAT buttons) */
  sendRaw(text) { this._write(text); }

  tune(frequencyHz, mode, { split, filterWidth } = {}) {
    this._log(`tune() called: freq=${frequencyHz} mode=${mode} split=${!!split} filter=${filterWidth || 0} connected=${this.connected}`);
    if (!this.connected) return false;
    // Cancel any pending mode/split/filter commands from a previous rapid tune call
    for (const t of this._pendingTuneTimers) clearTimeout(t);
    this._pendingTuneTimers = [];
    // Pause polling so tune commands aren't interleaved with FA; queries
    this._stopPolling();

    const isSerial = this._target && this._target.type === 'serial';
    let mapped = mode ? mapMode(mode, frequencyHz, isSerial) : null;
    // Rig-model override: some radios (QMX, QDX) use a non-standard MD code for digital
    if (mapped && this._digiMd != null && mapped.da != null) {
      mapped = { md: this._digiMd }; // e.g. MD6 for QMX DIGI mode
    }
    // Yaesu radios don't support the DA (data mode) command — they use dedicated
    // MD codes: MD0C = DATA-USB, MD08 = DATA-LSB. Remap when Yaesu detected.
    else if (mapped && mapped.da != null && this._isYaesu()) {
      const m = (mode || '').toUpperCase();
      if (m === 'DIGU' || m === 'PKTUSB' || m === 'FT8' || m === 'FT4' || m === 'FT2') {
        mapped = { md: 0xC }; // DATA-USB (MD0C)
      } else if (m === 'DIGL' || m === 'PKTLSB') {
        mapped = { md: 0x8 }; // DATA-LSB (MD08)
      }
    }
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
      const mdCmd = this._isYaesu() ? `MD0${mapped.md.toString(16).toUpperCase()};` : `MD${mapped.md};`;
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

    // Re-send mode AFTER frequency — Yaesu radios recall the last-used mode per band
    // when the frequency command crosses a band boundary, overriding the mode we just set.
    // For Yaesu: ALWAYS send mode after frequency (even if modeChanged is false) because
    // the FT-891/991 may drop the serial port during band changes — the pre-FA mode command
    // could be lost, and band recall can silently revert to a different mode.
    const alwaysSendPostMode = this._isYaesu();
    if (mapped && (modeChanged || alwaysSendPostMode)) {
      const mdCmd2 = this._isYaesu() ? `MD0${mapped.md.toString(16).toUpperCase()};` : `MD${mapped.md};`;
      this._pendingTuneTimers.push(setTimeout(() => {
        if (this.connected) this._write(mdCmd2);
      }, delay));
      delay += 100;
      // Re-send DA (data mode toggle) if needed
      if (mapped.da != null) {
        this._pendingTuneTimers.push(setTimeout(() => {
          if (this.connected) this._write(`DA${mapped.da};`);
        }, delay));
        delay += 100;
      }
      // Remember what mode we requested — used for post-reconnect enforcement
      this._requestedMd = mapped.md;
      this._requestedDa = mapped.da != null ? mapped.da : null;
    }

    // Send filter width after frequency
    if (mapped && filterWidth > 0) {
      this._pendingTuneTimers.push(setTimeout(() => {
        if (!this.connected) return;
        if (this._isYaesu()) {
          // Yaesu FT-891/991A: SH0<P1><P2P2> where P1=1 selects Width, P2=index
          // P1=0 is Shift (IF shift), P1=1 is Width (passband bandwidth)
          const idx = yaesuBwToIndex(filterWidth, MD_TO_MODE[mapped.md] || '');
          this._write(`SH01${String(idx).padStart(2, '0')};`);
        } else {
          this._write(`FW${String(filterWidth).padStart(4, '0')};`);
        }
      }, delay));
      delay += 100;
    }

    // Only send split ON when explicitly requested — don't send split OFF on every
    // tune as some Kenwood-compatible firmwares (e.g. FX4CR/f5bud) interpret FT as a toggle.
    if (split) {
      this._pendingTuneTimers.push(setTimeout(() => {
        if (!this.connected) return;
        // Yaesu uses ST1; for split (FT command not supported on FT-891)
        this._write(this._isYaesu() ? 'ST1;' : 'FT1;');
      }, delay));
    }
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
      this._write(`SH01${String(idx).padStart(2, '0')};`);
      this._log(`setFilterWidth Yaesu SH01${String(idx).padStart(2, '0')} (${hz}Hz)`);
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

  setPowerState(on) {
    // Power-on: radio may be off but serial port is open — don't require this.connected
    if (!this.transport) return;
    this._write(on ? 'PS1;' : 'PS0;');
    this._log(`setPowerState ${on ? 'ON' : 'OFF'}`);
  }

  setRfGain(val) {
    if (!this.connected) return;
    // Throttle: skip if last RG command was <150ms ago (prevents slider flutter on mobile)
    const now = Date.now();
    if (this._lastRgTime && now - this._lastRgTime < 150) return;
    this._lastRgTime = now;
    const clamped = Math.max(0, Math.min(255, Math.round(val * 2.55)));
    if (this._isYaesu()) {
      this._write(`RG0${String(clamped).padStart(3, '0')};`);
    } else {
      this._write(`RG${String(clamped).padStart(3, '0')};`);
    }
    this._log(`setRfGain ${val}% → RG${clamped}`);
  }

  setTxPower(watts) {
    if (!this.connected) return;
    // Throttle: skip if last PC command was <150ms ago (prevents slider flutter on mobile)
    const now = Date.now();
    if (this._lastPcTime && now - this._lastPcTime < 150) return;
    this._lastPcTime = now;
    const min = this._minPower || 0;
    const max = this._maxPower || 100;
    const clamped = Math.max(min, Math.min(max, Math.round(watts)));
    this._write(`PC${String(clamped).padStart(3, '0')};`);
    this._log(`setTxPower ${clamped}W`);
  }

  /**
   * Start ATU tune cycle.
   * Yaesu AC command has model-dependent parameter counts:
   *   FT-891: AC P1 P2 P3 — P1=0(fixed), P2=0(fixed), P3=0/1/2 (OFF/ON/TUNE)
   *           Must send AC001; (ON) then AC002; (TUNE) — tune fails if tuner isn't ON
   *   FT-991A, FTDX101D: AC P1 P2 P3 — P1=0, P2=0/1(OFF/ON), P3=0/1(THRU/TUNE)
   *   FT-450: AC P1 P2 — P1=0/1(OFF/ON), P2=0/1(THRU/TUNE)
   * Send all known formats — the radio accepts the one it understands.
   * Kenwood/Elecraft: AC011; (antenna 1, tuner ON, start tune)
   */
  startTune() {
    if (!this.connected) return;
    if (this._isYaesu() && this._atuCmd === 'ft891') {
      // FT-891/FTDX10: must send ON first, then TUNE
      this._write('AC001;');
      setTimeout(() => {
        if (!this.connected) return;
        this._write('AC002;');
      }, 300);
    } else if (this._isYaesu() && this._atuCmd === 'ac002') {
      // FTdx3000/FTdx1200: AC002 alone enables tuner + starts tune
      this._write('AC002;');
    } else if (this._isYaesu()) {
      // FT-991A/FTDX101D/FT-450/standard: AC011 (ON+TUNE)
      this._write('AC011;');
    } else {
      this._write('AC011;');
    }
    this._log('ATU tune started');
  }

  /** Turn the ATU off (bypass/thru mode). */
  stopTune() {
    if (!this.connected) return;
    if (this._isYaesu()) {
      this._write('AC000;');  // FT-891: P3=0 (OFF)
      this._write('AC000;');  // FT-991A/FTDX101D: P2=0, P3=0 (OFF/THRU)
    } else {
      this._write('AC010;');  // Kenwood: tuner on, thru (no active tuning)
    }
    this._log('ATU tuner off');
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

  /**
   * Send CW text via Kenwood KY command.
   * Radio's internal keyer plays the text at the current KS speed.
   * Max 80 chars in QMX buffer; we chunk to 24 chars for TS-480 compat.
   * @param {string} text — CW text (uppercase, spaces between words)
   */
  sendCwText(text) {
    if (!this.connected || !text) return;
    const clean = text.toUpperCase().replace(/[^A-Z0-9 /?.=,\-[\]_<>#%\\]/g, '');
    if (this._isYaesu() && this._kyMode === 'km') {
      // FTDX101D/MP: write to Text Memory 5 via KM, then play back via KYA
      // Uses slot 5 to avoid overwriting user's messages in slots 1-4
      // Max 50 chars per memory slot; chunk longer messages
      for (let i = 0; i < clean.length; i += 50) {
        const chunk = clean.slice(i, i + 50);
        this._write(`KM5${chunk};`);  // write to Text Memory 5
        this._write('KYA;');           // play back Text Memory 5 (Message Keyer 5)
      }
    } else if (this._isYaesu()) {
      // FT-991A, FT-710, FTDX10: KY<P1> <text padded to 48 chars>;
      const p1 = this._kyParam != null ? this._kyParam : 0;
      for (let i = 0; i < clean.length; i += 48) {
        const chunk = clean.slice(i, i + 48).padEnd(48, ' ');
        this._write(`KY${p1} ${chunk};`);
      }
    } else {
      // Kenwood KY command: KY <text>; (space separator, chunk to 24 for TS-480 compat)
      for (let i = 0; i < clean.length; i += 24) {
        const chunk = clean.slice(i, i + 24);
        this._write(`KY ${chunk};`);
      }
    }
    this._log(`sendCwText: ${clean}`);
  }

  /**
   * Set CW keyer speed via Kenwood KS command.
   * @param {number} wpm — words per minute (5-50)
   */
  setCwSpeed(wpm) {
    if (!this.connected) return;
    const clamped = Math.max(5, Math.min(50, wpm || 20));
    this._write(`KS${String(clamped).padStart(3, '0')};`);
    this._log(`setCwSpeed: ${clamped} WPM`);
  }

  /**
   * Key CW via DTR pin on serial port.
   * QMX firmware 1_03_000+: DTR high = key down, DTR low = key up.
   * Preserves operator's exact fist/timing (unlike KY text command).
   * Only works on serial connections — no-op on TCP.
   * If DTR fails (e.g. Linux CDC-ACM), falls back to TX/RX keying automatically.
   * @param {boolean} down — true = key down, false = key up
   */
  setCwKeyDtr(down) {
    if (this._dtrFailed) {
      this.setCwKeyTxRx(down);
      return;
    }
    if (!this.connected || !this.transport) {
      this._log(`setCwKeyDtr SKIP: connected=${this.connected} transport=${!!this.transport}`);
      return;
    }
    if (!(this.transport instanceof SerialPort)) {
      this._log(`setCwKeyDtr SKIP: transport is not SerialPort`);
      return;
    }
    const val = !!down;
    this.transport.set({ dtr: val, rts: val }, (err) => {
      if (err) {
        this._log(`setCwKeyDtr error: ${err.message} — falling back to TX/RX keying`);
        this._dtrFailed = true;
        this.setCwKeyTxRx(down);
      }
    });
    this._log(`setCwKeyDtr: dtr=${val} rts=${val}`);
  }

  /**
   * Key CW via TA (Transmit Audio) commands with Blackmann-Harris envelope shaping.
   * Uses Digi mode TA command: TA700; = tone on (shaped rise), TA0; = tone off (shaped fall).
   * TX;/RX; only sent once at start/end of keying session — not per element.
   * @param {boolean} down — true = key down, false = key up
   */
  setCwKeyTa(down) {
    if (down) {
      if (!this._cwTaActive) {
        // First key-down: switch to Digi mode and enter TX
        this._cwTaSavedMode = null;
        if (this._isYaesu()) {
          this._write('MD06;'); // Yaesu: Digi (RTTY-LSB) mode on main VFO
          this._write('TX1;');  // Yaesu TX
        } else {
          this._write('MD;');   // query current mode so we can restore later
          this._cwTaSavedMode = 'CW';
          this._write('MD6;');  // Kenwood: Digi (FSK) mode
          this._write('TX;');   // Kenwood TX
        }
        this._cwTaActive = true;
      }
      this._write('TA700;'); // tone on with shaped envelope
    } else {
      this._write('TA0;');   // tone off with shaped envelope
    }
  }

  /** End CW TA keying session — return to RX and restore CW mode */
  endCwKeyTa() {
    if (this._cwTaActive) {
      this._write('TA0;');  // ensure tone off
      if (this._isYaesu()) {
        this._write('TX0;');  // Yaesu RX
        this._write('MD03;'); // Yaesu: restore CW mode on main VFO
      } else {
        this._write('RX;');   // Kenwood RX
        this._write('MD3;');  // Kenwood: restore CW mode
      }
      this._cwTaActive = false;
    }
  }

  /**
   * Key CW via TX/RX commands on serial CAT (fallback, no envelope shaping).
   * @param {boolean} down — true = key down (TX), false = key up (RX)
   */
  setCwKeyTxRx(down) {
    if (this._isYaesu()) {
      this._write(down ? 'TX1;' : 'TX0;');
    } else {
      this._write(down ? 'TX;' : 'RX;');
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
  const result = ports.map((p) => ({
    path: p.path,
    manufacturer: p.manufacturer || '',
    friendlyName: p.friendlyName || p.path,
  }));

  // On macOS, ensure /dev/cu.* counterparts are listed alongside /dev/tty.* ports.
  // Many radios/interfaces (Digirig, FTDI, SiLabs) require the cu.* device for
  // non-blocking open. @serialport/list may only return tty.* on some macOS versions.
  if (process.platform === 'darwin') {
    const known = new Set(result.map((p) => p.path));
    for (const p of [...result]) {
      if (p.path.startsWith('/dev/tty.')) {
        const cuPath = p.path.replace('/dev/tty.', '/dev/cu.');
        if (!known.has(cuPath)) {
          known.add(cuPath);
          result.push({
            path: cuPath,
            manufacturer: p.manufacturer,
            friendlyName: cuPath,
          });
        }
      }
    }
  }

  return result;
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
    this._debug = false; // set to true to emit 'log' events
    this._yaesuRaw = false; // when true, send raw Yaesu CAT commands via 'w' passthrough
  }

  _log(msg) {
    if (this._debug) this.emit('log', msg);
  }

  /** Enable raw Yaesu CAT passthrough for NB/RF gain/ATU (works around incomplete hamlib backends) */
  setYaesuPassthrough(on) {
    this._yaesuRaw = !!on;
    if (on) this._log('Yaesu raw passthrough enabled (NB/RF gain/ATU via w command)');
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
      if (!line) continue;
      // After a mode response, the next line is the passband width — skip it.
      // Guard: if the value looks like a frequency (>100 kHz), don't consume it
      // as passband — some rigctld implementations (FLRig) omit the passband line.
      if (this._expectPassband) {
        this._expectPassband = false;
        if (/^\d+$/.test(line) && parseInt(line, 10) <= 100000) {
          continue; // genuine passband (0–100 kHz range)
        }
        // Fall through — process this line normally (it's not a passband)
      }
      // RPRT error responses from rigctld (e.g. "RPRT -1" = not implemented)
      if (/^RPRT\s+-?\d+/.test(line)) {
        const code = parseInt(line.split(/\s+/)[1], 10);
        // Clear pending state flags so they don't hang.
        // If NB query got an error, mark it unsupported to stop polling it.
        if (this._expectNb) {
          this._expectNb = false;
          if (code !== 0) this._nbUnsupported = true;
        }
        // Suppress repeated RPRT errors from polling (log only distinct codes)
        if (code !== 0 && code !== this._lastRprtCode) {
          this._log(`rx: ${line} (error: command not supported or failed)`);
        }
        this._lastRprtCode = code;
        continue;
      }
      // Frequency response is a plain integer (Hz) on its own line
      if (/^\d+$/.test(line)) {
        const hz = parseInt(line, 10);
        if (!isNaN(hz) && hz > 0) {
          // Log frequency changes (suppress repeated identical values)
          if (hz !== this._lastFreqHz) {
            this._log(`rx: ${hz} → freq=${(hz / 1000).toFixed(1)}kHz`);
            this._lastFreqHz = hz;
          }
          this.emit('frequency', hz);
        }
      }
      // Mode response: e.g. "USB" or "CW" (followed by passband on next line)
      else if (/^[A-Z]{2,8}$/.test(line) && !line.startsWith('RPRT')) {
        this._expectPassband = true;
        this._lastMode = line;
        this.emit('mode', line);
        this._log(`rx: ${line} → mode=${line}`);
      }
      // NB response from `u NB`: just "0" or "1" — disambiguated by _expectNb flag
      else if (this._expectNb && /^[01]$/.test(line)) {
        this._expectNb = false;
        this.emit('nb', line === '1');
        this._log(`rx: NB=${line === '1' ? 'ON' : 'OFF'}`);
      }
    }
  }

  _startPolling() {
    this._stopPolling();
    this._pollCount = 0;
    this._pollTimer = setInterval(() => {
      this._write('f\n'); // get frequency
      // Poll mode (and NB if supported) every 5th cycle
      if (this._pollCount++ % 5 === 0) {
        this._write('m\n');
        // Skip NB polling if the server returned an error (e.g. FLRig doesn't support it)
        if (!this._nbUnsupported) {
          this._expectNb = true;
          this._write('u NB\n');
        }
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
    if (!this.connected || !this.transport) {
      this._log(`_write DROPPED (connected=${this.connected}): ${data.replace(/\n/g, '\\n')}`);
      return;
    }
    // Suppress noisy poll commands from verbose log (f, m, u NB)
    if (data !== 'f\n' && data !== 'm\n' && data !== 'u NB\n') {
      this._log(`_write(${data.replace(/\n/g, '\\n')})`);
    }
    this.transport.write(data);
  }

  /** Send a raw CAT command via rigctld 'w' passthrough (for custom CAT buttons) */
  sendRaw(text) {
    const cmd = text.replace(/[\r\n]/g, '').trim();
    if (!cmd) return;
    this._sendImmediate(`w ${cmd}\n`);
    this._log(`sendRaw: w ${cmd}`);
  }

  tune(frequencyHz, mode, { split, filterWidth } = {}) {
    if (!this.connected) return false;
    // Pause polling so tune commands aren't interleaved with mode queries
    this._stopPolling();
    // Send mode BEFORE frequency — mode changes shift the passband/filter,
    // which moves the VFO position. Setting mode first ensures the subsequent
    // frequency command lands on the correct frequency.
    let modeToken = null;
    let modePassband = 0;
    if (mode) {
      modeToken = mapModeRigctld(mode, frequencyHz);
      if (modeToken) {
        modePassband = filterWidth > 0 ? filterWidth : 0;
        this._write(`M ${modeToken} ${modePassband}\n`);
        this._lastMode = modeToken;
      }
    }
    this._write(`F ${frequencyHz}\n`);
    // Re-send mode AFTER frequency — band changes can recall last-used mode for
    // the new band, overriding the mode we just set. Then re-send frequency to
    // correct any CW pitch offset that the mode change introduced (FT-710 issue).
    // Sequence: M → F → M → F (the "sandwich" — confirmed working by W3AVP)
    if (modeToken) {
      this._write(`M ${modeToken} ${modePassband}\n`);
      this._write(`F ${frequencyHz}\n`);
    }
    // Only send split command when explicitly enabled — sending S 0 to turn
    // split off can cause connection drops on some implementations (FLRig)
    if (split) this._write('S 1 VFOB\n');
    // Resume polling after radio has time to process
    setTimeout(() => {
      if (this.connected) this._startPolling();
    }, 500);
    return true;
  }

  /** Pause polling, send command(s), resume after brief delay.
   *  Prevents user-initiated commands from queuing behind poll responses. */
  _sendImmediate(cmds) {
    this._stopPolling();
    if (Array.isArray(cmds)) { for (const c of cmds) this._write(c); }
    else this._write(cmds);
    if (this._immediateTimer) clearTimeout(this._immediateTimer);
    this._immediateTimer = setTimeout(() => {
      this._immediateTimer = null;
      if (this.connected) this._startPolling();
    }, 1000);
  }

  setTransmit(state) {
    if (!this.connected) return;
    this._write(state ? 'T 1\n' : 'T 0\n');
    this._log(`PTT: ${state ? 'TX' : 'RX'}`);
  }

  setFilterWidth(hz) {
    if (!this.connected || !hz) return;
    const mode = this._lastMode || 'USB';
    this._sendImmediate(`M ${mode} ${hz}\n`);
    this._log(`setFilterWidth ${hz}Hz (mode=${mode})`);
  }

  setNb(on) {
    if (!this.connected) return;
    const cmd = this._yaesuRaw ? `w NB0${on ? 1 : 0};\n` : `U NB ${on ? 1 : 0}\n`;
    this._sendImmediate(cmd);
    this._log(`setNb ${on ? 'ON' : 'OFF'}`);
  }

  setVfo(vfo) {
    if (!this.connected) return;
    this._write(`V VFO${(vfo || 'A').toUpperCase()}\n`);
    this._log(`setVfo ${(vfo || 'A').toUpperCase()}`);
  }

  setRfGain(val) {
    if (!this.connected) return;
    const now = Date.now();
    if (this._lastRgTime && now - this._lastRgTime < 150) return;
    this._lastRgTime = now;
    if (this._yaesuRaw) {
      const clamped = Math.max(0, Math.min(255, Math.round(val * 255)));
      this._sendImmediate(`w RG0${String(clamped).padStart(3, '0')};\n`);
      this._log(`setRfGain ${(val * 100).toFixed(0)}% → w RG0${String(clamped).padStart(3, '0')}`);
    } else {
      this._sendImmediate(`L RFGAIN ${val.toFixed(3)}\n`);
      this._log(`setRfGain ${(val * 100).toFixed(0)}% → L RFGAIN ${val.toFixed(3)}`);
    }
  }

  /**
   * Start ATU tune cycle via rigctld.
   * Uses the TUNER function: U TUNER 1
   * Falls back to raw Kenwood AC011; for radios whose hamlib backend
   * doesn't implement set_func TUNER (e.g. Xiegu G90).
   */
  startTune() {
    if (!this.connected) return;
    if (this._yaesuRaw && this._atuCmd === 'ft891') {
      // FT-891/FTDX10: AC P1=0 P2=0 P3=0/1/2 → AC001; (ON) then AC002; (TUNE)
      // Must send ON first — AC002 fails if tuner isn't already enabled
      this._sendImmediate('w AC001;\n');
      setTimeout(() => {
        if (this.connected) this._sendImmediate('w AC002;\n');
      }, 300);
    } else if (this._yaesuRaw && this._atuCmd === 'ac002') {
      // FTdx3000/FTdx1200: AC002 alone enables tuner AND starts tune cycle
      this._sendImmediate('w AC002;\n');
    } else if (this._yaesuRaw) {
      // FT-991A/FTDX101D/standard: AC P1=0 P2=0/1 P3=0/1 → AC011; (ON+TUNE)
      this._sendImmediate('w AC011;\n');
    } else {
      // Use standard rigctld TUNER function — don't send raw Kenwood AC011
      // passthrough, which causes errors on non-Kenwood radios (e.g. Icom via FLRig)
      this._sendImmediate('U TUNER 1\n');
    }
    this._log('ATU tune started');
  }

  /** Turn the ATU off (bypass/thru mode). */
  stopTune() {
    if (!this.connected) return;
    if (this._yaesuRaw) {
      this._sendImmediate('w AC000;\n');
    } else {
      this._sendImmediate('U TUNER 0\n');
    }
    this._log('ATU tuner off');
  }

  setTxPower(val) {
    if (!this.connected) return;
    const now = Date.now();
    if (this._lastPcTime && now - this._lastPcTime < 150) return;
    this._lastPcTime = now;
    if (this._yaesuRaw) {
      // Yaesu: use raw PC command (L RFPOWER doesn't work reliably via hamlib)
      const min = this._minPower || 5;
      const max = this._maxPower || 100;
      const watts = Math.max(min, Math.min(max, Math.round(val * max)));
      this._sendImmediate(`w PC${String(watts).padStart(3, '0')};\n`);
      this._log(`setTxPower ${(val * 100).toFixed(0)}% → w PC${String(watts).padStart(3, '0')} (${watts}W)`);
    } else {
      this._sendImmediate(`L RFPOWER ${val.toFixed(3)}\n`);
      this._log(`setTxPower ${(val * 100).toFixed(0)}% → L RFPOWER ${val.toFixed(3)}`);
    }
  }

  setPowerState(on) {
    if (!this.connected) return;
    this._sendImmediate(`\\set_powerstat ${on ? 1 : 0}\n`);
    this._log(`setPowerState ${on ? 'ON' : 'OFF'}`);
  }

  sendCwText(text) {
    if (!this.connected || !text) return;
    const clean = text.toUpperCase().replace(/[^A-Z0-9 /?.=,\-]/g, '');
    // rigctld send_morse command: b <text>
    this._write(`b ${clean}\n`);
    this._log(`sendCwText: ${clean}`);
  }

  setCwSpeed(wpm) {
    if (!this.connected) return;
    const clamped = Math.max(5, Math.min(50, Math.round(wpm)));
    // rigctld set_level KEYSPD
    this._write(`L KEYSPD ${clamped}\n`);
    this._log(`setCwSpeed: ${clamped} WPM`);
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

// --- Icom CI-V binary protocol client ---
// Connects via USB serial to Icom radios (IC-7300, IC-705, IC-7610, etc.)
// Same EventEmitter interface as CatClient/RigctldClient.

class CivClient extends EventEmitter {
  constructor() {
    super();
    this.transport = null;     // SerialPort instance
    this.connected = false;
    this._reconnectTimer = null;
    this._pollTimer = null;
    this._pollPaused = false;
    this._pollCount = 0;
    this._target = null;       // { type: 'icom', path, baudRate, civAddress, civModel }
    this._buf = Buffer.alloc(0);
    this._debug = false;
    this._radioAddr = 0x94;    // default IC-7300 MK1
    this._ctrlAddr = 0xE0;     // standard controller address
    this._lastMode = null;     // last parsed mode name (e.g. 'CW')
    this._lastModeByte = null; // last parsed CI-V mode byte (e.g. 0x03)
    this._pendingTuneTimer = null;
  }

  connect(target) {
    this.disconnect();
    this._target = target;
    this._radioAddr = target.civAddress || 0x94;
    this._dtrFailed = false;
    this._connectSerial(target);
  }

  _log(msg) {
    if (this._debug) this.emit('log', msg);
  }

  _connectSerial({ path, baudRate }) {
    const baud = baudRate || 115200;
    const port = new SerialPort({
      path,
      baudRate: baud,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      autoOpen: false,
      rtscts: false,
      hupcl: false,
    });
    this.transport = port;

    port.on('data', (chunk) => {
      this._buf = Buffer.concat([this._buf, chunk]);
      this._processBuffer();
    });

    port.on('open', () => {
      // Guard: if disconnect() was called while port was opening
      if (this.transport !== port) {
        try { port.close(); } catch {}
        return;
      }
      // Start with DTR/RTS low (CW key up)
      try { port.set({ dtr: false, rts: false }); } catch {}
      this._log(`CI-V connected to ${path} @ ${baud}, addr=0x${this._radioAddr.toString(16).toUpperCase()}`);
      this.connected = true;
      this.emit('status', { connected: true, target: this._target });
      // Delay before first poll — give radio time after USB enumeration
      setTimeout(() => {
        if (this.connected && this.transport === port) this._startPolling();
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
        this._log(`CI-V open error: ${err.message}`);
        this.connected = false;
        this.emit('status', { connected: false, target: this._target });
        this._scheduleReconnect();
      }
    });
  }

  // --- CI-V frame I/O ---

  /** Build and write a CI-V frame: FE FE <radio> <ctrl> <cmd> [sub] [data] FD */
  _writeFrame(cmd, sub, data) {
    if (!this.connected || !this.transport) return;
    const parts = [0xFE, 0xFE, this._radioAddr, this._ctrlAddr, cmd];
    if (sub != null) {
      if (Array.isArray(sub)) parts.push(...sub);
      else parts.push(sub);
    }
    if (data != null) {
      if (Buffer.isBuffer(data)) parts.push(...data);
      else if (Array.isArray(data)) parts.push(...data);
      else parts.push(data);
    }
    parts.push(0xFD);
    const buf = Buffer.from(parts);
    this.transport.write(buf);
    this._log(`TX: ${[...buf].map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}`);
  }

  /** Send a raw hex string to the transport (for custom CAT buttons).
   *  Accepts space-separated hex bytes, e.g. "FE FE 94 E0 1C 00 01 FD" */
  sendRaw(text) {
    if (!this.connected || !this.transport) return;
    const hexStr = text.replace(/\s+/g, '');
    if (/^[0-9a-fA-F]+$/.test(hexStr) && hexStr.length % 2 === 0) {
      const buf = Buffer.from(hexStr, 'hex');
      this.transport.write(buf);
      this._log(`TX raw: ${[...buf].map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}`);
    }
  }

  /** Scan buffer for complete CI-V frames and dispatch them */
  _processBuffer() {
    while (this._buf.length >= 6) { // Minimum: FE FE to from cmd FD
      // Find FE FE preamble
      let preamble = -1;
      for (let i = 0; i < this._buf.length - 1; i++) {
        if (this._buf[i] === 0xFE && this._buf[i + 1] === 0xFE) {
          preamble = i;
          break;
        }
      }
      if (preamble === -1) { this._buf = Buffer.alloc(0); return; }
      if (preamble > 0) this._buf = this._buf.slice(preamble);

      // Find FD terminator
      const fdIdx = this._buf.indexOf(0xFD, 4);
      if (fdIdx === -1) return; // Incomplete frame — wait for more data

      // Extract frame body (between FE FE and FD)
      const body = this._buf.slice(2, fdIdx);
      this._buf = this._buf.slice(fdIdx + 1);

      if (body.length < 3) continue; // Need at least to + from + cmd

      const toAddr = body[0];
      const fromAddr = body[1];
      const cmd = body[2];
      const payload = body.slice(3);

      // Only process frames addressed to the controller (from radio to us).
      // Ignore echoed commands (addressed to radio) when CI-V echo is enabled.
      if (toAddr !== this._ctrlAddr) continue;

      this._log(`RX: cmd=0x${cmd.toString(16).toUpperCase().padStart(2, '0')} payload=${[...payload].map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')}`);
      this._dispatchFrame(cmd, payload);
    }
  }

  _dispatchFrame(cmd, payload) {
    switch (cmd) {
      // Frequency data — solicited (0x03) or unsolicited (0x00)
      case 0x03:
      case 0x00:
        if (payload.length >= 5) {
          const hz = this._bcdToHz(payload.slice(0, 5));
          if (hz > 0) this.emit('frequency', hz);
        }
        break;

      // Mode data — solicited (0x04) or unsolicited (0x01)
      case 0x04:
      case 0x01:
        if (payload.length >= 1) {
          const modeByte = payload[0];
          // payload[1] is filter (FIL1=1, FIL2=2, FIL3=3) — ignored for now
          // TODO: detect data mode (USB-D) via cmd 0x1A sub 0x06
          const modeName = CIV_MODE_TO_NAME[modeByte];
          if (modeName) {
            this._lastMode = modeName;
            this._lastModeByte = modeByte;
            this.emit('mode', modeName);
          }
          this._log(`mode: 0x${modeByte.toString(16).padStart(2, '0')} → ${modeName || '?'}`);
        }
        break;

      // Level data (response to cmd 0x14 + sub-command)
      case 0x14:
        if (payload.length >= 3) {
          const sub = payload[0];
          const value = this._bcdLevelToInt(payload.slice(1, 3));
          if (sub === 0x0A) {
            // RF power level: 0-255 → approximate watts (radio-dependent)
            this.emit('power', Math.round(value * 100 / 255));
          }
        }
        break;

      // OK acknowledgment
      case 0xFB:
        break;

      // NG (error)
      case 0xFA:
        this._log('NAK (command rejected)');
        break;
    }
  }

  // --- BCD helpers ---

  /** Decode CI-V BCD frequency bytes (5 bytes, LSB first) → Hz */
  _bcdToHz(bytes) {
    let hz = 0, mult = 1;
    for (let i = 0; i < bytes.length; i++) {
      hz += ((bytes[i] >> 4) * 10 + (bytes[i] & 0x0F)) * mult;
      mult *= 100;
    }
    return hz;
  }

  /** Encode Hz → 5-byte BCD (LSB first) for CI-V frequency commands */
  _hzToBcd(hz) {
    const buf = Buffer.alloc(5);
    let val = Math.abs(Math.round(hz));
    for (let i = 0; i < 5; i++) {
      const pair = val % 100;
      buf[i] = (Math.floor(pair / 10) << 4) | (pair % 10);
      val = Math.floor(val / 100);
    }
    return buf;
  }

  /** Decode 2-byte BCD level (0x00 0x00 = 0, 0x02 0x55 = 255) → int */
  _bcdLevelToInt(bytes) {
    const hi = (bytes[0] >> 4) * 10 + (bytes[0] & 0x0F);
    const lo = (bytes[1] >> 4) * 10 + (bytes[1] & 0x0F);
    return hi * 100 + lo;
  }

  /** Encode int 0-255 → 2-byte BCD level */
  _intToBcdLevel(val) {
    const v = Math.max(0, Math.min(255, Math.round(val)));
    const hi = Math.floor(v / 100);
    const lo = v % 100;
    return [
      (Math.floor(hi / 10) << 4) | (hi % 10),
      (Math.floor(lo / 10) << 4) | (lo % 10),
    ];
  }

  // --- Polling ---

  _startPolling() {
    this._stopPolling();
    this._pollCount = 0;
    this._pollTimer = setInterval(() => {
      this._writeFrame(0x03, null, null); // Read frequency
      this._writeFrame(0x04, null, null); // Read mode
      // Read power level every 5th cycle
      if (this._pollCount++ % 5 === 0) {
        this._writeFrame(0x14, 0x0A, null);
      }
    }, 1000);
  }

  _stopPolling() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
  }

  /** Pause polling during CW keying so DTR toggles aren't delayed */
  pausePolling() {
    if (this._pollTimer && !this._pollPaused) {
      this._pollPaused = true;
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /** Resume polling after CW keying stops */
  resumePolling() {
    if (this._pollPaused) {
      this._pollPaused = false;
      if (this.connected) this._startPolling();
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || !this._target) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._target) this.connect(this._target);
    }, 2000);
  }

  // --- Tune ---

  tune(frequencyHz, mode, { split, filterWidth } = {}) {
    this._log(`tune() freq=${frequencyHz} mode=${mode}`);
    if (!this.connected) return false;

    this._stopPolling();
    if (this._pendingTuneTimer) { clearTimeout(this._pendingTuneTimer); this._pendingTuneTimer = null; }

    let delay = 0;

    // Set mode if specified and different from current
    let civMode = null;
    if (mode) {
      civMode = mapModeCiv(mode, frequencyHz);
      if (civMode != null && civMode !== this._lastModeByte) {
        this._writeFrame(0x06, null, [civMode, 0x01]); // mode + FIL1
        delay = 100;
      }
    }

    // Set frequency after mode settles
    setTimeout(() => {
      if (this.connected) this._writeFrame(0x05, null, this._hzToBcd(frequencyHz));
    }, delay);

    // Re-send mode AFTER frequency — band stacking registers may recall a
    // different mode when the frequency crosses a band boundary.
    if (civMode != null && civMode !== this._lastModeByte) {
      setTimeout(() => {
        if (this.connected) this._writeFrame(0x06, null, [civMode, 0x01]);
      }, delay + 100);
    }

    // Query frequency shortly after to confirm (drives click-to-tune feedback)
    setTimeout(() => {
      if (this.connected) this._writeFrame(0x03, null, null);
    }, delay + 200);

    // Resume polling after settling
    this._pendingTuneTimer = setTimeout(() => {
      this._pendingTuneTimer = null;
      if (this.connected) this._startPolling();
    }, delay + 500);

    return true;
  }

  // --- PTT (cmd 0x1C sub 0x00) ---

  setTransmit(state) {
    if (!this.connected) return;
    this._writeFrame(0x1C, 0x00, [state ? 0x01 : 0x00]);
    this._log(`PTT: ${state ? 'TX' : 'RX'}`);
  }

  // --- CW text (cmd 0x17) ---

  /**
   * Send CW text via CI-V command 0x17.
   * Radio's internal keyer plays the text at the current speed.
   * Max 30 chars per frame. Use ^ for prosigns (e.g. ^AR).
   */
  sendCwText(text) {
    if (!this.connected || !text) return;
    const clean = text.toUpperCase().replace(/[^A-Z0-9 /?.=,\-^@]/g, '');
    for (let i = 0; i < clean.length; i += 30) {
      const chunk = clean.slice(i, i + 30);
      this._writeFrame(0x17, null, Buffer.from(chunk, 'ascii'));
    }
    this._log(`sendCwText: ${clean}`);
  }

  /** Stop CW text playback (send 0xFF) */
  stopCwText() {
    if (!this.connected) return;
    this._writeFrame(0x17, null, [0xFF]);
    this._log('stopCwText');
  }

  /**
   * Set CW keyer speed via CI-V (cmd 0x14 sub 0x0C).
   * Range: 6-48 WPM → level 0-255 (linear approximation).
   */
  setCwSpeed(wpm) {
    if (!this.connected) return;
    const clamped = Math.max(6, Math.min(48, wpm || 20));
    const level = Math.round((clamped - 6) * (255 / 42));
    this._writeFrame(0x14, 0x0C, this._intToBcdLevel(level));
    this._log(`setCwSpeed: ${clamped} WPM (level=${level})`);
  }

  /**
   * Key CW via DTR on the serial port.
   * Radio menu must be set: USB Keying (CW) = DTR.
   * Only works on radios that support DTR keying over their USB serial interface.
   * If DTR fails (e.g. Linux CDC-ACM), falls back to CI-V PTT keying automatically.
   */
  setCwKeyDtr(down) {
    if (this._dtrFailed) {
      this.setCwKeyTxRx(down);
      return;
    }
    if (!this.connected || !this.transport) return;
    if (!(this.transport instanceof SerialPort)) return;
    this.transport.set({ dtr: !!down }, (err) => {
      if (err) {
        this._log(`setCwKeyDtr error: ${err.message} — falling back to CI-V PTT keying`);
        this._dtrFailed = true;
        this.setCwKeyTxRx(down);
      }
    });
  }

  /**
   * Key CW via CI-V PTT command (0x1C sub 0x00).
   * Universal CI-V method — works on all Icom radios without DTR configuration.
   * TX/RX per element; adequate for iambic keyer speeds.
   */
  setCwKeyTxRx(down) {
    if (!this.connected) return;
    this._writeFrame(0x1C, 0x00, [down ? 0x01 : 0x00]);
  }

  setCwKeyTa() {}
  endCwKeyTa() {}

  // --- Stubs for interface compatibility with CatClient/RigctldClient ---

  setFilterWidth() {}
  setNb() {}
  startTune() {}
  setVfo() {}
  swapVfo() {}
  setRfGain() {}
  setTxPower() {}

  /**
   * Power on/off via CI-V command 0x18.
   * Power on:  FE FE <addr> E0 18 01 FD
   * Power off: FE FE <addr> E0 18 00 FD
   * Note: USB interface must remain powered in standby for power-on to work.
   */
  setPowerState(on) {
    // Power-on needs the serial port open even if radio is off,
    // so we write directly to transport rather than checking this.connected
    if (!this.transport) return;
    this._writeFrame(0x18, on ? 0x01 : 0x00);
    this._log(`setPowerState ${on ? 'ON' : 'OFF'} (CI-V 0x18)`);
    // After power-on, send explicit RX command to clear any stale TX state
    // (IC-7300 can come up in TX if previous session left PTT asserted)
    if (on) {
      setTimeout(() => {
        if (this.transport) {
          this._writeFrame(0x1C, 0x00, [0x00]);
          this._log('setPowerState: forced RX after power-on (safety)');
        }
      }, 3000); // wait for radio to boot before sending RX
    }
  }

  // --- Disconnect ---

  disconnect() {
    this._target = null;
    this._stopPolling();
    if (this._pendingTuneTimer) { clearTimeout(this._pendingTuneTimer); this._pendingTuneTimer = null; }
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.transport) {
      // Safety: force DTR low (CW key up) before closing
      if (this.transport instanceof SerialPort && this.transport.isOpen) {
        try { this.transport.set({ dtr: false, rts: false }); } catch {}
        this.transport.close();
      }
      this.transport = null;
    }
    this.connected = false;
  }
}

module.exports = { CatClient, RigctldClient, CivClient, listSerialPorts };
