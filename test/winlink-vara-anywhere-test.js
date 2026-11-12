#!/usr/bin/env node
'use strict';
// VARA HF and VARA FM on every system (#287; Casey 2026-11-11: "I want mac,
// Linux and windows to have all available modems"). VARA stays the operator's
// own copy: on Windows, under Wine on Linux or macOS, or on another computer.
// POTACAT starts it only on Windows for a copy on this PC; everywhere else it
// only connects to its TCP ports. A fake VARA TNC (test/fake-vara-tnc.js)
// stands in for VARA; with Pat's binary present the real Pat drives it.
// Run: node test/winlink-vara-anywhere-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { readSrc } = require('./_src');
const M = require('../lib/winlink-modes');
const V = require('../lib/vara-process');
const W = require('../lib/winlink-pat');
const { startFakeVaraTnc } = require('./fake-vara-tnc');

const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
let pass = 0, fail = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const base = { rigFamily: 'icom', audioSource: 'dax', ardopSocketAudio: true, ardopFound: true, direwolfFound: true };
const mode = (list, id) => list.find((m) => m.id === id);

test('VARA HF and VARA FM are offered on Linux, macOS and Windows', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const list = M.winlinkModesFor({ ...base, platform, varaHf: { enabled: true, port: 8300 }, varaFm: { enabled: true, port: 8310 } });
    for (const id of ['vara', 'varafm']) {
      const m = mode(list, id);
      assert.ok(m, `${id} listed on ${platform}`);
      assert.strictEqual(m.available, true, `${id} available on ${platform}: ${m.reason}`);
      assert.ok(!/Windows program/.test(m.reason));
    }
  }
});

test('the reasons name what is actually missing', () => {
  // Network audio and no cable: VARA here cannot open the radio; VARA on another computer can.
  const flexLocal = mode(M.winlinkModesFor({ ...base, platform: 'linux', audioSource: 'smartsdr', varaHf: { enabled: true, port: 8300, host: '127.0.0.1' } }), 'vara');
  assert.ok(!flexLocal.available && /virtual audio cable/.test(flexLocal.reason));
  const flexRemote = mode(M.winlinkModesFor({ ...base, platform: 'darwin', audioSource: 'smartsdr', varaHf: { enabled: true, port: 8300, host: '192.168.1.50' } }), 'vara');
  assert.ok(flexRemote.available, 'VARA on another computer uses that computer\'s sound card');
  const bad = mode(M.winlinkModesFor({ ...base, platform: 'linux', varaHf: { enabled: true, port: 8300, hostBad: 'my vara!' } }), 'vara');
  assert.ok(!bad.available && /is not a computer name or address/.test(bad.reason));
  // A port clash is a clash only on the same computer.
  const clash = mode(M.winlinkModesFor({ ...base, platform: 'linux', varaHf: { enabled: true, port: 8300 }, varaFm: { enabled: true, port: 8300 } }), 'varafm');
  assert.ok(!clash.available && /same port/.test(clash.reason));
  const apart = mode(M.winlinkModesFor({ ...base, platform: 'linux', varaHf: { enabled: true, port: 8300, host: '127.0.0.1' }, varaFm: { enabled: true, port: 8300, host: '10.0.0.9' } }), 'varafm');
  assert.ok(apart.available, 'VARA FM on another computer may use 8300');
  const merc = mode(M.winlinkModesFor({ ...base, platform: 'linux', mercuryEnabled: true, mercuryPort: 8300, varaHf: { enabled: true, port: 8300, host: '10.0.0.9' } }), 'vara');
  assert.ok(merc.available, 'Mercury on this PC does not clash with VARA on another');
  const remote = mode(M.winlinkModesFor({ ...base, platform: 'linux', remote: true, varaHf: { enabled: true, port: 8300 } }), 'vara');
  assert.ok(!remote.available, 'a desktop driving another shack still starts radio sessions there');
});

test('hosts: cleaned, local or not, written for Pat', () => {
  assert.strictEqual(V.normalizeVaraHost(''), '127.0.0.1');
  assert.strictEqual(V.normalizeVaraHost('  192.168.1.50 '), '192.168.1.50');
  assert.strictEqual(V.normalizeVaraHost('[::1]'), '::1');
  assert.strictEqual(V.normalizeVaraHost('vara-pc.local'), 'vara-pc.local');
  assert.strictEqual(V.normalizeVaraHost('a b'), null);
  assert.strictEqual(V.normalizeVaraHost('host;rm'), null);
  assert.ok(V.isLocalVaraHost('127.0.0.1') && V.isLocalVaraHost('localhost') && V.isLocalVaraHost('::1'));
  assert.ok(!V.isLocalVaraHost('192.168.1.50'));
  assert.strictEqual(V.varaAddr('192.168.1.50', 8300), '192.168.1.50:8300');
  assert.strictEqual(V.varaAddr('fe80::1', 8310), '[fe80::1]:8310');
  assert.strictEqual(V.varaAddr('', 8300), '127.0.0.1:8300');
  assert.strictEqual(V.varaHostFor({ winlinkVaraFmHost: 'shack-pc' }, 'fm'), 'shack-pc');
  assert.strictEqual(V.varaHostFor({ winlinkVaraHost: 'bad host' }, 'hf'), '127.0.0.1', 'a bad host never reaches Pat');
});

test('review: a host with a port in it, a name that only looks local, ports next to each other', () => {
  // "host:port" is not an IPv6 address: it must never reach Pat as "[192.168.1.5:8300]:8300".
  assert.strictEqual(V.normalizeVaraHost('192.168.1.5:8300'), null);
  assert.strictEqual(V.normalizeVaraHost('shack-pc:8300'), null);
  assert.match(V.varaHostProblem('192.168.1.5:8300'), /has a port in it.*Port box/);
  assert.match(V.varaHostProblem('my vara!'), /is not a computer name or address/);
  assert.strictEqual(V.normalizeVaraHost('fe80::1'), 'fe80::1', 'IPv6 still passes');
  assert.strictEqual(V.normalizeVaraHost('-shack'), null);
  assert.strictEqual(V.normalizeVaraHost('shack.'), null);
  // 127.x.x.x is this computer only as an address: a name beginning "127." is on the network,
  // so POTACAT never starts a local VARA for it and never treats its audio as local.
  assert.ok(!V.isLocalVaraHost('127.example.com'));
  assert.ok(V.isLocalVaraHost('127.0.0.2'));
  assert.ok(!V.canLaunchVara({ platform: 'win32', host: '127.example.com' }));
  const named = mode(M.winlinkModesFor({ ...base, platform: 'win32', audioSource: 'smartsdr', varaHf: { enabled: true, port: 8300, host: '127.example.com' } }), 'vara');
  assert.ok(named.available, 'the mode list reads that name as another computer too');
  // VARA's data port is its command port plus one: HF on 8300 holds 8301.
  const next = mode(M.winlinkModesFor({ ...base, platform: 'linux', varaHf: { enabled: true, port: 8300 }, varaFm: { enabled: true, port: 8301 } }), 'varafm');
  assert.ok(!next.available && /next to each other \(8301 and 8300\)/.test(next.reason), next.reason);
  const below = mode(M.winlinkModesFor({ ...base, platform: 'linux', varaHf: { enabled: true, port: 8300 }, varaFm: { enabled: true, port: 8299 } }), 'varafm');
  assert.ok(!below.available, 'VARA FM on 8299 would hold 8300');
  const nextApart = mode(M.winlinkModesFor({ ...base, platform: 'linux', varaHf: { enabled: true, port: 8300 }, varaFm: { enabled: true, port: 8301, host: '10.0.0.9' } }), 'varafm');
  assert.ok(nextApart.available, 'only on the same computer');
});

test('review: Test says what happened in plain words; Set up refuses a VARA on another computer', () => {
  assert.strictEqual(V.varaTestText('hf', { probe: { ok: true, version: 'VARA HF v4.8.7' }, host: '127.0.0.1', port: 8300 }), 'VARA HF answered at 127.0.0.1:8300 (VARA HF v4.8.7).');
  assert.match(V.varaTestText('hf', { probe: { ok: false, error: 'refused' }, host: '127.0.0.1', port: 8300 }), /^VARA HF did not answer at 127\.0\.0\.1:8300\. Start VARA HF and check that its TCP port is 8300\.$/);
  assert.match(V.varaTestText('fm', { probe: { ok: false, error: 'refused' }, host: '10.0.0.9', port: 8310 }), /Start VARA FM on that computer/);
  assert.match(V.varaTestText('hf', { probe: { ok: false, error: 'ENOTFOUND' }, host: 'shack-pc', port: 8300 }), /No computer named "shack-pc" was found/);
  assert.match(V.varaTestText('hf', { probe: { ok: false, error: 'timeout' }, host: '10.0.0.9', port: 8300 }), /firewall/);
  assert.match(V.varaTestText('hf', { probe: { ok: true, version: '', silent: true }, host: '127.0.0.1', port: 8300 }), /did not give a VARA version/);
  for (const k of ['refused', 'timeout', 'ENOTFOUND', 'EHOSTUNREACH']) assert.ok(!/ECONN|ENOT|EHOST/.test(V.varaTestText('hf', { probe: { ok: false, error: k }, host: 'shack-pc', port: 8300 })), 'no error codes in the words');
  assert.ok(main.includes(': VaraProcess.varaTestText(kind, { probe, host, port });'), 'the Test button uses those words where POTACAT does not start VARA');
  const s = main.slice(main.indexOf('async function winlinkVaraSetup('), main.indexOf('async function winlinkVaraSetup(') + 900);
  assert.ok(s.indexOf('if (!_winlinkVaraLaunches(kind)) {') > 0 && s.indexOf('if (!_winlinkVaraLaunches(kind)) {') < s.indexOf('winlinkVaraConfigure('), '"Set up VARA for me" writes no local settings for a VARA on another computer');
  assert.ok(main.includes('if (!_winlinkVaraLaunches(kind)) continue; // a VARA on another computer is not ours to configure (#287)'), 'nor does a rig switch');
  assert.ok(!/probeVaraPort\(port\);/.test(main.slice(main.indexOf('async function winlinkVaraReady('), main.indexOf('async function winlinkVaraAudioReady('))), 'every probe in a session names the host');
});

test('POTACAT starts VARA only on Windows, for a copy on this PC', () => {
  assert.ok(V.canLaunchVara({ platform: 'win32', host: '127.0.0.1' }));
  assert.ok(!V.canLaunchVara({ platform: 'win32', host: '192.168.1.50' }));
  assert.ok(!V.canLaunchVara({ platform: 'linux', host: '127.0.0.1' }));
  assert.ok(!V.canLaunchVara({ platform: 'darwin', host: '127.0.0.1' }));
  assert.match(V.describeVara('hf', { enabled: true, probe: { ok: false, error: 'refused' }, host: '127.0.0.1', port: 8300, launches: false }), /at 127\.0\.0\.1:8300, started by you, not running/);
  assert.match(V.varaWhere('10.0.0.9', 8300), /another computer: VARA's audio runs there/);
});

test('Pat gets VARA at its host and port', () => {
  // The radio-control stand-in's port is what turns the radio transports on in Pat's config.
  const cfg = W.buildPatConfig({ mycall: 'K3SBP', shimPort: 4541, transport: { varaAddr: V.varaAddr('192.168.1.50', 8300), varaFmAddr: V.varaAddr('127.0.0.1', 8310) } });
  assert.strictEqual(cfg.varahf.addr, '192.168.1.50:8300');
  assert.strictEqual(cfg.varafm.addr, '127.0.0.1:8310');
});

test('main: host settings, Pat config, no launch off Windows, no local audio for a remote VARA', () => {
  assert.ok(/const addr = varaAddr \|\| VaraProcess\.varaAddr\(_winlinkVaraHost\('hf'\), _winlinkVaraPort\(\)\);/.test(main));
  assert.ok(/varaFmAddr: VaraProcess\.varaAddr\(_winlinkVaraHost\('fm'\), _winlinkVaraFmPort\(\)\)/.test(main));
  const i = main.indexOf('async function winlinkVaraReady(');
  const fn = main.slice(i, main.indexOf('\nasync function ', i + 10) > 0 ? main.indexOf('\n/**', i + 10) : i + 6000);
  const refuse = fn.indexOf('if (!probe.ok && !_winlinkVaraLaunches(kind))');
  const spawnAt = fn.indexOf('spawn(bin.path');
  assert.ok(refuse > 0 && spawnAt > refuse, 'off Windows (or another computer) it says so before any launch');
  assert.ok(/probeVaraPort\(port, \{ host \}\)/.test(fn));
  assert.ok(/'winlinkVaraHost',/.test(main) && /'winlinkVaraFmHost',/.test(main), 'machine settings, kept per computer');
  assert.ok(/'winlinkVaraHost', 'winlinkVaraFmHost',/.test(main), 'a host change rewrites Pat\'s config');
  const a = main.indexOf('async function winlinkVaraAudioReady(mode)');
  assert.ok(a > 0 && /if \(!VaraProcess\.isLocalVaraHost\(_winlinkVaraHost\(kind\)\)\) \{[\s\S]{0,300}return 'remote';/.test(main.slice(a, a + 800)));
});

test('Settings: VARA on every system, host and Test off Windows, Windows-only parts hidden', () => {
  const html = readSrc(path.join(root, 'renderer', 'index.html'));
  const app = readSrc(path.join(root, 'renderer', 'app.js'));
  assert.ok(/<div style="font-weight:600;">VARA \(your own copy\)<\/div>/.test(html));
  assert.ok(/id="set-vara-hf-host"/.test(html) && /id="set-vara-fm-host"/.test(html));
  assert.ok(/class="vara-other-only" id="vara-hf-test">Test<\/button>/.test(html));
  assert.ok(/<label class="vara-win-only">Program:/.test(html), 'no program path off Windows');
  assert.ok(/winlinkVaraSection\.classList\.remove\('hidden'\);/.test(app) && !/winlinkVaraSection\.classList\.toggle\('hidden', window\.api\.platform !== 'win32'\)/.test(app));
  assert.ok(/winlinkVaraHost: setVaraHfHost\.value\.trim\(\)/.test(app));
});

// The probe and Pat against the fake VARA.
test('the probe reaches a VARA at its host', async () => {
  const tnc = await startFakeVaraTnc();
  try {
    const r = await V.probeVaraPort(tnc.port, { host: tnc.host, timeoutMs: 1500 });
    assert.ok(r.ok && /fake/.test(r.version), JSON.stringify(r));
  } finally { await tnc.close(); }
  const off = await V.probeVaraPort(1, { host: '127.0.0.1', timeoutMs: 800 });
  assert.ok(!off.ok);
});

function findPat() {
  for (const p of [path.join(root, 'assets', 'pat', 'pat.exe'), path.join(root, 'assets', 'pat', 'pat')]) if (fs.existsSync(p)) return p;
  return null;
}
function get(port, p, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: timeoutMs }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
  });
}

test('the real Pat drives a VARA at its host and port (skipped without Pat\'s binary)', async () => {
  const bin = findPat();
  if (!bin) { console.log('       SKIP: no Pat binary in assets/pat (the release build has one)'); return; }
  const tnc = await startFakeVaraTnc();
  // POTACAT's own rigctld shim (lib/rigctld-server.js), with a pretend radio
  // on 7.100 MHz that never keys: what Pat talks to for the rig in real life.
  const { createRigctldServer } = require('../lib/rigctld-server');
  let freqHz = 7100000, ptt = false;
  const shim = createRigctldServer({ getFreqHz: () => freqHz, setFreqHz: (hz) => { freqHz = hz; return true; }, getPtt: () => ptt, setPtt: (on) => { ptt = !!on; return true; } });
  const shimPort = await shim.listen(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-vara-'));
  const httpPort = 18700 + Math.floor(Math.random() * 200);
  const cfg = W.buildPatConfig({ mycall: 'N0CALL', httpPort, shimPort, transport: { varaAddr: V.varaAddr(tnc.host, tnc.port), varaFmAddr: V.varaAddr(tnc.host, tnc.port) } });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
  fs.mkdirSync(path.join(dir, 'mbox'));
  const args = W.buildPatArgs({ configPath: path.join(dir, 'config.json'), mboxDir: path.join(dir, 'mbox'), logPath: path.join(dir, 'pat.log'), eventLogPath: path.join(dir, 'events.json') });
  const pat = spawn(bin, args, { stdio: 'ignore', windowsHide: true });
  const cleanup = [];
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await new Promise((r) => setTimeout(r, 250)); up = (await get(httpPort, '/api/status', 1000)).status === 200; }
    assert.ok(up, 'Pat started');
    // Before any call Pat asks winlink.org whether the account exists, and for
    // a call it cannot confirm it waits for the operator on its WebSocket:
    // POTACAT's own client answers there, as it does in the app.
    const { WinlinkClient } = require('../lib/winlink-client');
    const client = new WinlinkClient({ port: httpPort });
    client.on('event', (ev) => { if (ev.kind === 'prompt' && /account/i.test(ev.prompt)) client.respondPrompt(ev.id, 'confirmed'); });
    client.openEvents();
    cleanup.push(() => client.close());
    await new Promise((r) => setTimeout(r, 500));
    const cr = await get(httpPort, '/api/connect?url=' + encodeURIComponent('varahf:///W1AW'), 15000);
    if (!tnc.commands.length) console.log('       connect answered', cr.status, String(cr.body).slice(0, 300));
    const seen = tnc.commands.join(' | ');
    for (const want of ['PUBLIC ON', 'MYCALL N0CALL', 'LISTEN OFF']) assert.ok(tnc.commands.includes(want), `Pat sent ${want}: ${seen}`);
    assert.ok(tnc.commands.some((c) => /^CONNECT N0CALL W1AW$/.test(c)), 'Pat placed the call through VARA at its host: ' + seen);
  } finally {
    for (const f of cleanup) { try { f(); } catch {} }
    try { pat.kill(); } catch {}
    await tnc.close();
    shim.close();
  }
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/winlink-vara-anywhere-test.js'"));
});

(async () => {
  console.log('VARA on every system (#287)');
  for (const [name, fn] of tests) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
