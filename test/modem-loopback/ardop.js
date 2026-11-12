'use strict';
// One ardopcf instance on socket audio, driven over its host ports the way
// Pat drives it: commands on <port> (CR-terminated text), data on <port>+1
// (host to modem: 2-byte big-endian length + bytes; modem to host: 2-byte
// length + 3-byte tag "ARQ"/"FEC"/"IDF"/"ERR" + bytes). Verified against
// pflarue/ardop 1.0.4.1.3 src/common/TCPHostInterface.c.

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

function binPath(root) {
  const exe = process.platform === 'win32' ? 'ardopcf.exe' : 'ardopcf';
  return path.join(root, 'assets', 'ardopcf', exe);
}

function connectRetry(port, untilMs) {
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => resolve(s));
      s.once('error', () => { s.destroy(); if (Date.now() > untilMs) reject(new Error(`port ${port} never opened`)); else setTimeout(tryOnce, 150); });
    };
    tryOnce();
  });
}

class Ardop extends EventEmitter {
  constructor({ root, name, call, hostPort, audioPort, logDir, bw = 500 }) {
    super();
    Object.assign(this, { root, name, call, hostPort, audioPort, logDir, bw });
    this.lines = [];          // command-port lines received
    this.rx = Buffer.alloc(0);// ARQ data received
    this.state = '';
    this.connectedAt = 0;
    this.out = '';
  }
  async start() {
    fs.mkdirSync(this.logDir, { recursive: true });
    const ArdopProcess = require(path.join(this.root, 'lib', 'ardop-process.js'));
    const args = ArdopProcess.buildArdopArgs({ port: this.hostPort, capture: `tcp:${this.audioPort}`, playback: `tcp:${this.audioPort}`, logDir: this.logDir, driveLevel: 90, mycall: this.call });
    this.t0 = Date.now();
    this.proc = spawn(binPath(this.root), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const keep = (d) => { this.out += d; if (this.out.length > 200000) this.out = this.out.slice(-100000); };
    this.proc.stdout.on('data', keep);
    this.proc.stderr.on('data', keep);
    this.proc.on('exit', (code, sig) => { this.exited = { code, sig }; this.emit('exit', code, sig); });
    this.cmd = await connectRetry(this.hostPort, Date.now() + 10000);
    this.data = await connectRetry(this.hostPort + 1, Date.now() + 5000);
    let carry = '';
    this.cmd.on('data', (d) => {
      carry += d.toString('latin1');
      let i;
      while ((i = carry.indexOf('\r')) >= 0) {
        const line = carry.slice(0, i).trim();
        carry = carry.slice(i + 1);
        if (!line) continue;
        this.lines.push(`${Date.now() - this.t0} ${line}`);
        if (/^NEWSTATE /.test(line)) this.state = line.slice(9).trim();
        if (/^CONNECTED /.test(line)) { this.connectedAt = Date.now(); this.emit('connected', line); }
        if (/^DISCONNECTED/.test(line)) this.emit('disconnected');
        this.emit('line', line);
      }
    });
    let dcarry = Buffer.alloc(0);
    this.data.on('data', (d) => {
      dcarry = Buffer.concat([dcarry, d]);
      while (dcarry.length >= 2) {
        const len = dcarry.readUInt16BE(0);
        if (dcarry.length < 2 + len) break;
        const tag = dcarry.subarray(2, 5).toString('latin1');
        const body = dcarry.subarray(5, 2 + len);
        dcarry = dcarry.subarray(2 + len);
        if (tag === 'ARQ') { this.rx = Buffer.concat([this.rx, body]); this.emit('data', body); }
      }
    });
    this.cmd.on('error', () => {}); this.data.on('error', () => {});
  }
  send(line) { this.cmd.write(line + '\r'); }
  sendData(buf) {
    for (let o = 0; o < buf.length; o += 256) {
      const part = buf.subarray(o, o + 256);
      const h = Buffer.alloc(2); h.writeUInt16BE(part.length, 0);
      this.data.write(Buffer.concat([h, part]));
    }
  }
  waitFor(re, ms) {
    return new Promise((resolve, reject) => {
      const hit = this.lines.find((l) => re.test(l.replace(/^\d+ /, '')));
      if (hit) return resolve(hit);
      const t = setTimeout(() => { this.off('line', on); reject(new Error(`${this.name}: no ${re} within ${ms} ms`)); }, ms);
      const on = (l) => { if (re.test(l)) { clearTimeout(t); this.off('line', on); resolve(l); } };
      this.on('line', on);
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
    try { this.cmd && this.cmd.destroy(); } catch {}
    try { this.data && this.data.destroy(); } catch {}
    try { this.proc && !this.exited && this.proc.kill(); } catch {}
  }
}

/** A connects to B, sends `bytes`, B sends `bytes` back, A disconnects. */
async function runArdop({ root, epA, epB, hostPortBase, logDir, bw = 500, bytes = 2048, timeoutMs = 240000 }) {
  const A = new Ardop({ root, name: 'A', call: 'W1AAA', hostPort: hostPortBase, audioPort: epA.port, logDir: path.join(logDir, 'A'), bw });
  const B = new Ardop({ root, name: 'B', call: 'W1BBB', hostPort: hostPortBase + 10, audioPort: epB.port, logDir: path.join(logDir, 'B'), bw });
  const res = { modem: 'ardop', bw, bytes, ok: false, steps: [] };
  const step = (s) => res.steps.push(`${((Date.now() - res.t0) / 1000).toFixed(1)}s ${s}`);
  res.t0 = Date.now();
  const payloadA = Buffer.from(Array.from({ length: bytes }, (_, i) => (i * 7 + 13) & 0xff));
  const payloadB = Buffer.from(Array.from({ length: bytes }, (_, i) => (i * 11 + 5) & 0xff));
  try {
    await Promise.all([A.start(), B.start()]);
    step('both modems up');
    for (const m of [A, B]) { m.send('PROTOCOLMODE ARQ'); m.send(`ARQBW ${bw}MAX`); }
    B.send('LISTEN TRUE');
    A.send('LISTEN FALSE');
    await new Promise((r) => setTimeout(r, 500));
    const tCall = Date.now();
    A.send('ARQCALL W1BBB 10');
    await Promise.all([A.waitFor(/^CONNECTED /, timeoutMs / 3), B.waitFor(/^CONNECTED /, timeoutMs / 3)]);
    res.connectS = +((Date.now() - tCall) / 1000).toFixed(1);
    res.connectedLine = (A.lines.find((l) => / CONNECTED /.test(l)) || '').replace(/^\d+ /, '');
    step(`connected (${res.connectedLine})`);
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
    A.send('DISCONNECT');
    await Promise.all([A.waitFor(/^DISCONNECTED/, 30000), B.waitFor(/^DISCONNECTED/, 30000)]).catch((e) => { res.disconnectError = e.message; });
    step('disconnected');
    res.ok = !!(res.abIntact && res.baIntact);
  } catch (e) {
    res.error = e.message;
  } finally {
    res.seconds = +((Date.now() - res.t0) / 1000).toFixed(1);
    res.aLines = A.lines.slice(-40); res.bLines = B.lines.slice(-40);
    res.aOut = A.out.slice(-3000); res.bOut = B.out.slice(-3000);
    res.aExit = A.exited || null; res.bExit = B.exited || null;
    A.stop(); B.stop();
    await new Promise((r) => setTimeout(r, 400));
  }
  return res;
}

module.exports = { runArdop, binPath };
