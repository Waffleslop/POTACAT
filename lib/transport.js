// Shared transport classes for TCP and serial connections.
// Extracted from cat.js — used by CatClient, RigctldClient, CivClient.

const net = require('net');
const { EventEmitter } = require('events');
const { SerialPort } = require('serialport');

// ---------------------------------------------------------------------------
// TcpTransport — wraps net.Socket with auto-reconnect
// Emits: 'data' (chunk), 'connect', 'close', 'error'
// ---------------------------------------------------------------------------

class TcpTransport extends EventEmitter {
  constructor() {
    super();
    this._sock = null;
    this._connected = false;
    this._reconnectTimer = null;
    this._target = null; // { host, port }
  }

  get connected() { return this._connected; }

  /**
   * Open a TCP connection.
   * @param {{ host?: string, port: number }} opts
   */
  connect({ host = '127.0.0.1', port }) {
    this.disconnect();
    this._target = { host, port };

    const sock = new net.Socket();
    this._sock = sock;

    sock.on('data', (chunk) => {
      // Guard against events on a stale socket after disconnect
      if (this._sock !== sock) return;
      this.emit('data', chunk);
    });

    sock.on('connect', () => {
      if (this._sock !== sock) return;
      sock.setNoDelay(true);         // disable Nagle — must be set after connect on Windows
      sock.setKeepAlive(true, 10000); // detect dead connections within ~10s
      this._connected = true;
      this.emit('connect');
    });

    sock.on('error', (err) => {
      // Emit for callers that want it; close handler does the real cleanup
      if (this._sock !== sock) return;
      this.emit('error', err);
    });

    sock.on('close', () => {
      if (this._sock !== sock) return;
      this._connected = false;
      this.emit('close');
      this._scheduleReconnect();
    });

    sock.connect(port, host);
  }

  /**
   * Gracefully close the connection and stop auto-reconnect.
   */
  disconnect() {
    this._target = null; // clear target first to prevent auto-reconnect from close event
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._sock) {
      this._sock.end();
      const old = this._sock;
      setTimeout(() => { try { old.destroy(); } catch { /* ignore */ } }, 500);
      this._sock = null;
    }
    this._connected = false;
  }

  /**
   * Write data to the socket.
   * @param {string|Buffer} data
   * @returns {boolean} false if buffered by the kernel (backpressure)
   */
  write(data) {
    if (!this._connected || !this._sock) return false;
    return this._sock.write(data);
  }

  /** @private */
  _scheduleReconnect() {
    if (this._reconnectTimer || !this._target) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._target) this.connect(this._target);
    }, 2000);
  }
}

// ---------------------------------------------------------------------------
// SerialTransport — wraps SerialPort with auto-reconnect
// Emits: 'data' (chunk), 'connect', 'close', 'error'
// ---------------------------------------------------------------------------

class SerialTransport extends EventEmitter {
  constructor() {
    super();
    this._port = null;
    this._connected = false;
    this._reconnectTimer = null;
    this._target = null; // { path, baudRate, dtrOff, connectDelay }
    this._lastPinState = null; // { dtr, rts } — preserved across reconnects for CW keying
  }

  get connected() { return this._connected; }

  /** True when the underlying serial port is physically open. */
  get isOpen() { return !!(this._port && this._port.isOpen); }

  /**
   * Open a serial connection.
   * @param {{ path: string, baudRate?: number, dtrOff?: boolean, connectDelay?: number }} opts
   *   - dtrOff: force DTR/RTS low after open (prevents TX on radios that key PTT via DTR)
   *   - connectDelay: ms to wait after port.open before emitting 'connect' (some radios
   *     need time after USB enumeration before accepting commands)
   */
  connect({ path, baudRate, dtrOff, connectDelay }) {
    this.disconnect();
    this._target = { path, baudRate, dtrOff, connectDelay };

    const port = new SerialPort({
      path,
      baudRate: baudRate || 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      autoOpen: false,
      rtscts: false,
      hupcl: false, // don't toggle DTR on close
    });
    this._port = port;

    port.on('data', (chunk) => {
      // Guard against events on a stale port after disconnect
      if (this._port !== port) return;
      this.emit('data', chunk);
    });

    port.on('open', () => {
      // Guard: if disconnect() was called while the port was opening, bail out
      if (this._port !== port) {
        try { port.close(); } catch { /* ignore */ }
        return;
      }

      // Force DTR/RTS low if requested (prevents TX on radios that use DTR
      // as a CW key / PTT source). Emit logs so it's visible in the CAT log
      // panel whether the pin set actually succeeded — on some Linux
      // cdc-acm kernel driver + firmware combinations the call silently
      // no-ops, which is crucial diagnostic context for "my radio keys on
      // CW mode switch" bug reports.
      if (dtrOff) {
        this.emit('log', `DTR/RTS low requested on ${path} — sending SetControlLineState`);
        port.set({ dtr: false, rts: false }, (err) => {
          if (err) this.emit('log', `DTR/RTS low failed: ${err.message} (your cdc-acm driver may not honor TIOCMSET — set USB Keying (CW) = OFF on the radio as a workaround)`);
          else this.emit('log', `DTR/RTS low acknowledged by driver`);
        });
      }

      // Restore last pin state from a previous connection (preserves CW key state
      // across serial port drops, e.g. Digirig losing USB momentarily during TX)
      if (this._lastPinState) {
        try { port.set(this._lastPinState); } catch { /* ignore */ }
      }

      const delay = connectDelay || 0;
      if (delay > 0) {
        // Delay before emitting 'connect' — some radios (e.g. Yaesu FT-710) need
        // time after port open before they're ready to accept commands
        setTimeout(() => {
          if (this._port === port) {
            this._connected = true;
            this.emit('connect');
          }
        }, delay);
      } else {
        this._connected = true;
        this.emit('connect');
      }
    });

    port.on('error', (err) => {
      if (this._port !== port) return;
      this.emit('error', err);
    });

    port.on('close', () => {
      if (this._port !== port) return;
      this._connected = false;
      this.emit('close');
      this._scheduleReconnect();
    });

    port.open((err) => {
      if (err) {
        this._connected = false;
        this.emit('error', err);
        this._scheduleReconnect();
      }
    });
  }

  /**
   * Gracefully close the port and stop auto-reconnect.
   */
  disconnect() {
    this._target = null; // clear target first to prevent auto-reconnect from close event
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._port) {
      if (this._port.isOpen) {
        // Safety: force DTR/RTS low before closing (CW key up)
        try { this._port.set({ dtr: false, rts: false }); } catch { /* ignore */ }
        this._port.close();
      }
      this._port = null;
    }
    this._connected = false;
  }

  /**
   * Write data to the serial port.
   * @param {string|Buffer} data
   * @returns {boolean} false if buffered (backpressure)
   */
  write(data) {
    if (!this._connected || !this._port) return false;
    return this._port.write(data);
  }

  /**
   * Set DTR/RTS pin state on the serial port.
   * Pin state is remembered and re-applied on reconnect (important for CW keying).
   * @param {{ dtr?: boolean, rts?: boolean }} pins
   * @param {function} [callback] — called with (err) after pin state is applied
   */
  setPin(pins, callback) {
    // Remember pin state for reconnect
    this._lastPinState = Object.assign({}, this._lastPinState, pins);
    if (!this._connected || !this._port) {
      if (callback) callback(new Error('not connected'));
      return;
    }
    this._port.set(pins, (err) => {
      if (err && !this._setPinLoggedError) {
        this._setPinLoggedError = true;
        this.emit('error', new Error(
          `DTR/RTS pin control failed: ${err.message}. ` +
          (process.platform === 'linux'
            ? 'Linux CDC-ACM (QMX/QDX) does not support TIOCMSET. Use an external USB-UART adapter (FTDI/CH340) for CW keying.'
            : 'Pin control not supported on this port.')
        ));
      }
      if (callback) callback(err);
    });
  }

  /** @private */
  _scheduleReconnect() {
    if (this._reconnectTimer || !this._target) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._target) this.connect(this._target);
    }, 2000);
  }
}

module.exports = { TcpTransport, SerialTransport };
