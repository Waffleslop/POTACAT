// Launch-time origin checks behind the Cloud Tunnel (K5AWJ 2026-09-17).
//
// Cloudflare had his tunnel healthy for hours while k5awj.potacat.com
// answered 502: POTACAT was running (cloudflared is its child) but its local
// server on :7300 was not answering, and nothing in the app looked. These
// tests pin the three things that now do:
//   - lib/origin-health.js   decideOriginState (pure) + probeLocalOrigin (live)
//   - lib/remote-server.js   bind failure is reported and retried; a missing
//                            TLS cert is refused behind the tunnel, never a
//                            silent plain-HTTP fallback
//   - lib/cloud-tunnel.js    the health tick runs the origin probe and the
//                            result rides getState().origin / 'change'
// plus source guards on main.js and the snapshot shape the phone consumes.
//
// Run: node test/launch-origin-test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');

const { decideOriginState, probeLocalOrigin, TUNNEL_INGRESS_PORT } = require('../lib/origin-health');
const { RemoteServer, getOrCreateTlsCert } = require('../lib/remote-server');
const { CloudTunnelManager } = require('../lib/cloud-tunnel');
const { assembleSections } = require('../lib/diagnostic-snapshot');

let failures = 0;
const queue = [];
function check(name, fn) {
  queue.push(async () => {
    try { await fn(); console.log(`  ok   ${name}`); }
    catch (err) { failures++; console.error(`  FAIL ${name}\n       ${err.stack || err.message}`); }
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms = 5000, step = 25) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (pred()) return true; await sleep(step); }
  return pred();
};
const freePort = () => new Promise((resolve) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-origin-'));

// ── decideOriginState ─────────────────────────────────────────────────────
const up = { listening: true, https: true, bindFailed: false, tlsFailed: false, lastError: '' };

check('decide: tunnel off → off', () => {
  assert.strictEqual(decideOriginState({ tunnelEnabled: false, tunnelStatus: 'off', port: 7300, server: up }).state, 'off');
});
check('decide: healthy tunnel, listening TLS, probe ok → ok, labelled Live', () => {
  const d = decideOriginState({ tunnelEnabled: true, tunnelStatus: 'live', port: 7300, server: up, probe: { ok: true, https: true } });
  assert.deepStrictEqual([d.state, d.label], ['ok', 'Live']);
});
check('decide: a changed ECHOCAT port is named first — the ingress does not follow it', () => {
  const d = decideOriginState({ tunnelEnabled: true, tunnelStatus: 'live', port: 7301, server: up, probe: { ok: true, https: true } });
  assert.strictEqual(d.state, 'port-mismatch');
  assert.ok(d.reason.includes('7301') && d.reason.includes(String(TUNNEL_INGRESS_PORT)));
  assert.strictEqual(TUNNEL_INGRESS_PORT, 7300, 'must match potacat-cloudlog routes/cloud-tunnel.js DESKTOP_HTTPS_PORT');
});
check('decide: bind failed → not-listening, carrying the server\'s own message', () => {
  const d = decideOriginState({ tunnelEnabled: true, tunnelStatus: 'live', port: 7300, server: { ...up, listening: false, bindFailed: true, lastError: 'port busy' } });
  assert.deepStrictEqual([d.state, d.reason], ['not-listening', 'port busy']);
});
check('decide: ECHOCAT switched off → not-listening with the caller\'s reason', () => {
  const d = decideOriginState({ tunnelEnabled: true, tunnelStatus: 'live', port: 7300, server: { listening: false, https: null, bindFailed: false, tlsFailed: false, lastError: 'ECHOCAT is switched off' } });
  assert.deepStrictEqual([d.state, d.reason], ['not-listening', 'ECHOCAT is switched off']);
});
check('decide: TLS failed (refused) or serving HTTP → http-origin', () => {
  assert.strictEqual(decideOriginState({ tunnelEnabled: true, tunnelStatus: 'live', port: 7300, server: { ...up, listening: false, https: false, tlsFailed: true } }).state, 'http-origin');
  assert.strictEqual(decideOriginState({ tunnelEnabled: true, tunnelStatus: 'live', port: 7300, server: { ...up, https: false } }).state, 'http-origin');
  assert.strictEqual(decideOriginState({ tunnelEnabled: true, tunnelStatus: 'live', port: 7300, server: up, probe: { ok: true, https: false } }).state, 'http-origin');
});
check('decide: listening but the probe got nothing → not-answering', () => {
  const d = decideOriginState({ tunnelEnabled: true, tunnelStatus: 'live', port: 7300, server: up, probe: { ok: false, https: true, error: 'timed out' } });
  assert.strictEqual(d.state, 'not-answering');
  assert.ok(d.reason.includes('timed out'));
});
check('decide: nothing known yet → pending (never amber on a guess)', () => {
  assert.strictEqual(decideOriginState({ tunnelEnabled: true, tunnelStatus: 'connecting', port: 7300, server: { listening: false, tlsFailed: true } }).state, 'http-origin');
  assert.strictEqual(decideOriginState({ tunnelEnabled: true, tunnelStatus: 'connecting', port: 7300, server: { listening: undefined } }).state, 'pending');
});

// ── probeLocalOrigin ──────────────────────────────────────────────────────
const cert = getOrCreateTlsCert(tmp, {});

check('probe: HTTPS listener → ok/https (self-signed accepted, as the tunnel does)', async () => {
  const srv = https.createServer({ cert: cert.cert, key: cert.key }, (req, res) => res.end('hi'));
  const port = await freePort();
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  try {
    const p = await probeLocalOrigin(port);
    assert.deepStrictEqual([p.ok, p.https, p.statusCode], [true, true, 200]);
  } finally { srv.close(); }
});
check('probe: plain HTTP listener → ok but https:false (the 502 case, told apart from no server)', async () => {
  const srv = http.createServer((req, res) => res.end('hi'));
  const port = await freePort();
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  try {
    const p = await probeLocalOrigin(port);
    assert.deepStrictEqual([p.ok, p.https], [true, false]);
  } finally { srv.close(); }
});
check('probe: nothing listening → not ok, ECONNREFUSED, no second attempt needed', async () => {
  const port = await freePort();
  const p = await probeLocalOrigin(port);
  assert.deepStrictEqual([p.ok, p.error], [false, 'ECONNREFUSED']);
});

// ── RemoteServer: bind outcome ────────────────────────────────────────────
const fastRetry = { fastAttempts: 2, fastDelayMs: 40, slowDelayMs: 150 };

check('server: a held port is reported as bindFailed, then binds by itself once the port frees', async () => {
  const port = await freePort();
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(port, '0.0.0.0', r));
  const rs = new RemoteServer();
  const states = [];
  const logs = [];
  rs.on('server-state', (s) => states.push(s));
  rs.on('log', (m) => logs.push(m));
  rs.start(port, null, { requireToken: true, tunnelExposed: true, certDir: tmp, bindRetry: fastRetry });
  try {
    assert.ok(await waitFor(() => states.some((s) => s.bindFailed)), 'bindFailed reported');
    assert.strictEqual(rs.running, false);
    assert.ok(rs.serverState().lastError.includes('keeps retrying'), 'message says it keeps retrying');
    assert.ok(logs.some((m) => /could not bind/.test(m)), 'failure reaches the log');
    await new Promise((r) => blocker.close(r));
    assert.ok(await waitFor(() => rs.running, 3000), 'bound after the port freed (slow retry)');
    const last = states[states.length - 1];
    assert.deepStrictEqual([last.listening, last.https, last.bindFailed], [true, true, false]);
  } finally { rs.stop(); try { blocker.close(); } catch {} }
});

check('server: stop() during the retry loop cancels it (no zombie listen)', async () => {
  const port = await freePort();
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(port, '0.0.0.0', r));
  const rs = new RemoteServer();
  const states = [];
  rs.on('server-state', (s) => states.push(s));
  rs.start(port, null, { requireToken: true, certDir: tmp, bindRetry: fastRetry });
  await waitFor(() => states.some((s) => s.bindFailed));
  rs.stop();
  await new Promise((r) => blocker.close(r));
  await sleep(fastRetry.slowDelayMs * 3);
  assert.strictEqual(rs.running, false, 'did not bind after stop()');
  const probe = await probeLocalOrigin(port);
  assert.strictEqual(probe.ok, false, 'nothing listening on the port');
});

// ── RemoteServer: TLS failure ─────────────────────────────────────────────
// A certDir that is a FILE makes every cert write fail (ENOTDIR/ENOENT).
const badCertDir = path.join(tmp, 'not-a-dir');
fs.writeFileSync(badCertDir, 'x');

check('server: no cert + tunnel exposed → refuses to start, says why in the log', async () => {
  const port = await freePort();
  const rs = new RemoteServer();
  const logs = [];
  const states = [];
  rs.on('log', (m) => logs.push(m));
  rs.on('server-state', (s) => states.push(s));
  rs.start(port, null, { requireToken: true, tunnelExposed: true, certDir: badCertDir, bindRetry: fastRetry });
  await sleep(200);
  try {
    assert.strictEqual(rs.running, false);
    const st = rs.serverState();
    assert.deepStrictEqual([st.listening, st.tlsFailed, st.https], [false, true, false]);
    assert.ok(logs.some((m) => /NOT started/.test(m) && /TLS certificate/.test(m)), 'refusal is in the log, not console only');
    assert.ok(states.length >= 1 && states[0].tlsFailed, 'server-state carried tlsFailed');
    assert.strictEqual((await probeLocalOrigin(port)).ok, false, 'nothing bound');
  } finally { rs.stop(); }
});

check('server: no cert on a LAN-only station → plain HTTP, but logged and flagged', async () => {
  const port = await freePort();
  const rs = new RemoteServer();
  const logs = [];
  rs.on('log', (m) => logs.push(m));
  rs.start(port, null, { requireToken: true, tunnelExposed: false, certDir: badCertDir, bindRetry: fastRetry });
  try {
    assert.ok(await waitFor(() => rs.running), 'listening');
    const st = rs.serverState();
    assert.deepStrictEqual([st.https, st.tlsFailed], [false, true]);
    assert.ok(logs.some((m) => /plain HTTP/.test(m)), 'fallback announced in the log');
    const probe = await probeLocalOrigin(port);
    assert.deepStrictEqual([probe.ok, probe.https], [true, false]);
    // Turning the tunnel on over it is called out, and the decision is http-origin.
    rs.setTunnelExposed(true);
    assert.ok(logs.some((m) => /WITHOUT TLS/.test(m)), 'exposure over HTTP warned');
    assert.strictEqual(decideOriginState({ tunnelEnabled: true, tunnelStatus: 'live', port: 7300, server: rs.serverState(), probe }).state, 'http-origin');
  } finally { rs.stop(); }
});

// ── CloudTunnelManager: probe wiring ──────────────────────────────────────
function makeManager(probe, healthy = true) {
  const logs = [];
  const m = new CloudTunnelManager({
    userDataPath: tmp,
    configPath: path.join(tmp, `ct-${Math.random().toString(36).slice(2)}.json`),
    getCloudSync: () => ({ _authedRequest: async () => ({ healthy, cloudHost: 'k3sbp.potacat.com' }) }),
    getCloudflaredPath: () => null,
    log: (s) => logs.push(s),
    probeOrigin: probe,
  });
  m._enabled = true; m._cloudHost = 'k3sbp.potacat.com';
  return { m, logs };
}

check('tunnel: a healthy tick runs the probe; a bad origin rides getState().origin and emits change + log', async () => {
  let result = { state: 'not-listening', label: 'Cloud up · POTACAT not answering', reason: 'port busy', actionable: true };
  const { m, logs } = makeManager(async () => result);
  const changes = [];
  m.on('change', (s) => changes.push(s));
  await m._checkOnce();
  assert.strictEqual(m.getState().status, 'live');
  assert.strictEqual(m.getState().origin.state, 'not-listening');
  assert.ok(changes.some((s) => s.origin && s.origin.state === 'not-listening'), 'change carried origin');
  assert.ok(logs.some((l) => /ORIGIN:/.test(l) && /port busy/.test(l)), 'named in the log');
  // Recovery: recheckOrigin flips it back and says so, once.
  result = { state: 'ok', label: 'Live', reason: '', actionable: false };
  await m.recheckOrigin();
  assert.strictEqual(m.getState().origin.state, 'ok');
  assert.ok(logs.some((l) => /origin recovered/.test(l)));
  const n = changes.length;
  await m.recheckOrigin();
  assert.strictEqual(changes.length, n, 'no change emitted when the state is unchanged');
});

check('tunnel: an unhealthy tick does not probe; turning off clears origin', async () => {
  let probes = 0;
  const { m } = makeManager(async () => { probes++; return { state: 'ok' }; }, false);
  await m._checkOnce();
  assert.strictEqual(probes, 0);
  m._origin = { state: 'not-listening' };
  m._setStatus('off');
  assert.strictEqual(m.getState().origin, null);
});

check('tunnel: a manager without a probe never invents an origin', async () => {
  const { m } = makeManager(undefined);
  await m._checkOnce();
  assert.strictEqual(m.getState().origin, null);
});

// ── Diagnostic snapshot carries both, additively ──────────────────────────
check('snapshot: connection.localServer and cloudTunnel.origin are present; section set unchanged', () => {
  const s = assembleSections({
    connection: { localServer: { enabled: true, listening: false, https: null, port: 7300, bindFailed: true, tlsFailed: false, lastError: 'busy' } },
    cloudTunnel: { enabled: true, status: 'live', origin: { state: 'not-listening', reason: 'busy', checkedAt: 1 } },
  }, { redact: true });
  assert.deepStrictEqual(Object.keys(s).sort(), ['account', 'cloudTunnel', 'connection', 'logLines', 'pairedDevices', 'rig', 'tailscale']);
  assert.deepStrictEqual(s.connection.localServer, { enabled: true, listening: false, https: null, port: 7300, bindFailed: true, tlsFailed: false, lastError: 'busy' });
  assert.deepStrictEqual(s.cloudTunnel.origin, { state: 'not-listening', reason: 'busy', checkedAt: 1 });
  assert.strictEqual(assembleSections({}, {}).connection.localServer, null);
});

// ── Source guards on main.js ──────────────────────────────────────────────
check('main.js: listens for server-state, probes the CONFIGURED port, and feeds the tunnel manager', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/remoteServer\.on\('server-state', onEchocatServerState\)/.test(src), 'server-state wired');
  const fn = src.slice(src.indexOf('async function probeOriginForTunnel'), src.indexOf('function connectRemote()'));
  assert.ok(/settings\.remotePort \|\| 7300/.test(fn), 'probe uses settings.remotePort');
  assert.ok(/probeLocalOrigin\(port\)/.test(fn), 'the real request goes to that port');
  assert.ok(/probeOrigin: \(\) => probeOriginForTunnel\(\)/.test(src), 'manager constructed with the probe');
  assert.ok(/cloudTunnel\.recheckOrigin\(\)/.test(src), 'server-state change rechecks the origin immediately');
  assert.ok(/localServer:/.test(src) && /origin: \(tunnel && tunnel\.origin\) \|\| null/.test(src), 'bug report carries both');
});

check('renderer: the cloud link is withheld unless the origin is ok', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.ok(/tunnel\.cloudHost && originOk\)/.test(app), 'app.js cloudUrl gate');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'cloud-ui.js'), 'utf8');
  assert.ok(/if \(hostText && linkable\)/.test(ui), 'cloud-ui link gate');
  assert.ok(/cloud-tunnel-origin/.test(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8')), 'origin notice markup');
});

(async () => {
  for (const run of queue) await run();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  if (failures) { console.error(`\n${failures} launch-origin test(s) FAILED`); process.exit(1); }
  console.log('\nall launch-origin tests passed');
})();
