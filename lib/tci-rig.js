// SPDX-License-Identifier: Apache-2.0
'use strict';

// A radio driven through a TCI server (Zeus, Thetis): one WebSocket that
// carries rig control as `name:args;` text commands. Based on PR #632 by
// w5lee, tested on Zeus with a Hermes-Lite 2.
//
// Receive and control only. This module never keys the radio: send()
// drops any frame that would (`trx:<rx>,true`, `tune:<rx>,true`), so no
// path through it can transmit. trx:0; (no value) is the READ form.
//
// Everything is on receiver 0 (RX1) and its main VFO (channel 0).
//
// Dialects (the published TCI protocol, plus what w5lee's station showed):
//   - Thetis says `protocol:Thetis,...` (it may also call itself ExpertSDR3);
//     its attenuator is rx_step_att_ex behind rx_step_att_enabled_ex, its
//     squelch level is dBm (-140..0), and it reports VFO B on its own.
//   - Zeus answers rx_smeter on channel 0 or 2 (its WDSP RX1 channel).

const WebSocket = require('ws');
const TciTarget = require('./tci-target');
const { ssbSideband } = require('./ssb-sideband');

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
 * @param {object} [o.on]  callbacks: link(up), dial(hz), mode(potacatMode, tciMode),
 *   smeter(dbm), filter(widthHz), squelch(percent), agc(mode), nb(on), nr(on),
 *   rfGain(percent|null), tx(transmitting), drive(percent)
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
    if (thetis) reads += 'rx_sensors_enable:true,250;rx_step_att_enabled_ex:0;';
    reads += `${attCommand()}:0;`;
    send(reads);
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
      case 'tx_frequency': case 'tx_frequency_ex': {
        const hz = Number(f0);
        st.txFrequency = Number.isSafeInteger(hz) && hz >= 100000 ? hz : 0;
        return;
      }
      default:
    }
    if (f0 !== '0') return; // receiver 0 only
    switch (name) {
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
        on.drive?.(Math.min(100, Math.round(v * 100 / st.driveMax)));
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

  ws.on('message', (frame, binary) => {
    if (binary) return; // audio and IQ streams are not requested on this link
    for (const cmd of parseCommands(frame.toString())) handle(cmd);
  });
  ws.on('error', (err) => log(`${address}: ${err.message}`));
  ws.on('close', () => {
    const wasReady = st.ready;
    st.ready = false;
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

    /** Move RX1's VFO A, and the mode when one is given. '' or the reason it did not. */
    tune(hz, mode, { dataMode = true } = {}) {
      if (!this.connected) return 'The TCI server is not connected';
      if (st.transmitting !== false) return 'Wait for the radio to return to receive';
      if (!Number.isSafeInteger(hz) || hz < 100000) return 'Invalid TCI frequency';
      const mod = toTciMode(mode, hz, dataMode);
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
    close() {
      try { ws.close(); } catch { /* already closed */ }
    },
  };
}

module.exports = {
  connectTciRig, probeTci, parseCommands, toTciMode, fromTciMode,
  attenuationForGain, gainForAttenuation, KEYING,
};
