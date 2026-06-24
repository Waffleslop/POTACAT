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
const CMD_SET_MODE = 0x0E;    // [0x0E, mode_byte] — WinKeyer mode register
// Mode register byte. Bit 6 = Paddle Echo (echo paddle-decoded characters
// back to the host). All other bits 0 = host-mode defaults: paddle watchdog
// enabled, no paddle swap, no autospace, Iambic-B keyer. POTACAT needs the
// echo on so it can relay paddle CW to a network radio.
const MODE_PADDLE_ECHO = 0x40;
// Bit 3 = Paddle Swap (1 = swap dit/dah paddles). For left-handed ops (who
// still want DITs on the thumb) or a miswired keying cable. 0x0E rewrites the
// WHOLE mode register, so swap must be OR'd into the same byte as echo — you
// can't set it in isolation without clobbering echo/keyer-mode/autospace.
// (KI0ER 2026-06-18: WinKeyer enable was writing echo-only, wiping the op's
// standalone swap so a left-handed op got R sent as K.)
const MODE_PADDLE_SWAP = 0x08;

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
    this._paddleSwap = false; // mode register bit 3 — swap dit/dah (left-handed)
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
      // Errors arriving DURING a clean disconnect (typically the
      // ADMIN_CLOSE write's WriteFileEx racing the port.close()) are
      // expected; logging them as "[WinKeyer] Error: ..." and
      // re-emitting bubbles up to the top-level uncaughtException
      // swallower and produces two confusing lines on every quit.
      // Silently drop when we're tearing down.
      if (this._closing) return;
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
    const port = this._port;
    // Clear refs synchronously so subsequent sendText / setSpeed /
    // etc. don't try to use the half-closed port.
    this._port = null;
    this._connected = false;
    this._version = 0;
    this._busy = false;
    this._xoff = false;
    if (!port.isOpen) return;

    // Send ADMIN_CLOSE then close AFTER the write drains. The
    // previous version queued the write without a callback and
    // called close() on the next line — on Windows the close wins
    // the race and the in-flight WriteFileEx hits an invalid handle,
    // surfacing as "[WinKeyer] Error: Writing to COM port
    // (WriteFileEx): Invalid handle" on every quit. The write
    // callback also swallows its own errors so they don't bubble
    // through 'error' (already gated by _closing above, but defense
    // in depth doesn't hurt).
    const closeAfterDrain = () => {
      try { if (port.isOpen) port.close(() => {}); } catch {}
    };
    try {
      port.write(Buffer.from([0x00, ADMIN_CLOSE]), () => closeAfterDrain());
    } catch {
      closeAfterDrain();
    }
  }

  sendText(text) {
    if (!this._connected || !this._port || !this._port.isOpen) return;
    // Clean to CW-safe characters: letters, digits, common punctuation
    const clean = text.toUpperCase().replace(/[^A-Z0-9 /?.=,\-_+<>@[\]]/g, '');
    if (!clean) return;

    // Diagnostic so the user can confirm WinKeyer actually received the
    // characters — without this the only log line is "[CW] Text: <x>" up
    // in sendCwTextToRadio and a silently-eaten send (WinKeyer connected
    // but not wired to the rig's KEY jack) looks identical to a working
    // send. K3SBP 2026-05-13 hit this with WinKeyer on COM24 and a Flex
    // 6500 where the keyer wasn't physically connected to the radio.
    console.log(`[WinKeyer] sendText(${JSON.stringify(clean)}) @ ${this._wpm} WPM`);

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

  /** Enable Paddle Echo (mode register bit 6) so the WinKeyer echoes
   *  paddle-decoded characters to the host. Without this, paddle keying is
   *  invisible to POTACAT and can't be relayed to a network radio. */
  enablePaddleEcho() {
    if (!this._port || !this._port.isOpen) return;
    // 0x0E rewrites the entire mode register, so bake in every bit we want in
    // one byte: paddle echo (always — so POTACAT sees paddle CW) + paddle swap
    // when the op enabled it. Other bits stay 0 (host-mode defaults).
    const mode = MODE_PADDLE_ECHO | (this._paddleSwap ? MODE_PADDLE_SWAP : 0);
    this._port.write(Buffer.from([CMD_SET_MODE, mode]));
  }

  /** Set paddle swap (mode register bit 3) for left-handed ops / miswired
   *  cables. Stored on the instance and folded into the mode byte; re-applies
   *  immediately if host mode is already open. */
  setPaddleSwap(on) {
    this._paddleSwap = !!on;
    if (this._connected) this.enablePaddleEcho();
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
