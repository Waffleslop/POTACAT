// Dedicated SmartSDR audio subscriber — separate TCP connection.
//
// History (don't repeat the dead ends):
//
//   Attempt 1 (`audio client 0 slice 0 1` on the GUI-bound primary):
//     rejected 0x500000aa. Wrong command shape; that form needs a
//     client UUID, not literal "0".
//
//   Attempt 2 (legacy `audio stream 0 dax=0` on same primary):
//     same rejection. Stayed in the wrong rabbit hole.
//
//   Attempt 3 (`stream create type=remote_audio_rx` on a separate
//     UNBOUND TCP): rejected 0x500000aa. `remote_audio_rx` is for
//     SSL/SmartLink only — TCP local clients don't have access to it.
//
//   Attempt 4 (`stream create type=dax_rx dax_channel=1` on the same
//     unbound TCP): subscribe ACCEPTED but no audio packets arrived.
//     The radio accepts the create but doesn't route audio to a
//     client that hasn't `client bind`-ed to a GUI client.
//
//   Attempt 5 (this file, current): full documented flow per
//     flexlib-go/cmd/smartsdr-daxclient/main.go on GitHub:
//
//       client program <name>           — identify ourselves
//       client bind client_id=<gui_id>  — bind to existing GUI client
//       client udpport <port>           — register our UDP port
//       stream create type=dax_rx dax_channel=N
//
//     The `<gui_id>` is the UUID the primary SmartSdrClient already
//     discovered; main.js passes it in. Audio arrives on our UDP port
//     with VITA-49 class 0x03E3 (SL_VITA_IF_NARROW_CLASS / DAX RX),
//     payload = float32 LITTLE-endian L/R interleaved at 24 kHz
//     (Flex 6000) or 48 kHz (Flex 8000).
//
//     The reply to `stream create type=dax_rx` is:
//       R<seq>|0|<stream_id_hex_no_prefix>|...
//     i.e. third pipe-delimited field is the stream id as raw hex.
//
// Failure modes all surface as 'audio-fallback':
//   - TCP connect fails / refused.
//   - cmd-error on any setup command (program/bind/udpport/create).
//   - 5 s pass after subscribe with no audio packets (most often:
//     user doesn't have DAX RX <N> mapped to any slice).
const net = require('net');
const dgram = require('dgram');
const { EventEmitter } = require('events');

const SL_VITA_METER_CLASS     = 0x8002;
const SL_VITA_IF_NARROW_CLASS = 0x03E3; // DAX RX audio (24 kHz mono/stereo)
const SL_VITA_OPUS_CLASS      = 0x8005; // remote_audio_rx compression=opus

class SmartSdrAudio extends EventEmitter {
  constructor() {
    super();
    this._sock = null;
    this._udpSock = null;
    this._buf = '';
    this._seq = 1;
    this._connected = false;
    this._daxChannel = 1;
    this._guiClientId = null;
    this._streamIds = new Set();
    this._cmdSeqs = new Set();
    this._createSeq = null; // seq of the stream-create cmd (the one whose reply carries stream_id)
    this._frameSeen = false;
    this._watchdog = null;
    this._gaveUp = false;
  }

  start(host, daxChannel = 1, guiClientId = null) {
    this.stop();
    this._daxChannel = daxChannel;
    this._guiClientId = guiClientId;
    this._frameSeen = false;
    this._gaveUp = false;

    if (!guiClientId) {
      this.emit('log', 'Cannot start: no GUI client ID provided (primary must be connected first)');
      this._fallback('no gui client id');
      return;
    }

    const sock = new net.Socket();
    sock.setNoDelay(true);
    this._sock = sock;

    sock.on('connect', () => {
      this._connected = true;
      this.emit('log', `Audio TCP connected to ${host}:4992`);
      // Sequence the documented setup commands. Each line is fired
      // in order with no waiting for ACK — the Flex queues them and
      // processes in order. Logging the verbatim TX so the trace is
      // readable end-to-end.
      this._setupUdp((udpPort) => {
        this._fireSetupSequence(udpPort);
      });

      this._armWatchdog();
    });

    sock.on('data', (chunk) => {
      this._buf += chunk.toString();
      let nl;
      while ((nl = this._buf.indexOf('\n')) !== -1) {
        const line = this._buf.slice(0, nl).replace(/\r$/, '');
        this._buf = this._buf.slice(nl + 1);
        this._handleLine(line);
      }
    });

    sock.on('error', (err) => {
      this.emit('log', `Audio TCP error: ${err.message}`);
      this._fallback(`tcp error: ${err.message}`);
    });

    sock.on('close', () => {
      const wasConnected = this._connected;
      this._connected = false;
      this._sock = null;
      if (wasConnected && !this._gaveUp) {
        this.emit('log', 'Audio TCP closed unexpectedly');
        this._fallback('tcp closed');
      }
    });

    sock.connect(4992, host);
  }

  _fireSetupSequence(udpPort) {
    const send = (cmd) => {
      const seq = this._send(cmd);
      this.emit('log', `Audio TX: C${seq}|${cmd}`);
      return seq;
    };

    // 1. Identify the client. Per flexlib-go reference, this is sent
    //    before bind. Failure here is non-fatal but worth logging.
    const seqProgram = send('client program POTACAT');
    if (seqProgram != null) this._cmdSeqs.add(seqProgram);

    // 2. Bind to the existing GUI client. This is the step that was
    //    missing from runs #3 and #4 — without it the radio accepts
    //    `stream create dax_rx` but never routes audio to us.
    const seqBind = send(`client bind client_id=${this._guiClientId}`);
    if (seqBind != null) this._cmdSeqs.add(seqBind);

    // 3. Tell the radio which UDP port we're listening on.
    const seqUdp = send(`client udpport ${udpPort}`);
    if (seqUdp != null) this._cmdSeqs.add(seqUdp);

    // 4. Create the DAX RX stream. The reply carries the stream_id
    //    we'll use to filter incoming UDP packets.
    this._createSeq = send(`stream create type=dax_rx dax_channel=${this._daxChannel}`);
    if (this._createSeq != null) this._cmdSeqs.add(this._createSeq);
  }

  stop() {
    this._gaveUp = true;
    if (this._watchdog) {
      clearTimeout(this._watchdog);
      this._watchdog = null;
    }
    if (this._streamIds.size && this._connected) {
      for (const id of this._streamIds) {
        try { this._send(`stream remove 0x${id.toString(16)}`); } catch {}
      }
    }
    this._streamIds.clear();
    this._cmdSeqs.clear();
    this._createSeq = null;
    if (this._udpSock) {
      try { this._udpSock.close(); } catch {}
      this._udpSock = null;
    }
    if (this._sock) {
      try { this._sock.destroy(); } catch {}
      this._sock = null;
    }
    this._connected = false;
    this._buf = '';
  }

  _send(cmd) {
    if (!this._sock || !this._connected) return null;
    const seq = this._seq++;
    this._sock.write(`C${seq}|${cmd}\n`);
    return seq;
  }

  _setupUdp(after) {
    const sock = dgram.createSocket('udp4');
    this._udpSock = sock;
    sock.on('message', (buf) => this._parseUdpPacket(buf));
    sock.on('error', (err) => this.emit('log', `Audio UDP error: ${err.message}`));
    sock.bind(0, () => {
      const port = sock.address().port;
      this.emit('log', `Audio UDP listening on port ${port}`);
      after(port);
    });
  }

  _armWatchdog() {
    if (this._watchdog) clearTimeout(this._watchdog);
    this._watchdog = setTimeout(() => {
      if (!this._frameSeen) {
        this.emit('log', 'No audio frames in 5s after subscribe — falling back');
        this._fallback('no frames in 5s');
      }
    }, 5000);
  }

  _handleLine(line) {
    // Command responses: R<seq>|<status hex>|<message>[|<debug>]
    const rMatch = line.match(/^R(\d+)\|([0-9A-Fa-f]+)\|?(.*)$/);
    if (!rMatch) return;
    const seq = parseInt(rMatch[1]);
    const status = parseInt(rMatch[2], 16);
    const rest = rMatch[3] || '';

    if (this._cmdSeqs.has(seq)) {
      this.emit('log', `Audio RX: R${seq}|${rMatch[2]}|${rest}`);
      this._cmdSeqs.delete(seq);

      if (status !== 0) {
        // Any of program/bind/udpport/create rejection → fallback.
        // Bind rejection is the most likely failure path on a fresh
        // setup if the GUI client UUID is wrong or has churned.
        if (!this._frameSeen) {
          this._fallback(`cmd rejected 0x${status.toString(16)}`);
        }
        return;
      }

      // Only the stream-create reply carries the stream id — third
      // pipe field as raw hex (no `0x`, no `stream_id=` label). Per
      // flexlib-go's parser:
      //   strings.Split(response, "|")[2]
      //   parseUint(streamHexString, 16, 64)
      if (this._createSeq != null && seq === this._createSeq) {
        this._createSeq = null;
        const fields = rest.split('|');
        const idHex = fields[0] || '';
        if (/^[0-9a-fA-F]+$/.test(idHex)) {
          const id = parseInt(idHex, 16);
          this._streamIds.add(id);
          this.emit('log', `Audio stream id 0x${id.toString(16)} captured`);
        } else {
          this.emit('log', `Subscribe ack didn't carry hex stream_id — got "${idHex}". Falling back.`);
          this._fallback('no stream_id in subscribe ack');
        }
      }
    }
  }

  _parseUdpPacket(buf) {
    if (buf.length < 28) return;
    if ((buf[0] & 0xF8) !== 0x38) return;
    const streamId = buf.readUInt32BE(4);
    const packetClass = buf.readUInt16BE(14);

    // Meter packets shouldn't land here (separate UDP socket), but
    // filter defensively.
    if (packetClass === SL_VITA_METER_CLASS) return;

    // Strict stream_id filter — only accept the stream we created.
    if (!this._streamIds.has(streamId)) return;

    const payload = buf.slice(28);
    if (payload.length === 0) return;

    if (packetClass === SL_VITA_IF_NARROW_CLASS) {
      this._handleNarrowPcm(payload);
    } else if (packetClass === SL_VITA_OPUS_CLASS) {
      // Not used today — we don't subscribe to remote_audio_rx — but
      // if we ever flip to that path, this is where it lands.
      this.emit('log', `Got Opus class packet (${payload.length} bytes) — Opus path not implemented yet`);
    } else {
      this.emit('log', `Unknown audio class 0x${packetClass.toString(16)} (${payload.length} bytes) — ignoring`);
    }
  }

  _handleNarrowPcm(payload) {
    // DAX RX audio is float32 LITTLE-endian, L/R interleaved at
    // 24 kHz. flexlib-go reference: vita/vitahandler.go
    // getFloat32fromLE = math.Float32frombits(binary.LittleEndian.Uint32(bytes))
    const floatBytes = payload.length - (payload.length % 8);
    const stereoSamples = floatBytes / 8;
    const pcm = new Float32Array(stereoSamples);
    for (let i = 0; i < stereoSamples; i++) {
      pcm[i] = payload.readFloatLE(i * 8);
    }

    if (!this._frameSeen) {
      this._frameSeen = true;
      if (this._watchdog) {
        clearTimeout(this._watchdog);
        this._watchdog = null;
      }
      this.emit('log', `First audio frame: ${payload.length} bytes → ${stereoSamples} mono samples (PCM f32 LE, 24 kHz)`);
    }
    this.emit('audio-frame', { pcm, sampleRate: 24000 });
  }

  _fallback(reason) {
    if (this._gaveUp) return;
    this._gaveUp = true;
    if (this._watchdog) {
      clearTimeout(this._watchdog);
      this._watchdog = null;
    }
    this.emit('audio-fallback', { reason });
  }
}

module.exports = { SmartSdrAudio };
