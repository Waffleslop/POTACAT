'use strict';
// KiwiSDR WebSocket client — connects to a public KiwiSDR receiver,
// tunes to a frequency/mode, and streams decoded PCM audio.

const { EventEmitter } = require('events');
const WebSocket = require('ws');

// IMA ADPCM step table and index adjustment
const STEP = [7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
const IDX_ADJ = [-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8];

class KiwiSdrClient extends EventEmitter {
  constructor() {
    super();
    this._ws = null;
    this._keepalive = null;
    this._connected = false;
    this._host = '';
    this._port = 8073;
    this._adpcmState = { predictor: 0, stepIndex: 0 };
    // Dedup: three callers in main.js (tuneRadio, the tune IPC handler, and
    // the CAT polling wrapper) all fire kiwiClient.tune() for the same QSY,
    // and the polling wrapper re-fires every poll response (~1 Hz) with a
    // possibly-stale mode. Skip a tune if the last command was identical
    // (freq+mode) — and only send `compression=0` once per session, since
    // re-sending it appears to reset the audio decoder on the server.
    this._lastTuneSig = '';
    this._compressionSet = false;
  }

  get connected() { return this._connected; }

  /**
   * Connect to a KiwiSDR receiver.
   * @param {string} host — hostname or IP
   * @param {number} port — default 8073
   * @param {string} password — default '#' for public receivers
   * @param {string} callsign — operator callsign for SET ident_user. Required
   *   by many public kiwis (server replies `badp=5` and drops the connection
   *   without it). Falls back to "POTACAT" if unset, but real callsign is
   *   strongly preferred — some sysops require a valid call.
   */
  connect(host, port, password, callsign) {
    this.disconnect();
    this._host = host;
    this._port = port || 8073;
    this._authFailed = false;
    const ts = Date.now();
    const url = `ws://${this._host}:${this._port}/kiwi/${ts}/SND`;
    console.log(`[KiwiSDR] Connecting to ${url}`);

    try {
      this._ws = new WebSocket(url, { handshakeTimeout: 10000 });
    } catch (err) {
      this.emit('error', err.message);
      return;
    }

    this._ws.on('open', () => {
      this._lastTuneSig = '';
      this._compressionSet = false;
      this._diagFrames = 0;
      // Auth password handling for public kiwis:
      //   - If an explicit password was given, use it (sysops who set one).
      //   - Else if we have a callsign, send it as the password — many sysops
      //     gate "extended listener time" on callsign-as-password. Without
      //     this, Bucks (and similar) allow ~10 s of preview audio then bump
      //     the connection with too_busy=1.
      //   - Else fall back to '#' (anonymous public listener, short time limit).
      const cs = (callsign || '').trim();
      const authPwd = password || cs || '#';
      this._send(`SET auth t=kiwi p=${authPwd}`);
      // ident_user is a separate, free-form identifier that the sysop sees in
      // the kiwi's user list. Required by some kiwis (rejected with badp=5
      // without it) and good citizenship in any case.
      const ident = encodeURIComponent(cs || 'POTACAT');
      this._send(`SET ident_user=${ident}`);
      // Tell the server we're an active listener — bypass any inactivity-
      // timeout kick the sysop has configured (kiwiclient.py sends this).
      this._send('SET override_inactivity_timeout=1');
      this._startKeepalive();
      this._connected = true;
      this._gotAudio = false;
      // Some kiwis accept auth (badp=0) but never send audio_init because the
      // server is full and we got a "preview slot" with no actual audio. Set
      // a short timeout to detect that and surface a clear error rather than
      // letting the user stare at a connected indicator with no sound.
      this._noAudioTimer = setTimeout(() => {
        if (!this._gotAudio && this._connected) {
          this.emit('error', 'KiwiSDR connected but no audio received within 8s — server may be full (no audio slot available). Try a different station.');
          this.disconnect();
        }
      }, 8000);
      this.emit('connected');
    });

    this._ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      // KiwiSDR sends all messages as binary frames with a 3-byte marker
      const marker = buf.length >= 3 ? buf.slice(0, 3).toString('ascii') : '';
      if (marker === 'MSG') {
        this._parseText(buf.slice(4).toString('utf8')); // skip "MSG " (4 bytes)
      } else if (marker === 'SND') {
        // First audio frame received — clear the no-audio watchdog.
        if (!this._gotAudio) {
          this._gotAudio = true;
          if (this._noAudioTimer) { clearTimeout(this._noAudioTimer); this._noAudioTimer = null; }
        }
        this._parseBinary(buf);
      }
    });

    this._ws.on('close', (code, reason) => {
      console.log(`[KiwiSDR] WebSocket closed: code=${code} reason=${reason || 'none'}`);
      this._cleanup();
      this.emit('disconnected');
    });

    this._ws.on('error', (err) => {
      console.log(`[KiwiSDR] WebSocket error: ${err.message}`);
      this.emit('error', err.message || 'WebSocket error');
    });
  }

  disconnect() {
    if (this._ws) {
      try { this._ws.close(); } catch {}
    }
    this._cleanup();
  }

  /**
   * Tune to a frequency and mode.
   * @param {number} freqKhz — frequency in kHz (e.g. 7255)
   * @param {string} mode — 'usb', 'lsb', 'am', 'cw', 'nbfm'
   * @param {number} [bwLow] — lower passband edge in Hz
   * @param {number} [bwHigh] — upper passband edge in Hz
   */
  tune(freqKhz, mode, bwLow, bwHigh) {
    if (!this._connected) return;
    const m = (mode || 'usb').toLowerCase();
    let low, high;
    if (bwLow != null && bwHigh != null) {
      low = bwLow;
      high = bwHigh;
    } else {
      // Default passbands by mode
      switch (m) {
        case 'usb': low = 300; high = 2700; break;
        case 'lsb': low = -2700; high = -300; break;
        case 'am':  low = -4000; high = 4000; break;
        case 'cw':  low = 300; high = 800; break;
        case 'cwn': low = 400; high = 700; break;
        case 'nbfm': low = -6000; high = 6000; break;
        default:    low = 300; high = 2700; break;
      }
    }
    // KiwiSDR's SET freq parameter is in kHz, not MHz — we were dividing by
    // 1000 and sending MHz, so 14.074 MHz arrived as 14 kHz (VLF). The receiver
    // tuned to a band with no signal, AGC pumped the noise floor to full scale,
    // and audio came out as a loud white-noise blast. (KI4GT report 2026-05-01.)
    const sig = `${m}|${freqKhz.toFixed(3)}|${low}|${high}`;
    if (sig === this._lastTuneSig) return; // already there — no-op
    this._lastTuneSig = sig;
    this._send(`SET mod=${m} low_cut=${low} high_cut=${high} freq=${freqKhz.toFixed(3)}`);
    if (!this._compressionSet) {
      this._send('SET compression=0');
      this._compressionSet = true;
    }
    this._adpcmState = { predictor: 0, stepIndex: 0 };
  }

  /** Set AGC parameters */
  setAgc(on, manGain) {
    if (!this._connected) return;
    if (on) {
      this._send('SET agc=1 hang=0 thresh=-100 slope=6 decay=1000 manGain=50');
    } else {
      this._send(`SET agc=0 hang=0 thresh=-130 slope=6 decay=1000 manGain=${manGain || 50}`);
    }
  }

  // --- Internal ---

  _send(msg) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._ws.send(msg);
      // Surface every non-keepalive SET to the verbose log so QSY-doesn't-
      // retune diagnoses don't require a packet capture.
      if (!msg.startsWith('SET keepalive')) this.emit('log', `tx: ${msg}`);
    } else {
      this.emit('log', `tx DROPPED (ws not open): ${msg}`);
    }
  }

  _startKeepalive() {
    this._stopKeepalive();
    this._keepalive = setInterval(() => this._send('SET keepalive'), 5000);
  }

  _stopKeepalive() {
    if (this._keepalive) { clearInterval(this._keepalive); this._keepalive = null; }
  }

  _cleanup() {
    this._stopKeepalive();
    if (this._noAudioTimer) { clearTimeout(this._noAudioTimer); this._noAudioTimer = null; }
    this._connected = false;
    this._ws = null;
    this._diagMsgCount = 0;
  }

  _parseText(msg) {
    // Always log the first ~12 server messages for diagnostic visibility.
    // Beyond that, only log keyword-matched messages so verbose mode doesn't
    // get drowned in routine config dumps the kiwi sends after init.
    if (this._diagMsgCount == null) this._diagMsgCount = 0;
    const isKeyword = msg.includes('badp') || msg.includes('too_busy') || msg.includes('audio_init');
    if (isKeyword || this._diagMsgCount < 12) {
      this._diagMsgCount++;
      this.emit('log', `rx: ${msg.substring(0, 140)}`);
    }
    if (msg.includes('too_busy')) {
      // `too_busy=0` is a periodic all-clear heartbeat — slots are free,
      // we're fine. Only `too_busy=1` (or any non-zero) means the server
      // is bumping us. Don't disconnect on the heartbeat.
      const m = msg.match(/too_busy=(\d+)/);
      const code = m ? parseInt(m[1], 10) : 0;
      if (code !== 0) {
        this.emit('error', 'KiwiSDR is full (no available channels)');
        this.disconnect();
      }
    } else if (msg.includes('badp')) {
      // badp=x: 0=OK, 1=bad password, 5=identification required (and likely
      // other non-zero codes for various rejection reasons). Anything other
      // than 0 means the server is going to drop us, so surface it as a
      // hard error and mark the session so callers don't auto-retry.
      const m = msg.match(/badp=(\d+)/);
      const code = m ? parseInt(m[1], 10) : -1;
      if (code === 0) {
        // ok — continue
      } else {
        this._authFailed = true;
        let why;
        if (code === 1) why = 'bad password';
        else if (code === 5) why = 'identification required (set your callsign in Settings → Station)';
        else why = `auth rejected (badp=${code})`;
        this.emit('error', `KiwiSDR ${why}`);
        this.disconnect();
      }
    } else if (msg.includes('audio_init')) {
      // Use the rate the server reports — match kiwiclient.py exactly
      // (`SET AR OK in=<rate> out=<rate>`), not our previous in=12000
      // out=44100 mismatch. Some kiwi firmwares deliver scrambled audio
      // when out= doesn't match in=. Save the rate so we can hand it
      // to the renderer for correct buffer playback (Bucks is 12000,
      // some proxies are 20250).
      const m = msg.match(/audio_rate=(\d+)/);
      const rate = m ? parseInt(m[1], 10) : 12000;
      this._sampleRate = rate;
      this._send(`SET AR OK in=${rate} out=${rate}`);
      this.emit('info', { sampleRate: rate });
    }
  }

  _parseBinary(buf) {
    if (buf.length < 10) return;
    // SND frame layout (per jks-prv/kiwiclient client.py):
    //   0..2   'SND' marker
    //   3      flags (uint8)        — bit 0x10 = ADPCM compressed
    //   4..7   sequence number      (uint32 LE)
    //   8..9   s-meter              (uint16 BE; dBm = 0.1*smeter - 127)
    //   10..   audio payload        (16-bit LE PCM, or 4-bit ADPCM if compressed)
    if (buf.slice(0, 3).toString('ascii') !== 'SND') return;

    const flags = buf.readUInt8(3);
    const isCompressed = (flags & 0x10) !== 0;
    const smeterRaw = buf.readUInt16BE(8);
    const smeterDbm = 0.1 * smeterRaw - 127;

    const audioData = buf.slice(10);
    if (audioData.length === 0) return;

    let pcmFloat;
    if (isCompressed) {
      pcmFloat = this._decodeAdpcm(audioData);
    } else {
      // Uncompressed audio is BIG-endian int16 (kiwiclient: dtype='>i2').
      // We were reading little-endian — every sample's bytes were swapped,
      // which turns smooth audio into uniformly-distributed noise across
      // the full int16 range (the meanAbs≈0.5 we kept seeing in the
      // diagnostics). The s-meter parse worked because we already used
      // `readUInt16BE` for that field.
      const samples = audioData.length >> 1;
      pcmFloat = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        pcmFloat[i] = audioData.readInt16BE(i * 2) / 32768;
      }
    }

    // Diagnostic for the first few frames: surface the flag byte, raw audio
    // length, and decoded sample range so we can see empirically whether the
    // server is sending what we think it is. (KI4GT report 2026-05-01.)
    if (this._diagFrames == null) this._diagFrames = 0;
    if (this._diagFrames < 3 && pcmFloat.length > 0) {
      this._diagFrames++;
      let mn = Infinity, mx = -Infinity, sumAbs = 0;
      for (let i = 0; i < pcmFloat.length; i++) {
        const v = pcmFloat[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
        sumAbs += Math.abs(v);
      }
      const meanAbs = sumAbs / pcmFloat.length;
      this.emit('log', `frame#${this._diagFrames} flags=0x${flags.toString(16).padStart(2, '0')} compressed=${isCompressed} audioBytes=${audioData.length} samples=${pcmFloat.length} smeter=${smeterDbm.toFixed(1)}dBm range=${mn.toFixed(3)}..${mx.toFixed(3)} meanAbs=${meanAbs.toFixed(3)}`);
    }

    if (pcmFloat.length > 0) {
      this.emit('audio', pcmFloat, this._sampleRate || 12000);
      this.emit('smeter', smeterDbm);
    }
  }

  _decodeAdpcm(data) {
    const s = this._adpcmState;
    const out = new Float32Array(data.length * 2);
    let oi = 0;
    for (let i = 0; i < data.length; i++) {
      const byte = data[i];
      for (let nibIdx = 0; nibIdx < 2; nibIdx++) {
        const nib = nibIdx === 0 ? (byte & 0x0F) : ((byte >> 4) & 0x0F);
        const step = STEP[s.stepIndex];
        let delta = step >> 3;
        if (nib & 4) delta += step;
        if (nib & 2) delta += step >> 1;
        if (nib & 1) delta += step >> 2;
        if (nib & 8) delta = -delta;
        s.predictor = Math.max(-32768, Math.min(32767, s.predictor + delta));
        s.stepIndex = Math.max(0, Math.min(88, s.stepIndex + IDX_ADJ[nib]));
        out[oi++] = s.predictor / 32768;
      }
    }
    return out.subarray(0, oi);
  }
}

module.exports = { KiwiSdrClient };
