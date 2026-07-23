// SmartSDR CAT client — supports both TCP and COM (serial) connections
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { SerialPort } = require('serialport');

// Elecraft K4 network protocol framing — verified against QK4 (the open-source
// reference client) at https://github.com/mikeg-dal/QK4 src/network/protocol.cpp
//
// Wire format for every packet, both directions, after the SHA-384(password)
// hex-string auth blob is sent on socket open:
//
//   START_MARKER (4 bytes) : FE FD FC FB
//   LENGTH       (4 bytes) : big-endian uint32, length of PAYLOAD
//   PAYLOAD      (N bytes) : [type:1] [00 00] [ASCII...]
//                             type 0x00 = CAT (Kenwood-style with trailing ';')
//                             type 0x01 = Opus audio (ignored for now)
//                             type 0x02 = full pan spectrum (ignored)
//                             type 0x03 = mini pan spectrum (ignored)
//   END_MARKER   (4 bytes) : FB FC FD FE
//
// Session handshake after auth: RDY; → K41; (required for extended replies)
// → ER1; (verbose error responses). Then PING; every 1000 ms to keep alive.
// K3SBP 2026-05-15: built for K4D-over-the-internet support.
const K4_FRAME_START = Buffer.from([0xFE, 0xFD, 0xFC, 0xFB]);
const K4_FRAME_END   = Buffer.from([0xFB, 0xFC, 0xFD, 0xFE]);
const K4_TYPE_CAT    = 0x00;
const K4_TYPE_AUDIO  = 0x01;
const K4_MAX_PAYLOAD = 1024 * 1024; // 1 MB — anything larger is desync
// Type-0x01 (audio) payload layout — 7-byte header then Opus/PCM data:
//   [0] = type 0x01
//   [1] = version (0x01)
//   [2] = u8 sequence (wraps)
//   [3] = encode mode (0=RAW32, 1=RAW16, 2=Opus int, 3=Opus float — we use 3)
//   [4-5] = uint16 LE frame samples (240/480/720/1440 — set by SL tier)
//   [6] = sample-rate code (always 0x00 = 12 kHz on real K4 firmware)
//   [7..] = Opus or raw PCM payload
// Verified against QK4 src/network/protocol.h:62-71 + protocol.cpp:181-209.
const K4_AUDIO_HEADER_BYTES = 7;
const K4_AUDIO_VERSION      = 0x01;
const K4_EM_OPUS_FLOAT      = 0x03;
const K4_SR_CODE_12K        = 0x00;
const K4_AUDIO_RATE_HZ      = 12000;
const {
  MD_TO_MODE, CIV_MODE_TO_NAME, YAESU_SSB_BW, YAESU_CW_BW,
  ssbSideband, yaesuBwToIndex, mapMode, mapModeRigctld, mapModeCiv,
} = require('./rig-utils');

// Tune-confirmation tunables (see CatClient._tuneConfirm).
const TUNE_CONFIRM_TOL_HZ = 100;   // polled freq within this of commanded = confirmed
const TUNE_CONFIRM_WINDOW_MS = 4500; // poll is 1s; 4 cycles is comfortable margin
const TUNE_CONFIRM_FAIL_LIMIT = 3; // consecutive unconfirmed tunes before we warn

// Pure: did the radio's reported frequency land near what we commanded?
// XIT is applied to the VFO upstream (the commanded value already includes any
// shift), so an exact-ish match is expected; the tolerance only absorbs rounding.
function tuneFreqConfirmed(reportedHz, targetHz, tolHz = TUNE_CONFIRM_TOL_HZ) {
  if (!Number.isFinite(reportedHz) || !Number.isFinite(targetHz)) return false;
  return Math.abs(reportedHz - targetHz) <= tolHz;
}

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
    this._k4Sock = null;  // raw socket for K4 TX-audio writes (TLS or net)
    this._k4TxSeq = 0;    // u8 wrapping sequence counter for type-0x01 frames
    this._pendingTuneTimers = []; // setTimeout IDs for mode/split/filter after tune
    this._faDigits = 11; // FA frequency digit count (auto-detected from radio response; 11=Kenwood/Flex, 9=Yaesu)
    this._faDigitsDetected = false; // true once we've received at least one FA response from the radio
    this._digiMd = null; // rig-model override for digital mode MD code (e.g. 6 for QMX)
    this._dataCmd = 'DA'; // DATA mode command prefix (DA for Kenwood, DT for Elecraft)
    this._requestedMd = null; // last mode sent during tune (for post-reconnect enforcement)
    this._requestedDa = null; // last DA value sent during tune
    // Tune-confirmation tracker (serial only). A serial CAT port that opens but
    // can't write — classically a Yaesu FTDX1200/3000/5000 with menu "CAT RTS"
    // enabled while we de-assert RTS, or a DTR/RTS-blocked interface — accepts
    // the connection (so QRZ/logging look fine) but silently ignores FA tune
    // commands. We arm a short confirm window on each serial tune; if the polled
    // frequency never lands near the commanded one across several tunes, we emit
    // 'tune-unconfirmed' so the UI can point the user at the RTS/DTR settings.
    this._tuneConfirm = null;   // { targetHz, timer } awaiting a matching FA readback
    this._tuneFailCount = 0;    // consecutive tunes that timed out unconfirmed
    this._tuneWarned = false;   // latched once warned, so we don't nag every tune
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
    } else if (target.type === 'k4-network') {
      this._connectK4Network(target);
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
      // Remember the port's USB identity (VID/PID/serial). If Windows later
      // re-enumerates the adapter under a NEW COM number (classic after an
      // RF-induced USB reset — K6RBJ's IC-7100), the open-failure path below
      // can recognize the same device on its new port and say so, instead of
      // silently retrying a name that no longer exists.
      SerialPort.list().then((ports) => {
        const me = ports.find((p) => p.path === path);
        if (me && (me.vendorId || me.serialNumber)) {
          this._usbIdentity = { vendorId: me.vendorId, productId: me.productId, serialNumber: me.serialNumber };
          this._log(`serial ${path} USB identity: ${me.vendorId || '?'}:${me.productId || '?'}${me.serialNumber ? ' sn=' + me.serialNumber : ''}${me.manufacturer ? ' (' + me.manufacturer + ')' : ''}`);
        }
      }).catch(() => { /* enumeration is best-effort */ });
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
                  if (this.connected) this._write(`${this._dataCmd}${this._requestedDa};`);
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
        // Say WHY (this error used to be swallowed — K6RBJ retried a vanished
        // COM port for weeks with no trace). Throttled: the 2s reconnect loop
        // would otherwise log this thirty times a minute.
        const now = Date.now();
        if (now - (this._lastOpenFailLog || 0) > 15000) {
          this._lastOpenFailLog = now;
          this._log(`serial open FAILED: ${err.message}`);
          SerialPort.list().then((ports) => {
            const names = ports.map((p) => p.path + (p.manufacturer ? ' (' + p.manufacturer + ')' : '')).join(', ');
            this._log(`serial ports present: ${names || 'none'}`);
            // Same USB device on a different COM number? (Windows renumbers
            // ports when an adapter re-enumerates after an RF/power reset.)
            const id = this._usbIdentity;
            if (id && (id.vendorId || id.serialNumber)) {
              const moved = ports.find((p) => p.path !== path &&
                p.vendorId === id.vendorId && p.productId === id.productId &&
                (!id.serialNumber || p.serialNumber === id.serialNumber));
              if (moved) {
                this._log(`radio's USB adapter appears to have MOVED to ${moved.path} — update the port in Settings > My Rigs`);
                this.emit('port-moved', { from: path, to: moved.path });
              }
            }
          }).catch(() => { /* enumeration is best-effort */ });
        }
        this.emit('status', { connected: false, target: this._target });
        this._scheduleReconnect();
      }
    });
  }

  // Elecraft K4 / K4D over the network. Sends SHA-384(password) hex auth
  // blob on socket open, then wraps every CAT command in the K4 framed
  // envelope. The radio's CAT responses arrive in the same envelope; we
  // strip the envelope and hand the inner ASCII to the existing _onData
  // path so the rest of CatClient (line splitter, FA/MD/PC/NB parsers,
  // tune logic, post-reconnect mode enforcement, etc.) keeps working
  // unchanged. K3SBP 2026-05-15.
  _connectK4Network({ host = '127.0.0.1', port = 9205, password = '' }) {
    // K4 offers two transports for the same framed protocol:
    //   port 9205 — plain TCP, client sends SHA-384(password) hex as the
    //               first 96 bytes; auth-blob is unframed; CAT frames
    //               follow immediately after the radio accepts the blob.
    //   port 9204 — TLS 1.2+ with PSK ciphers; password IS the pre-shared
    //               key (no SHA-384 hash). TLS handshake itself proves both
    //               sides know the secret; QK4 sends NO additional SHA-384
    //               blob after the handshake — framed CAT begins right away.
    // We branch only on the socket factory; everything after the socket is
    // "writable" (handshake done + auth blob sent if applicable) is the
    // same framed flow. K3SBP 2026-05-16.
    const useTls = (port === 9204);
    let sock;
    if (useTls) {
      sock = tls.connect({
        host,
        port,
        // K4 uses ad-hoc PSK ciphers — no cert chain to validate.
        rejectUnauthorized: false,
        // Negotiate PSK with the password directly. Identity string is
        // arbitrary on the K4 (QK4 uses an empty/unset identity); send
        // the client program name so the radio log identifies us.
        pskCallback: () => ({
          psk: Buffer.from(password || '', 'utf8'),
          identity: 'POTACAT',
        }),
        // PSK cipher suites — TLS 1.2's PSK family. Modern OpenSSL has
        // these disabled by default; enable explicitly.
        ciphers: 'PSK',
        minVersion: 'TLSv1.2',
      });
    } else {
      sock = new net.Socket();
    }
    this._k4Sock = sock;
    this._k4TxSeq = 0;
    let rxBuf = Buffer.alloc(0);
    let authSent = false;
    let pingTimer = null;
    let sessionReady = false;

    // Custom transport-like wrapper so _write() goes through K4 framing.
    // Mirrors the shape of net.Socket / SerialPort enough for everywhere
    // else in CatClient that calls this.transport.write(...).
    const transport = {
      write: (data) => {
        if (!sock.writable || !authSent) return false;
        const ascii = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'ascii');
        // Payload = [type:1][00][00][ASCII...]
        const payload = Buffer.concat([Buffer.from([K4_TYPE_CAT, 0x00, 0x00]), ascii]);
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(payload.length, 0);
        return sock.write(Buffer.concat([K4_FRAME_START, lenBuf, payload, K4_FRAME_END]));
      },
      destroy: () => {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        try { sock.destroy(); } catch { /* ignore */ }
      },
      close:   () => { try { sock.end(); } catch { /* ignore */ } },
    };
    this.transport = transport;

    sock.on('data', (chunk) => {
      rxBuf = Buffer.concat([rxBuf, chunk]);
      // Frame extractor — keeps a 3-byte tail when no start marker is
      // found so a marker split across reads still syncs on the next chunk.
      while (true) {
        const startIdx = rxBuf.indexOf(K4_FRAME_START);
        if (startIdx < 0) {
          if (rxBuf.length > 3) rxBuf = rxBuf.subarray(rxBuf.length - 3);
          return;
        }
        if (startIdx > 0) rxBuf = rxBuf.subarray(startIdx);
        if (rxBuf.length < 12) return; // need at least header (8) + end marker (4)
        const payloadLen = rxBuf.readUInt32BE(4);
        if (payloadLen > K4_MAX_PAYLOAD) {
          // sanity check — desynced, skip the start marker and re-hunt
          this._log(`K4 frame: oversized payload (${payloadLen}), resyncing`);
          rxBuf = rxBuf.subarray(4);
          continue;
        }
        const totalLen = 8 + payloadLen + 4;
        if (rxBuf.length < totalLen) return; // wait for more bytes
        const payload = rxBuf.subarray(8, 8 + payloadLen);
        const endMarker = rxBuf.subarray(8 + payloadLen, totalLen);
        rxBuf = rxBuf.subarray(totalLen);
        if (!endMarker.equals(K4_FRAME_END)) {
          this._log('K4 frame: bad end marker, resyncing');
          continue;
        }
        if (payload.length < 4) continue;
        const ptype = payload[0];
        if (ptype === K4_TYPE_CAT) {
          // Strip type + 2 nulls; hand the ASCII to the existing line parser
          const ascii = payload.subarray(3).toString('ascii');
          this._onData(ascii);
        } else if (ptype === K4_TYPE_AUDIO) {
          // Surface the payload to main; decoding happens there so the @discordjs/opus
          // native addon is loaded lazily only when audio is actually requested.
          if (payload.length <= K4_AUDIO_HEADER_BYTES) continue;
          const seq        = payload[2];
          const encodeMode = payload[3];
          const frameSize  = payload.readUInt16LE(4);
          const srCode     = payload[6];
          this.emit('k4-audio', {
            seq, encodeMode, frameSize, srCode,
            // Slice rather than copy — main.js processes synchronously and we
            // immediately move on to the next frame, so the underlying Buffer
            // memory isn't held past this tick.
            data: payload.subarray(K4_AUDIO_HEADER_BYTES),
          });
        }
        // Other types (0x02 full pan, 0x03 mini pan) ignored for now.
      }
    });

    // Shared post-connect handler: starts the framed session. For TLS the
    // PSK handshake already authenticated, so we skip the SHA-384 blob.
    // For plain TCP we send the blob first; the K4 will close the socket
    // (we surface that via 'close') if the hash doesn't match.
    const onReady = () => {
      try { sock.setNoDelay(true); } catch { /* tls.connect sets this via socket */ }
      try { sock.setKeepAlive(true, 10000); } catch { /* same */ }
      if (useTls) {
        this._log(`K4 network: TLS-PSK handshake complete to ${host}:${port}`);
        authSent = true; // PSK handshake replaces the unframed auth blob
      } else {
        this._log(`K4 network: TCP connected to ${host}:${port}, sending SHA-384 auth`);
        const authHex = crypto.createHash('sha384').update(password || '').digest('hex');
        sock.write(authHex);
        authSent = true;
      }
      // Brief settle before the framed session-init commands. The radio
      // will drop the socket if auth fails — we'll learn that via 'close'.
      setTimeout(() => {
        if (!sock.writable) return;
        this.connected = true;
        sessionReady = true;
        this.emit('status', { connected: true, target: this._target });
        // Session init — required for the K4 to return extended (K4-mode)
        // CAT responses and verbose errors. Order taken from QK4.
        transport.write('RDY;');
        transport.write('K41;');
        transport.write('ER1;');
        // Audio: EM3 = Opus Float, SL3 = 60 ms latency tier (720 samples
        // per Opus frame at 12 kHz). Neither command is echoed by the K4;
        // we just hope the radio applies them and starts sending type-0x01
        // frames within ~1 s. Audio decoding happens in main.js when frames
        // actually arrive (lazy-loads the @discordjs/opus native addon).
        transport.write('EM3;');
        transport.write('SL3;');
        this._startPolling();
        // Heartbeat — keeps the link alive and lets the radio detect a dead client.
        pingTimer = setInterval(() => {
          if (sock.writable) transport.write('PING;');
        }, 1000);
      }, 200);
    };
    // net.Socket emits 'connect'; tls.connect (TLSSocket) emits 'secureConnect'
    // after the TLS-PSK handshake completes. Use whichever applies.
    sock.on(useTls ? 'secureConnect' : 'connect', onReady);

    sock.on('error', () => { /* surfaced via 'close' */ });

    sock.on('close', () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      const wasConnected = this.connected;
      this.connected = false;
      this._stopPolling();
      this.emit('status', { connected: false, target: this._target });
      if (wasConnected && !sessionReady) {
        // Socket dropped before we ever heard a framed reply — almost certainly
        // bad password (radio rejects silently and closes). Surface a clear hint.
        this._log(`K4 network: socket closed before session established — bad password? (${useTls ? 'TLS-PSK' : 'plain'} on :${port})`);
      }
      this._scheduleReconnect();
    });

    // tls.connect() initiates the TLS handshake itself; plain net.Socket
    // needs an explicit .connect(port, host).
    if (!useTls) sock.connect(port, host);
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
        if (!isNaN(hz)) {
          this.emit('frequency', hz);
          this._confirmTune(hz);
        }
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
        this._log(`rx: ${msg} -> mode=${modeName || '?'}`);
      } else if (msg.startsWith('NB')) {
        // Yaesu: NB0x (x=0 off, x=1 on), Kenwood: NBx
        const nbPayload = msg.slice(2);
        const nbVal = parseInt(nbPayload.slice(-1), 10);
        const nbOn = nbVal === 1;
        this.emit('nb', nbOn);
        this._log(`rx: ${msg} -> nb=${nbOn}`);
      } else if (msg.startsWith('SM')) {
        // S-meter: SM0xxx (Yaesu/Flex) or SMxxx (Kenwood)
        const smDigits = msg.replace(/^SM0?/, '');
        const smVal = parseInt(smDigits, 10) || 0;
        this.emit('smeter', smVal);
      } else if (msg.startsWith('RM')) {
        // Legacy CatClient is Flex TCP CAT emulation (Kenwood TS-2000 profile):
        // RM1=SWR, RM2=COMP, RM3=ALC.
        const rmType = msg.charAt(2);
        const rmVal = parseInt(msg.slice(3), 10) || 0;
        if (rmType === '1') this.emit('swr', rmVal);
        else if (rmType === '3') this.emit('alc', rmVal);
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
        this._write('RM3;');
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

  tune(frequencyHz, mode, { split, filterWidth, xit } = {}) {
    this._log(`tune() called: freq=${frequencyHz} mode=${mode} split=${!!split} filter=${filterWidth || 0}${xit != null ? ' xit=' + xit + 'Hz' : ''} connected=${this.connected}`);
    if (!this.connected) return false;
    // Cancel any pending mode/split/filter commands from a previous rapid tune call
    for (const t of this._pendingTuneTimers) clearTimeout(t);
    this._pendingTuneTimers = [];
    // Pause polling so tune commands aren't interleaved with FA; queries
    this._stopPolling();

    // Use Flex mode codes (MD9=DIGU) only for FlexRadio TCP (ports 5002-5005).
    // All other radios (serial, Icom, K4 via TCP) use Kenwood-style MD+DA commands.
    const isFlexTcp = this._target && this._target.type === 'tcp' &&
      [5002, 5003, 5004, 5005].includes(this._target.port);
    const useKenwoodModes = !isFlexTcp;
    let mapped = mode ? mapMode(mode, frequencyHz, useKenwoodModes) : null;
    // Rig-model override: some radios (QMX, QDX, K4) use a non-standard MD code
    // for digital. Only fire when DATA mode is actually being requested (da > 0).
    // mapMode returns `da: 0` for plain voice modes (SSB/USB/LSB/FM/AM) on the
    // Kenwood serial path; using `!= null` matched those too and turned an SSB
    // spot click into MD6 (DATA-A on the K4) — N7QT 2026-05-16.
    if (mapped && this._digiMd != null && mapped.da > 0) {
      mapped = { md: this._digiMd }; // e.g. MD6 for K4 DIGU / QMX DIGI
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
      // Optimistic update: a future tune() call needs to compare against the
      // mode we just commanded, not the last value polled from the rig. The
      // SSB-over-DATA PTT round-trip pauses polling during TX; without this
      // update, the post-PTT restore-tune sees stale `_lastParsedMode='USB'`
      // (set before PTT-down switched us to DIGU), decides modeChanged=false,
      // and skips the MD2 restore command — radio sticks in DIGU after PTT
      // releases. (K0OTC, Flex via CAT TCP, 2026-04-29.) Subsequent poll
      // responses overwrite this with reality, which is correct.
      this._lastParsedMode = targetModeName;
    }
    // Kenwood DATA mode toggle (DA/DT command) for FT8/FT4/FT2 on serial radios —
    // always send when specified, even if MD didn't change (USB->FT8 is same MD)
    // Elecraft uses DT instead of DA
    if (mapped && mapped.da != null) {
      this._pendingTuneTimers.push(setTimeout(() => {
        if (this.connected) this._write(`${this._dataCmd}${mapped.da};`);
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
      // Re-send DA/DT (data mode toggle) if needed
      if (mapped.da != null) {
        this._pendingTuneTimers.push(setTimeout(() => {
          if (this.connected) this._write(`${this._dataCmd}${mapped.da};`);
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

    // XIT (TX clarifier offset) for CW spot tuning. K3SBP via N7QT report
    // 2026-05-16: user has CW XIT offset set in Settings, but the legacy
    // CatClient tune() used to silently drop the xit option — POTACAT
    // never sent any XIT command, so XIT stayed off on the radio.
    //
    // K4 in K41 mode (and Kenwood TS-2000 emulation on Flex CAT) accept:
    //   RO+nnnn; / RO-nnnn;  — set the shared RIT/XIT offset (Hz, 4-digit, signed)
    //   XT0; / XT1;          — disable / enable XIT
    // We send the offset first, then flip the enable.
    //
    // xit === null|undefined: caller didn't ask — leave the radio's XIT alone.
    // xit === 0:              caller wants XIT explicitly off.
    // xit !== 0:              enable XIT at this Hz offset.
    if (xit != null) {
      this._pendingTuneTimers.push(setTimeout(() => {
        if (!this.connected) return;
        if (!xit) {
          this._write('XT0;');
          return;
        }
        const clamped = Math.max(-9999, Math.min(9999, Math.round(xit)));
        const sign = clamped >= 0 ? '+' : '-';
        const abs = String(Math.abs(clamped)).padStart(4, '0');
        this._write(`RO${sign}${abs};`);
        this._write('XT1;');
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
    this._armTuneConfirm(frequencyHz);
    return true;
  }

  // Arm a window to confirm the radio actually moved to `targetHz`. Serial only —
  // a Flex/K4 TCP CAT session echoes its VFO reliably and isn't subject to the
  // RTS/DTR handshake failure this guards against. If no matching FA readback
  // arrives before the window closes, the tune is counted as unconfirmed.
  _armTuneConfirm(targetHz) {
    if (!this._target || this._target.type !== 'serial') return;
    if (!Number.isFinite(targetHz)) return;
    if (this._tuneConfirm && this._tuneConfirm.timer) clearTimeout(this._tuneConfirm.timer);
    const timer = setTimeout(() => this._onTuneConfirmTimeout(targetHz), TUNE_CONFIRM_WINDOW_MS);
    if (timer.unref) timer.unref();
    this._tuneConfirm = { targetHz, timer };
  }

  // A frequency readback arrived — if it matches the pending tune target, the
  // radio is honoring CAT writes: clear the failure streak (and any prior warning,
  // so a one-off hiccup doesn't latch). Called for every FA response.
  _confirmTune(reportedHz) {
    const pending = this._tuneConfirm;
    if (!pending) return;
    if (!tuneFreqConfirmed(reportedHz, pending.targetHz)) return;
    if (pending.timer) clearTimeout(pending.timer);
    this._tuneConfirm = null;
    if (this._tuneFailCount > 0 || this._tuneWarned) {
      this._log(`tune confirmed (${reportedHz}Hz) — clearing unconfirmed streak`);
    }
    this._tuneFailCount = 0;
    this._tuneWarned = false;
  }

  // The confirm window closed without a matching readback. Count it; once the
  // streak crosses the limit, warn once (latched) so the UI can prompt the user
  // to check the radio's CAT RTS menu and the Disable DTR/RTS option.
  _onTuneConfirmTimeout(targetHz) {
    this._tuneConfirm = null;
    this._tuneFailCount++;
    this._log(`tune unconfirmed: ${targetHz}Hz not echoed within ${TUNE_CONFIRM_WINDOW_MS}ms (streak=${this._tuneFailCount})`);
    if (this._tuneFailCount >= TUNE_CONFIRM_FAIL_LIMIT && !this._tuneWarned) {
      this._tuneWarned = true;
      this.emit('tune-unconfirmed', {
        targetHz,
        attempts: this._tuneFailCount,
        path: (this._target && this._target.path) || '',
        isYaesu: this._isYaesu(),
      });
    }
  }

  // Drop any pending confirm state (called on disconnect / target change).
  _resetTuneConfirm() {
    if (this._tuneConfirm && this._tuneConfirm.timer) clearTimeout(this._tuneConfirm.timer);
    this._tuneConfirm = null;
    this._tuneFailCount = 0;
    this._tuneWarned = false;
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

  // --- Phase-3 expanded modifiers (Yaesu / Kenwood). Commands chosen so a
  // single command works across the modern FT- and TS- lineups (FT-991 /
  // FT-710 / FT-891 / FT-DX10, TS-590S/G/SG, TS-990). Rig-specific quirks
  // (Yaesu PA ladder, Kenwood NR1/NR2 distinction) we treat as either-or
  // until users report otherwise. ---

  setPreamp(on) {
    if (!this.connected) return;
    // PA0=off, PA1=on. Yaesu rigs with multi-stage preamp (FT-DX5000 etc.)
    // also accept PA1; this command picks the first stage; multi-stage
    // selection would need its own UI affordance.
    this._write(`PA${on ? 1 : 0};`);
    this._log(`setPreamp ${on ? 'ON' : 'OFF'}`);
  }

  setAttenuator(on) {
    if (!this.connected) return;
    // RA00=off, RA01=first ATT stage. Like preamp, multi-stage (RA02/RA03
    // on FT-710/991 for 12dB/24dB) selection isn't exposed yet.
    this._write(`RA0${on ? 1 : 0};`);
    this._log(`setAttenuator ${on ? 'ON' : 'OFF'}`);
  }

  setCompressor(on) {
    if (!this.connected) return;
    this._write(`PR${on ? 1 : 0};`);
    this._log(`setCompressor ${on ? 'ON' : 'OFF'}`);
  }

  setNoiseReduction(on) {
    if (!this.connected) return;
    // NR0=off, NR1=on. Kenwood TS-590 supports NR2 (alternate algorithm)
    // — call site can't pick yet; on means NR1.
    this._write(`NR${on ? 1 : 0};`);
    this._log(`setNoiseReduction ${on ? 'ON' : 'OFF'}`);
  }

  setAutoNotch(on) {
    if (!this.connected) return;
    // Yaesu calls auto-notch "BC" (Beat Cancel); Kenwood calls it "NT".
    if (this._isYaesu()) {
      this._write(`BC${on ? 1 : 0};`);
    } else {
      this._write(`NT${on ? 1 : 0};`);
    }
    this._log(`setAutoNotch ${on ? 'ON' : 'OFF'}`);
  }

  setVox(on) {
    if (!this.connected) return;
    this._write(`VX${on ? 1 : 0};`);
    this._log(`setVox ${on ? 'ON' : 'OFF'}`);
  }

  setRit(on) {
    if (!this.connected) return;
    // RT0/RT1 — same command on both Yaesu and modern Kenwood. Doesn't set
    // the offset (which is at the rig's front-panel knob) — just toggles
    // the receiver-side incremental tuning on/off.
    this._write(`RT${on ? 1 : 0};`);
    this._log(`setRit ${on ? 'ON' : 'OFF'}`);
  }

  setAgc(mode) {
    if (!this.connected) return;
    // Yaesu and Kenwood disagree on both the GT param width and the
    // value mapping:
    //   Yaesu  (FT-991/710/891/DX10): GT0<x>;  x = 0:Auto 1:Fast 2:Mid 3:Slow 4:Off
    //   Kenwood (TS-590/990):          GT00<x>; x = 0:Off  1:Slow 2:Mid 3:Fast
    // We don't expose "Auto" yet (no UI option), so 'fast'/'med'/'slow'/'off'
    // are mapped explicitly and the rest are ignored.
    const yaesuMap   = { fast: 1, med: 2, slow: 3, off: 4 };
    const kenwoodMap = { off: 0, slow: 1, med: 2, fast: 3 };
    if (this._isYaesu()) {
      const v = yaesuMap[(mode || '').toLowerCase()];
      if (v == null) return;
      this._write(`GT0${v};`);
      this._log(`setAgc Yaesu GT0${v} (${mode})`);
    } else {
      const v = kenwoodMap[(mode || '').toLowerCase()];
      if (v == null) return;
      this._write(`GT00${v};`);
      this._log(`setAgc Kenwood GT00${v} (${mode})`);
    }
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
    this._log(`setRfGain ${val}% -> RG${clamped}`);
  }

  setSquelch(val) {
    if (!this.connected) return;
    const now = Date.now();
    if (this._lastSqTime && now - this._lastSqTime < 150) return;
    this._lastSqTime = now;
    // SQ is a 0-100 value (not 0-255 like RG). Both Yaesu and Elecraft/Kenwood
    // use the P1=0 (main RX) form: SQ0nnn;
    const v = Math.max(0, Math.min(100, Math.round(Number(val) || 0)));
    this._write(`SQ0${String(v).padStart(3, '0')};`);
    this._log(`setSquelch ${val}% -> SQ0${v}`);
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
    } else if (this._isYaesu() && this._atuCmd === 'ac003') {
      // FT-710: AC003 (Tuner Activate) runs a full tune from off or on —
      // no AC001 first (baumertjohn, issue #55)
      this._write('AC003;');
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
    this._resetTuneConfirm();
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
        // SerialPort or K4 framed-transport wrapper (has .destroy()).
        if (typeof this.transport.destroy === 'function') this.transport.destroy();
        else if (this.transport.isOpen) this.transport.close();
      }
      this.transport = null;
    }
    if (this._k4Sock) {
      try { this._k4Sock.destroy(); } catch { /* ignore */ }
      this._k4Sock = null;
    }
    this.connected = false;
  }

  /**
   * Send one Opus-encoded mic frame as a K4 type-0x01 audio packet over
   * the active K4-network transport. Caller is responsible for matching
   * the SL tier (frameSamples = 720 for SL3, our default). No-ops on any
   * other transport, so safe to call unconditionally from the TX path.
   */
  sendK4Audio(opusBuffer, frameSamples) {
    const sock = this._k4Sock;
    if (!sock || !sock.writable) return false;
    if (!opusBuffer || !opusBuffer.length) return false;
    const payloadLen = K4_AUDIO_HEADER_BYTES + opusBuffer.length;
    const buf = Buffer.alloc(8 + payloadLen + 4);
    // Frame envelope
    K4_FRAME_START.copy(buf, 0);
    buf.writeUInt32BE(payloadLen, 4);
    // Audio header
    buf[8 + 0] = K4_TYPE_AUDIO;
    buf[8 + 1] = K4_AUDIO_VERSION;
    buf[8 + 2] = this._k4TxSeq & 0xFF;
    buf[8 + 3] = K4_EM_OPUS_FLOAT;          // EM3 — matches what we asked for on init
    buf.writeUInt16LE(frameSamples & 0xFFFF, 8 + 4);
    buf[8 + 6] = K4_SR_CODE_12K;
    opusBuffer.copy(buf, 8 + K4_AUDIO_HEADER_BYTES);
    K4_FRAME_END.copy(buf, 8 + payloadLen);
    this._k4TxSeq = (this._k4TxSeq + 1) & 0xFF;
    return sock.write(buf);
  }

  /** Reset the K4 TX-audio sequence counter (QK4 does this on every PTT-down). */
  resetK4TxSeq() { this._k4TxSeq = 0; }
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

  // On Linux, also surface stable /dev/serial/by-id/ symlinks. These carry
  // the vendor / product / serial number in the device name (e.g.
  // usb-Icom_Inc._IC-7300MK2_IC-7300MK2_12003113-if00) and remain valid
  // across reboots / hotplugs, unlike /dev/ttyACM<N> which can renumber.
  // wfview / RS-BA1 / many modern ham apps show these paths; reported
  // missing by KM4CFT 2026-04-23.
  if (process.platform === 'linux') {
    try {
      const fs = require('fs');
      const path = require('path');
      const byIdDir = '/dev/serial/by-id';
      if (fs.existsSync(byIdDir)) {
        const entries = fs.readdirSync(byIdDir);
        for (const name of entries) {
          const link = path.join(byIdDir, name);
          let target;
          try { target = fs.realpathSync(link); } catch { continue; }
          // Only surface the by-id alias if the canonical target is already
          // in the enumeration — keeps orphaned stale symlinks out.
          if (!result.some((p) => p.path === target)) continue;
          result.push({
            path: link,
            manufacturer: 'Stable by-id alias',
            friendlyName: name + ' (' + path.basename(target) + ')',
          });
        }
      }
    } catch { /* ignore — optional enrichment */ }
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
            this._log(`rx: ${hz} -> freq=${(hz / 1000).toFixed(1)}kHz`);
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
        this._log(`rx: ${line} -> mode=${line}`);
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

  /** Pause polling (used by idle-pause timer to let the radio sleep) */
  pausePolling() {
    if (this._pollTimer && !this._pollPaused) {
      this._pollPaused = true;
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /** Resume polling after a pause */
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
    // Sequence: M -> F -> M -> F (the "sandwich" — confirmed working by W3AVP)
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

  // --- Phase-3 expanded modifiers (hamlib / rigctld). All controlled via
  // hamlib's `U <func> <0|1>` (function on/off) and `L <level> <value>`
  // (continuous level) commands. The `_yaesuRaw` fallback wraps the
  // command in a `w <kenwood>;` raw-write — same pattern as setNb above.

  setPreamp(on) {
    if (!this.connected) return;
    const cmd = this._yaesuRaw ? `w PA${on ? 1 : 0};\n` : `U PREAMP ${on ? 1 : 0}\n`;
    this._sendImmediate(cmd);
    this._log(`setPreamp ${on ? 'ON' : 'OFF'}`);
  }

  setAttenuator(on) {
    if (!this.connected) return;
    const cmd = this._yaesuRaw ? `w RA0${on ? 1 : 0};\n` : `U ATT ${on ? 1 : 0}\n`;
    this._sendImmediate(cmd);
    this._log(`setAttenuator ${on ? 'ON' : 'OFF'}`);
  }

  setCompressor(on) {
    if (!this.connected) return;
    const cmd = this._yaesuRaw ? `w PR${on ? 1 : 0};\n` : `U COMP ${on ? 1 : 0}\n`;
    this._sendImmediate(cmd);
    this._log(`setCompressor ${on ? 'ON' : 'OFF'}`);
  }

  setNoiseReduction(on) {
    if (!this.connected) return;
    const cmd = this._yaesuRaw ? `w NR${on ? 1 : 0};\n` : `U NR ${on ? 1 : 0}\n`;
    this._sendImmediate(cmd);
    this._log(`setNoiseReduction ${on ? 'ON' : 'OFF'}`);
  }

  setAutoNotch(on) {
    if (!this.connected) return;
    // Hamlib's auto-notch function flag is ANF. Yaesu-raw passthrough sends
    // BC (Beat Cancel — the Yaesu name); Kenwood would want NT, but since
    // _yaesuRaw implies a Yaesu, that path uses BC.
    const cmd = this._yaesuRaw ? `w BC${on ? 1 : 0};\n` : `U ANF ${on ? 1 : 0}\n`;
    this._sendImmediate(cmd);
    this._log(`setAutoNotch ${on ? 'ON' : 'OFF'}`);
  }

  setVox(on) {
    if (!this.connected) return;
    const cmd = this._yaesuRaw ? `w VX${on ? 1 : 0};\n` : `U VOX ${on ? 1 : 0}\n`;
    this._sendImmediate(cmd);
    this._log(`setVox ${on ? 'ON' : 'OFF'}`);
  }

  setAgc(mode) {
    if (!this.connected) return;
    // Hamlib AGC level values: 0=off, 1=super-fast, 2=fast, 3=fast-slow,
    // 4=slow, 5=auto. We map our 3-position UI ('fast'/'med'/'slow') plus
    // 'off' onto the closest hamlib values.
    const map = { off: 0, fast: 2, med: 3, slow: 4 };
    const v = map[(mode || '').toLowerCase()];
    if (v == null) return;
    if (this._yaesuRaw) {
      // Yaesu raw passthrough — fall back to GT0<x>; with Yaesu encoding.
      const yaesuMap = { fast: 1, med: 2, slow: 3, off: 4 };
      const yv = yaesuMap[mode.toLowerCase()];
      if (yv == null) return;
      this._sendImmediate(`w GT0${yv};\n`);
    } else {
      this._sendImmediate(`L AGC ${v}\n`);
    }
    this._log(`setAgc ${mode}`);
  }

  setNrLevel(pct) {
    if (!this.connected) return;
    if (this._yaesuRaw) return; // no portable raw Yaesu command
    const v = Math.max(0, Math.min(1, pct / 100)).toFixed(2);
    this._sendImmediate(`L NR ${v}\n`);
    this._log(`setNrLevel ${pct}% (${v})`);
  }

  setNbLevel(pct) {
    if (!this.connected) return;
    if (this._yaesuRaw) return;
    const v = Math.max(0, Math.min(1, pct / 100)).toFixed(2);
    this._sendImmediate(`L NB ${v}\n`);
    this._log(`setNbLevel ${pct}% (${v})`);
  }

  setVoxLevel(pct) {
    if (!this.connected) return;
    if (this._yaesuRaw) return;
    const v = Math.max(0, Math.min(1, pct / 100)).toFixed(2);
    this._sendImmediate(`L VOX_GAIN ${v}\n`);
    this._log(`setVoxLevel ${pct}% (${v})`);
  }

  setMonitor(on) {
    if (!this.connected) return;
    if (this._yaesuRaw) {
      // Yaesu MON command is rig-specific (ML0; / MR0; on some, ML000; on
      // others). Don't issue a raw command we can't be sure about.
      return;
    }
    this._sendImmediate(`U MN ${on ? 1 : 0}\n`);
    this._log(`setMonitor ${on ? 'ON' : 'OFF'}`);
  }

  setMonLevel(pct) {
    if (!this.connected) return;
    if (this._yaesuRaw) return;
    const v = Math.max(0, Math.min(1, pct / 100)).toFixed(2);
    this._sendImmediate(`L MONITOR_GAIN ${v}\n`);
    this._log(`setMonLevel ${pct}% (${v})`);
  }

  setRit(on) {
    if (!this.connected) return;
    const cmd = this._yaesuRaw ? `w RT${on ? 1 : 0};\n` : `U RIT ${on ? 1 : 0}\n`;
    this._sendImmediate(cmd);
    this._log(`setRit ${on ? 'ON' : 'OFF'}`);
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
      this._log(`setRfGain ${(val * 100).toFixed(0)}% -> w RG0${String(clamped).padStart(3, '0')}`);
    } else {
      this._sendImmediate(`L RFGAIN ${val.toFixed(3)}\n`);
      this._log(`setRfGain ${(val * 100).toFixed(0)}% -> L RFGAIN ${val.toFixed(3)}`);
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
    let written;
    if (this._yaesuRaw && this._atuCmd === 'ft891') {
      // FT-891/FTDX10: AC P1=0 P2=0 P3=0/1/2 -> AC001; (ON) then AC002; (TUNE)
      // Must send ON first — AC002 fails if tuner isn't already enabled
      this._sendImmediate('w AC001;\n');
      setTimeout(() => {
        if (this.connected) this._sendImmediate('w AC002;\n');
      }, 300);
      written = 'w AC001; then w AC002;';
    } else if (this._yaesuRaw && this._atuCmd === 'ac002') {
      // FTdx3000/FTdx1200: AC002 alone enables tuner AND starts tune cycle
      this._sendImmediate('w AC002;\n');
      written = 'w AC002;';
    } else if (this._yaesuRaw && this._atuCmd === 'ac003') {
      // FT-710: AC003 (Tuner Activate) runs a full tune from off or on —
      // no AC001 first (baumertjohn, issue #55)
      this._sendImmediate('w AC003;\n');
      written = 'w AC003;';
    } else if (this._yaesuRaw && this._atuCmd === 'ac103') {
      // FTX-1 Optima — P1=1, P3=3 (W9JL confirmed 2026-04-19)
      this._sendImmediate('w AC103;\n');
      written = 'w AC103;';
    } else if (this._yaesuRaw) {
      // FT-991A/FTDX101D/standard: AC P1=0 P2=0/1 P3=0/1 -> AC011; (ON+TUNE)
      this._sendImmediate('w AC011;\n');
      written = 'w AC011;';
    } else {
      // Use standard rigctld TUNER function — don't send raw Kenwood AC011
      // passthrough, which causes errors on non-Kenwood radios (e.g. Icom via FLRig)
      this._sendImmediate('U TUNER 1\n');
      written = 'U TUNER 1';
    }
    this._log(`ATU tune started (variant=${this._atuCmd || 'default'}, sent: ${written})`);
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
      this._log(`setTxPower ${(val * 100).toFixed(0)}% -> w PC${String(watts).padStart(3, '0')} (${watts}W)`);
    } else {
      this._sendImmediate(`L RFPOWER ${val.toFixed(3)}\n`);
      this._log(`setTxPower ${(val * 100).toFixed(0)}% -> L RFPOWER ${val.toFixed(3)}`);
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
          this._log(`mode: 0x${modeByte.toString(16).padStart(2, '0')} -> ${modeName || '?'}`);
        }
        break;

      // Level data (response to cmd 0x14 + sub-command)
      case 0x14:
        if (payload.length >= 3) {
          const sub = payload[0];
          const value = this._bcdLevelToInt(payload.slice(1, 3));
          if (sub === 0x0A) {
            // RF power level: 0-255 -> approximate watts (radio-dependent)
            this.emit('power', Math.round(value * 100 / 255));
          }
        }
        break;

      // Meter data (response to cmd 0x15 + sub-command)
      case 0x15:
        if (payload.length >= 3) {
          const sub = payload[0];
          const value = this._bcdLevelToInt(payload.slice(1, 3));
          if (sub === 0x02) {
            // S-meter: 0-255 -> S0-S9+60dB
            this.emit('smeter', value);
          } else if (sub === 0x12) {
            // SWR meter: 0-255
            this.emit('swr', value);
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

  /** Decode CI-V BCD frequency bytes (5 bytes, LSB first) -> Hz */
  _bcdToHz(bytes) {
    let hz = 0, mult = 1;
    for (let i = 0; i < bytes.length; i++) {
      hz += ((bytes[i] >> 4) * 10 + (bytes[i] & 0x0F)) * mult;
      mult *= 100;
    }
    return hz;
  }

  /** Encode Hz -> 5-byte BCD (LSB first) for CI-V frequency commands */
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

  /** Decode 2-byte BCD level (0x00 0x00 = 0, 0x02 0x55 = 255) -> int */
  _bcdLevelToInt(bytes) {
    const hi = (bytes[0] >> 4) * 10 + (bytes[0] & 0x0F);
    const lo = (bytes[1] >> 4) * 10 + (bytes[1] & 0x0F);
    return hi * 100 + lo;
  }

  /** Encode int 0-255 -> 2-byte BCD level */
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
      // Read power level + S-meter every 5th cycle
      if (this._pollCount++ % 5 === 0) {
        this._writeFrame(0x14, 0x0A, null); // TX power
        this._writeFrame(0x15, 0x02, null); // S-meter
        this._writeFrame(0x15, 0x12, null); // SWR meter
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
    // Cancel ALL pending tune commands (prevents rapid-fire collisions on CI-V serial)
    if (this._pendingTuneTimer) { clearTimeout(this._pendingTuneTimer); this._pendingTuneTimer = null; }
    if (this._civTuneTimers) {
      for (const t of this._civTuneTimers) clearTimeout(t);
    }
    this._civTuneTimers = [];

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
    this._civTuneTimers.push(setTimeout(() => {
      if (this.connected) this._writeFrame(0x05, null, this._hzToBcd(frequencyHz));
    }, delay));

    // Re-send mode AFTER frequency — band stacking registers may recall a
    // different mode when the frequency crosses a band boundary.
    if (civMode != null && civMode !== this._lastModeByte) {
      this._civTuneTimers.push(setTimeout(() => {
        if (this.connected) this._writeFrame(0x06, null, [civMode, 0x01]);
      }, delay + 100));
    }

    // Query frequency shortly after to confirm (drives click-to-tune feedback)
    this._civTuneTimers.push(setTimeout(() => {
      if (this.connected) this._writeFrame(0x03, null, null);
    }, delay + 200));

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
   * Range: 6-48 WPM -> level 0-255 (linear approximation).
   */
  setCwSpeed(wpm) {
    if (!this.connected) return;
    const clamped = Math.max(6, Math.min(48, wpm || 20));
    const level = Math.round((clamped - 6) * (255 / 42));
    this._writeFrame(0x14, 0x0C, this._intToBcdLevel(level));
    this._log(`setCwSpeed: ${clamped} WPM (level=${level})`);
  }

  /**
   * Key CW via a modem-control line on the serial port.
   * Radio menu must be set: USB Keying (CW) = DTR or RTS (match `pins`).
   * Only works on radios that key CW off their USB serial DTR/RTS line.
   *
   * NOTE (legacy): this CivClient is no longer instantiated — the live Icom path
   * is RigController + CivCodec (see main.js connectCat 'icom' branch). Kept for
   * reference/compat; the fixes here mirror RigController.setCwKeyDtr.
   *
   * @param {boolean} down
   * @param {{dtr?:boolean, rts?:boolean}} [pins] - which line(s) follow the key
   */
  setCwKeyDtr(down, pins) {
    if (this._dtrFailed) return; // control-line keying already known-bad this session
    if (!this.connected || !this.transport) return;
    if (!(this.transport instanceof SerialPort)) return;
    const p = pins || { dtr: true, rts: false };
    // Drive BOTH lines explicitly — the keyed line follows `down`, the other is
    // forced low. node-serialport resets any omitted line to its default (TRUE),
    // which would latch it high (node-serialport #2636).
    const state = { dtr: p.dtr ? !!down : false, rts: p.rts ? !!down : false };
    this.transport.set(state, (err) => {
      if (err) {
        // Do NOT fall back to setCwKeyTxRx here: on Icom there is no per-element
        // CW key command — CI-V 0x1C 0x01 is the ANTENNA TUNER (00=off/01=on/
        // 02=tune), so the old fallback flapped the ATU per dit/dah. Just latch
        // and stop; CW *text* (CI-V 0x17, sendCwText) still works.
        this._log(`setCwKeyDtr error: ${err.message} — control-line CW keying unavailable on this port. Use CW text (CI-V 0x17) or a dedicated CW Key Port.`);
        this._dtrFailed = true;
      }
    });
  }

  /**
   * PTT-based "keying" fallback (CI-V 0x1C sub 0x00 = TX on/off). This is NOT a
   * real CW key — it dead-keys the transmitter with no CW element modulation.
   * Icom has no per-element CW key command over CI-V; the correct way to send CW
   * without a control line is CI-V 0x17 (sendCwText). Retained only so callers
   * that expect this method don't throw.
   */
  setCwKeyTxRx(down) {
    if (!this.connected) return;
    this._writeFrame(0x1C, 0x00, [down ? 0x01 : 0x00]); // 0x1C 00 = PTT (TX on/off), NOT the tuner
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

module.exports = { CatClient, RigctldClient, CivClient, listSerialPorts, tuneFreqConfirmed };
