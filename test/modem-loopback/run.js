#!/usr/bin/env node
'use strict';
// Two modems, no radio (#187, docs/ardop-macos-plan.md, layers L1 and L2).
//
//   node test/modem-loopback/run.js                 L1 + L2, ARDOP and packet (the CI set)
//   node test/modem-loopback/run.js --modem ardop   one modem
//   node test/modem-loopback/run.js --stress        the tolerance matrix (long)
//   --out <file.json>  results;  --logs <dir>  modem logs
//
// Needs the built helpers in assets/ (ardopcf, direwolf). Without them it says
// SKIP and exits 0, unless LOOPBACK_REQUIRED=1 (CI), when it fails.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { rawEndpoint, serverEndpoint, crossConnect } = require('./relay');
const { runArdop, binPath: ardopBin } = require('./ardop');
const { runPacket, binPath: dwBin } = require('./packet');

const ROOT = path.join(__dirname, '..', '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);
const required = process.env.LOOPBACK_REQUIRED === '1';
const OUT = opt('--out', path.join(os.tmpdir(), 'potacat-loopback-results.json'));
const LOGS = opt('--logs', fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-loopback-')));
const only = opt('--modem', '');

const MODEM_RATE = { ardop: 12000, packet: 48000 };
let portBase = 18700 + Math.floor(Math.random() * 400) * 2;

async function once({ modem, layer, radioRate, bw, imp = {}, bytes, label }) {
  const rate = MODEM_RATE[modem];
  const mk = () => (layer === 'L1' ? rawEndpoint(rate) : serverEndpoint(ROOT, rate, radioRate));
  const [epA, epB] = await Promise.all([mk(), mk()]);
  const relay = crossConnect(epA, epB, { impAB: imp, impBA: imp });
  const logDir = path.join(LOGS, label.replace(/[^a-z0-9.-]+/gi, '_'));
  portBase += 40;
  let r;
  try {
    r = modem === 'ardop'
      ? await runArdop({ root: ROOT, epA, epB, hostPortBase: portBase, logDir, bw, bytes })
      : await runPacket({ root: ROOT, epA, epB, agwBase: portBase, logDir, bytes });
  } finally {
    relay.stop();
    r = Object.assign(r || {}, { relay: relay.stats() });
    if (epA.stats) r.serverA = epA.stats; if (epB.stats) r.serverB = epB.stats;
    await Promise.all([epA.close(), epB.close()]);
  }
  Object.assign(r, { label, layer, radioRate: layer === 'L2' ? radioRate : rate, imp, platform: process.platform, arch: process.arch });
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${label}${r.ok ? `  connect ${r.connectS}s, ${r.bytes} B each way in ${r.abS}s / ${r.baS}s` : `  ${r.error || 'data not intact'}`}`);
  return r;
}

function ciSet() {
  const s = [];
  if (!only || only === 'ardop') {
    for (const bw of [500, 2000]) s.push({ modem: 'ardop', layer: 'L1', bw, bytes: 2048, label: `ardop L1 ${bw} Hz` });
    for (const rr of [24000, 44100, 48000]) s.push({ modem: 'ardop', layer: 'L2', radioRate: rr, bw: 2000, bytes: 2048, label: `ardop L2 ${bw2(2000)} via server at ${rr}` });
  }
  if (!only || only === 'packet') {
    s.push({ modem: 'packet', layer: 'L1', bytes: 2048, label: 'packet L1 1200 bd' });
    for (const rr of [24000, 44100, 48000]) s.push({ modem: 'packet', layer: 'L2', radioRate: rr, bytes: 1024, label: `packet L2 via server at ${rr}` });
  }
  return s;
}
function bw2(b) { return `${b} Hz`; }

function stressSet() {
  const s = [];
  const m = only || 'ardop';
  const base = m === 'ardop' ? { modem: 'ardop', layer: 'L1', bw: 500, bytes: 512 } : { modem: 'packet', layer: 'L1', bytes: 512 };
  const add = (name, imp) => s.push({ ...base, imp, label: `${m} stress ${name}` });
  for (const g of [-10, -20, -30, -40]) add(`level ${g} dB`, { gainDb: g });
  for (const n of [-50, -40, -30, -25, -20]) add(`noise ${n} dBFS`, { noiseDbfs: n });
  for (const p of [50, 500, 5000]) add(`clock ${p} ppm`, { ppm: p });
  for (const d of [5, 20, 100]) add(`dropout ${d} ms/s`, { dropoutMs: d });
  for (const k of [50, 150, 300, 500]) add(`key delay ${k} ms`, { keyDelayMs: k });
  return s;
}

(async () => {
  const need = [];
  if (!only || only === 'ardop') need.push(ardopBin(ROOT));
  if (!only || only === 'packet') need.push(dwBin(ROOT));
  const missing = need.filter((p) => !fs.existsSync(p));
  if (missing.length) {
    console.log(`modem loopback: ${required ? 'FAIL' : 'SKIP'} (no helper at ${missing.join(', ')}; build them with scripts/build-winlink-helpers.sh)`);
    process.exit(required ? 1 : 0);
  }
  const set = has('--stress') ? stressSet() : ciSet();
  const results = [];
  for (const c of set) results.push(await once(c));
  const summary = { platform: process.platform, arch: process.arch, node: process.version, when: new Date().toISOString(), passed: results.filter((r) => r.ok).length, total: results.length };
  fs.writeFileSync(OUT, JSON.stringify({ summary, results }, null, 1));
  console.log(`\nmodem loopback (${process.platform}/${process.arch}): ${summary.passed} of ${summary.total} passed. Results: ${OUT}  Logs: ${LOGS}`);
  if (has('--stress')) {
    console.log('\nTolerance (pass = connected and every byte intact):');
    for (const r of results) console.log(`  ${r.ok ? 'pass' : 'FAIL'}  ${r.label}${r.ok ? `  (connect ${r.connectS}s, data ${r.abS}s)` : `  ${r.error || ''}`}`);
    process.exit(0);
  }
  process.exit(summary.passed === summary.total ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
