// SPDX-License-Identifier: Apache-2.0
'use strict';

// A radio driven through a TCI server (Zeus, Thetis): one WebSocket that
// carries rig control as `name:args;` text commands. Based on PR #632 by
// w5lee, tested on Zeus with a Hermes-Lite 2.
//
// Keying: send() drops any frame that would key (`trx:<rx>,true`,
// `tune:<rx>,true`). The only key-down is lib/tci-tx.js (startTx,
// startVoiceTx), with its own rules. trx:0; (no value) is the READ form.
//
// Everything is on receiver 0 (RX1) and its main VFO (channel 0).
//
// Receive audio (`audio: true`): RX1 as 12 kHz mono Float32, the rate the
// FT8 engine decodes at. A binary frame is a 64-byte little-endian header
// (receiver, sample rate, format 3 = float32, codec, crc, sample count,
// stream type 1 = RX audio, channels) and then the samples.
//
// IQ (setIq): RX1's IQ stream for the band scope, interleaved float32 I/Q
// (stream type 0) centred on the `dds` frequency the server reports. Zeus
// leaves the channel field 0 on IQ frames; the payload is still I/Q pairs.
//
// Dialects (the published TCI protocol, plus what w5lee's station showed):
//   - Thetis says `protocol:Thetis,...` (it may also call itself ExpertSDR3);
//     its attenuator is rx_step_att_ex behind rx_step_att_enabled_ex, its
//     squelch level is dBm (-140..0), and it reports VFO B on its own.
//   - Zeus answers rx_smeter on channel 0 or 2 (its WDSP RX1 channel).

const WebSocket = require('ws');
const TciTarget = require('./tci-target');
const { ssbSideband } = require('./ssb-sideband');
const TciTx = require('./tci-tx');

const AUDIO_RATE = 12000;
const HEADER_BYTES = 64;
const STREAM_RX_AUDIO = 1;
const STREAM_IQ = 0;
const AUDIO_SUBSCRIBE = `audio_samplerate:${AUDIO_RATE};audio_stream_channels:1;audio_stream_sample_type:float32;audio_start:0;`;

/**
 * RX1's audio from one binary frame, or null when the frame is anything
 * else (IQ, TX pacing, another receiver, rate or format). Samples are
 * clamped to -1..1 and a non-number becomes 0.
 */
function decodeRxFrame(frame) {
  if (!frame || frame.length < HEADER_BYTES) return null;
  if (frame.readUInt32LE(0) !== 0 || frame.readUInt32LE(4) !== AUDIO_RATE ||
      frame.readUInt32LE(8) !== 3 || frame.readUInt32LE(24) !== STREAM_RX_AUDIO) return null;
  // Zeus leaves the channel field 0; a mono stream is what was asked for.
  const channels = frame.readUInt32LE(28);
  if (channels !== 0 && channels !== 1) return null;
  const count = frame.readUInt32LE(20);
  if (count === 0 || frame.length !== HEADER_BYTES + count * 4) return null;
  const pcm = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const v = frame.readFloatLE(HEADER_BYTES + i * 4);
    pcm[i] = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  }
  return pcm;
}

/**
 * RX1's IQ from one binary frame: { payload (interleaved float32 I/Q bytes),
 * rate }, or null when the frame is anything else.
 */
function decodeIqFrame(frame) {
  if (!frame || frame.length < HEADER_BYTES) return null;
  if (frame.readUInt32LE(24) !== STREAM_IQ || frame.readUInt32LE(0) !== 0 || frame.readUInt32LE(8) !== 3) return null;
  const channels = frame.readUInt32LE(28);
  if (channels !== 2 && channels !== 0) return null;
  const rate = frame.readUInt32LE(4);
  const count = frame.readUInt32LE(20); // float values: I and Q each count
  if (!(rate >= 8000 && rate <= 3072000) || count === 0 || count % 2 || frame.length !== HEADER_BYTES + count * 4) return null;
  return { payload: frame.subarray(HEADER_BYTES), rate };
}

// Any frame that keys the transmitter. Checked on every send.
const KEYING = /(?:^|;)\s*(?:trx|tune)\s*:\s*\d+\s*,\s*(?:true|1)\b/i;

const TCI_MODES = new Set(['AM', 'SAM', 'DSB', 'LSB', 'USB', 'FM', 'NFM', 'CWL', 'CWU', 'DIGL', 'DIGU', 'WFM', 'DRM', 'SPEC']);
const AGC_MODES = new Map([
  ['off', 'off'], ['fixed', 'off'], ['fixd', 'off'],
  ['med', 'med'], ['medium', 'med'], ['normal', 'med'],
  ['slow', 'slow'], ['fast', 'fast'], ['long', 'long'], ['custom', 'custom'],
]);
const SETTABLE_AGC = new Set(['off', 'fast', 'med', 'slow']);

/**
 * The TCI modulation for a POTACAT mode. A spot names the waveform (FT8,
 * PSK31); the server needs a demodulator. Digital modes go to DIGU when
 * `dataMode`, else USB. '' when TCI has no such mode.
 */
function toTciMode(mode, hz, dataMode) {
  const name = String(mode || '').trim().toUpperCase();
  if (!name) return '';
  if (name === 'SSB') return ssbSideband(hz); // lib/ssb-sideband.js, the one rule (60 m is USB)
  if (name === 'CW') return 'CWU';
  if (name === 'CW-R' || name === 'CWR') return 'CWL';
  if (/^(FT[248]|WSPR|JS8|JTTY|RTTY|PSK(?:31|63|125)?|DIGU|PKTUSB|USB-D|DATA-USB)$/.test(name)) return dataMode ? 'DIGU' : 'USB';
  if (/^(DIGL|PKTLSB|LSB-D|DATA-LSB)$/.test(name)) return dataMode ? 'DIGL' : 'LSB';
  return TCI_MODES.has(name) ? name : '';
}

/** The POTACAT mode name for a TCI modulation (CWU/CWL read as CW). */
function fromTciMode(mod) {
  const m = String(mod || '').trim().toUpperCase();
  if (m === 'CWU' || m === 'CWL') return 'CW';
  if (m === 'NFM') return 'FM';
  return TCI_MODES.has(m) ? m : '';
}

/** `a:1,2;b;` -> [{ name: 'a', fields: ['1','2'] }, { name: 'b', fields: [] }] */
function parseCommands(text) {
  const out = [];
  for (const raw of String(text).split(';')) {
    const cmd = raw.trim();
    if (!cmd) continue;
    const colon = cmd.indexOf(':');
    const name = (colon === -1 ? cmd : cmd.slice(0, colon)).trim().toLowerCase();
    const args = colon === -1 ? '' : cmd.slice(colon + 1);
    out.push({ name, fields: args === '' ? [] : args.split(',').map((f) => f.trim()) });
  }
  return out;
}

// RF gain on a TCI rig is the 0..31 dB step attenuator, shown as 0..100 %.
function attenuationForGain(percent) {
  return Math.round(31 * (100 - percent) / 100);
}
function gainForAttenuation(db) {
  // ECHOCAT's presets light only on an exact percent: prefer the preset
  // that resolves to this whole-dB step.
  return [0, 25, 50, 75, 100].find((p) => attenuationForGain(p) === db) ?? Math.round(100 * (31 - db) / 31);
}

/** Resolves once the server says `ready`; never subscribes or changes anything. */
function probeTci(host, port, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(TciTarget.address(host, port), { handshakeTimeout: Math.max(500, timeoutMs - 500), maxPayload: 65536 });
    let settled = false;
    const deadline = setTimeout(() => finish(new Error('The server did not send a TCI ready message')), timeoutMs);
    function finish(err) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (err) { ws.terminate(); reject(err); } else { ws.close(); resolve(); }
    }
    ws.on('message', (frame, binary) => {
      if (!binary && parseCommands(frame.toString()).some((c) => c.name === 'ready')) finish();
    });
    ws.on('error', (e) => finish(e));
    ws.once('close', () => finish(new Error('The TCI connection closed before it was ready')));
  });
}

/**
 * Open a TCI rig.
 * @param {object} o
 * @param {string} o.host
 * @param {number} o.port
 * @param {'zeus'|'thetis'} o.server
 * @param {boolean} [o.autoStart]  send `start;` when the server reports a stopped receiver
 * @param {boolean} [o.audio]      stream RX1's audio (on.audio) from the start
 * @param {() => number} [o.driveCapPct]  the amplifier drive limit in percent (0 = none)
 * @param {object} [o.on]  callbacks: link(up), dial(hz), mode(potacatMode, tciMode),
 *   smeter(dbm), filter(widthHz), squelch(percent), agc(mode), nb(on), nr(on),
 *   rfGain(percent|null), tx(transmitting), drive(percent), audio(Float32Array @ 12 kHz),
 *   iq(payload, rateHz, centerHz), txMeter('power'|'swr'|'alc', value)
 * @param {(line: string) => void} [o.log]
 */
function connectTciRig(o) {
  const on = o.on || {};
  const log = o.log || (() => {});
  const address = TciTarget.address(o.host, o.port);
  const ws = new WebSocket(address, { handshakeTimeout: 5000, maxPayload: 65536 });
  let thetis = o.server === 'thetis';
  const attCommand = () => (thetis ? 'rx_step_att_ex' : 'attenuator');

  const st = {
    ready: false, receiverRunning: null, transmitting: null,
    rxDial: 0, txDialB: 0, txFrequency: 0, split: null,
    tciMode: '', agc: '', filterBand: null,
    sqlEnabled: null, sqlLevel: null,
    stepAttEnabled: false, attDb: null, driveMax: 100,
    drivePct: null, driveKnown: false,
    audio: !!o.audio, audioFrames: 0,
    iq: false, iqCenter: 0,
  };

  function send(text) {
    if (KEYING.test(text)) {
      log(`refused to send a keying command (${text.trim()}): this TCI link is receive-only`);
      return false;
    }
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(text);
    return true;
  }

  // A second session that only releases the key: Zeus keeps MOX on when the
  // session that keyed it closes.
  function recover() {
    let rescue;
    try { rescue = new WebSocket(address, { handshakeTimeout: 1000 }); } catch (e) { log(`PTT recovery: ${e.message}`); return; }
    const timeout = setTimeout(() => rescue.terminate(), 1500);
    rescue.on('open', () => rescue.send(TciTx.RELEASE));
    rescue.on('message', (f, bin) => {
      if (!bin && /(?:^|;)s*trx:0,(?:false|0);/.test(f.toString())) { log('PTT release confirmed on a second TCI session'); rescue.close(); }
    });
    rescue.on('error', (e) => log(`PTT recovery: ${e.message}`));
    rescue.on('close', () => clearTimeout(timeout));
  }
  // Thetis reports VFO B on its own even while transmitting on A: only its
  // tx_frequency says where it transmits.
  const txState = () => ({
    ready: st.ready && ws.readyState === WebSocket.OPEN, thetis, transmitting: st.transmitting,
    rxDial: st.rxDial, txFrequency: st.txFrequency, txDialB: thetis ? 0 : st.txDialB, split: st.split,
    tciMode: st.tciMode, driveKnown: st.driveKnown, drivePct: st.drivePct,
  });
  const capPct = () => { const c = Number(o.driveCapPct ? o.driveCapPct() : 0); return c > 0 ? c : 0; };
  const tx = TciTx.createTciTransmitter({
    sendKey: (text) => { if (ws.readyState !== WebSocket.OPEN) return false; ws.send(text); return true; },
    sendBinary: (buf) => { if (ws.readyState !== WebSocket.OPEN) return false; ws.send(buf); return true; },
    state: txState,
    driveCapPct: capPct,
    recover,
    log,
  });

  const inReceive = () => st.ready && ws.readyState === WebSocket.OPEN && st.transmitting === false;

  function reportSquelch() {
    if (st.sqlEnabled === false) on.squelch?.(0);
    else if (st.sqlEnabled && st.sqlLevel !== null) on.squelch?.(st.sqlLevel);
  }
  function reportAttenuation() {
    const usable = (!thetis || st.stepAttEnabled) && st.attDb !== null;
    on.rfGain?.(usable ? gainForAttenuation(Math.min(31, st.attDb)) : null);
  }

  function onReady() {
    if (st.ready) return;
    st.ready = true;
    // Read forms only: each asks the server for its current value.
    let reads = 'trx:0;vfo:0,0;modulation:0;rx_filter_band:0;sql_enable:0;sql_level:0;agc_mode:0;drive:0;rx_nb_enable:0;rx_nr_enable:0;split_enable:0;';
    if (thetis) reads += 'rx_sensors_enable:true,250;tx_sensors_enable:true,250;rx_step_att_enabled_ex:0;';
    reads += `${attCommand()}:0;`;
    send(reads);
    if (st.audio) send(AUDIO_SUBSCRIBE);
    if (st.receiverRunning === false && o.autoStart) {
      log('Starting the receiver');
      send('start;');
    }
    on.link?.(true);
  }

  function handle({ name, fields }) {
    const f0 = fields[0];
    switch (name) {
      case 'protocol':
        if (String(f0 || '').toLowerCase() === 'thetis') thetis = true;
        return;
      case 'device':
        // Thetis drives a Hermes-Lite on 0..90; POTACAT shows 0..100 %.
        if (thetis && String(f0 || '').toUpperCase() === 'HERMESLITE') st.driveMax = 90;
        return;
      case 'start': case 'stop':
        st.receiverRunning = name === 'start';
        log(st.receiverRunning ? 'Receiver is running' : 'Receiver is stopped');
        return;
      case 'ready':
        onReady();
        return;
      case 'tx_power': case 'tx_swr': case 'tx_alc':
        txMeter(name.slice(3), Number(f0));
        return;
      case 'tx_frequency': case 'tx_frequency_ex': {
        const hz = Number(f0);
        st.txFrequency = Number.isSafeInteger(hz) && hz >= 100000 ? hz : 0;
        return;
      }
      default:
    }
    if (f0 !== '0') return; // receiver 0 only
    switch (name) {
      case 'dds': {
        const hz = Number(fields[1]);
        if (Number.isSafeInteger(hz) && hz > 0) st.iqCenter = hz;
        return;
      }
      case 'vfo': {
        const hz = Number(fields[2]);
        if (!Number.isSafeInteger(hz) || hz < 100000) return;
        if (fields[1] === '0') {
          st.rxDial = hz;
          on.dial?.(hz);
        } else if (fields[1] === '1') st.txDialB = hz;
        return;
      }
      case 'modulation': {
        const m = String(fields[1] || '').toUpperCase();
        if (!TCI_MODES.has(m)) return;
        st.tciMode = m;
        on.mode?.(fromTciMode(m), m);
        return;
      }
      case 'split_enable':
        st.split = fields[1] === 'true' || fields[1] === '1';
        return;
      case 'trx': {
        const v = fields[1];
        if (v !== 'true' && v !== '1' && v !== 'false' && v !== '0') return;
        const was = st.transmitting;
        st.transmitting = v === 'true' || v === '1';
        tx.onTrx(st.transmitting);
        if (was !== st.transmitting) on.tx?.(st.transmitting);
        return;
      }
      case 'rx_filter_band': {
        const lo = Number(fields[1]), hi = Number(fields[2]);
        if (fields[1] && fields[2] && Number.isInteger(lo) && Number.isInteger(hi) && hi > lo) {
          st.filterBand = { lo, hi };
          on.filter?.(hi - lo);
        }
        return;
      }
      case 'sql_enable':
        if (!/^(true|false)$/i.test(fields[1] || '')) return;
        st.sqlEnabled = fields[1].toLowerCase() === 'true';
        reportSquelch();
        return;
      case 'sql_level': {
        const level = Number(fields[1]);
        if (!fields[1] || !Number.isFinite(level)) return;
        const pct = thetis ? Math.round(100 * (level + 140) / 140) : Math.round(level);
        st.sqlLevel = Math.max(0, Math.min(100, pct));
        reportSquelch();
        return;
      }
      case 'agc_mode': {
        const v = AGC_MODES.get(String(fields[1] || '').toLowerCase());
        if (!v) return;
        st.agc = v;
        on.agc?.(v);
        return;
      }
      case 'rx_nb_enable': {
        const v = String(fields[1] || '').toLowerCase();
        if (v === 'true' || v === 'false') on.nb?.(v === 'true');
        return;
      }
      case 'rx_nr_enable': case 'rx_nr_enable_ex': {
        const v = String(fields[1] || '').toLowerCase();
        if (v === 'true' || v === 'false') on.nr?.(v === 'true');
        return;
      }
      case 'rx_step_att_enabled_ex': {
        if (!thetis) return;
        const v = String(fields[1] || '').toLowerCase();
        if (v !== 'true' && v !== 'false') return;
        st.stepAttEnabled = v === 'true';
        reportAttenuation();
        return;
      }
      case 'attenuator': case 'rx_step_att_ex': {
        if (name !== attCommand()) return;
        const db = Number(fields[1]);
        if (!fields[1] || !Number.isInteger(db) || db < 0) return;
        st.attDb = db;
        reportAttenuation();
        return;
      }
      case 'drive': {
        const v = Number(fields[1]);
        if (!fields[1] || !Number.isInteger(v) || v < 0 || v > 100) return;
        st.drivePct = Math.min(100, Math.round(v * 100 / st.driveMax));
        on.drive?.(st.drivePct);
        return;
      }
      case 'tx_sensors': {
        // Thetis: tx_sensors:0,mic,power,peak power,swr;
        txMeter('power', Number(fields[3]));
        txMeter('swr', Number(fields[4]));
        return;
      }
      case 'rx_sensors': {
        const dbm = Number(fields[1]);
        if (fields[1] && Number.isFinite(dbm)) on.smeter?.(dbm);
        return;
      }
      case 'rx_smeter': {
        // Zeus reports its WDSP RX1 channel as 2; the protocol's RX1 is 0.
        if (fields[1] !== '0' && fields[1] !== '2') return;
        const dbm = Number(fields[2]);
        if (fields[2] && Number.isFinite(dbm)) on.smeter?.(dbm);
        return;
      }
      default:
    }
  }

  function txMeter(kind, value) {
    if (!Number.isFinite(value)) return;
    if (kind === 'power' && value >= 0) { tx.onForwardWatts(value); on.txMeter?.('power', value); }
    else if (kind === 'swr' && value >= 1) on.txMeter?.('swr', value);
    else if (kind === 'alc' && value >= 0 && value <= 100) on.txMeter?.('alc', value);
  }

  ws.on('message', (frame, binary) => {
    if (binary && st.iq && frame.length >= HEADER_BYTES && frame.readUInt32LE(24) === STREAM_IQ) {
      // The scope shows what we hear: never our own transmission.
      const iq = decodeIqFrame(frame);
      if (iq && st.iqCenter > 0 && st.transmitting === false) on.iq?.(iq.payload, iq.rate, st.iqCenter);
      return;
    }
    if (binary) {
      if (tx.onBinary(frame, st.transmitting)) return; // TX pacing (lib/tci-tx.js)
      if (!st.audio || !st.ready) return;
      const pcm = decodeRxFrame(frame);
      // RX audio only while receiving: the decoder must not hear our own TX.
      if (!pcm || st.transmitting === true) return;
      if (++st.audioFrames === 1) log(`RX1 audio arriving (${AUDIO_RATE} Hz mono float32)`);
      on.audio?.(pcm);
      return;
    }
    for (const cmd of parseCommands(frame.toString())) handle(cmd);
  });
  ws.on('error', (err) => log(`${address}: ${err.message}`));
  ws.on('close', () => {
    const wasReady = st.ready;
    st.ready = false;
    tx.onClose();
    if (wasReady) log('TCI link closed');
    on.link?.(false);
  });

  return {
    get connected() { return st.ready && ws.readyState === WebSocket.OPEN; },
    get receiveDialHz() { return st.rxDial; },
    get tciMode() { return st.tciMode; },
    get transmitting() { return st.transmitting === true; },
    get filterBand() { return st.filterBand; },
    get squelchAvailable() { return st.sqlEnabled !== null; },
    get rfGainAvailable() { return !thetis || (st.stepAttEnabled && st.attDb !== null); },
    get agcMode() { return st.agc; },
    get isThetis() { return thetis; },
    get audioStreaming() { return st.audio && st.audioFrames > 0; },

    get iqStreaming() { return st.iq; },
    /** Start or stop RX1's IQ stream (the band scope). */
    setIq(enabled) {
      enabled = !!enabled;
      if (st.iq === enabled || !st.ready) return st.ready;
      st.iq = enabled;
      return send(enabled ? 'dds:0;iq_start:0;' : 'iq_stop:0;');
    },

    /** Start or stop RX1's audio stream (the rig's audio source changed). */
    setAudio(enabled) {
      enabled = !!enabled;
      if (st.audio === enabled) return;
      st.audio = enabled;
      st.audioFrames = 0;
      if (st.ready) send(enabled ? AUDIO_SUBSCRIBE : 'audio_stop:0;');
    },

    /** Move RX1's VFO A, and the mode when one is given. '' or the reason it did not. */
    tune(hz, mode, { dataMode = true } = {}) {
      if (!this.connected) return 'The TCI server is not connected';
      if (st.transmitting !== false || tx.busy) return 'Wait for the radio to return to receive';
      if (!Number.isSafeInteger(hz) || hz < 100000) return 'Invalid TCI frequency';
      // Zeus refuses digital audio in USB (#185): digital modes always go DIGU there.
      const mod = toTciMode(mode, hz, thetis ? dataMode : true);
      if (mode && !mod) return `TCI has no ${String(mode).toUpperCase()} mode`;
      send(`vfo:0,0,${hz};${mod ? `modulation:0,${mod};` : ''}`);
      return '';
    },
    setFilterBand(lo, hi) {
      if (!inReceive() || !st.filterBand || !Number.isInteger(lo) || !Number.isInteger(hi) || hi <= lo) return false;
      return send(`rx_filter_band:0,${lo},${hi};rx_filter_band:0;`);
    },
    setSquelch(percent) {
      if (!inReceive() || st.sqlEnabled === null || !Number.isFinite(percent) || percent < 0 || percent > 100) return false;
      const level = thetis ? Math.round(-140 + 1.4 * percent) : Math.round(percent);
      return send((percent > 0 ? `sql_level:0,${level};` : '') + `sql_enable:0,${percent > 0};sql_enable:0;sql_level:0;`);
    },
    setAgcMode(mode) {
      if (!inReceive() || !SETTABLE_AGC.has(mode)) return false;
      return send(`agc_mode:0,${mode};agc_mode:0;`);
    },
    setNoiseBlanker(enabled) {
      if (!inReceive()) return false;
      return send(`rx_nb_enable:0,${!!enabled};rx_nb_enable:0;`);
    },
    setNoiseReduction(enabled) {
      if (!inReceive()) return false;
      return send(`rx_nr_enable:0,${!!enabled};rx_nr_enable:0;`);
    },
    setRfGain(percent) {
      if (!inReceive() || !this.rfGainAvailable || !Number.isFinite(percent) || percent < 0 || percent > 100) return false;
      const cmd = attCommand();
      return send(`${cmd}:0,${attenuationForGain(percent)};${cmd}:0;`);
    },

    // ── Transmit (lib/tci-tx.js) ──
    get txActive() { return tx.active; },
    get voiceTxActive() { return tx.voiceActive; },
    get digitalTxActive() { return tx.digitalActive; },
    get driveKnown() { return st.driveKnown; },
    get drivePct() { return st.drivePct; },
    /** '' when a key-down of this kind would go now, else why not. */
    txRefusal(kind) { return TciTx.txRefusal({ ...txState(), busy: tx.busy }, kind, capPct()); },
    startTx(samples, done) { return tx.startTx(samples, done); },
    startVoiceTx(timeoutMs, done) { return tx.startVoiceTx(timeoutMs, done); },
    pushVoiceAudio(pcm) { tx.pushVoiceAudio(pcm); },
    stopTx(reason) { tx.stopTx(reason); },
    stopVoiceTx(reason) { tx.stopVoiceTx(reason); },
    stopAllTx(reason) { tx.stopAll(reason); },
    /** TX drive in percent, clamped to the drive cap. false when refused. */
    setDrive(percent) {
      if (!inReceive() || tx.busy || !Number.isFinite(percent) || percent < 0 || percent > 100) return false;
      const pct = tx.clampDrive(Math.round(percent));
      st.driveKnown = true;
      st.drivePct = pct;
      return send(`drive:0,${Math.round(pct * st.driveMax / 100)};drive:0;`);
    },

    close() {
      tx.stopAll('closed');
      try { ws.close(); } catch { /* already closed */ }
    },
  };
}

module.exports = {
  connectTciRig, probeTci, parseCommands, toTciMode, fromTciMode, decodeRxFrame, decodeIqFrame,
  attenuationForGain, gainForAttenuation, KEYING, AUDIO_RATE,
};
