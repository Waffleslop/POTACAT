'use strict';
// One Dire Wolf on socket audio (ADEVICE tcp:<port>, ARATE 48000), driven over
// its AGW port the way Pat drives it: register a callsign ('X'), connect
// ('C'), connected data ('D'), disconnect ('d'). AGW frame = 36-byte header
// (port u32 LE, kind byte, reserved, PID byte, reserved, from[10], to[10],
// data length u32 LE, user u32) + data.
//
// No PTT line: with no radio, Dire Wolf transmits straight into the socket.

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

function binPath(root) {
  return path.join(root, 'assets', 'direwolf', process.platform === 'win32' ? 'direwolf.exe' : 'direwolf');
}

function agwFrame(kind, from = '', to = '', data = Buffer.alloc(0), pid = 0) {
  const h = Buffer.alloc(36);
  h.writeUInt32LE(0, 0);
  h.write(kind, 4, 'latin1');
  h.writeUInt8(pid, 6);
  h.write(from.padEnd(10, '\0').slice(0, 10), 8, 'latin1');
  h.write(to.padEnd(10, '\0').slice(0, 10), 18, 'latin1');
  h.writeUInt32LE(data.length, 28);
  return Buffer.concat([h, data]);
}

function connectRetry(port, untilMs) {
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => resolve(s));
      s.once('error', () => { s.destroy(); if (Date.now() > untilMs) reject(new Error(`AGW port ${port} never opened`)); else setTimeout(tryOnce, 200); });
    };
    tryOnce();
  });
}

class Wolf extends EventEmitter {
  constructor({ root, name, call, agwPort, audioPort, dir, txDelayMs = 300 }) {
    super();
    Object.assign(this, { root, name, call, agwPort, audioPort, dir, txDelayMs });
    this.rx = Buffer.alloc(0);
    this.events = [];
    this.out = '';
  }
  async start() {
    fs.mkdirSync(this.dir, { recursive: true });
    const conf = [
      `ADEVICE tcp:${this.audioPort}`, 'ARATE 48000', 'ACHANNELS 1', 'CHANNEL 0',
      `MYCALL ${this.call}`, 'MODEM 1200', `TXDELAY ${Math.round(this.txDelayMs / 10)}`, 'TXTAIL 20',
      `AGWPORT ${this.agwPort}`, 'KISSPORT 0', '',
    ].join('\n');
    fs.writeFileSync(path.join(this.dir, 'direwolf.conf'), conf);
    this.t0 = Date.now();
    this.proc = spawn(binPath(this.root), ['-c', 'direwolf.conf', '-t', '0'], { cwd: this.dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const keep = (d) => { this.out += d; if (this.out.length > 200000) this.out = this.out.slice(-100000); };
    this.proc.stdout.on('data', keep); this.proc.stderr.on('data', keep);
    this.proc.on('exit', (code, sig) => { this.exited = { code, sig }; });
    this.sock = await connectRetry(this.agwPort, Date.now() + 15000);
    this.sock.on('error', () => {});
    let carry = Buffer.alloc(0);
    this.sock.on('data', (d) => {
      carry = Buffer.concat([carry, d]);
      while (carry.length >= 36) {
        const len = carry.readUInt32LE(28);
        if (carry.length < 36 + len) break;
        const kind = String.fromCharCode(carry[4]);
        const body = carry.subarray(36, 36 + len);
        carry = carry.subarray(36 + len);
        const text = body.toString('latin1').replace(/\0+$/, '').trim();
        if (kind === 'D') { this.rx = Buffer.concat([this.rx, body]); this.emit('data'); }
        else this.events.push(`${Date.now() - this.t0} ${kind} ${text.slice(0, 80)}`);
        if (kind === 'C') { this.connectedAt = Date.now(); this.emit('connected', text); }
        if (kind === 'd') this.emit('disconnected', text);
      }
    });
    this.sock.write(agwFrame('X', this.call));
  }
  connect(to) { this.peer = to; this.sock.write(agwFrame('C', this.call, to)); }
  sendData(buf) {
    for (let o = 0; o < buf.length; o += 128) this.sock.write(agwFrame('D', this.call, this.peer, buf.subarray(o, o + 128), 0xf0));
  }
  disconnect() { this.sock.write(agwFrame('d', this.call, this.peer)); }
  once2(ev, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.off(ev, on); reject(new Error(`${this.name}: no ${ev} within ${ms} ms`)); }, ms);
      const on = (x) => { clearTimeout(t); resolve(x); };
      this.once(ev, on);
    });
  }
  waitBytes(n, ms) {
    return new Promise((resolve, reject) => {
      if (this.rx.length >= n) return resolve();
      const t = setTimeout(() => { this.off('data', on); reject(new Error(`${this.name}: ${this.rx.length} of ${n} bytes after ${ms} ms`)); }, ms);
      const on = () => { if (this.rx.length >= n) { clearTimeout(t); this.off('data', on); resolve(); } };
      this.on('data', on);
    });
  }
  stop() {
    try { this.sock && this.sock.destroy(); } catch {}
    try { this.proc && !this.exited && this.proc.kill(); } catch {}
  }
}

async function runPacket({ root, epA, epB, agwBase, logDir, bytes = 2048, txDelayMs = 300, timeoutMs = 240000 }) {
  const A = new Wolf({ root, name: 'A', call: 'W1AAA', agwPort: agwBase, audioPort: epA.port, dir: path.join(logDir, 'A'), txDelayMs });
  const B = new Wolf({ root, name: 'B', call: 'W1BBB', agwPort: agwBase + 10, audioPort: epB.port, dir: path.join(logDir, 'B'), txDelayMs });
  const res = { modem: 'packet', baud: 1200, bytes, ok: false, steps: [] };
  res.t0 = Date.now();
  const step = (s) => res.steps.push(`${((Date.now() - res.t0) / 1000).toFixed(1)}s ${s}`);
  const payloadA = Buffer.from(Array.from({ length: bytes }, (_, i) => (i * 7 + 13) & 0xff));
  const payloadB = Buffer.from(Array.from({ length: bytes }, (_, i) => (i * 11 + 5) & 0xff));
  try {
    await Promise.all([A.start(), B.start()]);
    step('both modems up');
    await new Promise((r) => setTimeout(r, 1500));
    const tCall = Date.now();
    B.peer = 'W1AAA';
    A.connect('W1BBB');
    await Promise.all([A.once2('connected', timeoutMs / 4), B.once2('connected', timeoutMs / 4)]);
    res.connectS = +((Date.now() - tCall) / 1000).toFixed(1);
    step('connected');
    let t = Date.now();
    A.sendData(payloadA);
    await B.waitBytes(bytes, timeoutMs / 3);
    res.abS = +((Date.now() - t) / 1000).toFixed(1);
    step(`A to B ${bytes} bytes`);
    t = Date.now();
    B.sendData(payloadB);
    await A.waitBytes(bytes, timeoutMs / 3);
    res.baS = +((Date.now() - t) / 1000).toFixed(1);
    step(`B to A ${bytes} bytes`);
    res.abIntact = B.rx.subarray(0, bytes).equals(payloadA);
    res.baIntact = A.rx.subarray(0, bytes).equals(payloadB);
    A.disconnect();
    await Promise.all([A.once2('disconnected', 30000), B.once2('disconnected', 30000)]).catch((e) => { res.disconnectError = e.message; });
    step('disconnected');
    res.ok = !!(res.abIntact && res.baIntact);
  } catch (e) {
    res.error = e.message;
  } finally {
    res.seconds = +((Date.now() - res.t0) / 1000).toFixed(1);
    res.aEvents = A.events.slice(-30); res.bEvents = B.events.slice(-30);
    res.aOut = A.out.slice(-3000); res.bOut = B.out.slice(-3000);
    res.aExit = A.exited || null; res.bExit = B.exited || null;
    A.stop(); B.stop();
    await new Promise((r) => setTimeout(r, 400));
  }
  return res;
}

module.exports = { runPacket, binPath, Wolf };
