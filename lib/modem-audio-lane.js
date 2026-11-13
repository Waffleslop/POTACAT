'use strict';
// The modem audio lane (#187, docs/ardop-macos-plan.md): the modem's audio
// path, OFF the main process. It runs in its own Electron utility process and
// owns everything that touches the modem's samples:
//
//   modem socket (ModemAudioServer) ── transmit ──> pre-key hold (#289)
//        │                                        > transmit leveler
//        │                                        > the bridge window's play
//        │                                          worklet, straight to its
//        │                                          audio thread (a MessagePort)
//        └──── receive <── the capture worklet's audio thread (a MessagePort)
//
// Main keeps every decision about the RADIO (PTT, refusals, the shim, the
// over's log line) and sends the lane only control messages, so a main stall
// (a settings save, a GC, a spot burst) cannot cut or delay a transmission:
// on a Mac CI runner main's timers ran up to 177 ms late and the old path,
// main -> IPC -> page -> worklet, cut up to 1.9 s of every 2 minutes on air.
//
// Transmit to the worklet is credit-based: the worklet reports how much it
// holds and the last chunk it got, and the lane never sends more than its ring
// holds, so nothing is thrown away there. What cannot be held (the lane's own
// FIFO past FIFO_MAX_MS) is cut, counted and reported, never silent.
//
// Routes without a sound card (Flex Direct, Icom Network) and a bridge that has
// not attached its port get the leveled audio back in main ('tx-out'), the same
// pipeline on every platform.
//
// LaneCore is plain logic (testable without Electron); the bottom of this file
// is the utility-process entry.

const { PreKeyBuffer } = require('./modem-prekey');
const { TxLeveler } = require('./modem-rx-level');

const TX_RATE = 24000;            // what the lane hands on: the radio paths' rate
const RING_MS = 2000;             // the play worklet's ring (renderer/modem-play-worklet.js)
const FIFO_MAX_MS = 10000;        // the lane's own hold for a worklet that stopped reading
const PIECE = TX_RATE / 50;     // 20 ms: what the lane sends the worklet at a time
const LANE_DEFAULTS = Object.freeze({ ringMs: RING_MS, fifoMaxMs: FIFO_MAX_MS, txRate: TX_RATE });

function peakOf(pcm) {
  let p = 0;
  for (let i = 0; i < pcm.length; i++) { const a = pcm[i] < 0 ? -pcm[i] : pcm[i]; if (a > p) p = a; }
  return p;
}

class LaneCore {
  /**
   * @param {object} o
   * @param {(evt:string, data?:any)=>void} o.toMain   events to main
   * @param {(pcm:Float32Array, rate:number)=>void} [o.feedRx]  receive audio to the modem socket
   * @param {()=>number} [o.now]
   */
  constructor({ toMain, feedRx, ringMs = RING_MS, fifoMaxMs = FIFO_MAX_MS, now } = {}) {
    this.toMain = toMain || (() => {});
    this.feedRx = feedRx || (() => {});
    this.now = now || Date.now;
    this.ringCap = Math.round(TX_RATE * ringMs / 1000);
    this.fifoMax = Math.round(TX_RATE * fifoMaxMs / 1000);
    this.preKey = new PreKeyBuffer({ now: this.now });
    this.leveler = null;
    this.boostSaid = false;
    this.keyed = false;
    this.bridgeRoute = true;   // the radio's audio is the sound card (the bridge); false = Flex Direct / Icom Network
    this.txPort = null;        // the play worklet's lane port: { postMessage(msg) }
    this.fifo = [];            // queued for the worklet: Float32Array chunks and { end } markers
    this.fifoLen = 0;
    this.seq = 0;
    this.inflight = [];        // [{ seq, n }] sent, not yet confirmed by the worklet
    this.workletQueued = 0;    // samples the worklet last said it holds
    this.ending = false;       // an over-end marker is queued or with the worklet
    this.cutSamples = 0;       // transmit audio the lane had to drop (reported)
    this.rx = { frames: 0, skipped: 0, rate: 0, batches: 0 };
    this.rxDirectSaid = false;
  }

  /** The modem wrote transmit audio (24 kHz mono, from the socket). */
  modemTx(pcm) {
    if (!pcm || !pcm.length) return;
    if (!this.keyed) { this.preKey.hold(pcm, TX_RATE); return; } // beat its own PTT request: kept until key-down
    this._out(pcm, true);
  }

  /** Audio that is already gated by main (VARA through the virtual cable). */
  txIn(pcm) { if (pcm && pcm.length) this._out(pcm, false); }

  _out(pcm, fromModem) {
    if (!this.leveler) { this.leveler = new TxLeveler({ gain: this.seedGain >= 1 && this.seedGain <= 8 ? this.seedGain : 1 }); this.boostSaid = false; }
    if (fromModem) this.toMain('tx-note', { samples: pcm.length, peak: peakOf(pcm), rate: TX_RATE });
    const out = this.leveler.process(pcm, this.now());
    if (!this.boostSaid && this.leveler.gainDb >= 2) { this.boostSaid = true; this.toMain('tx-boost', this.txLevel()); }
    if (!this.txPort || !this.bridgeRoute) { this.toMain('tx-out', out); return; }
    this._enqueue(out);
  }

  txLevel() {
    const l = this.leveler;
    if (!l) return { gain: this.seedGain || 1, gainDb: 0, boostDb: 0, inDb: -90 };
    const v = typeof l.levels === 'function' ? l.levels() : {};
    return { gain: l.gain, gainDb: l.gainDb, boostDb: v.boostDb != null ? v.boostDb : Math.round(l.gainDb), inDb: v.inDb != null ? v.inDb : -90 };
  }

  /** Key-down (on) or the carrier dropped (off). */
  key(on, { seedGain, bridge } = {}) {
    if (seedGain != null) this.seedGain = Number(seedGain);
    if (bridge != null) this.bridgeRoute = !!bridge;
    if (on) {
      this.keyed = true;
      this.ending = false;
      this._send({ cmd: 'over-start' });
      const early = this.preKey.take();
      for (const c of early.chunks) this._out(c, true);
      if (early.ms) this.toMain('prekey-sent', { ms: early.ms });
      return;
    }
    // Off: whatever is still queued goes nowhere (the radio is unkeyed) — not a cut.
    this.keyed = false;
    this.preKey.clear();
    this.fifo = []; this.fifoLen = 0;
    this.inflight = [];
    this.ending = false;
    this._send({ cmd: 'over-end' });
    this._send({ cmd: 'reset' });
    this.workletQueued = 0;
  }

  /**
   * The modem asked for PTT off: let the worklet play out what it holds and
   * report 'drained' (leaveMs before the very end, for packet's TXTAIL).
   * Without a worklet port the caller keeps its own drain timer.
   */
  endOver({ leaveMs = 0 } = {}) {
    if (!this.txPort || !this.bridgeRoute) return false;
    this.ending = true;
    this.fifo.push({ end: true, leave: Math.max(0, Math.round(TX_RATE * leaveMs / 1000)) });
    this._pump();
    return true;
  }

  /** Re-keyed inside the drain hold: the over goes on. */
  cancelEnd() {
    const i = this.fifo.findIndex((c) => c && c.end);
    if (i >= 0) this.fifo.splice(i, 1);
    else this._send({ cmd: 'cancel-end' });
    this.ending = false;
  }

  setTxPort(port) {
    this.txPort = port || null;
    this.inflight = []; this.workletQueued = 0;
    if (this.txPort) this._pump();
  }

  /** A message from the play worklet. */
  onWorklet(d) {
    if (!d) return;
    if (d.cap > 0) this.ringCap = d.cap;
    if (d.q != null) {
      this.workletQueued = d.q;
      if (d.seq != null) { while (this.inflight.length && this.inflight[0].seq <= d.seq) this.inflight.shift(); }
      this._pump();
    }
    if (d.over) this.toMain('over-report', d.over);
    if (d.drained) { this.ending = false; this.toMain('drained', { over: d.over || null }); }
  }

  /** A batch from the capture worklet: straight to the modem. */
  onCapture(d) {
    if (!d || !d.pcm) return;
    const pcm = d.pcm instanceof Float32Array ? d.pcm : new Float32Array(d.pcm);
    this.rx.frames += pcm.length;
    this.rx.skipped += Number(d.skipped) || 0;
    this.rx.rate = Number(d.sampleRate) || this.rx.rate;
    this.rx.batches++;
    if (!this.rxDirectSaid) { this.rxDirectSaid = true; this.toMain('rx-direct', { rate: this.rx.rate }); }
    this.feedRx(pcm, this.rx.rate);
  }

  _space() {
    let inflight = 0;
    for (const c of this.inflight) inflight += c.n;
    return this.ringCap - this.workletQueued - inflight;
  }

  _enqueue(pcm) {
    // In 20 ms pieces: credit is counted in whole pieces, and none can be bigger than the ring.
    for (let o = 0; o < pcm.length; o += PIECE) { const c = pcm.subarray(o, o + PIECE); this.fifo.push(c); this.fifoLen += c.length; }
    this._pump(); // the worklet takes what it has room for before anything is judged too much
    // The worklet stopped reading for FIFO_MAX_MS: drop the oldest audio — counted, never silent.
    while (this.fifoLen > this.fifoMax) {
      const i = this.fifo.findIndex((c) => c instanceof Float32Array);
      if (i < 0) break;
      const c = this.fifo.splice(i, 1)[0];
      this.fifoLen -= c.length;
      this.cutSamples += c.length;
      this.toMain('tx-cut', { ms: Math.round(c.length * 1000 / TX_RATE), totalMs: Math.round(this.cutSamples * 1000 / TX_RATE) });
    }
    this._pump();
  }

  _pump() {
    if (!this.txPort) return;
    while (this.fifo.length) {
      const h = this.fifo[0];
      if (!(h instanceof Float32Array)) {
        this.fifo.shift();
        this._send({ cmd: 'over-end', drain: true, leave: h.leave });
        continue;
      }
      if (h.length > this._space()) break;
      this.fifo.shift(); this.fifoLen -= h.length;
      const seq = ++this.seq;
      this.inflight.push({ seq, n: h.length });
      this._send({ pcm: h, seq });
    }
  }

  _send(msg) {
    if (!this.txPort) return;
    try { this.txPort.postMessage(msg); } catch {}
  }

  stats() {
    return { rx: { ...this.rx }, txCutMs: Math.round(this.cutSamples * 1000 / TX_RATE), fifoMs: Math.round(this.fifoLen * 1000 / TX_RATE), workletQueuedMs: Math.round(this.workletQueued * 1000 / TX_RATE), txLevel: this.txLevel() };
  }

  resetCounters() {
    this.cutSamples = 0;
    this.rx = { frames: 0, skipped: 0, rate: this.rx.rate, batches: 0 };
  }
}

module.exports = { LaneCore, LANE_DEFAULTS, TX_RATE };

// ── the utility process ──────────────────────────────────────────────────────
if (process.parentPort) {
  const path = require('path');
  const { ModemAudioServer } = require(path.join(__dirname, 'modem-audio-server.js'));
  const { StreamingResampler } = require(path.join(__dirname, 'mercury-audio-bridge.js'));
  const parent = process.parentPort;
  const toMain = (evt, data) => { try { parent.postMessage({ evt, data }); } catch {} };
  let srv = null;
  const core = new LaneCore({ toMain, feedRx: (pcm, rate) => { if (srv && srv.connected) srv.feedRx(pcm, rate); } });
  let rxPort = null;
  const meterRaw = (m) => ({ blocks: m.blocks, samples: m.samples, maxGapMs: m.maxGapMs, gapsOverWarn: m.gapsOverWarn });
  const pushStats = () => {
    if (!srv) return;
    toMain('stats', { connected: srv.connected, rxMeter: meterRaw(srv.rxMeter), txMeter: meterRaw(srv.txMeter), rxDropped: srv.stats.rxDropped, socketRxSamples: srv.rxMeter.samples, ...core.stats() });
  };
  setInterval(pushStats, 250);
  parent.on('message', async (e) => {
    const m = e.data || {};
    try {
      switch (m.cmd) {
        case 'listen': {
          srv = new ModemAudioServer({ makeResampler: (a, b) => new StreamingResampler(a, b), txOutRate: TX_RATE, modemRate: m.modemRate, log: (s) => toMain('log', s) });
          srv.on('modem-connected', () => toMain('modem-connected'));
          srv.on('modem-gone', () => toMain('modem-gone'));
          srv.on('tx', (pcm) => core.modemTx(pcm));
          const port = await srv.listen(0);
          toMain('listening', { port });
          break;
        }
        case 'feed-rx': if (srv && srv.connected && m.pcm) srv.feedRx(m.pcm instanceof Float32Array ? m.pcm : new Float32Array(m.pcm), m.rate); break;
        case 'tx-in': core.txIn(m.pcm instanceof Float32Array ? m.pcm : new Float32Array(m.pcm)); break;
        case 'key': core.key(!!m.on, { seedGain: m.seedGain, bridge: m.bridge }); if (srv) srv.overBoundary(); break;
        case 'end-over': { const ok = core.endOver({ leaveMs: m.leaveMs }); if (!ok) toMain('drained', { over: null, noPort: true }); break; }
        case 'cancel-end': core.cancelEnd(); break;
        case 'tx-level-reset': core.leveler = null; core.seedGain = m.seedGain; break;
        case 'reset-meters': if (srv) { srv.resetMeters(); } core.resetCounters(); pushStats(); break;
        case 'stats': pushStats(); break;
        case 'tap': if (srv) srv.tap = m.on ? { rx: (b) => toMain('tap', { dir: 'rx', buf: Buffer.from(b) }), tx: (b) => toMain('tap', { dir: 'tx', buf: Buffer.from(b) }) } : null; break;
        case 'tx-port': {
          const p = e.ports && e.ports[0];
          if (!p) break;
          p.on('message', (ev) => core.onWorklet(ev.data));
          p.on('close', () => { if (core.txPort && core.txPort._p === p) core.setTxPort(null); });
          p.start();
          core.setTxPort({ _p: p, postMessage: (msg) => p.postMessage(msg) });
          toMain('tx-port-live');
          break;
        }
        case 'rx-port': {
          const p = e.ports && e.ports[0];
          if (!p) break;
          if (rxPort) { try { rxPort.close(); } catch {} }
          rxPort = p;
          p.on('message', (ev) => core.onCapture(ev.data));
          p.start();
          break;
        }
        case 'close':
          if (srv) await srv.close();
          process.exit(0);
          break;
        default: break;
      }
    } catch (err) { toMain('log', `modem audio lane: ${m.cmd}: ${err && err.message}`); }
  });
}
