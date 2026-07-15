// Phase 1 smoke test: enabling Mercury must (a) NOT crash startup, (b) write a
// correct mercury.ini (radio_model=-1 so it never keys the rig), and (c) attempt
// a spawn and degrade gracefully to a "not found / not running" status when no
// Mercury binary is installed — the exact state real users without Mercury hit.
// The live TNC connect/probe path is validated against a real binary in a later
// phase (loopback); here the binary is deliberately absent.
// Run: node scripts/shot-mercury-phase1.mjs
import { _electron as electron } from 'playwright-core';
import * as path from 'node:path';
import * as fs from 'node:fs';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const OUT = path.join(APP_DIR, 'test-output');
fs.mkdirSync(OUT, { recursive: true });
const bin = path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'electron.exe');

const UD = path.join(OUT, 'ud-mercury-phase1');
fs.rmSync(UD, { recursive: true, force: true });
fs.mkdirSync(UD, { recursive: true });
// enableMercury on, a deliberately bogus binary path so findMercury falls
// through to the bare name and spawn ENOENTs → graceful "not found".
fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify({
  remotePort: 7399, firstRun: false, grid: 'FN20jb', myCallsign: 'K3SBP',
  enablePota: false, enableRbn: false, enablePskrMap: false, watchlist: '',
  enableMercury: true,
  mercuryPath: path.join(UD, 'does-not-exist-mercury'),
  mercuryBasePort: 8300, mercuryTxGainDb: -3,
  // Phase 3: mercuryListen exercises the arbiter/onMercuryReady wiring at boot.
  mercuryListen: true, mercuryBw: 2300,
}, null, 2));

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
};

const app = await electron.launch({
  executablePath: bin,
  args: ['--no-sandbox', path.join(APP_DIR, 'scripts', 'mercury-phase1-entry.js')],
  cwd: APP_DIR,
  env: { ...process.env, POTACAT_TEST_UD: UD },
  timeout: 60_000,
});

let main = null;
for (let i = 0; i < 40 && !main; i++) {
  main = app.windows().find((w) => w.url().includes('index.html')) || null;
  if (!main) await new Promise((r) => setTimeout(r, 500));
}
check('app booted with a window (no startup crash from Mercury launch)', !!main);
if (main) {
  await main.waitForLoadState('domcontentloaded').catch(() => {});
}
// Let the spawn attempt + supervision settle.
await new Promise((r) => setTimeout(r, 4000));

// (b) mercury.ini written with the safety-critical defaults.
const iniPath = path.join(UD, 'mercury.ini');
const iniExists = fs.existsSync(iniPath);
check('mercury.ini generated in userData', iniExists);
if (iniExists) {
  const ini = fs.readFileSync(iniPath, 'utf8');
  check('ini pins radio_model=-1 (Mercury never keys the rig)', /radio_model = -1/.test(ini), ini.match(/radio_model.*/)?.[0]);
  check('ini disables the mercury UI', /ui_enabled = false/.test(ini));
  check('ini carries the configured base port', /arq_tcp_base_port = 8300/.test(ini));
  check('ini carries the configured tx gain', /tx_gain_db = -3\.0/.test(ini));
}

// (c) spawn attempt logged + graceful not-found status (via the session log).
const logCandidates = ['session.log', 'startup.log'].map((f) => path.join(UD, f)).filter((p) => fs.existsSync(p));
const logText = logCandidates.map((p) => fs.readFileSync(p, 'utf8')).join('\n');
check('spawn was attempted (logged the mercury spawn line)', /\[Mercury\] spawn:/.test(logText));
check('degraded gracefully to a not-found / not-running status', /\[Mercury\].*(not found|not running|ENOENT)/i.test(logText),
  (logText.match(/\[Mercury\][^\n]*/g) || []).slice(-3).join(' | '));

await app.close();
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
