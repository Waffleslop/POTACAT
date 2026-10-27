#!/usr/bin/env node
'use strict';
/**
 * Guest Pass hopping and take-over (Casey 2026-10-27): guests move between
 * rigs on a pass that lasts its whole window, and the owner can take the
 * radio back at any time and hand it back later.
 *
 * Who has the radio: the owner at any time (an owner device confirms with
 * pass-take-over; the desktop banner's Take over needs no confirm), else the
 * guest who holds it (connected, paused, or inside the 60 s reconnect hold),
 * else the next pass holder. A guest who leaves on purpose frees it at once.
 * A refused guest gets auth-fail {code:'rig_in_use', by}.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { PassEnforcement } = require('../lib/pass-enforcement');
const { RemoteServer } = require('../lib/remote-server');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  for (let t = 0; t < ms; t += 25) { if (fn()) return true; await sleep(25); }
  return false;
}

const TOKEN = 'hopping-token';
const CODE = 'abcd1234';

function client(port) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
  const c = { ws, got: [], closed: null };
  ws.on('message', (raw) => { try { c.got.push(JSON.parse(raw)); } catch {} });
  ws.on('close', (code) => { c.closed = code; });
  ws.on('error', () => {});
  c.open = new Promise((r) => ws.on('open', r));
  c.send = (m) => ws.send(JSON.stringify(m));
  c.has = (type, pred) => c.got.some((m) => m.type === type && (!pred || pred(m)));
  c.find = (type) => c.got.find((m) => m.type === type);
  return c;
}

function server(port) {
  const rs = new RemoteServer();
  const events = [];
  rs.on('log', () => {});
  for (const e of ['pass-paused', 'pass-resumed', 'pass-guest-left', 'pass-client-disconnected']) {
    rs.on(e, (info) => events.push({ e, info }));
  }
  const expires = new Date(Date.now() + 3600_000).toISOString();
  rs.setPassValidator(async (code) => ({
    code, privilege_class: 'general', max_power_w: 100, allowed_modes: [], expires_at: expires,
    station_callsign: '', owner_callsign: 'W7RTA', status: 'active', guest_callsign: code === CODE ? 'K3SBP' : code === 'anon0000' ? null : 'N0CALL',
  }));
  // main's rules, reduced: one pass at a time.
  const live = { live: false, paused: false, code: null, call: '', endsAt: expires };
  rs.setPassAuthCallback(async (code) => {
    if (live.live && live.code !== code) {
      const err = new Error('Another pass session is already active on this station');
      err.code = 'rig_in_use'; err.by = 'guest';
      throw err;
    }
    Object.assign(live, { live: true, code, call: 'K3SBP' });
  });
  rs.setPassLiveCheck(() => ({ ...live }));
  rs.on('pass-paused', () => { live.paused = true; });
  rs.on('pass-resumed', () => { live.paused = false; });
  rs.start(port, TOKEN, { requireToken: true, certDir: os.tmpdir() });
  return { rs, events, live };
}

async function guest(port, code = CODE) {
  const g = client(port);
  await g.open;
  g.send({ type: 'auth', mode: 'pass', passCode: code, sessionId: 'a'.repeat(64) });
  await until(() => g.has('auth-ok') || g.has('auth-fail'));
  return g;
}
async function owner(port) {
  const o = client(port);
  await o.open;
  o.send({ type: 'auth', token: TOKEN });
  await until(() => o.has('auth-ok') || o.has('auth-fail'));
  return o;
}

(async () => {
  console.log('PassEnforcement');
  check('pause gives the station back to the owner; resume lends it again; the timer keeps running', () => {
    const pe = new PassEnforcement({ revalidateMs: 0, log: () => {} });
    pe._state = 'active';
    pe._pass = { code: CODE, guest_callsign: 'K3SBP', privilege_class: 'us_technician', privilege_class_short: 'tech', max_power_w: 5, allowed_modes: ['FT8'] };
    pe._expiresAtMs = Date.now() + 3600_000;
    assert.strictEqual(pe.onAirCallsign('W7RTA'), 'K3SBP');
    assert.strictEqual(pe.interceptCatCommand({ type: 'tx_power', watts: 100 }).allowed, false, 'guest power cap');
    assert.strictEqual(pe.pause(), true);
    assert.strictEqual(pe.getState(), 'paused');
    assert.strictEqual(pe.onAirCallsign('W7RTA'), 'W7RTA', 'the owner\'s call while paused');
    assert.strictEqual(pe.interceptCatCommand({ type: 'tx_power', watts: 100 }).allowed, true, 'no guest limits while paused');
    assert.strictEqual(pe.interceptCatCommand({ type: 'tx_enable', freqHz: 14200000, mode: 'USB' }).allowed, true);
    assert.strictEqual(pe.getSessionStatus().code, CODE, 'the session is still there');
    assert.strictEqual(pe.resume(), true);
    assert.strictEqual(pe.getState(), 'active');
    assert.strictEqual(pe.onAirCallsign('W7RTA'), 'K3SBP');
    pe.endPass('test');
  });
  await checkAsync('a pass that ends while paused says so (main leaves the owner\'s transmitters alone)', async () => {
    const pe = new PassEnforcement({ revalidateMs: 0, log: () => {} });
    pe._state = 'active';
    pe._pass = { code: CODE, privilege_class: 'us_extra', max_power_w: 100, allowed_modes: [] };
    pe._expiresAtMs = Date.now() + 3600_000;
    pe.pause();
    let info = null;
    pe.on('ended', (i) => { info = i; });
    assert.strictEqual(pe.endPassIfCode(CODE, 'left'), true, 'a paused session can be ended by code');
    assert.ok(info && info.wasPaused === true && info.reason === 'left');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(pe.getState(), 'idle');
  });

  console.log('RemoteServer');
  await checkAsync('an owner device waits, takes over on confirm, and the guest gets the radio back when it leaves', async () => {
    const PORT = 17411;
    const { rs, events } = server(PORT);
    await sleep(500);
    try {
      const g = await guest(PORT);
      assert.ok(g.has('auth-ok'), 'guest admitted');
      const o = await owner(PORT);
      const ok = o.find('auth-ok');
      assert.ok(ok && ok.passGuest && ok.passGuest.callsign === 'K3SBP', 'auth-ok carries passGuest: ' + JSON.stringify(ok && ok.passGuest));
      await sleep(100);
      assert.strictEqual(g.closed, null, 'the guest was NOT kicked');
      assert.ok(!g.has('kicked'));
      o.send({ type: 'ping', ts: 1 });
      assert.ok(await until(() => o.has('pong')), 'a waiting owner device gets pongs');

      o.send({ type: 'pass-take-over' });
      assert.ok(await until(() => o.has('pass-take-over-ok')), 'owner told it operates');
      assert.ok(await until(() => g.has('pass-paused', (m) => m.by === 'owner')), 'guest told pass-paused');
      assert.ok(events.some((x) => x.e === 'pass-paused' && x.info.source === 'device'));
      assert.strictEqual(rs.isPassPaused(), true);
      assert.strictEqual(g.closed, null, 'the paused guest stays connected');
      assert.strictEqual(rs.hasActivePassClient(), true, 'a paused guest still holds the rig');

      // another pass holder is refused, with a code the phone can show
      const g2 = await guest(PORT, 'zzzz9999');
      const fail = g2.find('auth-fail');
      assert.ok(fail && fail.code === 'rig_in_use' && fail.by === 'guest', JSON.stringify(fail));
      g2.ws.close();

      rs._ownerHoldMs = 200;
      o.ws.close();
      assert.ok(await until(() => g.has('pass-resumed')), 'guest told pass-resumed when the owner device left (after the hold)');
      assert.ok(events.some((x) => x.e === 'pass-resumed' && x.info.guestConnected === true));
      assert.strictEqual(rs.isPassPaused(), false);
      const resumed = g.find('pass-resumed');
      assert.strictEqual(resumed.stationCallsign, 'K3SBP', 'the guest is on the air as themselves again');

      // the guest leaves on purpose: freed at once, no 60 s hold
      g.send({ type: 'pass-leave' });
      assert.ok(await until(() => g.has('pass-left')), 'pass-left ack');
      assert.ok(await until(() => g.closed != null), 'socket closed');
      assert.strictEqual(g.closed, 1000);
      assert.ok(events.some((x) => x.e === 'pass-guest-left' && x.info.code === CODE));
      await sleep(100);
      assert.ok(!events.some((x) => x.e === 'pass-client-disconnected'), 'a clean leave starts no reconnect hold');
    } finally { rs.stop(); await sleep(200); }
  });

  await checkAsync('a guest with no verified call is told an empty stationCallsign (listen only), never null', async () => {
    const PORT = 17419;
    const { rs } = server(PORT);
    await sleep(500);
    try {
      const g = await guest(PORT, 'anon0000');
      const ok = g.find('auth-ok');
      assert.ok(ok, 'admitted');
      assert.strictEqual(ok.stationCallsign, '', 'listen only is the empty string; null means an older desktop');
      g.ws.close();
    } finally { rs.stop(); await sleep(200); }
  });

  await checkAsync('the desktop takes over and gives back; an owner device cannot give back the desktop\'s take-over', async () => {
    const PORT = 17412;
    const { rs, events } = server(PORT);
    await sleep(500);
    try {
      const g = await guest(PORT);
      assert.strictEqual(rs.takeOverPass('desktop'), true);
      assert.ok(await until(() => g.has('pass-paused')));
      assert.strictEqual(rs.resumePass('device'), false);
      assert.strictEqual(rs.resumePass('desktop'), true);
      assert.ok(await until(() => g.has('pass-resumed')));
      assert.ok(events.some((x) => x.e === 'pass-paused' && x.info.source === 'desktop'));
      g.ws.close();
    } finally { rs.stop(); await sleep(200); }
  });

  await checkAsync('a guest returning while the owner operates is admitted paused', async () => {
    const PORT = 17413;
    const { rs } = server(PORT);
    await sleep(500);
    try {
      const g = await guest(PORT);
      rs.takeOverPass('desktop');
      g.ws.close();
      await sleep(150);
      const g2 = await guest(PORT);
      assert.ok(g2.has('auth-ok'), 'same pass is accepted');
      assert.ok(await until(() => g2.has('pass-paused')), 'and told it is paused');
      assert.ok(!g2.has('spots') && !g2.has('status'), 'a paused guest is not hydrated');
      rs.resumePass('desktop');
      assert.ok(await until(() => g2.has('pass-resumed') && g2.has('status')), 'hydrated on resume');
      g2.ws.close();
    } finally { rs.stop(); await sleep(200); }
  });

  await checkAsync('with no pass on the rig, a guest is refused while an owner device operates', async () => {
    const PORT = 17414;
    const { rs } = server(PORT);
    await sleep(500);
    try {
      const o = await owner(PORT);
      assert.ok(!o.find('auth-ok').passGuest, 'no guest to wait for');
      const g = await guest(PORT);
      const fail = g.find('auth-fail');
      assert.ok(fail && fail.code === 'rig_in_use' && fail.by === 'owner', JSON.stringify(fail));
      assert.strictEqual(o.closed, null, 'the owner was not kicked');
      o.ws.close(); g.ws.close();
    } finally { rs.stop(); await sleep(200); }
  });

  await checkAsync('Lend my rig: an idle owner device lets a guest in and waits; operating again does not take the rig, Take over does', async () => {
    const PORT = 17417;
    const { rs } = server(PORT);
    await sleep(500);
    try {
      const o = await owner(PORT);
      o.send({ type: 'owner-presence', operating: false });
      await sleep(100);
      const g = await guest(PORT);
      assert.ok(g.has('auth-ok') && !g.has('auth-fail'), 'an idle owner device lends the rig');
      assert.ok(await until(() => o.has('pass-guest-waiting', (m) => m.callsign === 'K3SBP')), 'the owner device is told who has it');
      assert.strictEqual(o.closed, null, 'and is not kicked');
      assert.ok(!o.has('kicked'));
      o.send({ type: 'owner-presence', operating: true });
      await sleep(150);
      assert.ok(!o.has('pass-take-over-ok') && !g.has('pass-paused'), 'operating again is not a take-over');
      o.send({ type: 'pass-take-over' });
      assert.ok(await until(() => o.has('pass-take-over-ok') && g.has('pass-paused')));
      // The owner's phone goes idle after taking over (an app switch): the rig
      // stays with the owner for the hold, and operating again keeps it.
      rs._ownerHoldMs = 300;
      o.send({ type: 'owner-presence', operating: false });
      await sleep(100);
      o.send({ type: 'owner-presence', operating: true });
      await sleep(450);
      assert.ok(!g.has('pass-resumed'), 'back inside the hold: the owner keeps the rig');
      // Idle past the hold: the guest gets it back.
      o.send({ type: 'owner-presence', operating: false });
      await sleep(100);
      assert.ok(!g.has('pass-resumed'), 'not at once');
      assert.ok(await until(() => g.has('pass-resumed')), 'an owner idle past the hold hands the rig back');
      assert.ok(await until(() => o.got.filter((m) => m.type === 'pass-guest-waiting').length === 2), 'and waits again');
      o.ws.close(); g.ws.close();
    } finally { rs.stop(); await sleep(200); }
  });

  await checkAsync('an owner device that took over and reconnects inside the hold is admitted as usual and keeps the rig', async () => {
    const PORT = 17418;
    const { rs } = server(PORT);
    await sleep(500);
    try {
      const g = await guest(PORT);
      const o = await owner(PORT);
      o.send({ type: 'pass-take-over' });
      assert.ok(await until(() => g.has('pass-paused')));
      rs._ownerHoldMs = 600;
      o.ws.close();                       // iOS dropped the socket in the background
      await sleep(150);
      const o2 = await owner(PORT);
      const ok = o2.find('auth-ok');
      assert.ok(ok && !ok.passGuest, 'a normal auth-ok: the owner already confirmed');
      await sleep(700);
      assert.ok(!g.has('pass-resumed'), 'the hold was kept by the reconnect');
      assert.strictEqual(rs.isPassPaused(), true);
      o2.ws.close(); g.ws.close();
    } finally { rs.stop(); await sleep(200); }
  });

  await checkAsync('a waiting owner device operates when the guest\'s pass ends', async () => {
    const PORT = 17415;
    const { rs, live } = server(PORT);
    await sleep(500);
    try {
      const g = await guest(PORT);
      const o = await owner(PORT);
      assert.ok(o.find('auth-ok').passGuest);
      live.live = false;
      rs.broadcastPassEnded('expired', CODE);
      assert.ok(await until(() => o.has('pass-guest-gone', (m) => m.reason === 'expired')));
      assert.ok(await until(() => g.closed === 4005));
      assert.ok(await until(() => o.has('status')), 'the owner device is hydrated');
      o.ws.close();
    } finally { rs.stop(); await sleep(200); }
  });

  await checkAsync('a guest plays their OWN voice recording once; no verified call, an oversize file and a stop are handled', async () => {
    const PORT = 17416;
    const { rs } = server(PORT);
    const played = [];
    let stops = 0;
    rs.on('voice-macro-play-audio', (x) => played.push(x));
    rs.on('voice-macro-stop', () => { stops++; });
    await sleep(500);
    try {
      const g = await guest(PORT);
      // No lease call yet: the guest has no verified identity and is refused.
      g.send({ type: 'voice-macro-play-audio', audio: 'AAAA', label: 'CQ' });
      assert.ok(await until(() => g.has('tune-blocked', (m) => /verified callsign/.test(m.reason))), 'refused without a verified call');
      assert.strictEqual(played.length, 0);
      rs.setLeaseCall('K3SBP');
      g.send({ type: 'voice-macro-play-audio', audio: 'AAAA', label: 'CQ POTA' });
      assert.ok(await until(() => played.length === 1));
      assert.deepStrictEqual(played[0], { audio: 'AAAA', label: 'CQ POTA', guest: true });
      g.send({ type: 'voice-macro-play-audio', audio: 'A'.repeat(4 * 1024 * 1024 + 4) });
      assert.ok(await until(() => g.has('tune-blocked', (m) => /too long/.test(m.reason))), 'an oversize recording is refused');
      assert.strictEqual(played.length, 1);
      g.send({ type: 'voice-macro-stop' });
      assert.ok(await until(() => stops === 1));
      rs.broadcastVoiceMacroPlaying(true, 'CQ POTA');
      assert.ok(await until(() => g.has('voice-macro-playing', (m) => m.playing === true && m.label === 'CQ POTA')));
      g.ws.close();
    } finally { rs.stop(); await sleep(200); }
  });

  console.log('main.js wiring');
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  check('a device recording asks the pass before it reaches the player, and is never written to disk', () => {
    const i = main.indexOf("remoteServer.on('voice-macro-play-audio'");
    const b = main.slice(i, i + 900);
    assert.ok(i > 0);
    assert.ok(b.indexOf('passTxAllowed(') > 0 && b.indexOf('passTxAllowed(') < b.indexOf("'play-voice-macro-audio'"));
    assert.ok(!/writeFile/.test(b), 'not stored');
    assert.ok(main.includes("remoteServer.on('voice-macro-stop'"));
  });
  check('the renderer plays slots and device recordings through one player that reports what is on the air', () => {
    const app = fs.readFileSync(path.join(ROOT, 'renderer/app.js'), 'utf8');
    assert.ok(/async function playVoiceAudio\(/.test(app));
    assert.ok(/playVoiceAudio\(base64, \{ idx: idx/.test(app), 'slots use it');
    assert.ok(/onPlayVoiceMacroAudio\([\s\S]{0,200}playVoiceAudio\(info\.audio/.test(app), 'device recordings use it');
    assert.ok(/voiceMacroPlaying\(\{ playing: true/.test(app) && /voiceMacroPlaying\(\{ playing: false/.test(app));
  });
  check('pause stops the guest\'s transmitters, then gives the station back', () => {
    const i = main.indexOf("rs.on('pass-paused'");
    const b = main.slice(i, i + 700);
    assert.ok(i > 0);
    assert.ok(b.indexOf('passLeaseStopTransmitters(') < b.indexOf('passEnforcement.pause()'));
  });
  check('resume stops the owner\'s transmitters, then lends the station again', () => {
    const i = main.indexOf("rs.on('pass-resumed'");
    const b = main.slice(i, i + 700);
    assert.ok(i > 0);
    assert.ok(b.indexOf('passLeaseStopTransmitters(') < b.indexOf('passEnforcement.resume()'));
  });
  check('a pass ending while paused stops nothing of the owner\'s', () => {
    assert.ok(/info\.wasPaused \? \[\] : passLeaseStopTransmitters\(info\.reason\)/.test(main));
  });
  check('a second pass is refused with rig_in_use while one is held, paused or inside the hold', () => {
    const i = main.indexOf('rs.setPassAuthCallback(');
    const b = main.slice(i, i + 2500);
    assert.ok(/hasActivePassClient\(\) \|\| passClientDisconnectTimer \|\| state === 'paused'/.test(b));
    assert.ok(/err\.code = 'rig_in_use'/.test(b));
  });
  check('the live check, a clean leave and the banner IPC are wired', () => {
    assert.ok(main.includes('rs.setPassLiveCheck('));
    assert.ok(/rs\.on\('pass-guest-left'[\s\S]{0,200}endPassIfCode\(code, 'left'\)/.test(main));
    assert.ok(main.includes("ipcMain.handle('pass-take-over'") && main.includes("ipcMain.handle('pass-give-back'"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
