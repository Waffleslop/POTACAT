// SPDX-License-Identifier: Apache-2.0
'use strict';

const WebSocket = require('ws');
const { isIP } = require('node:net');

const AUDIO_RATE = 12000;
const RX_LEVEL_SAMPLE_COUNT = 5 * AUDIO_RATE;
const RX_PEAK_SAMPLE_COUNT = AUDIO_RATE / 4;
const RX_CLIP_LEVEL = 0.999;
const RX_LEVEL_TARGET_DBFS = -12;
const RX_LEVEL_PREFERRED_VOLUME = 0.5;
const RX_LEVEL_MAX_ADJUSTMENTS = 4;
const HEADER_BYTES = 64;
const TX_CHRONO = 3;
const TX_AUDIO = 2;
const TX_RELEASE = 'trx:0,false;';
// Bound both stalls and the whole burst. The server requests PCM and can
// stop asking while PTT is still active.
const TX_STALL_MS = 800;
// JTTY and PSK31 can render up to two minutes of audio, plus the lead.
const TX_MAX_SECONDS = 121;
const TX_DEADLINE_GRACE_MS = 800;
const VOICE_BUFFER_SAMPLES = AUDIO_RATE / 4;
// Zeus broadcasts these without a sensor subscription. Forward watts are
// independent of the requested drive percentage reported by CAT.
const TX_METER_LIMITS = { tx_power: [0, Infinity], tx_swr: [1, Infinity], tx_alc: [0, 100] };
const ZEUS_MODES = new Set(['AM', 'SAM', 'DSB', 'LSB', 'USB', 'FM', 'CWL', 'CWU', 'DIGL', 'DIGU']);

const TCI_AGC_MODES = new Map([
  ['off', 'off'], ['fixed', 'off'], ['fixd', 'off'],
  ['med', 'med'], ['medium', 'med'], ['normal', 'med'],
  ['slow', 'slow'], ['fast', 'fast'], ['long', 'long'], ['custom', 'custom'],
]);

// Spot modes describe the digital waveform; Zeus needs a demodulation mode.
function toZeusMode(mode, hz, useDataMode) {
  const name = String(mode || '').trim().toUpperCase();
  if (name === 'SSB') return hz < 10000000 ? 'LSB' : 'USB';
  if (name === 'CW' || name === 'CW-R' || name === 'CWR') return name === 'CW' ? 'CWU' : 'CWL';
  if (name === 'NFM') return 'FM';
  if (/^(FT[248]|WSPR|JS8|JTTY|RTTY|PSK(?:31|63|125)?|DIGU|PKTUSB|USB-D|DATA-USB)$/.test(name)) {
    return useDataMode ? 'DIGU' : 'USB';
  }
  if (/^(DIGL|PKTLSB|LSB-D|DATA-LSB)$/.test(name)) return useDataMode ? 'DIGL' : 'LSB';
  return ZEUS_MODES.has(name) ? name : '';
}

// TCI v1.x encodes a 64-byte little-endian header followed by scalar PCM.
// This prototype requests RX1, mono Float32. Ignore IQ, TX pacing frames and
// unexpected formats rather than accidentally feeding them to the decoder.
function decodeRxFrame(frame) {
  if (frame.length < HEADER_BYTES ||
      frame.readUInt32LE(0) !== 0 || frame.readUInt32LE(4) !== AUDIO_RATE ||
      frame.readUInt32LE(8) !== 3 || frame.readUInt32LE(12) !== 0 ||
      frame.readUInt32LE(24) !== 1) return null;
  const count = frame.readUInt32LE(20);
  if (count === 0 || frame.length !== HEADER_BYTES + count * 4) return null;

  const pcm = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    const value = frame.readFloatLE(HEADER_BYTES + index * 4);
    pcm[index] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  }
  return pcm;
}

// Initial setup verifies a real TCI handshake without subscribing to audio,
// changing the receiver, or sending any command to Zeus.
function tciAddress(host, port) {
  if (isIP(host) === 6) host = `[${host}]`;
  return `ws://${host}:${port}`;
}

function probeTci(port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(tciAddress(host, port), { handshakeTimeout: 2500, maxPayload: 65536 });
    let settled = false;
    const deadline = setTimeout(() => finish(new Error('The server did not send a TCI ready message')), 3000);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) {
        ws.terminate();
        reject(error);
      } else {
        ws.close();
        resolve();
      }
    }
    ws.on('message', (frame, binary) => {
      if (!binary && frame.toString().split(';').some(command => command.trim() === 'ready')) finish();
    });
    ws.on('error', finish);
    ws.once('close', () => finish(new Error('The TCI connection closed before it was ready')));
  });
}

function attenuationForGain(percent) {
  return Math.round(31 * (100 - percent) / 100);
}

function gainForAttenuation(db) {
  // EchoCAT lights presets only on an exact percent match. Prefer the
  // preset whose command resolves to this confirmed whole-dB step.
  return [0, 25, 50, 75, 100].find(percent => attenuationForGain(percent) === db)
    ?? Math.round(100 * (31 - db) / 31);
}

function connectTciJtcatRx(port, { host = '127.0.0.1', server, autoStart = false, onAudio, onDigitalTxAudio, onDial, onMode, onSmeter, onTxMeter, onTxState, onLink, onRxVolume, onRxPeak, onAgcMode, onNoiseReduction, onNoiseBlanker, onAttenuation, onDrive, getZeusFixedGain, cycleZeusNrMode, setFt8Rx, log }) {
  const address = tciAddress(host, port);
  // Zeus AF trim can boost above unity. Thetis maps its RX fader to -60..0 dB.
  const minVolumeDb = server === 'zeus' ? -50 : -60;
  const maxVolumeDb = server === 'zeus' ? 20 : 0;
  let requestedRxVolumeDb = null;
  const volumeCommandFor = value => {
    const db = value === 0 ? minVolumeDb
      : Math.max(minVolumeDb, maxVolumeDb + 20 * Math.log10(value));
    const valueDb = db.toFixed(2);
    requestedRxVolumeDb = Number(valueDb);
    return `rx_volume:0,0,${valueDb};`;
  };
  const ws = new WebSocket(address, { handshakeTimeout: 5000, maxPayload: 65536 });
  let subscribed = false;
  let receiverRunning = null;
  let firstAudio = true;
  let transmitting = null;
  let rxDial = 0;
  let txDial = 0;
  let explicitTxDial = 0;
  // Thetis can identify itself as ExpertSDR3 for compatibility.
  let thetis = server === 'thetis';
  let splitEnabled = null;
  let radioMode = '';
  let agcMode = '';
  const attenuationCommand = thetis ? 'rx_step_att_ex' : 'attenuator';
  let stepAttenuatorEnabled = false;
  let attenuationDb = null;
  let rxPeakSamples = 0;
  let rxPeak = 0;
  let driveSetInSession = false;
  let driveMaximum = 100;
  const reportAttenuation = () => {
    const available = (!thetis || stepAttenuatorEnabled) && attenuationDb !== null;
    onAttenuation?.(available ? gainForAttenuation(Math.min(31, attenuationDb)) : null);
  };
  let zeusNrLevel = 0;
  let zeusNbLevel = 0;
  let zeusNb2Available = false;
  let pendingNbNotice = null;
  let cyclingNr = false;
  let fixedGain = null;
  let rxVolume = null;
  let rxMeasurement = null;
  let leveling = false;
  let activeTx = null;
  let releaseTimer = null;
  let tuning = false;

  // Use a second TCI session to release our key if the audio socket
  // drops. Zeus currently keeps MOX on when the originating session closes.
  function recoverPtt() {
    const rescue = new WebSocket(address, { handshakeTimeout: 1000 });
    const timeout = setTimeout(() => rescue.terminate(), 1500);
    rescue.on('open', () => rescue.send(TX_RELEASE));
    rescue.on('message', (frame, binary) => {
      if (!binary && /(?:^|;)trx:0,(?:false|0);/.test(frame.toString())) {
        log('PTT release confirmed on recovery connection');
        rescue.close();
      }
    });
    rescue.on('error', (error) => log(`PTT recovery: ${error.message}`));
    rescue.on('close', () => clearTimeout(timeout));
  }

  function finishTx(reason, { alreadyReleased = false, lostSocket = false } = {}) {
    if (!activeTx) return;
    const { done, deadline, stall, tail, micStall, peakWatts } = activeTx;
    activeTx = null;
    clearTimeout(deadline);
    clearTimeout(stall);
    clearTimeout(tail);
    clearTimeout(micStall);
    if (lostSocket) recoverPtt();
    else if (!alreadyReleased && ws.readyState === WebSocket.OPEN) {
      ws.send(TX_RELEASE);
      // Confirm RX before treating the release as delivered. A socket close
      // before the acknowledgement uses the same recovery path.
      releaseTimer = setTimeout(() => {
        releaseTimer = null;
        recoverPtt();
      }, 500);
    }
    done(reason, peakWatts);
  }

  function handleChrono(frame) {
    if (!activeTx || transmitting !== true || activeTx.tail) return;
    // TX_CHRONO is header-only. Zeus requests mono scalar samples at the
    // negotiated rate. Respond to each request, never on a local audio timer.
    const count = frame.readUInt32LE(20);
    if (frame.length !== HEADER_BYTES || frame.readUInt32LE(0) !== 0 ||
        frame.readUInt32LE(4) !== AUDIO_RATE || frame.readUInt32LE(28) !== 1 ||
        count === 0 || count > 2048) {
      finishTx('invalid TX_CHRONO');
      return;
    }
    clearTimeout(activeTx.stall);
    const audio = Buffer.alloc(HEADER_BYTES + count * 4);
    audio.writeUInt32LE(AUDIO_RATE, 4);
    audio.writeUInt32LE(3, 8); // Float32
    audio.writeUInt32LE(count, 20);
    audio.writeUInt32LE(TX_AUDIO, 24);
    audio.writeUInt32LE(1, 28); // mono
    const voice = activeTx.voice;
    const available = voice ? Math.min(count, voice.length) : count;
    for (let i = 0; i < available; i++, activeTx.offset++) {
      const sample = activeTx.samples[voice ? i : activeTx.offset];
      if (Number.isFinite(sample)) audio.writeFloatLE(Math.max(-1, Math.min(1, sample)), HEADER_BYTES + i * 4);
    }
    if (voice) {
      activeTx.samples.copyWithin(0, available, voice.length);
      voice.length -= available;
    }
    ws.send(audio);
    if (!voice && activeTx.offset >= activeTx.samples.length) {
      // Give the last buffered audio block time to reach the DAC.
      activeTx.tail = setTimeout(() => finishTx('complete'), 150);
    } else {
      activeTx.stall = setTimeout(() => finishTx('TX_CHRONO stalled'), TX_STALL_MS);
    }
    if (!voice) onDigitalTxAudio?.(audio.subarray(HEADER_BYTES));
  }

  function stopRxMeasurement(error) {
    if (!rxMeasurement) return;
    const { finish, timer, peak, clipped } = rxMeasurement;
    rxMeasurement = null;
    clearTimeout(timer);
    finish(error ? { error } : { peak, clipped });
  }

  function measureRxPeak() {
    return new Promise(finish => {
      const timer = setTimeout(() => stopRxMeasurement('No steady RX audio arrived'), 7000);
      rxMeasurement = { finish, timer, count: 0, peak: 0, clipped: 0 };
    });
  }

  function reportTxMeter(name, reading) {
    if (!reading?.trim()) return;
    const value = Number(reading);
    const [min, max] = TX_METER_LIMITS[name];
    if (!Number.isFinite(value) || value < min || value > max) return;
    // Attribute only readings from our acknowledged burst after sending PCM.
    if (name === 'tx_power' && activeTx && transmitting === true && activeTx.offset > 0) {
      activeTx.peakWatts = Math.max(activeTx.peakWatts, value);
    }
    onTxMeter(name, value);
  }

  ws.on('message', (frame, binary) => {
    if (binary) {
      if (frame.length >= HEADER_BYTES && frame.readUInt32LE(24) === TX_CHRONO) {
        handleChrono(frame);
        return;
      }
      const pcm = subscribed && decodeRxFrame(frame);
      if (!pcm) return;
      if (firstAudio) {
        firstAudio = false;
        log('RX1 audio received at 12 kHz (mono Float32)');
      }
      if (transmitting === false && (onRxPeak || rxMeasurement)) {
        let framePeak = 0;
        let clipped = 0;
        for (const sample of pcm) {
          const level = Math.abs(sample);
          if (level > framePeak) framePeak = level;
          if (rxMeasurement && level >= RX_CLIP_LEVEL) clipped++;
        }
        if (onRxPeak) {
          rxPeak = Math.max(rxPeak, framePeak);
          rxPeakSamples += pcm.length;
          if (rxPeakSamples >= RX_PEAK_SAMPLE_COUNT) {
            onRxPeak({
              peakDb: rxPeak > 0 ? 20 * Math.log10(rxPeak) : null,
              nearClip: rxPeak >= RX_CLIP_LEVEL,
            });
            rxPeak = rxPeakSamples = 0;
          }
        }
        if (rxMeasurement) {
          rxMeasurement.peak = Math.max(rxMeasurement.peak, framePeak);
          rxMeasurement.clipped += clipped;
          rxMeasurement.count += pcm.length;
          if (rxMeasurement.count >= RX_LEVEL_SAMPLE_COUNT) stopRxMeasurement();
        }
      }
      onAudio(pcm);
      return;
    }

    for (const command of frame.toString().split(';')) {
      const [name, args = ''] = command.trim().split(':', 2);
      const fields = args.split(',').map(field => field.trim());
      if (name === 'start' || name === 'stop') {
        receiverRunning = name === 'start';
        log(receiverRunning ? 'Receiver is running' : 'Receiver is stopped');
      } else if (name === 'protocol' && fields[0].toLowerCase() === 'thetis') {
        thetis = true;
      } else if (name === 'device' && thetis) {
        // Thetis uses a 0–90 native drive range for Hermes-Lite. Keep
        // POTACAT and EchoCAT on a normalized 0–100% scale.
        if (fields[0].toUpperCase() === 'HERMESLITE') driveMaximum = 90;
      } else if (name === 'rx_volume' && fields[0] === '0' && fields[1] === '0') {
        const db = Number(fields[2]);
        if (fields[2]?.trim() && Number.isFinite(db) && db >= minVolumeDb && db <= maxVolumeDb) {
          // Zeus returns whole dB on query, even though its setter accepts
          // decimals. Keep the requested precision if that echo agrees.
          const confirmedDb = server === 'zeus' && requestedRxVolumeDb !== null
            && Number.isInteger(db) && Math.abs(db - requestedRxVolumeDb) <= 0.5
            ? requestedRxVolumeDb : db;
          if (confirmedDb !== requestedRxVolumeDb) requestedRxVolumeDb = null;
          const volume = confirmedDb === minVolumeDb ? 0 : Math.pow(10, (confirmedDb - maxVolumeDb) / 20);
          if (volume !== rxVolume) stopRxMeasurement('RX volume changed during the measurement');
          rxVolume = volume;
          onRxVolume?.(volume);
        }
      } else if (name === 'tx_frequency' || name === 'tx_frequency_ex') {
        const hz = Number(fields[0]);
        explicitTxDial = Number.isSafeInteger(hz) && hz >= 100000 ? hz : 0;
      } else if (name === 'ready' && !subscribed) {
        subscribed = true;
        // Wait for the server handshake before changing session-local audio
        // settings. trx:0 is the read form and never keys the radio.
        ws.send('audio_samplerate:12000;audio_stream_channels:1;audio_stream_sample_type:float32;audio_start:0;trx:0;');
        if (thetis) ws.send('rx_sensors_enable:true,250;tx_sensors_enable:true,250;agc_gain:0;');
        if (onRxVolume) ws.send('rx_volume:0,0;');
        if (onAgcMode) ws.send('agc_mode:0;');
        if (onAttenuation) {
          if (thetis) ws.send('rx_step_att_enabled_ex:0;');
          ws.send(`${attenuationCommand}:0;`);
        }
        if (onDrive) ws.send('drive:0;');
        if (thetis && onNoiseReduction) ws.send('rx_nr_enable:0;');
        if (onNoiseBlanker) {
          ws.send(server === 'zeus' ? 'rx_nb_enable:0;rx_nb2_enable:0;' : 'rx_nb_enable:0;');
        }
        if (receiverRunning === false && autoStart) {
          log('Starting receiver');
          ws.send('start;');
        }
        onLink?.(true);
      } else if (name === 'tx_sensors' && fields[0] === '0') {
        reportTxMeter('tx_power', fields[3]);
        reportTxMeter('tx_swr', fields[4]);
      } else if (Object.hasOwn(TX_METER_LIMITS, name)) {
        reportTxMeter(name, args);
      } else if (fields[0] === '0') {
        // Use only RX1 and its main VFO. The S-meter frames are unsolicited
        // dBm reports from Zeus, not the 0–255 values used by PotaCAT's UI.
        if (name === 'vfo') {
          const hz = Number(fields[2]);
          if (!Number.isSafeInteger(hz) || hz < 100000) continue;
          if (fields[1] === '0') {
            if (hz !== rxDial) stopRxMeasurement('The receive dial changed');
            rxDial = hz;
            onDial(hz);
          } else if (fields[1] === '1') txDial = hz;
        } else if (name === 'split_enable') {
          splitEnabled = fields[1] === 'true' || fields[1] === '1';
        } else if (thetis && name === 'rx_step_att_enabled_ex') {
          const enabled = fields[1]?.toLowerCase();
          if (enabled !== 'true' && enabled !== 'false') continue;
          stepAttenuatorEnabled = enabled === 'true';
          reportAttenuation();
        } else if ((name === attenuationCommand || name === 'drive') && fields[1]?.trim()) {
          const value = Number(fields[1]);
          if (!Number.isInteger(value) || value < 0) continue;
          if (name === 'drive') {
            if (value <= 100) {
              onDrive?.(Math.min(100, Math.round(value * 100 / driveMaximum)), driveSetInSession);
            }
          } else {
            attenuationDb = value;
            reportAttenuation();
          }
        } else if (name === 'rx_nb_enable' || (server === 'zeus' && name === 'rx_nb2_enable')) {
          const enabled = fields[1]?.toLowerCase();
          if (enabled !== 'true' && enabled !== 'false') continue;
          if (server === 'zeus') {
            const level = name === 'rx_nb_enable' ? 1 : 2;
            if (level === 2) zeusNb2Available = true;
            if (enabled === 'true') zeusNbLevel = level;
            else if (zeusNbLevel === level) zeusNbLevel = 0;
            onNoiseBlanker?.(zeusNbLevel !== 0);
            if (pendingNbNotice?.command === name) {
              const { expectedLevel, expiresAt, notify } = pendingNbNotice;
              pendingNbNotice = null;
              if (zeusNbLevel === expectedLevel && Date.now() <= expiresAt) notify(zeusNbLevel);
            }
          } else {
            onNoiseBlanker?.(enabled === 'true');
          }
        } else if (name === 'rx_nr_enable' || name === 'rx_nr_enable_ex') {
          const enabled = fields[1]?.toLowerCase();
          if (enabled === 'true' || enabled === 'false') onNoiseReduction?.(enabled === 'true');
        } else if (name === 'agc_gain' && fields[1]?.trim()) {
          const value = Number(fields[1]);
          if (Number.isInteger(value) && value >= -20 && value <= 120) {
            if (value !== fixedGain) stopRxMeasurement('AGC gain changed during the measurement');
            fixedGain = value;
          }
        } else if (name === 'agc_mode') {
          const value = TCI_AGC_MODES.get(fields[1]?.toLowerCase());
          if (value) {
            if (value !== agcMode) stopRxMeasurement('The AGC mode changed');
            agcMode = value;
            onAgcMode?.(value);
          }
        } else if (name === 'modulation' && ZEUS_MODES.has(fields[1])) {
          if (fields[1] !== radioMode) stopRxMeasurement('The receive mode changed');
          radioMode = fields[1];
          onMode(radioMode);
        // Zeus reports its WDSP RX1 channel as 2; standard RX1 meters can
        // use channel 0. Ignore other DSP channels.
        } else if (name === 'rx_sensors' && fields[1]?.trim()) {
          const dbm = Number(fields[1]);
          if (Number.isFinite(dbm)) onSmeter(dbm);
        } else if (name === 'rx_smeter' && ['0', '2'].includes(fields[1]) && fields[2]?.trim()) {
          const dbm = Number(fields[2]);
          if (Number.isFinite(dbm)) onSmeter(dbm);
        } else if (name === 'trx') {
          const wasTransmitting = transmitting;
          if (fields[1] === 'true' || fields[1] === '1') {
            transmitting = true;
            rxPeak = rxPeakSamples = 0;
            stopRxMeasurement('The radio started transmitting');
          }
          if (fields[1] === 'false' || fields[1] === '0') {
            const hadKey = transmitting === true;
            transmitting = false;
            clearTimeout(releaseTimer);
            releaseTimer = null;
            // An idle status queued just before key-up is not an abort.
            if (hadKey) finishTx('Server released PTT', { alreadyReleased: true });
          }
          if (transmitting !== wasTransmitting) onTxState?.(transmitting);
        }
      }
    }
  });
  ws.on('error', (error) => log(`${address}: ${error.message}`));
  ws.on('close', () => {
    stopRxMeasurement('The TCI connection closed');
    finishTx('TCI socket disconnected', { lostSocket: true });
    if (releaseTimer) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
      recoverPtt();
    }
    log('RX stream disconnected');
    onLink?.(false);
  });
  const canStartTx = () => subscribed && ws.readyState === WebSocket.OPEN &&
    transmitting === false && !activeTx && !releaseTimer && !tuning;
  // Thetis reports VFO B independently, even while transmitting on VFO A.
  // Use its actual TX frequency and split status instead of treating B as TX.
  const matchingTxDial = () => !splitEnabled && (!thetis || splitEnabled === false) &&
    rxDial > 0 && (thetis ? explicitTxDial : (explicitTxDial || txDial)) === rxDial;
  return {
    get receiveDialHz() { return rxDial; },
    get transmitting() { return transmitting === true; },
    get connected() { return subscribed && ws.readyState === WebSocket.OPEN; },
    get busy() { return transmitting === true || !!activeTx || !!releaseTimer || tuning; },
    close() { finishTx('cancelled'); ws.close(); },
    stopTx() { finishTx('cancelled'); },
    startTx(samples, expectedDial, done) {
      if (!canStartTx()) {
        return 'Wait for Zeus to be connected and receiving';
      }
      if (rxDial !== expectedDial) {
        const expectedKhz = (expectedDial / 1000).toFixed(3);
        if (!rxDial) return `Waiting for the radio to confirm the ${expectedKhz} kHz dial`;
        return `Radio is on ${(rxDial / 1000).toFixed(3)} kHz. Select ${expectedKhz} kHz in FT8, or select the FT8 band that matches the radio.`;
      }
      if (!matchingTxDial()) return 'Turn split off and match the receive and transmit frequencies';
      if (!['USB', 'DIGU'].includes(radioMode)) return 'Select USB or DIGU on the radio';
      if (!(samples instanceof Float32Array) || !samples.length || samples.length > AUDIO_RATE * TX_MAX_SECONDS) {
        return 'Invalid TCI transmit buffer';
      }
      activeTx = { samples, offset: 0, peakWatts: 0, done };
      const durationMs = Math.ceil(samples.length * 1000 / AUDIO_RATE);
      activeTx.deadline = setTimeout(() => finishTx('TX deadline'), durationMs + TX_DEADLINE_GRACE_MS);
      activeTx.stall = setTimeout(() => finishTx('no TX_CHRONO received'), TX_STALL_MS);
      ws.send('trx:0,true,tci;');
      return '';
    },
    get voiceTxActive() { return !!activeTx?.voice; },
    startVoiceTx(checkPrivileges, timeoutMs, done) {
      if (!canStartTx()) return 'Wait for Zeus to be connected and receiving';
      if (!matchingTxDial() || !['USB', 'LSB'].includes(radioMode)) {
        return 'Select USB or LSB with split off before pressing PTT';
      }
      if (!checkPrivileges(radioMode, rxDial)) return 'Voice transmit is outside your license privileges';
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return 'Invalid PTT timeout';
      // A single bounded queue feeds Zeus on demand. Silence fills short
      // gaps in delivery, while a missing mic stream releases PTT.
      activeTx = { samples: new Float32Array(VOICE_BUFFER_SAMPLES), voice: { length: 0 }, offset: 0, peakWatts: 0, done };
      activeTx.deadline = setTimeout(() => finishTx('voice PTT timeout'), timeoutMs);
      activeTx.stall = setTimeout(() => finishTx('no TX_CHRONO received'), TX_STALL_MS);
      activeTx.micStall = setTimeout(() => finishTx('phone microphone audio stopped'), TX_STALL_MS);
      ws.send('trx:0,true,tci;');
      return '';
    },
    pushVoiceAudio(samples) {
      const voice = activeTx?.voice;
      if (!voice || !(samples instanceof Float32Array) || !samples.length) return;
      const queue = activeTx.samples;
      const pcm = samples.subarray(Math.max(0, samples.length - queue.length));
      // Drop the oldest samples on overflow to keep speech latency bounded.
      const drop = Math.max(0, voice.length + pcm.length - queue.length);
      queue.copyWithin(0, drop, voice.length);
      voice.length -= drop;
      queue.set(pcm, voice.length);
      voice.length += pcm.length;
      activeTx.micStall.refresh();
    },
    stopVoiceTx(reason = 'cancelled') {
      if (activeTx?.voice) finishTx(reason);
    },
    get noiseReductionLevel() { return zeusNrLevel; },
    setNoiseReduction(enabled) {
      if (!canStartTx()) return false;
      ws.send(`rx_nr_enable:0,${enabled};` + (thetis ? 'rx_nr_enable:0;' : ''));
      if (server === 'zeus') {
        zeusNrLevel = enabled ? 1 : 0;
        onNoiseReduction?.(enabled);
      }
      return true;
    },
    async cycleNoiseReduction() {
      if (server !== 'zeus' || cyclingNr || !canStartTx()) return false;
      cyclingNr = true;
      try {
        const engineLevel = await cycleZeusNrMode?.(canStartTx);
        if (!canStartTx()) return false;
        if (Number.isInteger(engineLevel)) {
          zeusNrLevel = engineLevel;
        } else {
          // The TCI extended command offers NR1, NR2 and NR4.
          const tciCycle = [0, 1, 2, 4];
          zeusNrLevel = tciCycle[(tciCycle.indexOf(zeusNrLevel) + 1) % tciCycle.length];
          const tciLevel = zeusNrLevel === 4 ? 3 : zeusNrLevel;
          ws.send(`rx_nr_enable_ex:0,${tciLevel !== 0},${tciLevel};`);
        }
        onNoiseReduction?.(zeusNrLevel !== 0);
        return true;
      } finally {
        cyclingNr = false;
      }
    },
    get rfGainAvailable() { return !thetis || (stepAttenuatorEnabled && attenuationDb !== null); },
    setRfGain(percent) {
      if (!this.rfGainAvailable || !canStartTx() || !Number.isFinite(percent) || percent < 0 || percent > 100) return false;
      const db = attenuationForGain(percent);
      ws.send(`${attenuationCommand}:0,${db};${attenuationCommand}:0;`);
      return true;
    },
    setDrive(percent) {
      if (!canStartTx() || !Number.isFinite(percent) || percent < 0 || percent > 100) return false;
      const drive = Math.round(percent * driveMaximum / 100);
      driveSetInSession = true;
      ws.send(`drive:0,${drive};drive:0;`);
      return true;
    },
    get noiseBlankerLevel() { return zeusNbLevel; },
    cycleNoiseBlanker(notify) {
      if (server !== 'zeus' || !canStartTx()) return false;
      const nextLevel = (zeusNbLevel + 1) % (zeusNb2Available ? 3 : 2);
      const command = zeusNbLevel === 2 || nextLevel === 2 ? 'rx_nb2_enable' : 'rx_nb_enable';
      pendingNbNotice = notify ? { command, expectedLevel: nextLevel, expiresAt: Date.now() + 2000, notify } : null;
      ws.send(`${command}:0,${nextLevel !== 0};${command}:0;`);
      return true;
    },
    setNoiseBlanker(enabled) {
      if (!canStartTx()) return false;
      pendingNbNotice = null;
      const command = server === 'zeus' && !enabled && zeusNbLevel === 2 ? 'rx_nb2_enable' : 'rx_nb_enable';
      ws.send(`${command}:0,${enabled};${command}:0;`);
      return true;
    },
    get agcMode() { return agcMode; },
    setAgcMode(value) {
      if (!subscribed || ws.readyState !== WebSocket.OPEN || transmitting !== false) return false;
      if (!TCI_AGC_MODES.has(value)) return false;
      ws.send(`agc_mode:0,${value};agc_mode:0;`);
      return true;
    },
    async autoRxLevel() {
      if (leveling) return { error: 'RX level measurement is already running' };
      if (!canStartTx()) return { error: 'Wait for the radio to return to receive' };
      if (rxVolume === null) return { error: 'Waiting for the radio to report its RX volume' };
      if (rxVolume === 0) return { error: 'Raise the RX slider above zero before measuring' };
      leveling = true;
      const initialVolume = rxVolume;
      const dial = rxDial;
      const mode = radioMode;
      const agc = agcMode;
      let initialGain = null;
      let adjustments = 0;
      let beforeAdjustment = null;
      const sameReceive = () => canStartTx() && rxDial === dial && radioMode === mode && agcMode === agc;
      try {
        for (;;) {
          if (!sameReceive()) return { error: 'Radio settings changed. Run Auto RX Level again.' };
          const measured = await measureRxPeak();
          if (measured.error) return measured;
          if (!(measured.peak > 0.0001)) return { error: 'No usable RX audio. Try while signals are visible.' };
          const peakDb = 20 * Math.log10(measured.peak);
          const correction = Math.min(12, RX_LEVEL_TARGET_DBFS - peakDb);
          const volumeBefore = rxVolume;
          let fixedGainBefore = null;
          if (agc === 'off') {
            if (thetis) fixedGainBefore = fixedGain;
            else if (server === 'zeus' && getZeusFixedGain) fixedGainBefore = await getZeusFixedGain();
          }
          if (!sameReceive() || rxVolume !== volumeBefore) {
            return { error: 'Radio settings changed. Run Auto RX Level again.' };
          }
          if (beforeAdjustment?.volume === volumeBefore && beforeAdjustment.gain === fixedGainBefore) {
            return { error: 'The radio did not confirm the RX level adjustment' };
          }
          if (adjustments === 0) initialGain = fixedGainBefore;
          const balanceFixedGain = Number.isFinite(fixedGainBefore);
          const inRange = Math.abs(RX_LEVEL_TARGET_DBFS - peakDb) < 2;
          const atPreferredVolume = Math.abs(volumeBefore - RX_LEVEL_PREFERRED_VOLUME) < 0.015;
          const levelOk = inRange && (!balanceFixedGain || atPreferredVolume);
          const result = {
            peakDb, clipped: measured.clipped, adjustments,
            volume: { from: Math.round(initialVolume * 100), to: Math.round(volumeBefore * 100) },
            fixedGain: balanceFixedGain ? { from: initialGain, to: fixedGainBefore } : null,
            fixedGainUnavailable: agc === 'off' && server === 'zeus' && !balanceFixedGain,
          };
          if (levelOk) return result;
          if (adjustments >= RX_LEVEL_MAX_ADJUSTMENTS) return { ...result, iterationLimit: true };

          let nextVolume = Math.min(1, volumeBefore * Math.pow(10, correction / 20));
          let nextGain = fixedGainBefore;
          if (balanceFixedGain) {
            const volumeDelta = 20 * Math.log10(RX_LEVEL_PREFERRED_VOLUME / volumeBefore);
            const preferredGain = fixedGainBefore + Math.round(correction - volumeDelta);
            nextGain = Math.max(-20, Math.min(80, fixedGainBefore + 12, preferredGain));
            nextVolume = nextGain === preferredGain ? RX_LEVEL_PREFERRED_VOLUME
              : Math.min(1, volumeBefore * Math.pow(10, (correction - (nextGain - fixedGainBefore)) / 20));
          }
          const volumeChanged = Math.abs(nextVolume - volumeBefore) > 0.005;
          const gainChanged = nextGain !== fixedGainBefore;
          if (!volumeChanged && !gainChanged) return { ...result, limited: !inRange };

          // Apply a gain reduction before an increase on the other control.
          const volumeCommand = volumeChanged ? volumeCommandFor(nextVolume) : '';
          const gainCommand = gainChanged ? `agc_gain:0,${nextGain};` : '';
          const commands = nextVolume > volumeBefore
            ? gainCommand + volumeCommand : volumeCommand + gainCommand;
          ws.send(commands + (gainChanged && thetis ? 'agc_gain:0;' : '') + (volumeChanged ? 'rx_volume:0,0;' : ''));
          beforeAdjustment = { volume: volumeBefore, gain: fixedGainBefore };
          adjustments++;
          // Let the server apply gain and send its volume/fixed-gain readback
          // before we use the next audio window to verify the result.
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      } catch (error) {
        return { error: error.message };
      } finally {
        leveling = false;
      }
    },
    setRxVolume(value) {
      if (!subscribed || ws.readyState !== WebSocket.OPEN) return false;
      if (!Number.isFinite(value) || value < 0 || value > 1) return false;
      ws.send(volumeCommandFor(value) + 'rx_volume:0,0;');
      return true;
    },
    async tune(hz, mode, useDataMode) {
      if (!subscribed || ws.readyState !== WebSocket.OPEN) return 'TCI is not connected';
      // Production may be transmitting through its other connection. Only
      // send a QSY after Zeus has reported RX; never queue one for later.
      if (transmitting !== false || activeTx || releaseTimer) return 'Wait for Zeus to return to receive';
      if (!Number.isSafeInteger(hz) || hz < 100000) return 'Invalid TCI frequency';
      const modulation = toZeusMode(mode, hz, useDataMode);
      if (mode && !modulation) return 'Unsupported TCI mode';
      if (tuning) return 'Wait for the current Zeus DSP change';
      tuning = true;
      try {
        const isReceiving = () => ws.readyState === WebSocket.OPEN && transmitting === false;
        if (modulation && setFt8Rx) await setFt8Rx(String(mode).trim().toUpperCase() === 'FT8', isReceiving);
        if (!isReceiving()) return 'Wait for Zeus to return to receive';
        ws.send(`vfo:0,0,${hz};${modulation ? `modulation:0,${modulation};` : ''}`);
        return '';
      } catch (error) {
        return `Zeus DSP change failed: ${error.message}`;
      } finally {
        tuning = false;
      }
    },
  };
}

module.exports = { connectTciJtcatRx, decodeRxFrame, probeTci, AUDIO_RATE };
