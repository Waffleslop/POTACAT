#!/usr/bin/env node
'use strict';
// The ARDOP link timeout, proven on the built helpers with no radio (#425).
//
// POTACAT's build of Pat (third_party/pat/potacat-arq-timeout.patch) reads
// POTACAT_ARDOP_ARQ_TIMEOUT when it opens the ARDOP modem. This runs the real
// Pat against the real ardopcf, with a recording relay on the modem's host
// port, and checks for each value of the variable:
//   - what Pat sent the modem (every ARQTIMEOUT command, in order),
//   - what the modem answered,
//   - what the modem's own debug log says it was given, read the way POTACAT
//     reads it for the session summary (lib/winlink-diag.js).
// Unset must be exactly upstream (one ARQTIMEOUT 90). A value outside 30..240
// or not a whole number must leave the modem at 90.
//
// The modem's audio is a loopback socket nobody listens to: nothing is
// transmitted, no rig is configured, and Pat is stopped as soon as it starts
// its call (to N0CALL-10), which is after it has finished setting the modem up.
//
//   node test/modem-loopback/pat-arq-timeout.js [--out file.json] [--logs dir]
//
// Needs assets/pat and assets/ardopcf (scripts/build-winlink-helpers.sh).
// Without them it says SKIP and exits 0, unless LOOPBACK_REQUIRED=1 (CI).

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { rawEndpoint } = require('./relay');
const { binPath: ardopBin } = require('./ardop');
const { patTestEnv } = require('./pat-env');

const ROOT = path.join(__dirname, '..', '..');
const WinlinkPat = require(path.join(ROOT, 'lib', 'winlink-pat.js'));
const WinlinkDiag = require(path.join(ROOT, 'lib', 'winlink-diag.js'));
const ArdopProcess = require(path.join(ROOT, 'lib', 'ardop-process.js'));

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const required = process.env.LOOPBACK_REQUIRED === '1';
const OUT = opt('--out', path.join(os.tmpdir(), 'potacat-pat-arq-timeout-results.json'));
const LOGS = opt('--logs', fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-pat-arq-')));
const ENV = WinlinkPat.ARDOP_ARQ_TIMEOUT.env;
const patBin = path.join(ROOT, 'assets', 'pat', WinlinkPat.patBinaryName(process.platform));

// `env`: undefined = the variable is not in Pat's environment at all; a string
// = exactly that; { setting } = what POTACAT's own spawn code makes of that
// saved setting (lib/winlink-pat.js patSpawnEnv, the function main.js uses).
const CASES = [
  { label: 'variable unset: upstream behaviour', env: undefined, sent: [90] },
  { label: 'variable empty', env: '', sent: [90] },
  { label: '120', env: '120', sent: [90, 120] },
  { label: 'lowest the modem accepts, 30', env: '30', sent: [90, 30] },
  { label: 'highest the modem accepts, 240', env: '240', sent: [90, 240] },
  { label: 'POTACAT with the setting never saved (default 120)', env: { setting: undefined }, sent: [90, 120] },
  { label: 'POTACAT with the setting at 90 (upstream value)', env: { setting: 90 }, sent: [90, 90] },
  { label: 'POTACAT with the setting at 180', env: { setting: 180 }, sent: [90, 180] },
  { label: 'POTACAT with a saved 9999 (held to 180)', env: { setting: 9999 }, sent: [90, 180] },
  { label: 'too low, 29: ignored', env: '29', sent: [90], ignored: true },
  { label: 'too high, 241: ignored', env: '241', sent: [90], ignored: true },
  { label: 'far too high, 9999: ignored', env: '9999', sent: [90], ignored: true },
  { label: 'zero: ignored', env: '0', sent: [90], ignored: true },
  { label: 'negative: ignored', env: '-120', sent: [90], ignored: true },
  { label: 'not a number: ignored', env: 'abc', sent: [90], ignored: true },
  { label: 'not a whole number, 120.5: ignored', env: '120.5', sent: [90], ignored: true },
];

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

/**
 * Relay Pat <-> modem for one port, keeping the CR-terminated lines each way
 * when `record` is given. The modem side is already connected; whatever it
 * said before Pat arrived is passed on first.
 */
function relayPort(listenPort, upstream, record) {
  let early = [];
  let client = null;
  const lines = (who) => {
    let carry = '';
    return (d) => {
      carry += d.toString('latin1');
      let i;
      while ((i = carry.indexOf('\r')) >= 0) {
        const line = carry.slice(0, i).trim();
        carry = carry.slice(i + 1);
        if (line) record(who, line);
      }
    };
  };
  const fromModem = record ? lines('modem') : null;
  const fromPat = record ? lines('pat') : null;
  upstream.on('data', (d) => { if (fromModem) fromModem(d); if (client) client.write(d); else early.push(d); });
  upstream.on('error', () => {});
  const server = net.createServer((sock) => {
    if (client) { sock.destroy(); return; }
    client = sock;
    sock.setNoDelay(true);
    for (const d of early) sock.write(d);
    early = [];
    sock.on('data', (d) => { if (fromPat) fromPat(d); upstream.write(d); });
    sock.on('error', () => {});
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, '127.0.0.1', () => resolve({ close: () => new Promise((r) => { try { if (client) client.destroy(); } catch {} try { upstream.destroy(); } catch {} server.close(() => r()); }) }));
  });
}

function waitExit(proc, ms) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode) return resolve();
    const t = setTimeout(resolve, ms);
    proc.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

let portBase = 21000 + Math.floor(Math.random() * 300) * 10;

async function once(c, index) {
  // Pat finds the modem's data port by adding one to the LAST CHARACTER of the
  // address (wl2k-go transport/ardop tnc.go OpenTCP), so no port here ends in 9.
  portBase += 40;
  const modemPort = portBase, relayPortNo = portBase + 20;
  const dir = path.join(LOGS, `${String(index + 1).padStart(2, '0')}-${c.label.replace(/[^a-z0-9.-]+/gi, '_')}`);
  const modemLogs = path.join(dir, 'ardopcf');
  fs.mkdirSync(modemLogs, { recursive: true });
  fs.mkdirSync(path.join(dir, 'mbox'), { recursive: true });
  const r = { label: c.label, env: c.env === undefined ? null : c.env, expected: c.sent, ok: false, patToModem: [], modemToPat: [] };
  const t0 = Date.now();
  const record = (who, line) => {
    (who === 'pat' ? r.patToModem : r.modemToPat).push(`${Date.now() - t0} ${line}`);
    if (who === 'pat' && /^ARQCALL\b/i.test(line) && called) called();
  };
  let called = null;
  const sawCall = new Promise((resolve) => { called = resolve; });
  let ep = null, modem = null, pat = null, relays = [];
  let patOut = '';
  try {
    ep = await rawEndpoint(12000);
    const args = ArdopProcess.buildArdopArgs({ port: modemPort, capture: `tcp:${ep.port}`, playback: `tcp:${ep.port}`, logDir: modemLogs, driveLevel: 90, mycall: 'N0CALL' });
    modem = spawn(ardopBin(ROOT), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let modemOut = '';
    modem.stdout.on('data', (d) => { modemOut = (modemOut + d).slice(-4000); });
    modem.stderr.on('data', (d) => { modemOut = (modemOut + d).slice(-4000); });
    modem.on('error', (e) => { r.error = r.error || `ardopcf did not start: ${e.message}`; });
    const cmdUp = await connectRetry(modemPort, Date.now() + 10000);
    const dataUp = await connectRetry(modemPort + 1, Date.now() + 5000);
    relays = [await relayPort(relayPortNo, cmdUp, record), await relayPort(relayPortNo + 1, dataUp, null)];

    // Pat's config: POTACAT's own internet-only shape plus an ARDOP modem at
    // the relay, with no rig and no PTT control.
    const cfg = WinlinkPat.buildPatConfig({ mycall: 'N0CALL', grid: 'FN20', httpPort: relayPortNo + 5 });
    cfg.ardop = { addr: `127.0.0.1:${relayPortNo}`, arq_bandwidth: { Forced: false, Max: 500 }, cwid_enabled: false };
    const cfgPath = path.join(dir, 'pat-config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    // Its own XDG folders and no way out (./pat-env.js): upstream Pat would otherwise ask winlink.org
    // about N0CALL and wait two minutes for an answer before it opens the modem.
    const base = patTestEnv(dir, ['N0CALL']);
    let env = base;
    if (typeof c.env === 'string') env = { ...base, [ENV]: c.env };
    else if (c.env && typeof c.env === 'object') env = WinlinkPat.patSpawnEnv(base, { arqTimeoutS: c.env.setting });
    r.envGiven = Object.prototype.hasOwnProperty.call(env, ENV) ? env[ENV] : null;
    const patLog = path.join(dir, 'pat.log');
    const patArgs = ['--config', cfgPath, '--mbox', path.join(dir, 'mbox'), '--log', patLog, '--event-log', path.join(dir, 'eventlog.json'),
      '--forms', path.join(dir, 'forms'), '--ignore-busy', 'connect', 'ardop:///N0CALL-10'];
    pat = spawn(patBin, patArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
    pat.stdout.on('data', (d) => { patOut = (patOut + d).slice(-8000); });
    pat.stderr.on('data', (d) => { patOut = (patOut + d).slice(-8000); });
    pat.on('error', (e) => { r.error = r.error || `Pat did not start: ${e.message}`; });
    const gaveUp = new Promise((resolve) => setTimeout(() => resolve('timeout'), 45000));
    const patGone = new Promise((resolve) => pat.once('exit', (code) => resolve(`exit ${code}`)));
    const how = await Promise.race([sawCall.then(() => 'called'), gaveUp, patGone]);
    if (how !== 'called') r.error = r.error || `Pat never started its call (${how})`;
    await new Promise((res) => setTimeout(res, 300)); // let the modem write its log lines
  } catch (e) {
    r.error = r.error || e.message;
  } finally {
    try { if (pat) pat.kill(); } catch {}
    await waitExit(pat, 3000);
    try { if (modem) modem.kill(); } catch {}
    await waitExit(modem, 3000);
    for (const x of relays) await x.close();
    if (ep) await ep.close();
  }
  const strip = (l) => l.replace(/^\d+ /, '');
  r.sent = r.patToModem.map(strip).map((l) => /^ARQTIMEOUT\s+(-?\d+)\s*$/i.exec(l)).filter(Boolean).map((m) => Number(m[1]));
  r.answers = r.modemToPat.map(strip).filter((l) => /^ARQTIMEOUT\b/i.test(l));
  r.faults = r.modemToPat.map(strip).filter((l) => /^FAULT\b/i.test(l));
  // The modem's own log, read as POTACAT reads it for the session summary.
  const story = new WinlinkDiag.ArdopLinkStory();
  r.modemLogLines = [];
  try {
    for (const f of fs.readdirSync(modemLogs).filter((n) => /^ARDOPDebug/i.test(n))) {
      for (const line of fs.readFileSync(path.join(modemLogs, f), 'latin1').split(/\r?\n/)) {
        if (/ARQTIMEOUT/i.test(line)) r.modemLogLines.push(line.trim());
        story.note(WinlinkDiag.classifyArdopDebugLine(line));
      }
    }
  } catch (e) { r.modemLogError = e.message; }
  r.inForce = story.snapshot().arqTimeoutS;
  let patLogText = '';
  try { patLogText = fs.readFileSync(path.join(dir, 'pat.log'), 'utf8'); } catch {}
  const said = `${patOut}\n${patLogText}`;
  r.patSaid = said.split(/\r?\n/).filter((l) => /POTACAT:/.test(l)).map((l) => l.trim()).slice(0, 4);
  r.patTail = patOut.slice(-600);
  const want = c.sent[c.sent.length - 1];
  const checks = {
    sent: JSON.stringify(r.sent) === JSON.stringify(c.sent),
    answered: r.answers.length === c.sent.length && new RegExp(`\\b${want}\\b`).test(r.answers[r.answers.length - 1] || ''),
    noFault: r.faults.length === 0,
    modemLog: r.inForce === want,
    saidIgnored: c.ignored ? r.patSaid.some((l) => /ignoring/i.test(l)) : !r.patSaid.some((l) => /ignoring/i.test(l)),
    saidSet: c.sent.length === 2 ? r.patSaid.some((l) => new RegExp(`ARQ timeout set to ${want} s`).test(l)) : !r.patSaid.some((l) => /ARQ timeout set to/.test(l)),
  };
  r.checks = checks;
  r.ok = !r.error && Object.values(checks).every(Boolean);
  r.seconds = +((Date.now() - t0) / 1000).toFixed(1);
  const failed = Object.keys(checks).filter((k) => !checks[k]);
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${c.label}: ${ENV}=${r.envGiven === null ? '(unset)' : JSON.stringify(r.envGiven)}  Pat sent ARQTIMEOUT ${JSON.stringify(r.sent)}, modem answered ${JSON.stringify(r.answers)}, modem log says ${r.inForce || 'nothing'}${r.ok ? '' : `  [${r.error || 'failed: ' + failed.join(', ')}]`}`);
  return r;
}

(async () => {
  const missing = [patBin, ardopBin(ROOT)].filter((p) => !fs.existsSync(p));
  if (missing.length) {
    console.log(`Pat ARQ timeout: ${required ? 'FAIL' : 'SKIP'} (no helper at ${missing.join(', ')}; build them with scripts/build-winlink-helpers.sh)`);
    process.exit(required ? 1 : 0);
  }
  let set = CASES;
  const filt = opt('--filter', '');
  if (filt) set = set.filter((c) => new RegExp(filt, 'i').test(c.label));
  const results = [];
  for (let i = 0; i < set.length; i++) results.push(await once(set[i], i));
  const summary = { platform: process.platform, arch: process.arch, node: process.version, when: new Date().toISOString(), passed: results.filter((r) => r.ok).length, total: results.length };
  fs.writeFileSync(OUT, JSON.stringify({ summary, results }, null, 1));
  console.log(`\nPat ARQ timeout (${process.platform}/${process.arch}): ${summary.passed} of ${summary.total} passed. Results: ${OUT}  Logs: ${LOGS}`);
  process.exit(summary.passed === summary.total ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
