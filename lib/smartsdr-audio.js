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

// VITA-49 TX constants — DAX TX (client → radio) packet building. Verified
// against AetherSDR src/core/AudioEngine.cpp:4112-4168 (the float32 stereo
// route, which is what FlexLib's own non-radio-route DAX TX uses):
//
//   Word 0:   type=1 (IFDataWithStream), C=1, T=0, TSI=3 (Other),
//             TSF=1 (SampleCount), 4-bit packet count, 16-bit size in words
//             → first byte = 0x18, lower bits = TSI/TSF/count/size
//   Word 1:   stream ID (from `stream create type=dax_tx` reply)
//   Word 2:   OUI = 0x001C2D (FlexRadio)
//   Word 3:   ICC (0x534C) << 16 | PCC (0x03E3 = DAX TX float32 stereo)
//   Words 4-6: timestamps — advertised but written as zero (FlexLib behavior)
//   Words 7+:  payload — float32 BE, L/R stereo interleaved, 24 kHz
//
// Outgoing datagrams go to <radio_ip>:4991, paced at 128 stereo frames per
// packet × 5.333 ms/packet = real-time 24 kHz delivery. POTACAT's FT8 engine
// produces 12 kHz mono samples; we 2x-upsample (zero-order hold is fine —
// the Flex's transmit DSP filters above the slice's audio passband anyway)
// and duplicate L→R for stereo. K3SBP 2026-05-15.
const FLEX_OUI         = 0x001C2D;
const FLEX_ICC         = 0x534C;
const TX_RADIO_UDP_PORT = 4991;
const TX_FRAMES_PER_PACKET = 128;  // stereo frames per VITA packet
const TX_SAMPLE_RATE   = 24000;    // dax_tx wire rate
const TX_PACKET_INTERVAL_MS = (TX_FRAMES_PER_PACKET / TX_SAMPLE_RATE) * 1000; // 5.333 ms
const TX_SLOT_AUDIO_START_MS = 500; // WSJT-X FT8 convention — audio starts 500 ms into the slot

// Ongoing-stall detection. dax_rx delivers 128-sample frames every
// ~5 ms, so a multi-second gap is unambiguously a stalled stream. The
// Flex mutes slice RX during TX (so frames legitimately stop then) and
// the stream is known to sometimes not resume on the TX→RX edge without
// a re-subscribe — the liveness check surfaces that to main.js.
const STALL_THRESHOLD_MS = 4000; // no frame this long → consider stalled
const STALL_CHECK_MS     = 1000; // liveness poll interval
const STALL_REEMIT_MS    = 5000; // re-emit 'stall' this often while stalled

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
    // Ongoing-stall state. The one-shot _watchdog above only catches
    // "subscribed but no audio ever arrived" — it's cleared the moment
    // the first frame lands and never re-armed. _livenessTimer is the
    // continuous check that catches a stream stopping mid-session.
    this._lastFrameMs = 0;
    this._livenessTimer = null;
    this._stallActive = false;
    this._lastStallEmitMs = 0;
    // TX state — DAX TX VITA-49 (FT8/digital audio direct to the radio,
    // bypassing the Windows DAX TX device and the DAX program entirely).
    this._host = null;            // radio IP — needed for UDP send target
    this._txStreamId = null;      // 0x... from `stream create type=dax_tx` reply
    this._txCreateSeq = null;     // seq# of the create cmd, captured in _handleLine
    this._txCreatePromise = null; // resolver chain for awaiting subscribe
    this._txPacketCount = 0;      // 4-bit rolling counter in word-0
    this._txTimer = null;         // pacing timer for in-flight TX
    this._txInFlight = null;      // { buf, pos, frames, host, onDone, startMs }
    this._streamAccum = null;     // Float32 accumulator for pushTxAudioChunk
    this._streamLen = 0;
  }

  start(host, daxChannel = 1, guiClientId = null) {
    this.stop();
    this._host = host;
    this._daxChannel = daxChannel;
    this._guiClientId = guiClientId;
    this._frameSeen = false;
    this._gaveUp = false;
    this._lastFrameMs = 0;
    this._stallActive = false;
    this._lastStallEmitMs = 0;
    this._txStreamId = null;
    this._txCreateSeq = null;
    this._txCreatePromise = null;
    this._txPacketCount = 0;
    this._streamAccum = null;
    this._streamLen = 0;

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

    // 5. Create the DAX TX stream. Reply gives the stream_id we put in
    //    word-1 of every outgoing VITA-49 audio packet. No `dax_channel=`
    //    argument here — the slice→DAX-channel binding is set in SmartSDR
    //    independently via `slice set N dax=M`. K3SBP 2026-05-15.
    this._txCreateSeq = send('stream create type=dax_tx');
    if (this._txCreateSeq != null) this._cmdSeqs.add(this._txCreateSeq);
  }

  stop() {
    this._gaveUp = true;
    // Abort any in-flight TX cycle so the paced send loop doesn't keep
    // ticking after the socket is gone.
    if (this._txTimer) { clearTimeout(this._txTimer); this._txTimer = null; }
    if (this._txInFlight) {
      try { this._txInFlight.reject(new Error('stopped')); } catch {}
      this._txInFlight = null;
    }
    if (this._txCreatePromise) {
      try { this._txCreatePromise.reject(new Error('stopped')); } catch {}
      this._txCreatePromise = null;
    }
    this._txStreamId = null;
    this._txCreateSeq = null;
    if (this._watchdog) {
      clearTimeout(this._watchdog);
      this._watchdog = null;
    }
    if (this._livenessTimer) {
      clearInterval(this._livenessTimer);
      this._livenessTimer = null;
    }
    this._stallActive = false;
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

      // Per Known-API-Responses.md: SL_INFO=0x10000000, SL_WARNING=
      // 0x31000000, SL_ERROR_BASE=0x50000000, SL_FATAL=0xF3000000.
      // The TCPIP-client docs explicitly say the 0x1xxxxxxx bucket
      // ("unknown client program" etc.) is informational, not a real
      // rejection. Only fallback on actual errors/fatals.
      const isError = status >= 0x50000000;
      if (isError) {
        if (!this._frameSeen) {
          this._fallback(`cmd rejected 0x${status.toString(16)}`);
        }
        return;
      }
      // status===0 OR informational/warning → continue. The stream-id
      // capture below still runs on success, and informational replies
      // for client program / bind / udpport are passed through silently.

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

      // DAX TX subscribe reply — same `0x<hex>|...` shape as dax_rx. We
      // don't fall back on failure here (TX is optional; RX is required),
      // we just log and leave _txStreamId null so sendTxAudio will refuse.
      if (this._txCreateSeq != null && seq === this._txCreateSeq) {
        this._txCreateSeq = null;
        const fields = rest.split('|');
        const idHex = fields[0] || '';
        if (/^[0-9a-fA-F]+$/.test(idHex)) {
          this._txStreamId = parseInt(idHex, 16);
          // Track for cleanup so stop() issues `stream remove` on both
          // dax_rx and dax_tx. (RX filtering on _streamIds is unaffected
          // — we never receive UDP packets bearing the dax_tx id.)
          this._streamIds.add(this._txStreamId);
          this.emit('log', `DAX TX stream id 0x${this._txStreamId.toString(16)} captured`);
        } else {
          this.emit('log', `dax_tx subscribe ack didn't carry hex stream_id — got "${idHex}". Direct TX disabled this session; will fall back to Windows DAX TX route.`);
        }
        if (this._txCreatePromise) {
          const p = this._txCreatePromise; this._txCreatePromise = null;
          p.resolve(this._txStreamId);
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
    // DAX RX audio is float32 BIG-endian (network byte order), L/R
    // interleaved at 24 kHz. Per flexlib-go's daxclient + readme:
    // vita/vitahandler.go ParseFData early-returns the payload UNCHANGED
    // for SL_VITA_IF_NARROW_CLASS, and the readme tells consumers to
    // pipe the raw bytes through `ffmpeg -f f32be -ar 24000 -ac 2`.
    // f32be = float32 big-endian. (The getFloat32fromLE helper in
    // vitahandler.go is only used for IQ data, not DAX RX audio.)
    const floatBytes = payload.length - (payload.length % 8);
    const stereoSamples = floatBytes / 8;
    const pcm = new Float32Array(stereoSamples);
    for (let i = 0; i < stereoSamples; i++) {
      pcm[i] = payload.readFloatBE(i * 8); // L channel only
    }

    // Stall tracking — record the frame time, and if we were flagged
    // stalled, announce recovery so main.js can stop worrying.
    const wasStalled = this._stallActive;
    this._lastFrameMs = Date.now();
    if (wasStalled) {
      this._stallActive = false;
      this.emit('log', 'Audio stream recovered — frames flowing again');
      this.emit('recovered');
    }

    if (!this._frameSeen) {
      this._frameSeen = true;
      if (this._watchdog) {
        clearTimeout(this._watchdog);
        this._watchdog = null;
      }
      this.emit('log', `First audio frame: ${payload.length} bytes → ${stereoSamples} mono samples (PCM f32 BE, 24 kHz)`);
      // Hand off from the one-shot subscribe watchdog to the continuous
      // liveness check now that audio is actually flowing.
      this._startLivenessCheck();
    }
    // DIAGNOSTIC (K3SBP SSTV-decode 2026-05-28): measure the TRUE incoming
    // sample rate by counting mono samples over wall-clock. The code
    // assumes 24 kHz, but the 8000-series may stream dax_rx at 48 kHz — in
    // which case the 2x upsample downstream halves every pitch and the
    // SSTV bandpass [1100,2400] rejects the (now sub-1kHz) leader/sync.
    // Remove once confirmed.
    if (this._rateDiagStart === undefined) { this._rateDiagStart = Date.now(); this._rateDiagSamples = 0; }
    this._rateDiagSamples += stereoSamples;
    const elapsed = Date.now() - this._rateDiagStart;
    if (elapsed >= 5000) {
      const measuredHz = Math.round(this._rateDiagSamples / (elapsed / 1000));
      this.emit('log', `[rate-diag] measured incoming dax_rx rate = ${measuredHz} Hz (assumed 24000) over ${this._rateDiagSamples} samples / ${elapsed}ms`);
      this._rateDiagStart = Date.now();
      this._rateDiagSamples = 0;
    }
    this.emit('audio-frame', { pcm, sampleRate: 24000 });
  }

  // Continuous stall detector. Fires 'stall' when no frame has arrived
  // for STALL_THRESHOLD_MS. Re-emits every STALL_REEMIT_MS while still
  // stalled so a stall that began during TX (RX legitimately muted)
  // still surfaces to main.js once TX ends — main.js gates the response
  // on rig TX state, so a stall *during* TX is a no-op there.
  _startLivenessCheck() {
    if (this._livenessTimer) clearInterval(this._livenessTimer);
    this._livenessTimer = setInterval(() => {
      if (this._gaveUp || !this._connected) return;
      const silentMs = Date.now() - this._lastFrameMs;
      if (silentMs < STALL_THRESHOLD_MS) return; // healthy
      const now = Date.now();
      if (!this._stallActive || now - this._lastStallEmitMs >= STALL_REEMIT_MS) {
        if (!this._stallActive) {
          this.emit('log', `Audio stream stalled — no frames for ${(silentMs / 1000).toFixed(1)}s`);
        }
        this._stallActive = true;
        this._lastStallEmitMs = now;
        this.emit('stall', { silentMs });
      }
    }, STALL_CHECK_MS);
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

  // ---- DAX TX (client → radio audio over VITA-49 / UDP) -------------------

  /** Whether the dax_tx stream is ready (subscribe ACK received). */
  get txReady() { return !!this._txStreamId; }

  /** Whether the TCP control channel to the radio is up. */
  get connected() { return this._connected; }

  /**
   * Push a mono 12 kHz Float32 audio buffer (the FT8 engine's native rate)
   * as VITA-49 dax_tx packets to the radio. Internally 2x-upsamples to
   * 24 kHz, duplicates L→R for stereo, prepends WSJT-X-style leading
   * silence so the FT8 envelope starts at slot+500 ms, and paces packet
   * delivery to real time so the radio's input buffer doesn't underrun
   * or overflow.
   *
   * @param {Float32Array} samples       — mono 12 kHz audio
   * @param {number}       offsetMs      — ms into the slot when we fire
   * @returns {Promise<void>} — resolves after the last packet is sent
   *                            (i.e. once the rig has the full envelope)
   */
  sendTxAudio(samples, offsetMs = 0) {
    return new Promise((resolve, reject) => {
      if (!this._connected || !this._sock) {
        return reject(new Error('SmartSDR audio not connected'));
      }
      if (!this._udpSock) {
        return reject(new Error('UDP socket not open'));
      }
      if (!this._txStreamId) {
        return reject(new Error('dax_tx stream not subscribed (subscribe ack never arrived)'));
      }
      if (!this._host) {
        return reject(new Error('radio host not known'));
      }
      if (this._txInFlight) {
        // Caller's job to wait — guard against re-entry mid-cycle.
        return reject(new Error('TX already in flight'));
      }
      if (!(samples instanceof Float32Array) || samples.length === 0) {
        return reject(new Error('samples must be a non-empty Float32Array'));
      }

      // 2x linear-interpolation upsample 12 kHz mono → 24 kHz stereo.
      // FT8 tones are 200–3000 Hz, well below 12 kHz Nyquist; either
      // linear interp or sample-hold would work, but linear costs one
      // multiply per pair so we just do it.
      const monoIn = samples;
      const inLen = monoIn.length;
      const upsampledLen = inLen * 2;             // mono samples at 24 kHz
      const leadSamples = Math.max(0, Math.round((TX_SLOT_AUDIO_START_MS - offsetMs) / 1000 * TX_SAMPLE_RATE));
      const totalMonoSamples = leadSamples + upsampledLen;
      const stereoFlat = new Float32Array(totalMonoSamples * 2); // L0 R0 L1 R1 ...
      // Leading silence already zero from Float32Array init.
      for (let i = 0; i < inLen; i++) {
        const s0 = monoIn[i];
        const s1 = (i + 1 < inLen) ? monoIn[i + 1] : s0;
        const mid = (s0 + s1) * 0.5;
        const base = (leadSamples + i * 2) * 2; // 2 channels per output sample
        stereoFlat[base    ] = s0;   // L
        stereoFlat[base + 1] = s0;   // R
        stereoFlat[base + 2] = mid;  // L (interp)
        stereoFlat[base + 3] = mid;  // R (interp)
      }

      const totalFrames = totalMonoSamples;        // L/R pairs
      const totalPackets = Math.ceil(totalFrames / TX_FRAMES_PER_PACKET);
      this.emit('log', `DAX TX start: ${inLen} samples @12k → ${totalFrames} frames @24k stereo, ${totalPackets} VITA pkts (lead ${leadSamples} samples / ${(leadSamples / TX_SAMPLE_RATE * 1000).toFixed(0)} ms)`);

      this._txInFlight = {
        stereoFlat,           // packed L R L R ... float32
        totalFrames,
        framePos: 0,          // next L/R frame index to send
        packetsSent: 0,
        totalPackets,
        startMs: Date.now(),
        resolve,
        reject,
      };
      this._txPacketCount = 0; // reset 4-bit rolling counter for this cycle
      // Kick off the paced send loop. _pumpTxPackets schedules itself.
      this._pumpTxPackets();
    });
  }

  /**
   * Stream a continuous live audio source (typically the iOS phone mic over
   * WebRTC) as VITA-49 dax_tx packets to the radio. Unlike sendTxAudio (one-
   * shot buffered FT8), this accumulates incoming chunks and emits packets
   * as they fill — no leading silence, no internal pacing (the upstream
   * source already runs at real time). Each accepted chunk is mono Float32
   * at 24 kHz; the renderer downsamples WebRTC audio (48 kHz default) using
   * an AudioContext-resampled MediaStreamSource before forwarding here.
   *
   * @param {Float32Array} mono24k — chunk of mono 24 kHz samples
   */
  pushTxAudioChunk(mono24k) {
    if (!this._connected || !this._udpSock || !this._txStreamId || !this._host) return;
    if (!(mono24k instanceof Float32Array) || mono24k.length === 0) return;
    if (!this._streamAccum) {
      this._streamAccum = new Float32Array(TX_FRAMES_PER_PACKET * 4); // grow-on-demand buffer
      this._streamLen = 0;
    }
    // Append chunk to accumulator, growing if needed.
    const need = this._streamLen + mono24k.length;
    if (need > this._streamAccum.length) {
      let cap = this._streamAccum.length;
      while (cap < need) cap *= 2;
      const grown = new Float32Array(cap);
      grown.set(this._streamAccum.subarray(0, this._streamLen));
      this._streamAccum = grown;
    }
    this._streamAccum.set(mono24k, this._streamLen);
    this._streamLen += mono24k.length;

    // Drain in 128-frame VITA packets. Each VITA packet carries 128 stereo
    // frames = 256 floats; we duplicate mono L→R as we copy out.
    while (this._streamLen >= TX_FRAMES_PER_PACKET) {
      const stereo = new Float32Array(TX_FRAMES_PER_PACKET * 2);
      for (let i = 0; i < TX_FRAMES_PER_PACKET; i++) {
        const s = this._streamAccum[i];
        stereo[i * 2    ] = s; // L
        stereo[i * 2 + 1] = s; // R
      }
      const pkt = this._buildVita49TxPacket(stereo, 0, TX_FRAMES_PER_PACKET);
      this._udpSock.send(pkt, TX_RADIO_UDP_PORT, this._host, (err) => {
        if (err) this.emit('log', `DAX TX stream UDP error: ${err.message}`);
      });
      // Shift accumulator left by one packet's worth.
      this._streamAccum.copyWithin(0, TX_FRAMES_PER_PACKET, this._streamLen);
      this._streamLen -= TX_FRAMES_PER_PACKET;
    }
  }

  /** Abort an in-flight TX (e.g. JTCAT engine cancelled the cycle). */
  cancelTx() {
    if (this._txTimer) { clearTimeout(this._txTimer); this._txTimer = null; }
    if (this._txInFlight) {
      const q = this._txInFlight;
      this._txInFlight = null;
      this.emit('log', `DAX TX cancelled at packet ${q.packetsSent}/${q.totalPackets}`);
      try { q.reject(new Error('TX cancelled')); } catch {}
    }
  }

  _pumpTxPackets() {
    const q = this._txInFlight;
    if (!q || !this._connected || !this._udpSock) {
      if (q) { this._txInFlight = null; try { q.reject(new Error('disconnected mid-TX')); } catch {} }
      return;
    }

    // Send up to N packets per tick — sending one at a time at 5.33 ms is
    // below Node's typical setTimeout floor (4 ms but jittery), so we
    // batch and self-correct against wall clock. 8 packets per ~42 ms
    // tick gives smooth pacing without straining the timer.
    const BATCH = 8;
    for (let n = 0; n < BATCH && q.framePos < q.totalFrames; n++) {
      const framesThisPkt = Math.min(TX_FRAMES_PER_PACKET, q.totalFrames - q.framePos);
      // L/R interleaved float32 BE payload — slice the chunk and write
      // big-endian floats one at a time. Each frame = 2 samples = 8 bytes.
      const pkt = this._buildVita49TxPacket(q.stereoFlat, q.framePos * 2, framesThisPkt);
      this._udpSock.send(pkt, TX_RADIO_UDP_PORT, this._host, (err) => {
        // Fire-and-forget; UDP errors are logged but not fatal — losing
        // one packet of FT8 is recoverable, losing the cycle isn't.
        if (err) this.emit('log', `DAX TX UDP send error: ${err.message}`);
      });
      q.framePos += framesThisPkt;
      q.packetsSent++;
    }

    if (q.framePos >= q.totalFrames) {
      // All packets queued. Resolve immediately — the radio has the data
      // even though it'll continue playing it for ~13 s. Caller (main.js)
      // will fire ft8Engine.txComplete() which clears the engine's safety
      // timer; PTT release happens via the engine's own tx-end event.
      const elapsed = Date.now() - q.startMs;
      this.emit('log', `DAX TX queued ${q.packetsSent} pkts in ${elapsed} ms (paced for real-time playback)`);
      const resolve = q.resolve;
      this._txInFlight = null;
      this._txTimer = null;
      try { resolve(); } catch {}
      return;
    }

    // Self-correcting pace: aim for "packets_sent × 5.333 ms" since start.
    // If we're behind schedule (Node lagged), the next batch fires
    // immediately; if ahead, we sleep the difference.
    const targetElapsedMs = q.packetsSent * TX_PACKET_INTERVAL_MS;
    const actualElapsedMs = Date.now() - q.startMs;
    const sleepMs = Math.max(0, targetElapsedMs - actualElapsedMs);
    this._txTimer = setTimeout(() => this._pumpTxPackets(), sleepMs);
  }

  _buildVita49TxPacket(stereoFlat, sampleOffset, numFrames) {
    const payloadBytes = numFrames * 2 * 4; // stereo × float32
    const packetBytes  = 28 + payloadBytes;
    const buf = Buffer.alloc(packetBytes);

    // Word 0: header. Byte breakdown:
    //   bits 31-28 = type 1 (IFDataWithStream)         → 0x1 << 28
    //   bit  27    = C   (class present)               → 1 << 27
    //   bit  26    = T   (no trailer)                  → 0
    //   bits 25-24 = reserved                          → 0
    //   bits 23-22 = TSI (3 = Other)                   → 0x3 << 22
    //   bits 21-20 = TSF (1 = SampleCount)             → 0x1 << 20
    //   bits 19-16 = 4-bit packet count (rolls 0..F)
    //   bits 15-0  = packet size in 32-bit words
    let hdr = 0;
    hdr |= (0x1 << 28);
    hdr |= (1   << 27);
    hdr |= (0x3 << 22);
    hdr |= (0x1 << 20);
    hdr |= ((this._txPacketCount & 0xF) << 16);
    hdr |= ((packetBytes / 4) & 0xFFFF);
    // JS bitwise ops are signed-32; force unsigned write.
    buf.writeUInt32BE(hdr >>> 0, 0);

    buf.writeUInt32BE(this._txStreamId >>> 0,                       4);
    buf.writeUInt32BE(FLEX_OUI >>> 0,                                8);
    buf.writeUInt32BE(((FLEX_ICC << 16) | SL_VITA_IF_NARROW_CLASS) >>> 0, 12);
    // Words 4-6 (offsets 16,20,24) — timestamps. Advertised as Other/
    // SampleCount but written as zero, matching FlexLib/AetherSDR.
    // Buffer.alloc already zero-fills, so nothing to do here.

    // Payload — interleaved L/R Float32 BE.
    let off = 28;
    const end = sampleOffset + numFrames * 2;
    for (let i = sampleOffset; i < end; i++) {
      buf.writeFloatBE(stereoFlat[i], off);
      off += 4;
    }

    this._txPacketCount = (this._txPacketCount + 1) & 0xF;
    return buf;
  }
}

module.exports = { SmartSdrAudio };
