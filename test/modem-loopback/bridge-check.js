#!/usr/bin/env node
'use strict';
// Layer L4 runner (docs/ardop-macos-plan.md, #187): the modem audio lane and
// the real bridge window, hidden, for --seconds of transmission inside one
// over, as POTACAT runs it and again with main frozen 200 ms every second.
//   node test/modem-loopback/bridge-check.js --seconds 120 --out bridge.json
//
// The bar:
//   transmit: no audio cut at all (neither the worklet nor the lane dropped a
//             sample), and the bridge reported the end of the over;
//   receive:  at most 0.05% of the samples the capture produced (render quanta
//             the audio thread skipped included) failed to reach the modem,
//             counted in samples at the modem's socket, not against a clock.
// Hole lengths, both ways, are reported and not judged.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SECONDS = Number(opt('--seconds', '120'));
const OUT = opt('--out', path.join(os.tmpdir(), 'potacat-bridge-check.json'));
const MAX_RX_LOSS_PCT = 0.05;
let electron = null;
try { electron = require('electron'); } catch { electron = null; }
if (!electron || typeof electron !== 'string' || !fs.existsSync(electron)) {
  console.log('bridge check: SKIP (no Electron; run npm ci)');
  process.exit(process.env.LOOPBACK_REQUIRED === '1' ? 1 : 0);
}
function failures(r) {
  const why = [];
  const tx = r.tx || {}, rx = r.rx || {};
  if ((r.errors || []).length) why.push('errors: ' + r.errors.join(' / ').slice(0, 300));
  if (!r.txDirect || !r.rxDirect) why.push(`the worklets did not get their lane ports (tx ${r.txDirect}, rx ${r.rxDirect})`);
  if (!tx.drained) why.push('the bridge never reported the end of the over');
  if ((tx.cutInWorkletMs || 0) > 0 || (tx.cutInLaneMs || 0) > 0 || (tx.laneStatsCutMs || 0) > 0) why.push(`transmit audio cut: ${tx.cutInWorkletMs} ms in the worklet, ${tx.cutInLaneMs} ms in the lane`);
  if (rx.lostPct == null || rx.lostPct > MAX_RX_LOSS_PCT) why.push(`receive loss ${rx.lostPct}% > ${MAX_RX_LOSS_PCT}%`);
  return why;
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-bridge-check-'));
const runs = [];
for (const v of [{ name: 'as POTACAT runs it', stall: false }, { name: 'main frozen 200 ms every second', stall: true }]) {
  const out = path.join(dir, `r-${v.stall ? 's' : 'n'}.json`);
  const args = [path.join(__dirname, 'bridge-harness.js'), '--no-sandbox', `--out=${out}`, `--seconds=${SECONDS}`];
  if (v.stall) args.push('--stall');
  const res = spawnSync(electron, args, { encoding: 'utf8', timeout: (SECONDS + 120) * 1000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } });
  const r = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { errors: ['no result: exit ' + res.status + ' ' + (res.stderr || '').slice(-800)] };
  r.variant = v.name;
  r.failures = failures(r);
  runs.push(r);
  const tx = r.tx || {}, rx = r.rx || {};
  console.log(`${v.name.padEnd(32)} TX: cut ${tx.cutInWorkletMs || 0} + ${tx.cutInLaneMs || 0} ms, holes ${tx.holes} (${tx.holeMs} ms), drained ${tx.drained} after ${tx.drainedAfterMs} ms | RX ${rx.captureRate} Hz: lost ${rx.lostPct}% (${rx.readByModem} of ${rx.expectedAtModem} samples; ${rx.skippedFrames} frames skipped, ${rx.droppedAtSocket} dropped at the socket), longest hole ${rx.longestHoleMs} ms (${rx.holesOver50ms} over 50 ms)${r.mainStalls ? ` | main frozen ${r.mainStalls} times` : ''}${r.failures.length ? '  FAIL: ' + r.failures.join('; ') : ''}`);
}
fs.writeFileSync(OUT, JSON.stringify({ platform: process.platform, arch: process.arch, seconds: SECONDS, maxRxLossPct: MAX_RX_LOSS_PCT, runs }, null, 1));
const bad = runs.filter((r) => r.failures.length);
console.log(bad.length ? `bridge check: FAIL (${bad.map((r) => r.variant).join(', ')})` : 'bridge check: pass (no transmit audio cut; receive loss within 0.05%)');
process.exit(bad.length ? 1 : 0);
