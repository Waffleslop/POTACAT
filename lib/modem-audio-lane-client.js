'use strict';
// Main's handle on the modem audio lane (lib/modem-audio-lane.js, #187). It
// stands where the ModemAudioServer used to stand in main (port, modemRate,
// connected, the meters, the recorder tap, feedRx) and adds the control
// messages: key, endOver, cancelEnd, txIn. Audio for the sound-card route
// never comes through here: attachBridge() hands each bridge worklet its own
// MessagePort to the lane.
//
// Events: modem-connected, modem-gone, tx-note {samples, peak, rate},
// tx-out (Float32Array, a route without a worklet port), tx-boost, tx-cut,
// prekey-sent {ms}, over-report, drained, rx-direct, tap {dir, buf}, log, exit.

const path = require('path');
const { EventEmitter } = require('events');

function meterView(get) {
  return { snapshot(rate) { const m = get() || {}; return { blocks: m.blocks || 0, seconds: rate ? Math.round((m.samples || 0) / rate) : 0, maxGapMs: Math.round(m.maxGapMs || 0), gapsOverWarn: m.gapsOverWarn || 0 }; } };
}

class ModemAudioLane extends EventEmitter {
  constructor({ modemRate = 12000, log, electron } = {}) {
    super();
    this._el = electron || require('electron');
    this._modemRate = modemRate;
    this._log = log || (() => {});
    this.port = 0;
    this.connected = false;
    this.txDirect = false;   // the play worklet has its port: transmit never passes main
    this.rxDirect = false;   // the capture worklet feeds the lane: receive never passes main
    this.last = {};          // the lane's latest stats
    const self = this;
    this.stats = { get rxDropped() { return (self.last && self.last.rxDropped) || 0; } };
    this.rxMeter = meterView(() => this.last.rxMeter);
    this.txMeter = meterView(() => this.last.txMeter);
    this._tap = null;
  }

  get modemRate() { return this._modemRate; }

  listen() {
    const { utilityProcess } = this._el;
    this.proc = utilityProcess.fork(path.join(__dirname, 'modem-audio-lane.js'), [], { serviceName: 'POTACAT modem audio', stdio: 'ignore' });
    this.proc.on('message', (m) => this._onMsg(m || {}));
    this.proc.on('exit', (code) => {
      const was = this.port;
      this.port = 0; this.connected = false; this.txDirect = false; this.rxDirect = false;
      if (was && !this._closing) this._log(`modem audio lane stopped (exit ${code})`);
      this.emit('exit', code);
    });
    this._post({ cmd: 'listen', modemRate: this._modemRate });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the modem audio lane did not start')), 10000);
      this.once('listening', (port) => { clearTimeout(t); resolve(port); });
    });
  }

  _post(msg, ports) { try { if (this.proc) this.proc.postMessage(msg, ports); } catch {} }

  _onMsg({ evt, data }) {
    switch (evt) {
      case 'listening': this.port = data.port; this.emit('listening', data.port); break;
      case 'modem-connected': this.connected = true; this.emit('modem-connected'); break;
      case 'modem-gone': this.connected = false; this.emit('modem-gone'); break;
      case 'stats': this.last = data; this.connected = !!data.connected; this.emit('stats', data); break;
      case 'tx-port-live': this.txDirect = true; break;
      case 'rx-direct': this.rxDirect = true; this.emit('rx-direct', data); break;
      case 'tap': if (this._tap && this._tap[data.dir]) { try { this._tap[data.dir](Buffer.from(data.buf)); } catch {} } break;
      case 'log': this._log(String(data)); break;
      default: this.emit(evt, data);
    }
  }

  /** Receive audio from a route the lane does not capture itself (Flex Direct, Icom Network). */
  feedRx(pcm, sampleRate) { this._post({ cmd: 'feed-rx', pcm, rate: sampleRate }); }
  /** Transmit audio main has already gated (VARA through the cable). */
  txIn(pcm) { this._post({ cmd: 'tx-in', pcm }); }
  key(on, opts = {}) { this._post({ cmd: 'key', on: !!on, seedGain: opts.seedGain, bridge: opts.bridge }); }
  endOver({ leaveMs = 0 } = {}) { this._post({ cmd: 'end-over', leaveMs }); }
  cancelEnd() { this._post({ cmd: 'cancel-end' }); }
  txLevelReset(seedGain) { this._post({ cmd: 'tx-level-reset', seedGain }); }
  resetMeters() { this.last = { ...this.last, rxMeter: null, txMeter: null, rxDropped: 0 }; this._post({ cmd: 'reset-meters' }); }

  set tap(t) { this._tap = t || null; this._post({ cmd: 'tap', on: !!t }); }
  get tap() { return this._tap; }

  /**
   * Give the bridge window's worklets their own ports to the lane: 'tx' for
   * the play worklet, 'rx' for the capture worklet. Called again whenever a
   * worklet is rebuilt (a port moves once, into one worklet).
   */
  attachBridge(webContents, { tx = true, rx = true } = {}) {
    const { MessageChannelMain } = this._el;
    if (!webContents || webContents.isDestroyed()) return;
    for (const kind of [tx && 'tx', rx && 'rx'].filter(Boolean)) {
      const { port1, port2 } = new MessageChannelMain();
      this._post({ cmd: `${kind}-port` }, [port1]);
      webContents.postMessage('modem-bridge-port', { kind }, [port2]);
      if (kind === 'tx') this.txDirect = false; // until the lane confirms it
    }
  }

  close() {
    this._closing = true;
    this._post({ cmd: 'close' });
    const p = this.proc;
    this.proc = null;
    return new Promise((resolve) => {
      if (!p) return resolve();
      const t = setTimeout(() => { try { p.kill(); } catch {} resolve(); }, 1500);
      p.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }
}

module.exports = { ModemAudioLane };
