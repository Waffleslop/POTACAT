'use strict';
// A fake SDRconnect WebSocket server for the tests (no SDRplay hardware or
// software). It speaks the message formats of SDRplay's published
// "SDRconnect WebSocket API 1.0.3": JSON text frames
// { event_type, property, value, device? } with string values, and binary
// frames of a 2-byte little-endian type then the payload. It answers
// get_property from its property table, applies set_property and pushes
// property_changed as SDRconnect does, records everything a client sends,
// and lets a test push spectrum and audio frames, drop the connection,
// flip can_control or answer slowly.

const { WebSocketServer } = require('ws');
const { EventEmitter } = require('events');

const DEFAULT_PROPS = {
  api_version: '1.0.3',
  valid_devices: 'nRSP-ST 2401AB0001,RSP1B 2305CD0002',
  active_device: 'nRSP-ST 2401AB0001',
  can_control: 'true',
  started: 'true',
  device_center_frequency: '7100000',
  device_vfo_frequency: '7100000',
  device_sample_rate: '2000000',
  lna_state: '3',
  lna_state_min: '0',
  lna_state_max: '9',
  demodulator: 'AM',
  filter_bandwidth: '6000',
  agc_enable: 'false',
  audio_volume_percent: '50',
  audio_mute: 'false',
  spectrum_ref_level: '-20',
  spectrum_base: '-120',
  signal_power: '-93.5',
};

class FakeSdrConnect extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.props = { ...DEFAULT_PROPS, ...(opts.props || {}) };
    this.answerGets = opts.answerGets !== false;
    this.getDelayMs = opts.getDelayMs || 0;
    this.received = [];   // every parsed text frame from a client
    this.streams = { spectrum: false, audio: false, iq: false, device: null };
    this.clients = new Set();
    this.connections = 0;
    this.wss = null;
    this.port = 0;
  }

  listen(port = 0) {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ host: '127.0.0.1', port });
      this.wss.on('listening', () => { this.port = this.wss.address().port; resolve(this.port); });
      this.wss.on('connection', (ws) => {
        this.connections++;
        this.clients.add(ws);
        ws.on('close', () => this.clients.delete(ws));
        ws.on('error', () => {});
        ws.on('message', (data, isBinary) => { if (!isBinary) this._onText(ws, data.toString()); });
        this.emit('connection', ws);
      });
    });
  }

  sets(prop) { return this.received.filter((m) => m.event_type === 'set_property' && (!prop || m.property === prop)); }
  events(type) { return this.received.filter((m) => m.event_type === type); }

  _send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch { /* gone */ } }

  _onText(ws, text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    this.received.push(m);
    this.emit('message', m);
    switch (m.event_type) {
      case 'get_property': {
        if (!this.answerGets) return;
        const answer = () => this._send(ws, { event_type: 'get_property_response', property: m.property, device: 'primary', value: this.props[m.property] == null ? '' : String(this.props[m.property]) });
        if (this.getDelayMs) setTimeout(answer, this.getDelayMs); else answer();
        return;
      }
      case 'set_property':
        // A client without control changes nothing (API: can_control).
        if (this.props.can_control !== 'true') return;
        this.pushProperty(m.property, m.value);
        return;
      case 'selected_device_name':
        this.pushProperty('active_device', m.value);
        return;
      case 'spectrum_enable': this.streams.spectrum = m.value === 'true'; return;
      case 'audio_stream_enable': this.streams.audio = m.value === 'true'; return;
      case 'iq_stream_enable': this.streams.iq = m.value === 'true'; return;
      case 'device_stream_enable':
        this.streams.device = m.value === 'true';
        this.pushProperty('started', m.value);
        return;
      default:
    }
  }

  pushProperty(prop, value) {
    this.props[prop] = String(value);
    for (const ws of this.clients) this._send(ws, { event_type: 'property_changed', property: prop, device: 'primary', value: String(value) });
  }

  _binary(type, payload) {
    const b = Buffer.alloc(2 + payload.length);
    b.writeUInt16LE(type, 0);
    payload.copy(b, 2);
    for (const ws of this.clients) { try { ws.send(b, { binary: true }); } catch { /* gone */ } }
  }

  /** Type 3: unsigned 8-bit spectrum bins. */
  pushSpectrum(u8) { this._binary(3, Buffer.from(u8)); }

  /** Type 1: signed 16-bit stereo LRLR at 48 kHz; `frames` of [L, R]. */
  pushAudio(frames) {
    const b = Buffer.alloc(frames.length * 4);
    frames.forEach(([l, r], i) => { b.writeInt16LE(l, 4 * i); b.writeInt16LE(r, 4 * i + 2); });
    this._binary(1, b);
  }

  pushRaw(buf) { for (const ws of this.clients) { try { ws.send(buf, { binary: true }); } catch { /* gone */ } } }

  /** Cut every client off without a close handshake (a crash, a cable pulled). */
  dropAll() { for (const ws of this.clients) { try { ws.terminate(); } catch { /* gone */ } } }

  close() {
    return new Promise((resolve) => {
      for (const ws of this.clients) { try { ws.terminate(); } catch { /* gone */ } }
      if (!this.wss) { resolve(); return; }
      this.wss.close(() => resolve());
    });
  }
}

module.exports = { FakeSdrConnect, DEFAULT_PROPS };
