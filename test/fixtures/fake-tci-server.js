// SPDX-License-Identifier: Apache-2.0
'use strict';

// A TCI server for tests: a real WebSocket on 127.0.0.1 speaking the text
// side of the protocol as Zeus or Thetis do (the published TCI 1.9 / 2.0
// commands, plus the dialect differences w5lee's station showed in #632).
//
// It records every text frame a client sends (`frames`), answers every read
// form (`name:0;`) from its state, and applies every write. Nothing it
// receives is trusted: a test asserts on `frames`.
//
// Dialects:
//   zeus   - protocol:Zeus; rx_smeter on channel 2; attenuator in dB
//   thetis - protocol:Thetis; device HERMESLITE (drive 0..90); squelch in dBm;
//            rx_step_att_ex behind rx_step_att_enabled_ex; VFO B reported apart

const { once } = require('node:events');
const { WebSocketServer } = require('ws');

function initialState(dialect) {
  return {
    trx: false, dial: 14074000, dialB: 14074000, modulation: 'USB',
    filter: [100, 2900], sqlEnable: false,
    sqlLevel: dialect === 'thetis' ? -140 : 0,
    agc: 'fast', drive: dialect === 'thetis' ? 45 : 50,
    nb: false, nr: false, att: 0, stepAttEnabled: true, split: false,
    running: true,
  };
}

async function startFakeTciServer({ dialect = 'zeus', running = true, greet = true } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const port = wss.address().port;
  const state = { ...initialState(dialect), running };
  const frames = [];
  const peers = new Set();
  let onFrame = null;

  const answer = {
    trx: () => `trx:0,${state.trx};`,
    vfo: (f) => (f[1] === '1' ? `vfo:0,1,${state.dialB};` : `vfo:0,0,${state.dial};`),
    modulation: () => `modulation:0,${state.modulation};`,
    rx_filter_band: () => `rx_filter_band:0,${state.filter[0]},${state.filter[1]};`,
    sql_enable: () => `sql_enable:0,${state.sqlEnable};`,
    sql_level: () => `sql_level:0,${state.sqlLevel};`,
    agc_mode: () => `agc_mode:0,${state.agc};`,
    drive: () => `drive:0,${state.drive};`,
    rx_nb_enable: () => `rx_nb_enable:0,${state.nb};`,
    rx_nr_enable: () => `rx_nr_enable:0,${state.nr};`,
    split_enable: () => `split_enable:0,${state.split};`,
    attenuator: () => (dialect === 'zeus' ? `attenuator:0,${state.att};` : ''),
    rx_step_att_ex: () => (dialect === 'thetis' ? `rx_step_att_ex:0,${state.att};` : ''),
    rx_step_att_enabled_ex: () => (dialect === 'thetis' ? `rx_step_att_enabled_ex:0,${state.stepAttEnabled};` : ''),
  };

  function apply(name, f) {
    switch (name) {
      case 'vfo': if (f[1] === '0') state.dial = Number(f[2]); else state.dialB = Number(f[2]); return `vfo:0,${f[1]},${f[2]};`;
      case 'modulation': state.modulation = f[1]; return `modulation:0,${f[1]};`;
      case 'rx_filter_band': state.filter = [Number(f[1]), Number(f[2])]; return '';
      case 'sql_enable': state.sqlEnable = f[1] === 'true'; return '';
      case 'sql_level': state.sqlLevel = Number(f[1]); return '';
      case 'agc_mode': state.agc = f[1]; return '';
      case 'drive': state.drive = Number(f[1]); return '';
      case 'rx_nb_enable': state.nb = f[1] === 'true'; return '';
      case 'rx_nr_enable': state.nr = f[1] === 'true'; return '';
      case 'attenuator': case 'rx_step_att_ex': state.att = Number(f[1]); return '';
      case 'trx': state.trx = f[1] === 'true'; return `trx:0,${state.trx};`;
      default: return '';
    }
  }

  wss.on('connection', (peer) => {
    peers.add(peer);
    peer.on('close', () => peers.delete(peer));
    peer.on('message', (data, binary) => {
      if (binary) return;
      const text = data.toString();
      frames.push(text);
      let reply = '';
      for (const raw of text.split(';')) {
        const cmd = raw.trim();
        if (!cmd) continue;
        const [name, args = ''] = cmd.split(':');
        const f = args === '' ? [] : args.split(',');
        if (name === 'start') { state.running = true; reply += 'start;'; continue; }
        const isRead = f.length === 1 || (name === 'vfo' && f.length === 2);
        reply += isRead ? (answer[name] ? answer[name](f) : '') : apply(name, f);
      }
      if (reply && peer.readyState === 1) peer.send(reply);
      if (onFrame) onFrame(text);
    });
    if (greet) {
      const hello = dialect === 'thetis'
        ? 'protocol:Thetis,2.0;device:HERMESLITE;receive_only:false;'
        : 'protocol:Zeus,1.9;device:HermesLite2;';
      peer.send(`${hello}${state.running ? 'start;' : 'stop;'}vfo:0,0,${state.dial};modulation:0,${state.modulation};trx:0,false;ready;`);
    }
  });

  return {
    port, dialect, state, frames,
    /** Push text (or a binary frame) to every connected client. */
    send(data) { for (const p of peers) if (p.readyState === 1) p.send(data); },
    /** Resolve on the next text frame a client sends. */
    nextFrame() { return new Promise((r) => { onFrame = (t) => { onFrame = null; r(t); }; }); },
    get clientCount() { return peers.size; },
    /** Drop every client without a close handshake (a half-dead link). */
    terminateClients() { for (const p of peers) p.terminate(); },
    async close() {
      for (const p of peers) p.terminate();
      await new Promise((r) => wss.close(r));
    },
  };
}

module.exports = { startFakeTciServer };
