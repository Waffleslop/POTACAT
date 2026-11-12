#!/usr/bin/env node
'use strict';
// Layer L4 runner (docs/ardop-macos-plan.md, #187): the real bridge window,
// hidden, for --seconds, without and then with a power-save blocker. Prints
// the receive continuity and transmit figures and writes --out. CI-only on
// the Mac runners (needs Electron from npm ci); elsewhere it runs the same.
//   node test/modem-loopback/bridge-check.js --seconds 120 --out bridge.json
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SECONDS = Number(opt('--seconds', '120'));
const OUT = opt('--out', path.join(os.tmpdir(), 'potacat-bridge-check.json'));
let electron = null;
try { electron = require('electron'); } catch { electron = null; }
if (!electron || typeof electron !== 'string' || !fs.existsSync(electron)) {
  console.log('bridge check: SKIP (no Electron; run npm ci)');
  process.exit(process.env.LOOPBACK_REQUIRED === '1' ? 1 : 0);
}
// The bar, from the stress table (docs/ardop-macos-plan.md): packet fails from
// 5 ms of audio lost once a second and ARDOP connects poorly past 50 ms, so a
// hole of 20 ms is the most the capture may leave, and losses under 0.05% are
// within measuring noise (a 2-minute run is ~6 million samples).
const MAX_HOLE_MS = Number(process.env.L4_MAX_HOLE_MS || 20);
const MAX_LOST_PCT = Number(process.env.L4_MAX_LOST_PCT || 0.05);
function meets(r) {
  const rx = r.rx || {}, h = rx.holes || {}, tx = r.tx || {};
  return !(r.errors || []).length && h.maxGapMs != null && h.maxGapMs <= MAX_HOLE_MS && rx.lostPct <= MAX_LOST_PCT && tx.acks >= tx.chunksSent;
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-bridge-check-'));
const runs = [];
// before: the app as it was; fix: the session's power-save blocker (main.js
// winlinkHoldAwake); fix+: also no renderer backgrounding, to see if it adds anything.
const VARIANTS = [
  { name: 'before (no blocker)', blocker: false, nobg: false, required: false },
  { name: 'fix (session power-save blocker)', blocker: true, nobg: false, required: true },
  { name: 'fix + renderer not backgrounded', blocker: true, nobg: true, required: false },
];
for (const v of VARIANTS) {
  const blocker = v.blocker;
  const out = path.join(dir, `r-${v.blocker ? 'b' : 'n'}${v.nobg ? 'r' : ''}.json`);
  const args = [path.join(__dirname, 'bridge-harness.js'), '--no-sandbox', `--out=${out}`, `--seconds=${SECONDS}`];
  if (v.blocker) args.push('--blocker');
  if (v.nobg) args.push('--no-backgrounding');
  const res = spawnSync(electron, args, { encoding: 'utf8', timeout: (SECONDS + 90) * 1000, env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' } });
  const r = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : { blocker, errors: ['no result: exit ' + res.status + ' ' + (res.stderr || '').slice(-800)] };
  r.variant = v.name; r.required = v.required;
  runs.push(r);
  const rx = r.rx || {}, tx = r.tx || {};
  const h = rx.holes || {};
  console.log(`${v.name.padEnd(34)} RX ${rx.sampleRate} Hz: lost ${rx.lostPct}%, longest hole ${h.maxGapMs} ms (${h.gapsOverWarn} over 20 ms), largest arrival gap ${rx.maxGapMs} ms  |  TX: ${tx.chunksSent} chunks sent, ${tx.acks} acked, timer late up to ${tx.timerMaxLateMs} ms, overs ${JSON.stringify(tx.overs || [])}${(r.errors || []).length ? '  ERRORS ' + r.errors.join(' / ') : ''}`);
}
fs.writeFileSync(OUT, JSON.stringify({ platform: process.platform, arch: process.arch, seconds: SECONDS, runs }, null, 1));
// Pass, for the variant POTACAT now runs (the fix): see THRESHOLDS below.
const bad = runs.filter((r) => r.required && !meets(r));
console.log(bad.length ? `bridge check: FAIL (the fix variant: longest hole must be <= ${MAX_HOLE_MS} ms and loss <= ${MAX_LOST_PCT}%)` : `bridge check: pass (the fix variant within ${MAX_HOLE_MS} ms and ${MAX_LOST_PCT}%)`);
process.exit(bad.length ? 1 : 0);
