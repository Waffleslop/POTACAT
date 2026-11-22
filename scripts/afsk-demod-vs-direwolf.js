#!/usr/bin/env node
'use strict';
// Dev tool, not in the test list: our AFSK demodulator (lib/afsk-demod.js)
// against the bundled Dire Wolf, on the same generated audio, frame for frame.
//
// It builds one 48 kHz stream per mode: tagged APRS frames, each with its own
// tuning offset and white-noise level (SNR in a 3 kHz bandwidth), separated by
// noise. Dire Wolf gets the stream as 16-bit PCM over its socket audio input
// with the receive-only config POTACAT writes (MODEM 1200, or MODEM 300
// 1600:1800 A- 7@30; no PTT), and is read back over its AGW monitor. Ours gets
// the same 16-bit samples as Float32. Nothing touches a radio or the network
// beyond 127.0.0.1. Dire Wolf is a reference only, never a source of code.
//
// Needs the POTACAT Dire Wolf build (assets/direwolf or POTACAT_DIREWOLF_BIN).
// Run: node scripts/afsk-demod-vs-direwolf.js [--frames 20] [--speed 4] [--mode 1200|300]

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const D = require('../lib/direwolf-process');
const Mon = require('../lib/direwolf-agw-monitor');
const AprsRfFrames = require('../lib/aprs-rf-frames');
const { createDemod } = require('../lib/afsk-demod');
const G = require('../test/afsk-gen');

const RATE = D.DIREWOLF_RATE; // 48000
const AMP = 0.05; // headroom for the noise at 0 dB SNR in 16 bits

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : def;
}
const FRAMES = Number(arg('frames', 20));
const SPEED = Number(arg('speed', 4));
const ONLY = arg('mode', '');

const PLANS = {
  1200: { band: '2m', conds: [['clean', 0, null], ['12 dB', 0, 12], ['10 dB', 0, 10], ['8 dB', 0, 8], ['7 dB', 0, 7], ['6 dB', 0, 6], ['5 dB', 0, 5]] },
  300: {
    band: '30m',
    conds: [
      ['+0 Hz', 0, null], ['+50 Hz', 50, null], ['-50 Hz', -50, null], ['+70 Hz', 70, null], ['-70 Hz', -70, null],
      ['+100 Hz', 100, null], ['-100 Hz', -100, null],
      ['6 dB', 0, 6], ['4 dB', 0, 4], ['3 dB', 0, 3], ['2 dB', 0, 2], ['1 dB', 0, 1], ['0 dB', 0, 0],
      ['70 Hz, 4 dB', 70, 4], ['70 Hz, 2 dB', 70, 2],
    ],
  },
};

function buildStream(mode, plan) {
  const chunks = [new Float32Array(RATE * 2)]; // 2 s of quiet first, while the decoders settle
  const want = [];
  let seed = 1;
  plan.conds.forEach(([label, shift, snr], c) => {
    for (let i = 0; i < FRAMES; i++) {
      const tag = `T${c}N${i}`;
      const tnc2 = `K3SBP-${(i % 15) + 1}>APRS,WIDE2-1:!3958.${String(i % 60).padStart(2, '0')}N/07510.47W-cmp ${tag} ${label}`;
      const a = G.afsk(G.bits(G.frame(tnc2)), { mode, rate: RATE, shiftHz: shift, amp: AMP, lead: 0.3, tail: 0.3 });
      if (snr != null) G.addNoise(a, { snrDb: snr, amp: AMP, rate: RATE, seed: seed++ });
      chunks.push(a);
      want.push({ tag, c });
    }
  });
  const f = G.join(chunks);
  const pcm = Buffer.alloc(f.length * 2);
  const back = new Float32Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767)));
    pcm.writeInt16LE(v, i * 2);
    back[i] = v / 32768;
  }
  return { pcm, float: back, want };
}

function ours(mode, float) {
  const d = createDemod({ sampleRate: RATE, mode });
  const tags = new Set();
  d.onFrame((fr) => { const m = / (T\d+N\d+) /.exec(fr.tnc2); if (m) tags.add(m[1]); });
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < float.length; i += 960) d.push(float.subarray(i, i + 960));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { tags, ms, seconds: float.length / RATE };
}

async function direwolf(bin, plan, pcm) {
  const chunk = RATE / 50 * 2; // 20 ms of 16-bit mono
  const queue = [];
  for (let i = 0; i < pcm.length; i += chunk) queue.push(pcm.subarray(i, i + chunk));
  const total = queue.length;
  let go = false; // the stream waits until the AGW monitor is listening
  const audio = net.createServer((s) => {
    let t0 = 0;
    let sent = 0;
    const t = setInterval(() => {
      if (!go) { try { s.write(Buffer.alloc(chunk)); } catch {} return; }
      if (!t0) t0 = Date.now();
      const due = Math.floor((Date.now() - t0) * SPEED / 20);
      while (sent < due) { sent++; try { s.write(queue.length ? queue.shift() : Buffer.alloc(chunk)); } catch {} }
    }, 10);
    s.on('data', () => {});
    s.on('close', () => clearInterval(t));
    s.on('error', () => clearInterval(t));
  });
  await new Promise((r) => audio.listen(0, '127.0.0.1', r));
  const agwPort = 18000 + Math.floor(Math.random() * 900);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-dw-cmp-'));
  fs.writeFileSync(path.join(dir, 'aprs.conf'), D.buildDirewolfAprsRxConfig({ mycall: 'N0CALL', audioPort: audio.address().port, agwPort, band: plan.band }));
  const p = spawn(bin, D.buildDirewolfArgs({ configName: 'aprs.conf' }), { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  const tags = new Set();
  let sock = null;
  try {
    const until = Date.now() + 15000;
    while (Date.now() < until && !(await D.probeAgwPort({ port: agwPort })).ok) await new Promise((r) => setTimeout(r, 200));
    sock = net.connect({ host: '127.0.0.1', port: agwPort });
    const parser = new Mon.AgwFrameParser();
    sock.on('data', (c) => {
      for (const f of parser.push(c)) {
        const h = AprsRfFrames.fromMonitorFrame(f);
        const m = h && / (T\d+N\d+) /.exec(h.line);
        if (m) tags.add(m[1]);
      }
    });
    await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j); });
    sock.write(Mon.encodeAgwFrame({ datakind: 'm' }));
    await new Promise((r) => setTimeout(r, 500));
    go = true;
    const end = Date.now() + (total * 20) / SPEED * 2 + 10000;
    while (Date.now() < end && queue.length) await new Promise((r) => setTimeout(r, 250));
    await new Promise((r) => setTimeout(r, 3000));
  } finally {
    if (sock) sock.destroy();
    p.kill();
    audio.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  return { tags, unsent: queue.length, log: out };
}

function bin() {
  if (process.env.POTACAT_DIREWOLF_BIN) return process.env.POTACAT_DIREWOLF_BIN;
  const p = path.join(__dirname, '..', 'assets', 'direwolf', D.direwolfBinaryName(process.platform));
  return fs.existsSync(p) ? p : '';
}

async function main() {
  const b = bin();
  for (const mode of ['1200', '300']) {
    if (ONLY && ONLY !== mode) continue;
    const plan = PLANS[mode];
    const s = buildStream(mode, plan);
    const o = ours(mode, s.float);
    const dw = b ? await direwolf(b, plan, s.pcm) : null;
    console.log(`\n${mode} baud, ${FRAMES} frames per row, 48 kHz, SNR in 3 kHz` + (dw ? `, Dire Wolf fed at ${SPEED}x` + (dw.unsent ? ` (${dw.unsent} chunks unsent)` : '') : ', no Dire Wolf build here'));
    console.log('condition        ours   Dire Wolf');
    plan.conds.forEach(([label], c) => {
      const tags = s.want.filter((w) => w.c === c).map((w) => w.tag);
      const n1 = tags.filter((t) => o.tags.has(t)).length;
      const n2 = dw ? tags.filter((t) => dw.tags.has(t)).length : '-';
      console.log(`${label.padEnd(16)} ${String(n1).padStart(3)}/${tags.length}  ${String(n2).padStart(3)}/${tags.length}`);
    });
    console.log(`ours: ${(o.ms / o.seconds).toFixed(1)} ms per second of 48 kHz audio`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
