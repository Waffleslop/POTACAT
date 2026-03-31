// K1EL WinKeyer serial protocol handler
// Supports WK2 and WK3 — 1200 baud, 8N2
// Sends ASCII text for CW transmission, handles flow control and status bytes

const { EventEmitter } = require('events');

// WinKeyer admin commands (prefixed with 0x00)
const ADMIN_OPEN = 0x02;
const ADMIN_CLOSE = 0x03;

// WinKeyer immediate commands
const CMD_SPEED = 0x02;       // [0x02, wpm]
const CMD_WEIGHT = 0x03;      // [0x03, weight] (50 = normal)
const CMD_PTT_LEADIN = 0x04;  // [0x04, 10ms_units]
const CMD_PTT_TAIL = 0x05;    // [0x05, 10ms_units]
const CMD_CLEAR = 0x0A;       // Clear buffer + stop sending
const CMD_PINCONFIG = 0x09;   // [0x09, config_byte]

// Status byte bits (bytes 0xC0-0xFF)
const STATUS_BREAKIN = 0x01;   // bit 0: paddle breakin during send
const STATUS_BUSY = 0x04;      // bit 2: keyer is sending
const STATUS_XOFF = 0x01;      // bit 0 of upper nibble: buffer 2/3 full (pause host)
// Note: XOFF indicated by status byte bit 5

class WinKeyer extends EventEmitter {
  constructor() {
    super();
    this._port = null;
    this._connected = false;
    this._version = 0;
    this._wpm = 20;
    this._busy = false;
    this._xoff = false;
    this._txBuffer = '';      // pending text when XOFF
    this._closing = false;
  }

  get connected() { return this._connected; }
  get version() { return this._version; }
  get busy() { return this._busy; }

  connect(portPath) {
    if (this._port) this.disconnect();
    if (!portPath) return;

    const { SerialPort } = require('serialport');
    const port = new SerialPort({
      path: portPath,
      baudRate: 1200,
      dataBits: 8,
      stopBits: 2,
      parity: 'none',
      autoOpen: false,
      rtscts: false,
      hupcl: false,
    });

    this._port = port;
    this._closing = false;

    port.on('open', () => {
      console.log(`[WinKeyer] Opened ${portPath}`);
      // Send Host Open command
      port.write(Buffer.from([0x00, ADMIN_OPEN]));
      // Version byte comes back in the data handler
    });

    port.on('data', (buf) => this._onData(buf));

    port.on('error', (err) => {
      console.log(`[WinKeyer] Error: ${err.message}`);
      this.emit('error', err);
    });

    port.on('close', () => {
      console.log(`[WinKeyer] Closed ${portPath}`);
      const wasConnected = this._connected;
      this._connected = false;
      this._version = 0;
      this._port = null;
      this._busy = false;
      this._xoff = false;
      this._txBuffer = '';
      if (wasConnected) this.emit('disconnected');
    });

    port.open((err) => {
      if (err) {
        console.log(`[WinKeyer] Open failed: ${err.message}`);
        this._port = null;
        this.emit('error', err);
      }
    });
  }

  disconnect() {
    if (!this._port) return;
    this._closing = true;
    this._txBuffer = '';
    try {
      if (this._port.isOpen) {
        // Send Host Close before closing port
        this._port.write(Buffer.from([0x00, ADMIN_CLOSE]));
      }
    } catch {}
    try {
      if (this._port.isOpen) this._port.close();
    } catch {}
    this._port = null;
    this._connected = false;
    this._version = 0;
    this._busy = false;
    this._xoff = false;
  }

  sendText(text) {
    if (!this._connected || !this._port || !this._port.isOpen) return;
    // Clean to CW-safe characters: letters, digits, common punctuation
    const clean = text.toUpperCase().replace(/[^A-Z0-9 /?.=,\-_+<>@[\]]/g, '');
    if (!clean) return;

    if (this._xoff) {
      // Buffer for later — WinKeyer will send XON when ready
      this._txBuffer += clean;
      return;
    }

    this._sendChunk(clean);
  }

  _sendChunk(text) {
    if (!this._port || !this._port.isOpen || !text) return;
    // WinKeyer buffer is ~120 chars. Send in chunks of 50 to stay safe.
    const CHUNK = 50;
    const chunk = text.substring(0, CHUNK);
    const remainder = text.substring(CHUNK);

    this._port.write(Buffer.from(chunk, 'ascii'), (err) => {
      if (err) console.log(`[WinKeyer] Write error: ${err.message}`);
    });

    if (remainder) {
      this._txBuffer = remainder + this._txBuffer;
    }
  }

  cancelText() {
    this._txBuffer = '';
    if (!this._port || !this._port.isOpen) return;
    this._port.write(Buffer.from([CMD_CLEAR]));
    this._xoff = false;
    console.log('[WinKeyer] Buffer cleared');
  }

  setSpeed(wpm) {
    wpm = Math.max(5, Math.min(99, Math.round(wpm)));
    this._wpm = wpm;
    if (!this._port || !this._port.isOpen) return;
    this._port.write(Buffer.from([CMD_SPEED, wpm]));
  }

  setWeight(weight) {
    weight = Math.max(10, Math.min(90, Math.round(weight)));
    if (!this._port || !this._port.isOpen) return;
    this._port.write(Buffer.from([CMD_WEIGHT, weight]));
  }

  setPttLeadIn(ms) {
    const units = Math.max(0, Math.min(25, Math.round(ms / 10)));
    if (!this._port || !this._port.isOpen) return;
    this._port.write(Buffer.from([CMD_PTT_LEADIN, units]));
  }

  setPttTail(ms) {
    const units = Math.max(0, Math.min(25, Math.round(ms / 10)));
    if (!this._port || !this._port.isOpen) return;
    this._port.write(Buffer.from([CMD_PTT_TAIL, units]));
  }

  // --- Internal ---

  _onData(buf) {
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];

      // Before host mode is open, first byte back is the version
      if (!this._connected) {
        if (b > 0 && b < 40) {
          // Valid version byte (WK1=10, WK2=20-23, WK3=30-33)
          this._version = b;
          this._connected = true;
          console.log(`[WinKeyer] Host mode open, version ${b}`);
          this.emit('connected', { version: b });
          continue;
        }
        // Ignore anything else before connected
        continue;
      }

      // Status byte: 0xC0-0xFF (bit 7 and bit 6 set)
      if ((b & 0xC0) === 0xC0) {
        this._handleStatus(b);
        continue;
      }

      // Echo byte: printable ASCII (0x20-0x7F)
      if (b >= 0x20 && b <= 0x7F) {
        this.emit('echo', { char: String.fromCharCode(b) });
        continue;
      }

      // Speed pot byte: returned from speed pot read (0x80-0xBF range)
      if ((b & 0xC0) === 0x80) {
        const potSpeed = b & 0x3F;
        if (potSpeed >= 5) {
          this._wpm = potSpeed;
          this.emit('speed', { wpm: potSpeed });
        }
        continue;
      }
    }
  }

  _handleStatus(b) {
    const wasBusy = this._busy;
    const breakin = !!(b & 0x01);
    const busy = !!(b & 0x04);
    const xoff = !!(b & 0x20);

    this._busy = busy;

    // XOFF/XON flow control
    if (xoff && !this._xoff) {
      this._xoff = true;
    } else if (!xoff && this._xoff) {
      this._xoff = false;
      // XON received — flush pending buffer
      if (this._txBuffer) {
        const pending = this._txBuffer;
        this._txBuffer = '';
        this._sendChunk(pending);
      }
    }

    // Busy transitions
    if (busy && !wasBusy) {
      this.emit('busy');
    } else if (!busy && wasBusy) {
      this.emit('idle');
      // Also try to flush buffer when idle
      if (this._txBuffer && !this._xoff) {
        const pending = this._txBuffer;
        this._txBuffer = '';
        this._sendChunk(pending);
      }
    }

    // Paddle breakin
    if (breakin) {
      this.emit('breakin');
    }

    this.emit('status', { busy, breakin, xoff });
  }
}

module.exports = { WinKeyer };
