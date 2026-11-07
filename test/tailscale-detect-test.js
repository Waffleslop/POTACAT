#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// A Linux shack on Tailscale whose `tailscale` command POTACAT could not run
// published NO tailnet leg: the pairing QR, the /api/pair reply and auth-ok
// carried the LAN address only, so an iPhone paired at home never reached the
// shack from anywhere else, and Settings said "Tailscale not detected"
// (Linux + iPhone, 2026-10-21). The tailnet address on the interfaces is
// evidence enough for the address leg; the CLI adds only the name.
//
// GitHub #132 (macOS): "Tailscale is installed but not signed in" while the
// menu bar app was signed in. The first binary that answered `version` was
// cached for the process lifetime, and on macOS PATH and Homebrew came before
// the app bundle — so a leftover Homebrew CLI reported ITS daemon's NeedsLogin
// and the app's Running daemon was never asked. Stopped (VPN off), Starting
// and NeedsMachineAuth all read as "not signed in" too. Now every candidate
// is asked `status --json`, the signed-in daemon wins, the probe is
// asynchronous (never execFileSync), and the state is named.
//
// Every exec here is a fake; no test runs a real tailscale binary.
// Run: node test/tailscale-detect-test.js
const assert = require('assert');
const path = require('path');
const RS = require('../lib/remote-server');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }
const R = (f) => readSrc(path.join(__dirname, '..', f)).replace(/\r\n/g, '\n');

// ── fixtures: what `tailscale status --json` prints ──────────────────────────
const HOST = 'shack.tail1234.ts.net.';
const RUNNING = { BackendState: 'Running', Self: { Online: true, DNSName: HOST, TailscaleIPs: ['100.93.206.18', 'fd7a:115c:a1e0::1'] }, CurrentTailnet: { MagicDNSEnabled: true } };
const STARTING_ONLINE = { BackendState: 'Starting', Self: { Online: true, DNSName: HOST, TailscaleIPs: ['100.93.206.18'] }, CurrentTailnet: { MagicDNSEnabled: true } };
const STOPPED = { BackendState: 'Stopped', Self: { Online: false, DNSName: HOST, TailscaleIPs: ['100.93.206.18'] } };
const NEEDS_LOGIN = { BackendState: 'NeedsLogin', Self: { Online: false } };
const NEEDS_AUTH = { BackendState: 'NeedsMachineAuth', Self: { Online: false, DNSName: HOST } };

const BUNDLE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const BREW = '/opt/homebrew/bin/tailscale';
const LOCAL = '/usr/local/bin/tailscale';

// table: path -> { json } | { stdout, stderr, code } | 'ENOENT'
function fakeExec(table) {
  const calls = [];
  const exec = async (file, args) => {
    calls.push(file + ' ' + args.join(' '));
    const r = table[file];
    if (r === undefined || r === 'ENOENT') {
      const e = new Error(`spawn ${file} ENOENT`); e.code = 'ENOENT'; e.stdout = ''; e.stderr = ''; throw e;
    }
    const stdout = r.json !== undefined ? JSON.stringify(r.json) : (r.stdout || '');
    if (r.code) {
      const e = new Error(`Command failed: ${file}`); e.code = r.code; e.stdout = stdout; e.stderr = r.stderr || ''; throw e;
    }
    return { stdout, stderr: r.stderr || '' };
  };
  exec.calls = calls;
  return exec;
}
const probe = (candidates, table) => RS.probeTailscale({ candidates, exec: fakeExec(table), timeoutMs: 50 });

console.log('Tailscale detection');

// ── the old cases ────────────────────────────────────────────────────────────
test('the tailnet address comes from the interfaces: 100.64/10 only, never loopback or a LAN 100.x', () => {
  assert.strictEqual(RS.tailnetIpFromInterfaces({
    eth0: [{ family: 'IPv4', address: '192.168.1.5', internal: false }],
    tailscale0: [{ family: 'IPv4', address: '100.93.206.18', internal: false }, { family: 'IPv6', address: 'fd7a::1', internal: false }],
  }), '100.93.206.18');
  assert.strictEqual(RS.tailnetIpFromInterfaces({ eth0: [{ family: 'IPv4', address: '100.10.0.1', internal: false }] }), null, '100.10 is not a tailnet');
  assert.strictEqual(RS.tailnetIpFromInterfaces({ eth0: [{ family: 'IPv4', address: '100.127.255.1', internal: false }] }), '100.127.255.1', 'the top of the range');
  assert.strictEqual(RS.tailnetIpFromInterfaces({ eth0: [{ family: 'IPv4', address: '100.128.0.1', internal: false }] }), null, 'just past it');
  assert.strictEqual(RS.tailnetIpFromInterfaces({ lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }), null);
  assert.strictEqual(RS.tailnetIpFromInterfaces({}), null);
});

test('the probe state says why the CLI gave nothing', () => {
  const st = RS.tailscaleProbeState();
  assert.ok(st && typeof st.error === 'string' && 'binary' in st);
  assert.ok(Array.isArray(st.candidates), 'and what every candidate answered');
});

test('Linux looks in the snap and per-user locations, then the login shell\'s PATH', () => {
  const src = R('lib/remote-server.js');
  assert.ok(/'\/snap\/bin\/tailscale'/.test(src) && /\.local\/bin\/tailscale/.test(src));
  assert.ok(/exec\('\/bin\/sh', \['-lc', 'command -v tailscale'\]/.test(src), 'the login-shell lookup is asynchronous too');
});

test('main publishes the interface address as the tailnet leg when the CLI gives nothing, and says why once', () => {
  const main = R('main.js');
  const at = main.indexOf('async function _refreshAltHosts() {');
  assert.ok(at > 0, '_refreshAltHosts awaits the probe');
  const fn = main.slice(at, at + 3500);
  assert.ok(/if \(!\(ts && ts\.loggedIn\)\) \{\n\s+const ifIp = tailnetIpFromInterfaces\(\);/.test(fn));
  assert.ok(/tsIp = ifIp \+ ':' \+ port;/.test(fn));
  assert.ok(/if \(line !== _altHostsNoteLogged\)/.test(fn), 'logged on change, not every 10 minutes');
  assert.ok(/\[Pair QR\] OK — mode=\$\{effectiveMode\} lan=.*tailscale=/.test(main), 'the QR log names every leg');
  const ipc = main.slice(main.indexOf("ipcMain.handle('echocat-tailscale-status'"), main.indexOf("ipcMain.handle('echocat-tailscale-status'") + 1800);
  assert.ok(/ipFromInterfaces: ipFromInterfaces \|\| null,/.test(ipc) && /cliError: ts \? '' : \(probe\.error \|\| ''\)/.test(ipc));
  const app = R('renderer/app.js');
  assert.ok(/if \(!s\.installed && s\.ipFromInterfaces\) \{/.test(app), 'the card tells the truth');
});

test('a refused tailscale cert names the operator command (KX4MG, Linux)', () => {
  const m = RS.describeTailscaleCertError("Access denied: cert access denied\n\nUse 'sudo tailscale cert' or 'tailscale up --operator=$USER' to not require root.");
  assert.ok(/sudo tailscale set --operator=\$USER/.test(m), m);
  assert.ok(/not enabled in your Tailscale admin console/.test(RS.describeTailscaleCertError('your Tailscale account does not support getting TLS certs; HTTPS is not enabled')));
  assert.strictEqual(RS.describeTailscaleCertError('', 'boom'), 'tailscale cert failed: boom');
});

test('a failed cert never disappears silently (source guard)', () => {
  const main = R('main.js');
  assert.ok(/\[Tailscale\] Cert for \$\{ts\.hostname\} not issued/.test(main), 'ensureTailscaleCertReady logs the failure');
  assert.ok(/const certResult = await ensureTailscaleCertReady\(\(msg\) => sendCatLog\('\[Pair-Link\] '/.test(main), 'the share-link path reads the result');
});

test('Linux operators are told the operator step before and after a failure (source guard)', () => {
  const main = R('main.js'), app = R('renderer/app.js'), html = R('renderer/index.html');
  assert.ok(/certError: cached \? '' : _tailscaleCertError,/.test(main), 'status carries the last cert error');
  assert.ok(/platform: process\.platform,/.test(main), 'status carries the platform');
  assert.ok(/if \(!s\.certCached && s\.certError\)/.test(app), 'the card shows the failure');
  assert.ok(/if \(!s\.certCached && s\.platform === 'linux'\)/.test(app), 'the card names the step on Linux before any failure');
  assert.ok(/sudo tailscale set --operator=\$USER/.test(html), 'the setup steps name it');
  assert.ok(!/if \(certResult && certResult\.error\) \{\n\s+return \{ error/.test(main), 'a cert failure must not withhold the LAN pairing QR');
  assert.ok(/certWarning,\n\s+\};/.test(main) && /r\.certWarning/.test(app), 'the share-link dialog shows the reason');
});

// ── #132: where the command lives ────────────────────────────────────────────
test('macOS: the app bundle first, then /usr/local/bin, /opt/homebrew/bin, then PATH; one binary behind two names is probed once', () => {
  const present = new Set([BUNDLE, LOCAL, BREW]);
  const exists = (p) => present.has(p);
  // "Install Tailscale CLI" puts a symlink in /usr/local/bin that points into the bundle.
  const realpath = (p) => (p === LOCAL ? BUNDLE : p);
  const got = RS.tailscaleCandidates('darwin', { PATH: '/opt/homebrew/bin:/usr/bin:/bin' }, exists, realpath);
  assert.deepStrictEqual(got, [BUNDLE, BREW]);
});

test('macOS with Homebrew only (no bundle) still finds the brew CLI', () => {
  const got = RS.tailscaleCandidates('darwin', { PATH: '/usr/bin' }, (p) => p === BREW, (p) => p);
  assert.deepStrictEqual(got, [BREW]);
});

test('Linux and Windows keep their order: PATH first, then the known locations', () => {
  const linuxPresent = new Set(['/usr/bin/tailscale', '/snap/bin/tailscale', '/home/op/.local/bin/tailscale']);
  const linux = RS.tailscaleCandidates('linux', { PATH: '/usr/bin:/bin', HOME: '/home/op' }, (p) => linuxPresent.has(p), (p) => p);
  assert.deepStrictEqual(linux, ['/usr/bin/tailscale', '/snap/bin/tailscale', '/home/op/.local/bin/tailscale']);
  const win = RS.tailscaleCandidates('win32', { Path: 'C:\\Windows;"C:\\Program Files\\Tailscale"' }, (p) => /Tailscale\\tailscale\.exe$/.test(p), (p) => p);
  assert.deepStrictEqual(win, ['C:\\Program Files\\Tailscale\\tailscale.exe']);
  assert.deepStrictEqual(RS.tailscaleCandidates('linux', { PATH: '' }, () => false, (p) => p), [], 'nothing present = nothing to probe');
});

// ── #132: what the daemon said ───────────────────────────────────────────────
test('classifyTailscaleStatus: Running, Starting+Online are signed in; Stopped, NeedsLogin, NeedsMachineAuth are named, not lumped', () => {
  const run = RS.classifyTailscaleStatus(RUNNING);
  assert.deepStrictEqual([run.loggedIn, run.state, run.hostname, run.ip4, run.magicDNS], [true, 'running', 'shack.tail1234.ts.net', '100.93.206.18', true]);
  const starting = RS.classifyTailscaleStatus(STARTING_ONLINE);
  assert.deepStrictEqual([starting.loggedIn, starting.state, starting.hostname], [true, 'starting', 'shack.tail1234.ts.net']);
  const stopped = RS.classifyTailscaleStatus(STOPPED);
  assert.deepStrictEqual([stopped.loggedIn, stopped.state, stopped.backendState], [false, 'stopped', 'Stopped']);
  assert.deepStrictEqual([RS.classifyTailscaleStatus(NEEDS_LOGIN).loggedIn, RS.classifyTailscaleStatus(NEEDS_LOGIN).state], [false, 'needs-login']);
  assert.deepStrictEqual([RS.classifyTailscaleStatus(NEEDS_AUTH).loggedIn, RS.classifyTailscaleStatus(NEEDS_AUTH).state], [false, 'needs-approval']);
  assert.strictEqual(RS.classifyTailscaleStatus({}).state, 'unknown');
  assert.strictEqual(RS.classifyTailscaleStatus(RUNNING).installed, true);
});

test('wording: Stopped and NeedsMachineAuth are not "not signed in"; a ready daemon has nothing to say', () => {
  const stopped = RS.describeTailscaleNotReady(RS.classifyTailscaleStatus(STOPPED));
  assert.ok(/signed in but turned off/i.test(stopped) && /menu bar or system tray/.test(stopped) && /tailscale up/.test(stopped), stopped);
  assert.ok(!/not signed in/i.test(stopped));
  const auth = RS.describeTailscaleNotReady(RS.classifyTailscaleStatus(NEEDS_AUTH));
  assert.ok(/not been approved/i.test(auth) && /login\.tailscale\.com\/admin\/machines/.test(auth), auth);
  assert.ok(/not signed in/i.test(RS.describeTailscaleNotReady(RS.classifyTailscaleStatus(NEEDS_LOGIN))));
  assert.ok(/still connecting/i.test(RS.describeTailscaleNotReady(RS.classifyTailscaleStatus(STARTING_ONLINE))));
  assert.strictEqual(RS.describeTailscaleNotReady(RS.classifyTailscaleStatus(RUNNING)), '');
  assert.ok(/not detected/i.test(RS.describeTailscaleNotReady(null)));
});

// ── #132: choosing by daemon ─────────────────────────────────────────────────
test('app bundle only: the bundle answers, the brew path is recorded as absent', async () => {
  const r = await probe([BUNDLE, BREW], { [BUNDLE]: { json: RUNNING } });
  assert.strictEqual(r.binary, BUNDLE);
  assert.strictEqual(r.status.state, 'running');
  assert.deepStrictEqual(r.results.map((x) => [x.path, x.backendState]), [[BUNDLE, 'Running'], [BREW, null]]);
});

test('the #132 shack: brew NeedsLogin vs bundle Running picks the bundle whatever the order', async () => {
  for (const order of [[BREW, BUNDLE], [BUNDLE, BREW]]) {
    const r = await probe(order, { [BREW]: { json: NEEDS_LOGIN }, [BUNDLE]: { json: RUNNING } });
    assert.strictEqual(r.binary, BUNDLE, order.join(','));
    assert.strictEqual(r.status.loggedIn, true);
  }
});

test('App Store CLI prints an error on stderr: the next candidate answers and the error is recorded', async () => {
  const r = await probe([BUNDLE, LOCAL], {
    [BUNDLE]: { stdout: '', stderr: 'Tailscale CLI is not available in the App Store build\nsecond line', code: 1 },
    [LOCAL]: { json: RUNNING },
  });
  assert.strictEqual(r.binary, LOCAL);
  assert.strictEqual(r.results[0].error, 'Tailscale CLI is not available in the App Store build');
  assert.strictEqual(r.results[0].backendState, null);
});

test('a non-zero exit that still printed JSON is parsed, not lost', async () => {
  const r = await probe([BUNDLE], { [BUNDLE]: { json: NEEDS_LOGIN, code: 1, stderr: 'Logged out.' } });
  assert.strictEqual(r.status.state, 'needs-login');
  assert.strictEqual(r.results[0].backendState, 'NeedsLogin');
});

test('nobody signed in: the most-signed-in answer wins (Stopped over NeedsLogin), so the UI can say "turned off"', async () => {
  const r = await probe([BREW, BUNDLE], { [BREW]: { json: NEEDS_LOGIN }, [BUNDLE]: { json: STOPPED } });
  assert.strictEqual(r.binary, BUNDLE);
  assert.strictEqual(r.status.state, 'stopped');
});

test('nothing found gives null, with every candidate answer kept for the bug report', async () => {
  const r = await probe([BUNDLE, BREW], {});
  assert.strictEqual(r.binary, null);
  assert.strictEqual(r.status, null);
  assert.deepStrictEqual(r.results.map((x) => x.error), ['not found', 'not found']);
  assert.deepStrictEqual((await probe([], {})).results, []);
});

test('the probe runs the candidates in parallel with one shared deadline', async () => {
  let inFlight = 0, peak = 0;
  const exec = async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return { stdout: JSON.stringify(NEEDS_LOGIN), stderr: '' };
  };
  const t0 = Date.now();
  await RS.probeTailscale({ candidates: [BUNDLE, LOCAL, BREW], exec, timeoutMs: 50 });
  assert.strictEqual(peak, 3, 'all three were in flight together');
  assert.ok(Date.now() - t0 < 200);
});

// ── #132: the cache and the synchronous callers ──────────────────────────────
test('only a signed-in binary is cached; a signed-out answer re-probes every candidate next time', async () => {
  const exec = fakeExec({ [BREW]: { json: NEEDS_LOGIN }, [BUNDLE]: { json: NEEDS_LOGIN } });
  RS._resetTailscaleProbeForTests({ exec, candidates: [BUNDLE, BREW], platform: 'win32' });
  let ts = await RS.refreshTailscaleStatus();
  assert.strictEqual(ts.state, 'needs-login');
  assert.strictEqual(exec.calls.length, 2);
  ts = await RS.refreshTailscaleStatus();
  assert.strictEqual(exec.calls.length, 4, 'both asked again: the operator may have signed in since');
  // The bundle's daemon comes up: it is picked and from then on it alone is asked.
  exec.calls.length = 0;
  const exec2 = fakeExec({ [BREW]: { json: NEEDS_LOGIN }, [BUNDLE]: { json: RUNNING } });
  RS._resetTailscaleProbeForTests({ exec: exec2, candidates: [BUNDLE, BREW], platform: 'win32' });
  ts = await RS.refreshTailscaleStatus();
  assert.strictEqual(ts.state, 'running');
  assert.strictEqual(RS.tailscaleProbeState().binary, BUNDLE);
  ts = await RS.refreshTailscaleStatus();
  assert.deepStrictEqual(exec2.calls.slice(2), [BUNDLE + ' status --json'], 'the cached signed-in binary only');
  assert.strictEqual(ts.hostname, 'shack.tail1234.ts.net');
});

test('a cached binary that signs out loses the cache and the others are asked in the same refresh', async () => {
  const table = { [BREW]: { json: RUNNING }, [BUNDLE]: { json: RUNNING } };
  const exec = fakeExec(table);
  RS._resetTailscaleProbeForTests({ exec, candidates: [BUNDLE, BREW], platform: 'win32' });
  await RS.refreshTailscaleStatus();
  assert.strictEqual(RS.tailscaleProbeState().binary, BUNDLE);
  table[BUNDLE] = { json: NEEDS_LOGIN };
  const ts = await RS.refreshTailscaleStatus();
  assert.strictEqual(ts.state, 'running');
  assert.strictEqual(RS.tailscaleProbeState().binary, BREW);
});

test('a synchronous caller gets the cached answer at once and never waits on a probe', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const exec = async () => { await gate; return { stdout: JSON.stringify(RUNNING), stderr: '' }; };
  RS._resetTailscaleProbeForTests({ exec, candidates: [BUNDLE], platform: 'win32' });
  const t0 = Date.now();
  assert.strictEqual(RS.tailscaleStatus(), null, 'cold cache: "unknown" reads as not detected, and a refresh starts');
  assert.ok(Date.now() - t0 < 50, 'returned without waiting');
  const pending = RS.refreshTailscaleStatus();
  assert.strictEqual(RS.tailscaleStatus(), null, 'still the cache while the probe is in flight');
  release();
  await pending;
  assert.strictEqual(RS.tailscaleStatus().state, 'running');
  assert.strictEqual(RS.tailscaleStatus().hostname, 'shack.tail1234.ts.net');
});

test('concurrent refreshes share one probe', async () => {
  const exec = fakeExec({ [BUNDLE]: { json: RUNNING } });
  RS._resetTailscaleProbeForTests({ exec, candidates: [BUNDLE], platform: 'win32' });
  await Promise.all([RS.refreshTailscaleStatus(), RS.refreshTailscaleStatus(), RS.refreshTailscaleStatus()]);
  assert.strictEqual(exec.calls.length, 1);
});

test('no static candidate: the login shell is asked once, and what it names is probed', async () => {
  const exec = fakeExec({ '/bin/sh': { stdout: '/Users/op/bin/tailscale\n' }, '/Users/op/bin/tailscale': { json: RUNNING } });
  RS._resetTailscaleProbeForTests({ exec, candidates: [], platform: 'darwin' });
  const ts = await RS.refreshTailscaleStatus();
  assert.strictEqual(ts.state, 'running');
  assert.deepStrictEqual(exec.calls, ['/bin/sh -lc command -v tailscale', '/Users/op/bin/tailscale status --json']);
  assert.strictEqual(RS.tailscaleProbeState().binary, '/Users/op/bin/tailscale');
  // Nothing anywhere: null, and the probe state says so.
  const none = fakeExec({ '/bin/sh': { stdout: '' } });
  RS._resetTailscaleProbeForTests({ exec: none, candidates: [], platform: 'darwin' });
  assert.strictEqual(await RS.refreshTailscaleStatus(), null);
  assert.strictEqual(RS.tailscaleProbeState().error, 'tailscale command not found');
});

test('the probe state carries each candidate\'s answer for the bug report', async () => {
  const exec = fakeExec({ [BREW]: { json: NEEDS_LOGIN }, [BUNDLE]: { json: RUNNING } });
  RS._resetTailscaleProbeForTests({ exec, candidates: [BUNDLE, BREW], platform: 'win32' });
  await RS.refreshTailscaleStatus();
  const st = RS.tailscaleProbeState();
  assert.deepStrictEqual(st.candidates, [
    { path: BUNDLE, backendState: 'Running', error: '' },
    { path: BREW, backendState: 'NeedsLogin', error: '' },
  ]);
});

// ── #132: certs ──────────────────────────────────────────────────────────────
test('issueTailscaleCert is asynchronous and uses the signed-in binary', async () => {
  const exec = fakeExec({ [BREW]: { json: NEEDS_LOGIN }, [BUNDLE]: { json: RUNNING } });
  RS._resetTailscaleProbeForTests({ exec, candidates: [BUNDLE, BREW], platform: 'win32' });
  const p = RS.issueTailscaleCert('/tmp/certs', 'shack.tail1234.ts.net', { exec });
  assert.ok(p && typeof p.then === 'function', 'returns a promise');
  const r = await p;
  assert.ok(/tailscale-cert\.pem$/.test(r.certPath));
  const certCall = exec.calls.find((c) => / cert /.test(c));
  assert.ok(certCall && certCall.startsWith(BUNDLE + ' cert -cert-file='), certCall);
  // A refusal still speaks the operator's language.
  const refusing = fakeExec({ [BUNDLE]: { json: RUNNING } });
  refusing.table = null;
  const exec3 = async (file, args) => {
    if (args[0] === 'cert') { const e = new Error('x'); e.stderr = 'Access denied: cert access denied'; throw e; }
    return { stdout: JSON.stringify(RUNNING), stderr: '' };
  };
  RS._resetTailscaleProbeForTests({ exec: exec3, candidates: [BUNDLE], platform: 'win32' });
  await assert.rejects(RS.issueTailscaleCert('/tmp/certs', 'shack.tail1234.ts.net', { exec: exec3 }), /sudo tailscale set --operator/);
});

test('cert renewal is due on <14 days or a renamed host, and only while Running', () => {
  const cached = { hostname: 'shack.tail1234.ts.net', daysLeft: 40 };
  const running = RS.classifyTailscaleStatus(RUNNING);
  assert.strictEqual(RS.tailscaleCertRenewalDue(cached, running).due, false);
  assert.strictEqual(RS.tailscaleCertRenewalDue({ ...cached, daysLeft: 13 }, running).due, true);
  const renamed = RS.tailscaleCertRenewalDue({ ...cached, hostname: 'old-name.tail1234.ts.net' }, running);
  assert.strictEqual(renamed.due, true);
  assert.strictEqual(renamed.host, 'shack.tail1234.ts.net');
  assert.strictEqual(RS.tailscaleCertRenewalDue({ ...cached, daysLeft: 3 }, RS.classifyTailscaleStatus(STARTING_ONLINE)).due, false, 'certs need Running');
  assert.strictEqual(RS.tailscaleCertRenewalDue({ ...cached, daysLeft: 3 }, RS.classifyTailscaleStatus(STOPPED)).due, false);
  assert.strictEqual(RS.tailscaleCertRenewalDue({ ...cached, daysLeft: 3 }, null).due, false);
  assert.strictEqual(RS.tailscaleCertRenewalDue(null, running).due, false);
});

// ── #132: source guards ──────────────────────────────────────────────────────
test('no synchronous child process remains on the Tailscale path (source guard)', () => {
  const src = R('lib/remote-server.js');
  const from = src.indexOf('function tailscaleCandidates(');
  const to = src.indexOf('function describeTailscaleCertError(');
  assert.ok(from > 0 && to > from);
  const slice = src.slice(from, to);
  assert.ok(!/execFileSync|execSync|spawnSync/.test(slice), 'the Tailscale path is asynchronous');
  assert.ok(!/function findTailscaleBinary/.test(src), 'the version-only picker is gone');
  const cert = src.slice(src.indexOf('function getOrCreateTlsCert('), src.indexOf('function getOrCreateTlsCert(') + 4000);
  assert.ok(!/issueTailscaleCert\(/.test(cert) && !/tailscaleStatus\(\)/.test(cert), 'the cert builder no longer waits on Tailscale');
  assert.ok(/_renewTailscaleCertLater\(certDir\)/.test(src) && /setSecureContext\(/.test(src), 'renewal happens after start and swaps the live cert');
});

test('main awaits the probe in every async caller and never blocks the renderer on it (source guard)', () => {
  const main = R('main.js');
  const slice = (start, len) => main.slice(main.indexOf(start), main.indexOf(start) + len);
  for (const [fn, len] of [['async function ensureTailscaleCertReady', 1200], ["ipcMain.handle('echocat-tailscale-status'", 1200], ["ipcMain.handle('echocat-issue-tailscale-cert'", 900], ['async function _refreshAltHosts', 600]]) {
    const s = slice(fn, len);
    assert.ok(/const ts = await refreshTailscaleStatus\(\);/.test(s), fn + ' awaits a fresh probe');
    assert.ok(!/= tailscaleStatus\(\)/.test(s), fn + ' has no synchronous probe');
  }
  assert.strictEqual((main.match(/await issueTailscaleCert\(/g) || []).length, 2, 'both cert issuers await');
  assert.ok((main.match(/try \{ await _refreshAltHosts\(\); \} catch \{\}/g) || []).length >= 2, 'the pairing QR and the pair link wait for the alt hosts they embed');
  assert.ok(/describeTailscaleNotReady\(ts\)/.test(main), 'the cert flows use the shared wording');
  assert.ok(/notReady: describeTailscaleNotReady\(ts\),/.test(main), 'the status IPC hands the renderer the wording');
  const diag = slice('function gatherDesktopRawDiagnostic', 6000);
  assert.ok(/backendState: \(ts && ts\.backendState\) \|\| null,/.test(diag) && /probe: tsProbe/.test(diag), 'the bug report carries the daemon state and the probe');
  const app = R('renderer/app.js');
  assert.ok(/s\.notReady \|\|/.test(app) && /tail\.notReady \|\|/.test(app), 'both cards show the named state');
});

(async () => {
  for (const { name, fn } of queue) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
  }
  RS._resetTailscaleProbeForTests && RS._resetTailscaleProbeForTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
