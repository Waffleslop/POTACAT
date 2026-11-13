'use strict';
// Two modems, no radio: a real-time relay that plays each modem's transmit
// audio into the other's receive, the way two radios on one frequency would
// (#187, docs/ardop-macos-plan.md). The relay is the clock: every 10 ms it
// writes exactly the samples that are due to each side, the other side's
// transmit audio when there is some and silence (plus any noise) when not, so
// each modem sees an unbroken stream like a sound card's.
//
// Endpoints are either raw modem sockets at the modem's own rate (layer L1)
// or POTACAT's real ModemAudioServer at a "radio" rate (layer L2). Both expose
// onTx(cb(Float32Array)) and feed(Float32Array).
//
// Impairments, each per direction, for the stress run:
//   gainDb      level change
//   noiseDbfs   white noise, always on (RMS in dBFS); null = none
//   ppm         sample-clock error (the receiving side's clock runs fast by ppm)
//   dropoutMs   that many ms of silence once a second
//   keyDelayMs  the first ms of every transmission lost (a radio keying late)

const net = require('net');

function dbToLin(db) { return Math.pow(10, db / 20); }

function s16ToFloat(buf) {
  const n = buf.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}
function floatToS16(f32) {
  const b = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    let v = Math.round(f32[i] * 32767);
    if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
    b.writeInt16LE(v, i * 2);
  }
  return b;
}

/** A raw socket server a modem connects to with `tcp:<port>` (layer L1). */
async function rawEndpoint(rate) {
  const ep = { rate, sock: null, connected: false, _cb: null, _carry: Buffer.alloc(0), connectedAt: 0 };
  const server = net.createServer((sock) => {
    if (ep.sock) { try { ep.sock.destroy(); } catch {} }
    ep.sock = sock; ep.connected = true; ep.connectedAt = Date.now();
    sock.setNoDelay(true);
    sock.on('data', (chunk) => {
      const buf = ep._carry.length ? Buffer.concat([ep._carry, chunk]) : chunk;
      const even = buf.length & ~1;
      ep._carry = buf.subarray(even);
      if (even && ep._cb) ep._cb(s16ToFloat(buf.subarray(0, even)));
    });
    sock.on('error', () => {});
    sock.on('close', () => { if (ep.sock === sock) { ep.sock = null; ep.connected = false; } });
  });
  ep.port = await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', () => res(server.address().port)); });
  ep.onTx = (cb) => { ep._cb = cb; };
  ep.feed = (f32) => { if (ep.sock && !ep.sock.destroyed) ep.sock.write(floatToS16(f32)); };
  ep.close = () => new Promise((r) => { try { if (ep.sock) ep.sock.destroy(); } catch {} server.close(() => r()); });
  return ep;
}

/** POTACAT's real ModemAudioServer, crossed at `radioRate` (layer L2). */
async function serverEndpoint(root, modemRate, radioRate) {
  const { ModemAudioServer } = require(require('path').join(root, 'lib', 'modem-audio-server.js'));
  const { StreamingResampler } = require(require('path').join(root, 'lib', 'mercury-audio-bridge.js'));
  const srv = new ModemAudioServer({ makeResampler: (a, b) => new StreamingResampler(a, b), txOutRate: radioRate, modemRate });
  const port = await srv.listen(0);
  const ep = { rate: radioRate, port, connectedAt: 0, get connected() { return srv.connected; } };
  srv.on('modem-connected', () => { ep.connectedAt = Date.now(); });
  ep.onTx = (cb) => srv.on('tx', (f32) => cb(f32));
  ep.feed = (f32) => srv.feedRx(f32, radioRate);
  ep.close = () => srv.close();
  ep.stats = srv.stats;
  return ep;
}

class Direction {
  constructor(rate, imp = {}) {
    this.rate = rate;
    this.imp = imp;
    this.q = [];            // queued transmit chunks (Float32Array)
    this.qLen = 0;
    this.lastTxAt = 0;      // when transmit audio last arrived
    this.dropLeft = 0;      // samples of the current transmission still to drop (key delay)
    this.phase = 0;         // fractional read position for the clock error
    this.sent = 0;          // samples written so far
    this.txSamples = 0;     // transmit samples received
    this.maxGapMs = 0;      // the longest stretch without transmit audio mid-transmission
  }
  push(f32) {
    const now = Date.now();
    // A new transmission: no transmit audio for 250 ms. ardopcf writes its
    // audio in chunks up to ~100 ms apart within one frame, so a shorter
    // pause is the same transmission (key delay would otherwise cut every chunk).
    if (now - this.lastTxAt > 250) {
      this.dropLeft = Math.round((this.imp.keyDelayMs || 0) * this.rate / 1000);
    } else {
      const gap = now - this.lastTxAt;
      if (gap > this.maxGapMs) this.maxGapMs = gap;
    }
    this.lastTxAt = now;
    this.txSamples += f32.length;
    let a = f32;
    if (this.dropLeft > 0) {
      const d = Math.min(this.dropLeft, a.length);
      this.dropLeft -= d;
      a = a.subarray(d);
    }
    if (a.length) { this.q.push(a); this.qLen += a.length; }
  }
  _take(n) {
    const out = new Float32Array(n);
    let o = 0;
    while (o < n && this.q.length) {
      const h = this.q[0];
      const k = Math.min(n - o, h.length);
      out.set(h.subarray(0, k), o);
      o += k;
      if (k === h.length) this.q.shift(); else this.q[0] = h.subarray(k);
      this.qLen -= k;
    }
    return out;
  }
  /** The next n samples for the receiving side, impairments applied. */
  next(n) {
    const ppm = this.imp.ppm || 0;
    let out;
    if (ppm) {
      // The receiver's clock is fast by ppm: it takes n samples that span n*(1+ppm) of the sender's.
      const step = 1 + ppm / 1e6;
      const need = Math.floor(this.phase + n * step) + 2;
      const src = this._peek(need);
      out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const x = this.phase + i * step;
        const j = Math.floor(x), f = x - j;
        out[i] = (src[j] || 0) * (1 - f) + (src[j + 1] || 0) * f;
      }
      const consumed = Math.floor(this.phase + n * step);
      this.phase = this.phase + n * step - consumed;
      this._take(consumed);
    } else {
      out = this._take(n);
    }
    const g = this.imp.gainDb ? dbToLin(this.imp.gainDb) : 1;
    if (g !== 1) for (let i = 0; i < n; i++) out[i] *= g;
    if (this.imp.noiseDbfs != null) {
      const rms = dbToLin(this.imp.noiseDbfs);
      for (let i = 0; i < n; i++) {
        // Gaussian (Box-Muller), RMS = rms
        const u = Math.random() || 1e-12, v = Math.random();
        out[i] += rms * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      }
    }
    if (this.imp.dropoutMs) {
      const per = this.rate, drop = Math.round(this.imp.dropoutMs * this.rate / 1000);
      for (let i = 0; i < n; i++) if (((this.sent + i) % per) < drop) out[i] = 0;
    }
    this.sent += n;
    return out;
  }
  _peek(n) {
    const out = new Float32Array(n);
    let o = 0;
    for (const h of this.q) {
      const k = Math.min(n - o, h.length);
      out.set(h.subarray(0, k), o);
      o += k;
      if (o >= n) break;
    }
    return out;
  }
}

/**
 * Cross two endpoints in real time. Returns { stop(), stats() }.
 * impAB: impairments on A's transmit heard by B; impBA the other way.
 */
function crossConnect(a, b, { impAB = {}, impBA = {}, tickMs = 10 } = {}) {
  if (a.rate !== b.rate) throw new Error('both ends of the relay run at one rate');
  const rate = a.rate;
  const ab = new Direction(rate, impAB), ba = new Direction(rate, impBA);
  a.onTx((f) => ab.push(f));
  b.onTx((f) => ba.push(f));
  const t0 = process.hrtime.bigint();
  let due = 0, maxLateMs = 0, lastTick = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const late = now - lastTick - tickMs;
    if (late > maxLateMs) maxLateMs = late;
    lastTick = now;
    const elapsed = Number(process.hrtime.bigint() - t0) / 1e9;
    const target = Math.floor(elapsed * rate);
    const n = target - due;
    if (n <= 0) return;
    due = target;
    if (b.connected) b.feed(ab.next(n)); else ab.next(n);
    if (a.connected) a.feed(ba.next(n)); else ba.next(n);
  }, tickMs);
  return {
    stop() { clearInterval(timer); },
    stats() {
      return {
        rate, relayMaxLateMs: maxLateMs,
        aTxSeconds: +(ab.txSamples / rate).toFixed(1), bTxSeconds: +(ba.txSamples / rate).toFixed(1),
        aTxMaxGapMs: ab.maxGapMs, bTxMaxGapMs: ba.maxGapMs,
      };
    },
  };
}

module.exports = { rawEndpoint, serverEndpoint, crossConnect, s16ToFloat, floatToS16 };
