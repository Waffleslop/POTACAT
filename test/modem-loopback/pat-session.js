#!/usr/bin/env node
'use strict';
// POTACAT's build of Pat, end to end, with no radio and no Winlink server (#425).
//
//   ardop    Two Pats exchange mail over two real ardopcf modems whose audio is
//            crossed in software (the L1 relay of run.js). The "gateway" is a
//            second Pat listening on ARDOP as N0CALL-10, a peer-to-peer link:
//            no CMS, no login. Our Pat (N0CALL) is started the way main.js
//            starts it (lib/winlink-pat.js patSpawnEnv, so with the ARDOP link
//            timeout at POTACAT's default) and asked to connect through its
//            HTTP API (/api/connect), as POTACAT asks. Pass: one message each
//            way arrives whole, both Outboxes empty, and the calling modem
//            was given ARQTIMEOUT 120.
//   telnet   Pat's HTTP API answers (/api/status, /api/mailbox/out); a telnet
//            connect to a closed local port fails without hanging; and a
//            connect to a local stand-in for the CMS gets the same opening
//            lines as upstream Pat sends (the callsign, then "CMSTelnet"),
//            after which the stand-in hangs up. No real CMS is reached.
//
// Every address is 127.0.0.1. Pat's web proxy is pointed at a closed port so a
// look-up it might try on its own (a version check, a gateway list) goes
// nowhere. Placeholder callsigns only. Nothing is transmitted: the modems'
// audio is two loopback sockets.
//
//   node test/modem-loopback/pat-session.js [--only ardop|telnet] [--out file.json] [--logs dir]
//
// Needs assets/pat and assets/ardopcf (scripts/build-winlink-helpers.sh).
// Without them it says SKIP and exits 0, unless LOOPBACK_REQUIRED=1 (CI).

const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { rawEndpoint, crossConnect } = require('./relay');
const { binPath: ardopBin } = require('./ardop');
const { patTestEnv } = require('./pat-env');

const ROOT = path.join(__dirname, '..', '..');
const WinlinkPat = require(path.join(ROOT, 'lib', 'winlink-pat.js'));
const ArdopProcess = require(path.join(ROOT, 'lib', 'ardop-process.js'));
const WinlinkDiag = require(path.join(ROOT, 'lib', 'winlink-diag.js'));

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const required = process.env.LOOPBACK_REQUIRED === '1';
const OUT = opt('--out', path.join(os.tmpdir(), 'potacat-pat-session-results.json'));
const LOGS = opt('--logs', fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-pat-session-')));
const ONLY = opt('--only', '');
const patBin = path.join(ROOT, 'assets', 'pat', WinlinkPat.patBinaryName(process.platform));
const CALLER = 'N0CALL', PEER = 'N0CALL-10';

// Pat's environment: its own XDG folders, loopback only (./pat-env.js). One per run.
let _env = null;
function baseEnv() {
  if (!_env) _env = patTestEnv(path.join(LOGS, 'pat-state'), [CALLER, PEER]);
  return { ..._env };
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

function req(port, method, p, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.setTimeout(timeoutMs, () => r.destroy(new Error(`no answer in ${timeoutMs} ms`)));
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    r.end();
  });
}

async function waitHttp(port, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = await req(port, 'GET', '/api/status', { timeoutMs: 2000 });
    if (r.status === 200) return r;
    await new Promise((res) => setTimeout(res, 250));
  }
  return null;
}

function waitExit(proc, ms) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode) return resolve();
    const t = setTimeout(resolve, ms);
    proc.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

/** One Pat's folder and config. `ardopPort` set = an ARDOP modem there; `listen` = answer calls. */
function patHome(dir, { call, httpPort, ardopPort, listen }) {
  fs.mkdirSync(path.join(dir, 'mbox'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'forms'), { recursive: true });
  const cfg = WinlinkPat.buildPatConfig({ mycall: call, grid: 'FN20jb', httpPort });
  cfg.prediction = { engine: 'disabled' };
  if (ardopPort) cfg.ardop = { addr: `127.0.0.1:${ardopPort}`, arq_bandwidth: { Forced: false, Max: 500 }, cwid_enabled: false };
  cfg.listen = listen ? ['ardop'] : [];
  const config = path.join(dir, 'pat-config.json');
  fs.writeFileSync(config, JSON.stringify(cfg, null, 2));
  const args = (extra) => ['--config', config, '--mbox', path.join(dir, 'mbox'), '--log', path.join(dir, 'pat.log'), '--event-log', path.join(dir, 'eventlog.json'), '--forms', path.join(dir, 'forms'), ...extra];
  return { dir, call, httpPort, args, mbox: (box) => path.join(dir, 'mbox', call, box) };
}

/** Queue one peer-to-peer message with Pat's own `compose`, as an operator would. */
function compose(home, to, subject, body) {
  const r = spawnSync(patBin, home.args(['compose', '--subject', subject, '--p2p-only', to]), { input: body + '\n', env: baseEnv(), encoding: 'utf8', timeout: 20000, windowsHide: true });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.slice(-400) };
}

function startPat(home, env, outFile) {
  const p = spawn(patBin, home.args(['http']), { stdio: ['ignore', 'pipe', 'pipe'], env, windowsHide: true });
  const keep = (d) => fs.appendFileSync(outFile, d);
  p.stdout.on('data', keep); p.stderr.on('data', keep);
  return p;
}

const listMsgs = (dir) => { try { return fs.readdirSync(dir).filter((f) => /\.b2f$/i.test(f)); } catch { return []; } };
const readAll = (dir) => listMsgs(dir).map((f) => fs.readFileSync(path.join(dir, f), 'latin1')).join('\n');

let portBase = 24000 + Math.floor(Math.random() * 300) * 10;
const nextPorts = () => { portBase += 50; return portBase; }; // multiples of 10: no port ends in 9 (Pat adds one to the last digit)

async function ardopCase() {
  const base = nextPorts();
  const P = { ardopA: base, ardopB: base + 10, httpA: base + 20, httpB: base + 30 };
  const dir = path.join(LOGS, 'ardop');
  const r = { case: 'ARDOP: two Pats exchange mail over two ardopcf, no radio', ok: false, steps: [] };
  const t0 = Date.now();
  const step = (s) => { r.steps.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`); };
  const procs = [];
  let epA, epB, relay;
  try {
    [epA, epB] = await Promise.all([rawEndpoint(12000), rawEndpoint(12000)]);
    relay = crossConnect(epA, epB, { impAB: {}, impBA: {} });
    for (const [name, call, port, ep] of [['A', CALLER, P.ardopA, epA], ['B', PEER, P.ardopB, epB]]) {
      const logDir = path.join(dir, `ardopcf-${name}`);
      fs.mkdirSync(logDir, { recursive: true });
      const args = ArdopProcess.buildArdopArgs({ port, capture: `tcp:${ep.port}`, playback: `tcp:${ep.port}`, logDir, driveLevel: 90, mycall: call });
      const m = spawn(ardopBin(ROOT), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      m.stdout.on('data', (d) => fs.appendFileSync(path.join(dir, `ardopcf-${name}.out`), d));
      m.stderr.on('data', (d) => fs.appendFileSync(path.join(dir, `ardopcf-${name}.out`), d));
      procs.push(m);
      (await connectRetry(port, Date.now() + 10000)).destroy();
    }
    step('both modems up');
    const A = patHome(path.join(dir, 'pat-A'), { call: CALLER, httpPort: P.httpA, ardopPort: P.ardopA, listen: false });
    const B = patHome(path.join(dir, 'pat-B'), { call: PEER, httpPort: P.httpB, ardopPort: P.ardopB, listen: true });
    const bodyA = `From ${CALLER} to ${PEER} over ARDOP, no radio. ${'0123456789'.repeat(40)}`;
    const bodyB = `From ${PEER} to ${CALLER} over ARDOP, no radio. ${'abcdefghij'.repeat(40)}`;
    r.composeA = compose(A, PEER, 'potacat loopback A to B', bodyA);
    r.composeB = compose(B, CALLER, 'potacat loopback B to A', bodyB);
    if (r.composeA.status !== 0 || r.composeB.status !== 0) throw new Error(`pat compose failed: ${JSON.stringify([r.composeA, r.composeB])}`);
    r.outboxBefore = { A: listMsgs(A.mbox('out')).length, B: listMsgs(B.mbox('out')).length };
    step(`queued: A ${r.outboxBefore.A}, B ${r.outboxBefore.B}`);
    const patB = startPat(B, baseEnv(), path.join(dir, 'pat-B.out'));
    procs.push(patB);
    if (!(await waitHttp(P.httpB, 20000))) throw new Error('the listening Pat never answered on its API');
    // The caller, started as main.js starts it.
    const envA = WinlinkPat.patSpawnEnv(baseEnv(), { arqTimeoutS: undefined });
    r.envA = envA[WinlinkPat.ARDOP_ARQ_TIMEOUT.env];
    const patA = startPat(A, envA, path.join(dir, 'pat-A.out'));
    procs.push(patA);
    const st = await waitHttp(P.httpA, 20000);
    if (!st) throw new Error('our Pat never answered on its API');
    step('both Pats up');
    await new Promise((res) => setTimeout(res, 3000)); // the listener opens its modem and starts listening
    const url = `ardop:///${PEER}?bw=500MAX`;
    const c = await req(P.httpA, 'POST', `/api/connect?url=${encodeURIComponent(url)}`, { timeoutMs: 600000 });
    r.connect = { status: c.status, body: String(c.body || c.error || '').slice(0, 300) };
    step(`connect answered ${c.status}`);
    await new Promise((res) => setTimeout(res, 1500));
    r.inbox = { A: listMsgs(A.mbox('in')).length, B: listMsgs(B.mbox('in')).length };
    r.outboxAfter = { A: listMsgs(A.mbox('out')).length, B: listMsgs(B.mbox('out')).length };
    const inA = readAll(A.mbox('in')), inB = readAll(B.mbox('in'));
    r.intact = { AtoB: inB.includes(bodyA), BtoA: inA.includes(bodyB) };
    // What the calling modem was given, read as POTACAT reads it.
    const story = new WinlinkDiag.ArdopLinkStory();
    const logDirA = path.join(dir, 'ardopcf-A');
    for (const f of fs.readdirSync(logDirA).filter((n) => /^ARDOPDebug/i.test(n))) {
      for (const line of fs.readFileSync(path.join(logDirA, f), 'latin1').split(/\r?\n/)) story.note(WinlinkDiag.classifyArdopDebugLine(line));
    }
    r.arqTimeoutA = story.snapshot().arqTimeoutS;
    r.ok = c.status === 200 && r.intact.AtoB && r.intact.BtoA && r.outboxAfter.A === 0 && r.outboxAfter.B === 0 && r.arqTimeoutA === 120;
  } catch (e) {
    r.error = e.message;
  } finally {
    for (const p of procs.reverse()) { try { if (p.exitCode === null) p.kill(); } catch {} await waitExit(p, 3000); }
    if (relay) relay.stop();
    for (const ep of [epA, epB]) if (ep) await ep.close();
    r.seconds = +((Date.now() - t0) / 1000).toFixed(1);
  }
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.case}: connect ${r.connect ? r.connect.status : '-'}, ${CALLER} to ${PEER} ${r.intact ? (r.intact.AtoB ? 'arrived whole' : 'MISSING') : '-'}, ${PEER} to ${CALLER} ${r.intact ? (r.intact.BtoA ? 'arrived whole' : 'MISSING') : '-'}, Outboxes after ${JSON.stringify(r.outboxAfter || null)}, calling modem's link timeout ${r.arqTimeoutA || '-'} s, ${r.seconds}s${r.error ? '  [' + r.error + ']' : ''}${!r.ok && r.connect ? '  Pat said: ' + r.connect.body : ''}`);
  return r;
}

/** A stand-in for the CMS telnet port: prompts as the CMS does, records what Pat answers, then hangs up. */
function fakeCms() {
  const seen = [];
  const server = net.createServer((sock) => {
    let buf = '';
    let stage = 0;
    sock.write('Callsign :\r');
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.search(/\r\n|\r|\n/)) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + (buf[i] === '\r' && buf[i + 1] === '\n' ? 2 : 1));
        if (!line) continue;
        seen.push(line);
        if (stage === 0) { stage = 1; sock.write('Password :\r'); }
        else if (stage === 1) { stage = 2; setTimeout(() => sock.destroy(), 200); }
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen, close: () => new Promise((r) => server.close(() => r())) })));
}

// POTACAT's own telnet alias (lib/winlink-pat.js), pointed at a local port instead of the CMS.
const telnetUrl = (port) => WinlinkPat.PAT_DEFAULTS.telnetAlias.replace('{mycall}', CALLER).replace(/@[^/]+\//, `@127.0.0.1:${port}/`);

async function telnetCase() {
  const base = nextPorts();
  const dir = path.join(LOGS, 'telnet');
  const r = { case: 'Telnet: API answers, refused connect, a stand-in CMS', ok: false };
  const t0 = Date.now();
  let pat, cms;
  try {
    const A = patHome(path.join(dir, 'pat'), { call: CALLER, httpPort: base + 20, listen: false });
    pat = startPat(A, WinlinkPat.patSpawnEnv(baseEnv(), {}), path.join(dir, 'pat.out'));
    const st = await waitHttp(base + 20, 20000);
    r.status = st ? { status: st.status, body: st.body.slice(0, 200) } : null;
    const out = await req(base + 20, 'GET', '/api/mailbox/out');
    r.mailboxOut = { status: out.status, isList: (() => { try { return Array.isArray(JSON.parse(out.body)); } catch { return false; } })() };
    // A closed port (nothing listens on base + 40).
    let t = Date.now();
    const refused = await req(base + 20, 'POST', `/api/connect?url=${encodeURIComponent(telnetUrl(base + 40))}`, { timeoutMs: 60000 });
    r.refused = { status: refused.status, body: String(refused.body || refused.error || '').slice(0, 200), seconds: +((Date.now() - t) / 1000).toFixed(1) };
    // The stand-in CMS.
    cms = await fakeCms();
    t = Date.now();
    const fake = await req(base + 20, 'POST', `/api/connect?url=${encodeURIComponent(telnetUrl(cms.port))}`, { timeoutMs: 60000 });
    r.fakeCms = { status: fake.status, body: String(fake.body || fake.error || '').slice(0, 200), seconds: +((Date.now() - t) / 1000).toFixed(1), patSent: cms.seen.slice(0, 4) };
    r.urls = [telnetUrl(base + 40), telnetUrl(cms.port)];
    if (!r.urls.every((u) => /@127\.0\.0\.1:\d+\/wl2k$/.test(u))) throw new Error(`not a loopback URL: ${r.urls}`);
    r.checks = {
      apiStatus: !!(st && st.status === 200),
      mailbox: out.status === 200 && r.mailboxOut.isList,
      refusedFails: refused.status !== 200 && refused.status !== 0 && r.refused.seconds < 30,
      fakeCmsLogin: cms.seen[0] === CALLER && cms.seen[1] === 'CMSTelnet',
      fakeCmsFails: fake.status !== 200 && fake.status !== 0,
    };
    r.ok = Object.values(r.checks).every(Boolean);
  } catch (e) {
    r.error = e.message;
  } finally {
    try { if (pat && pat.exitCode === null) pat.kill(); } catch {}
    await waitExit(pat, 3000);
    if (cms) await cms.close();
    r.seconds = +((Date.now() - t0) / 1000).toFixed(1);
  }
  const failed = r.checks ? Object.keys(r.checks).filter((k) => !r.checks[k]) : [];
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.case}: /api/status ${r.status ? r.status.status : '-'}, closed port -> ${r.refused ? `${r.refused.status} in ${r.refused.seconds}s` : '-'}, stand-in CMS got ${JSON.stringify(r.fakeCms ? r.fakeCms.patSent : null)} -> ${r.fakeCms ? r.fakeCms.status : '-'}${r.error ? '  [' + r.error + ']' : ''}${failed.length ? '  failed: ' + failed.join(', ') : ''}`);
  return r;
}

(async () => {
  const missing = [patBin, ardopBin(ROOT)].filter((p) => !fs.existsSync(p));
  if (missing.length) {
    console.log(`Pat session: ${required ? 'FAIL' : 'SKIP'} (no helper at ${missing.join(', ')}; build them with scripts/build-winlink-helpers.sh)`);
    process.exit(required ? 1 : 0);
  }
  const results = [];
  if (!ONLY || ONLY === 'telnet') results.push(await telnetCase());
  if (!ONLY || ONLY === 'ardop') results.push(await ardopCase());
  const summary = { platform: process.platform, arch: process.arch, node: process.version, when: new Date().toISOString(), passed: results.filter((r) => r.ok).length, total: results.length };
  fs.writeFileSync(OUT, JSON.stringify({ summary, results }, null, 1));
  console.log(`\nPat session (${process.platform}/${process.arch}): ${summary.passed} of ${summary.total} passed. Results: ${OUT}  Logs: ${LOGS}`);
  process.exit(summary.passed === summary.total ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
