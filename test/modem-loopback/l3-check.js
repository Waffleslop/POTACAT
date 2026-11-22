#!/usr/bin/env node
'use strict';
// Layer L3 runner (docs/ardop-macos-plan.md, #187): record real ARDOP frames,
// then pass them through the real bridge window's capture and its playback,
// and require ardopcf to decode them both ways. Prints the sample rates
// Chromium chose. Needs ardopcf in assets/ and Electron (npm ci).
//   node test/modem-loopback/l3-check.js --out l3-results.json --logs l3-logs
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { rawEndpoint, crossConnect, floatToS16 } = require('./relay');
const { Ardop, binPath } = require('./ardop');

const ROOT = path.join(__dirname, '..', '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = opt('--out', path.join(os.tmpdir(), 'potacat-l3.json'));
const LOGS = path.resolve(opt('--logs', fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-l3-'))));
const required = process.env.LOOPBACK_REQUIRED === '1';
fs.mkdirSync(LOGS, { recursive: true });
let electron = null;
try { electron = require('electron'); } catch { electron = null; }
if (!fs.existsSync(binPath(ROOT)) || !electron || typeof electron !== 'string') {
  console.log(`L3: ${required ? 'FAIL' : 'SKIP'} (needs ardopcf in assets/ and Electron)`);
  process.exit(required ? 1 : 0);
}

function wav16(f32, rate) {
  const data = floatToS16(f32);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

(async () => {
  // 1. Record: ardopcf A calls W1BBB (nobody answers, so it repeats its ConReq);
  // a stand-in radio records exactly what it hears, silences included.
  const epA = await rawEndpoint(12000);
  const rec = [];
  const epR = { rate: 12000, connected: true, onTx() {}, feed(f) { rec.push(f); }, close: async () => {} };
  const relay = crossConnect(epA, epR);
  const A = new Ardop({ root: ROOT, name: 'A', call: 'W1AAA', hostPort: 18960, audioPort: epA.port, logDir: path.join(LOGS, 'record-A') });
  await A.start();
  A.send('PROTOCOLMODE ARQ'); A.send('ARQBW 2000MAX');
  await new Promise((r) => setTimeout(r, 600));
  A.send('ARQCALL W1BBB 5');
  await new Promise((r) => setTimeout(r, 22000));
  A.stop(); relay.stop(); await epA.close();
  const n = rec.reduce((a, c) => a + c.length, 0);
  const all = new Float32Array(n); let o = 0; for (const c of rec) { all.set(c, o); o += c.length; }
  let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(all[i]));
  const wavPath = path.join(LOGS, 'ardop-conreq-12k.wav');
  fs.writeFileSync(wavPath, wav16(all, 12000));
  console.log(`recorded ${(n / 12000).toFixed(1)} s of ARDOP calls at 12 kHz, peak ${peak.toFixed(2)}: ${wavPath}`);

  // 2. Capture side, 3. playback side: each in its own Electron run.
  const results = {};
  for (const phase of ['capture', 'playback']) {
    const out = path.join(LOGS, `l3-${phase}.json`);
    const res = spawnSync(electron, [path.join(__dirname, 'l3-harness.js'), '--no-sandbox', `--out=${out}`, `--phase=${phase}`, `--wav=${wavPath}`, `--logs=${LOGS}`, `--port=${phase === 'capture' ? 18900 : 18930}`], { encoding: 'utf8', timeout: 200000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } });
    const r = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { errors: ['no result: exit ' + res.status + ' ' + (res.stderr || '').slice(-1000)] };
    results[phase] = r;
    const ok = r.statuses && r.statuses.find((s) => s && s.ok);
    const d = r.bDecoded || {};
    console.log(`${phase}: Chromium capture ${ok && ok.sampleRate ? ok.sampleRate + ' Hz' : '-'}, playback ${ok && ok.playbackSampleRate ? ok.playbackSampleRate + ' Hz' : '-'}; ` +
      (phase === 'capture' ? `captured ${r.capturedSeconds} s at ${r.captureRate} Hz` : `played ${r.playedSeconds} s at ${r.playbackRate} Hz, peak ${r.playedPeak}`) +
      `; modem B decoded ${d.pass || 0} frame(s) ${JSON.stringify(d.types || {})}, ${d.fail || 0} failed${(r.errors || []).length ? '; ERRORS ' + r.errors.join(' / ').slice(0, 400) : ''}`);
  }
  fs.writeFileSync(OUT, JSON.stringify({ platform: process.platform, arch: process.arch, recordedSeconds: +(n / 12000).toFixed(1), results }, null, 1));
  const good = (r) => r && r.bDecoded && r.bDecoded.pass > 0 && !(r.errors || []).length;
  const pass = good(results.capture) && good(results.playback);
  console.log(pass ? 'L3: pass (ardopcf decoded real frames through the bridge capture and playback)' : 'L3: FAIL');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
