#!/usr/bin/env node
'use strict';
/**
 * TEMPORARY release-build check for PR #124 (FreeDV / RADE on Linux).
 * Not part of the app. Run by .github/workflows/freedv-build-check.yml.
 *
 *   node check-addons.js <root>
 *
 * <root> is the folder that holds lib/ : the repo checkout, or a packaged
 * app's resources/app.asar (run then with ELECTRON_RUN_AS_NODE=1 and the
 * packaged Electron binary, so the addons load the way the app loads them).
 *
 * 1. freedv_native: require, then a 700E / 700D / 1600 loopback (tx -> rx) must sync and give speech back.
 * 2. rade_native:   require, then a RADE loopback must sync, decode speech and report end-of-over.
 *                   Prints the CPU time per second of received audio.
 * 3. FreedvEngine (the app's worker path) in RADE and 700E: ready, then speech out at the codec's rate.
 * 4. Without the addons beside it, the worker reports an error and stays alive.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const lib = path.join(root, 'lib');
console.log(`root: ${root}`);
console.log(`node ${process.version} electron ${process.versions.electron || '-'} ${process.platform}/${process.arch}`);

let fail = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  (' + detail + ')' : ''}`);
  if (!ok) fail++;
}

function speechLike(rate, seconds) {
  const out = new Int16Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const f0 = 120 + 30 * Math.sin(2 * Math.PI * 0.7 * t);
    let s = 0;
    for (let h = 1; h <= 12; h++) s += Math.sin(2 * Math.PI * f0 * h * t) / h;
    out[i] = Math.round(4000 * s * (0.55 + 0.45 * Math.sin(2 * Math.PI * 3.5 * t)));
  }
  return out;
}

function concat(parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Int16Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// tx `seconds` of speech through a codec handle, then 1 s of silence.
function modulate(codec, h, info, seconds) {
  const speech = speechLike(info.speechRate, seconds);
  const parts = [];
  for (let f = 0; f + info.nSpeech <= speech.length; f += info.nSpeech) {
    parts.push(codec.tx(h, speech.slice(f, f + info.nSpeech)));
  }
  if (codec.txEoo) parts.push(codec.txEoo(h));
  parts.push(new Int16Array(info.modemRate));
  return concat(parts);
}

function demodulate(codec, h, info, modem) {
  let pos = 0, synced = 0, frames = 0, out = 0, firstSync = -1, eoo = false;
  const t0 = process.cpuUsage();
  while (pos + codec.getNin(h) <= modem.length) {
    const nin = codec.getNin(h);
    const r = codec.rx(h, modem.slice(pos, pos + nin));
    pos += nin; frames++;
    if (r.sync) { synced++; if (firstSync < 0) firstSync = pos / info.modemRate; }
    if (r.eoo) eoo = true;
    out += r.speech.length;
  }
  const cpu = process.cpuUsage(t0);
  return { frames, synced, firstSync, eoo, decodedSeconds: out / info.speechRate,
    cpuMs: (cpu.user + cpu.system) / 1000, audioSeconds: modem.length / info.modemRate };
}

async function main() {
  // --- 1. freedv_native ---
  console.log('\n[1] freedv_native');
  let freedv = null;
  try {
    freedv = require(path.join(lib, 'freedv_native', 'build', 'Release', 'freedv_native.node'));
    check('freedv_native loads', true);
  } catch (e) { check('freedv_native loads', false, e.message); }
  if (freedv) {
    for (const m of ['MODE_700E', 'MODE_700D', 'MODE_1600']) {
      try {
        const h = freedv.open(freedv[m]);
        const info = freedv.getInfo(h);
        const r = demodulate(freedv, h, info, modulate(freedv, h, info, 8));
        freedv.close(h);
        check(`${m} loopback syncs and decodes`, r.synced > 0 && r.decodedSeconds > 3,
          `speechRate ${info.speechRate}, first sync ${r.firstSync.toFixed(2)} s, ${r.decodedSeconds.toFixed(2)} s speech of 8, ${r.synced}/${r.frames} frames in sync, cpu ${r.cpuMs.toFixed(0)} ms for ${r.audioSeconds.toFixed(1)} s`);
      } catch (e) { check(`${m} loopback`, false, e.message); }
    }
  }

  // --- 2. rade_native ---
  console.log('\n[2] rade_native');
  let rade = null, radeModem = null;
  try {
    rade = require(path.join(lib, 'rade_native', 'build', 'Release', 'rade_native.node'));
    check('rade_native loads', true);
  } catch (e) { check('rade_native loads', false, e.message); }
  if (rade) {
    try {
      const h = rade.open();
      const info = rade.getInfo(h);
      radeModem = modulate(rade, h, info, 10);
      const r = demodulate(rade, h, info, radeModem);
      rade.close(h);
      check('RADE loopback syncs within 1 s', r.firstSync >= 0 && r.firstSync < 1, `first sync ${r.firstSync.toFixed(2)} s`);
      check('RADE decodes (nearly) all speech', r.decodedSeconds > 0.85 * (10 - r.firstSync) && r.decodedSeconds < 10.5,
        `${r.decodedSeconds.toFixed(2)} s speech of 10 at ${info.speechRate} Hz`);
      check('RADE end-of-over received without a crash', r.eoo);
      console.log(`  RADE rx cpu: ${r.cpuMs.toFixed(0)} ms for ${r.audioSeconds.toFixed(1)} s of modem audio = ${(100 * r.cpuMs / 1000 / r.audioSeconds).toFixed(1)}% of one core (${os.cpus()[0] && os.cpus()[0].model})`);
    } catch (e) { check('RADE loopback', false, e.stack || e.message); }
  }

  // --- 3. FreedvEngine, the app's worker path ---
  console.log('\n[3] FreedvEngine worker path');
  const { FreedvEngine } = require(path.join(lib, 'freedv-engine.js'));
  async function engineRun(mode, modem, expectRate) {
    const eng = new FreedvEngine();
    let samples = 0, rate = 0, err = null;
    eng.on('rx-speech', (d) => { samples += d.samples.length; rate = d.rate; });
    eng.on('error', (d) => { err = d.message; });
    const ready = new Promise((res) => eng.on('status', (s) => { if (s.state === 'running') res(s.info); }));
    eng.start(mode);
    eng.setSquelch(false, 0);
    const info = await Promise.race([ready, new Promise((r) => setTimeout(() => r(null), 15000))]);
    if (!info) { eng.stop(); check(`engine ${mode} ready`, false, err || 'timeout'); return; }
    check(`engine ${mode} ready`, true, `speechRate ${info.speechRate}`);
    if (modem) {
      const step = 1600;
      for (let i = 0; i < modem.length; i += step) eng.feedRxAudio(modem.slice(i, i + step));
      await new Promise((r) => setTimeout(r, 8000));
      check(`engine ${mode} gives speech at ${expectRate} Hz`, samples > 0 && rate === expectRate,
        `${(samples / (rate || 1)).toFixed(2)} s at ${rate} Hz${err ? ', error ' + err : ''}`);
    }
    eng.stop();
  }
  await engineRun('RADE', radeModem, 16000);
  let m700 = null;
  if (freedv) {
    const h = freedv.open(freedv.MODE_700E);
    m700 = modulate(freedv, h, freedv.getInfo(h), 6);
    freedv.close(h);
  }
  await engineRun('700E', m700, 8000);

  // --- 4. no addons: the worker reports and carries on ---
  console.log('\n[4] worker without addons');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fdvchk-'));
  fs.writeFileSync(path.join(tmp, 'freedv-worker.js'), fs.readFileSync(path.join(lib, 'freedv-worker.js')));
  const w = new Worker(path.join(tmp, 'freedv-worker.js'));
  const msgs = [];
  let exited = null;
  w.on('message', (m) => msgs.push(m));
  w.on('error', (e) => msgs.push({ type: 'worker-error', message: e.message }));
  w.on('exit', (c) => { exited = c; });
  w.postMessage({ type: 'init', mode: 'RADE' });
  w.postMessage({ type: 'init', mode: '700E' });
  w.postMessage({ type: 'stop' });
  await new Promise((r) => setTimeout(r, 2000));
  const errs = msgs.filter((m) => m.type === 'error').map((m) => m.message);
  check('missing rade_native -> error message', errs.some((m) => /rade_native/.test(m)), errs[0]);
  check('missing freedv_native -> error message', errs.some((m) => /freedv_native/.test(m)), errs[1]);
  check('worker still alive afterwards', exited === null);
  await w.terminate();

  console.log(`\n${fail ? 'FAILED: ' + fail : 'ALL OK'}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
