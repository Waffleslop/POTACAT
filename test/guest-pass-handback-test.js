#!/usr/bin/env node
'use strict';
// GitHub #200, #541 step 4: the hand-back rule (Casey 2026-11-14).
//
// The radio stays the owner's while the owner uses it. After 5 minutes with
// no owner activity the guest is told the radio is free (waiting/owner-idle)
// and may press "Take the radio" (C2S pass-take-back). Nothing switches on its
// own, "Give it back" stays immediate, and the old 2-minute automatic
// hand-back is gone.
//
// Pinned here (fake clock throughout):
//   1. 5 minutes of no owner activity gives owner-idle; activity resets it
//   2. passive events do not count (lib/pass-owner-activity.js)
//   3. pass-take-back is granted on owner-idle, to the device that was on the
//      air, and refused otherwise (owner using it, owner-soon, a waiting
//      second device, an older client)
//   4. the idle offer seam fires once per offer
//   5. old phones keep pass-paused and wait for Give it back
//   6. the 2-minute hand-back is gone (a source guard)
//   7. the glue: wording, the owner's status line, both remote surfaces, docs

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const PS = require('../lib/pass-state');
const OC = require('../lib/pass-owner-controls');
const OA = require('../lib/pass-owner-activity');
const W = require('../lib/pass-wording');
const protocol = require('../lib/echocat-protocol');
const { RemoteServer } = require('../lib/remote-server');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  for (let t = 0; t < ms; t += 25) { if (fn()) return true; await sleep(25); }
  return false;
}

const T0 = Date.parse('2026-11-14T20:00:00.000Z');
const MIN = 60 * 1000;
const END = '2026-11-14T23:00:00.000Z';

(async () => {
  console.log('=== #200 / #541 step 4: the hand-back rule ===');

  // ------------------------------------------------------------ 1. the rule, pure
  await check('5 minutes with no owner activity gives waiting/owner-idle, not before', () => {
    assert.strictEqual(PS.OWNER_IDLE_MS, 5 * MIN);
    const hold = OC.takeNow(OC.initial(), { now: T0 }).controls.hold;
    assert.strictEqual(PS.msUntilOwnerIdle(hold, T0), 5 * MIN, 'one timer, for the whole wait');
    assert.strictEqual(PS.ownerIdleDue(hold, T0 + 5 * MIN - 1), false);
    assert.deepStrictEqual(PS.offerOwnerIdle(hold, T0 + 4 * MIN), { hold, offered: false });
    const r = PS.offerOwnerIdle(hold, T0 + 5 * MIN);
    assert.strictEqual(r.offered, true);
    assert.strictEqual(r.hold.idle, true);
    assert.strictEqual(r.hold.idleAt, T0 + 5 * MIN);
    const ps = PS.forConnection({ ownerHolds: true, ownerIdle: r.hold.idle, endsAt: END });
    assert.deepStrictEqual([ps.state, ps.reason], ['waiting', 'owner-idle']);
    assert.strictEqual(PS.msUntilOwnerIdle(null, T0), null, 'no hold, no timer');
  });

  await check('owner activity resets the wait and withdraws an offer (back to owner-has-radio)', () => {
    let hold = OC.takeNow(OC.initial(), { now: T0 }).controls.hold;
    hold = PS.noteOwnerActive(hold, T0 + 4 * MIN);
    assert.strictEqual(PS.offerOwnerIdle(hold, T0 + 5 * MIN).offered, false, 'the clock restarted at the activity');
    assert.strictEqual(PS.msUntilOwnerIdle(hold, T0 + 5 * MIN), 4 * MIN);
    const offered = PS.offerOwnerIdle(hold, T0 + 9 * MIN).hold;
    assert.strictEqual(offered.idle, true);
    const back = PS.noteOwnerActive(offered, T0 + 10 * MIN);
    assert.ok(!back.idle && back.idleAt === undefined, 'offer withdrawn');
    assert.strictEqual(PS.forConnection({ ownerHolds: true, ownerIdle: !!back.idle }).reason, 'owner-has-radio');
    assert.strictEqual(PS.offerOwnerIdle(back, T0 + 15 * MIN).offered, true, 'a later idle spell offers again');
  });

  // ------------------------------------------------------------ 2. what counts
  await check('owner activity is one list; passive events do not count', () => {
    assert.deepStrictEqual([...OA.KINDS], ['ptt', 'cw', 'tune', 'mode', 'jtcat-tx', 'winlink', 'data-tx', 'radio-tx']);
    for (const k of OA.KINDS) assert.ok(OA.isOwnerActivity(k), k);
    for (const k of OA.PASSIVE) assert.ok(!OA.isOwnerActivity(k), 'passive: ' + k);
    for (const k of ['', null, undefined, 'decode', 'spots', 'smeter', 'swr']) assert.ok(!OA.isOwnerActivity(k), String(k));
    // ECHOCAT messages from an owner device.
    const kind = (m) => OA.fromEchocatMessage(m);
    assert.strictEqual(kind({ type: 'ptt', state: true }), 'ptt');
    assert.strictEqual(kind({ type: 'ptt', state: false }), null, 'a key-up is not use');
    assert.strictEqual(kind({ type: 'paddle', state: 1 }), 'cw');
    assert.strictEqual(kind({ type: 'cw-key', down: false }), null);
    assert.strictEqual(kind({ type: 'cw-text', text: 'CQ' }), 'cw');
    assert.strictEqual(kind({ type: 'tune', freqKhz: 14074 }), 'tune');
    assert.strictEqual(kind({ type: 'set-mode', mode: 'USB' }), 'mode');
    assert.strictEqual(kind({ type: 'jtcat-call-cq' }), 'jtcat-tx');
    assert.strictEqual(kind({ type: 'jtcat-enable-tx', enabled: false }), null);
    assert.strictEqual(kind({ type: 'winlink-connect' }), 'winlink');
    assert.strictEqual(kind({ type: 'sstv-photo' }), 'data-tx');
    for (const t of ['ping', 'owner-presence', 'scope-subscribe', 'jtcat-spectrum-subscribe', 'refresh-events', 'get-all-qsos',
      'winlink-list', 'winlink-read', 'lookup-call', 'scan-state', 'toString', '__proto__']) {
      assert.strictEqual(kind({ type: t }), null, 'passive: ' + t);
    }
    assert.strictEqual(kind(null), null);
  });

  // ------------------------------------------------------------ 2b. the radio's own TX
  // A fake clock with timers: run(ms) moves time and fires what is due.
  function fakeTimers() {
    const t = { now: 0, q: [], id: 0 };
    t.setTimeout = (fn, ms) => { const h = { id: ++t.id, at: t.now + ms, fn }; t.q.push(h); return h; };
    t.clearTimeout = (h) => { t.q = t.q.filter((x) => x !== h); };
    t.run = (ms) => {
      const end = t.now + ms;
      for (;;) {
        t.q.sort((a, b) => a.at - b.at);
        const h = t.q[0];
        if (!h || h.at > end) break;
        t.q.shift(); t.now = h.at; h.fn();
      }
      t.now = end;
    };
    return t;
  }
  const watch = (t, hits) => OA.createRadioTxWatch({ onActive: (k) => hits.push([t.now, k]), now: () => t.now, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout });

  await check("radio-tx: the radio's TX status held 1 s counts, then every 30 s; a sub-second blip does nothing", () => {
    const t = fakeTimers(); const hits = []; const w = watch(t, hits);
    w.cat(true); t.run(400); w.cat(false); t.run(5000);
    assert.deepStrictEqual(hits, [], 'a 0.4 s blip is not use');
    w.cat(true); t.run(999);
    assert.deepStrictEqual(hits, [], 'not before 1 s');
    t.run(1);
    assert.deepStrictEqual(hits, [[t.now, 'radio-tx']], 'counted at 1 s');
    t.run(60 * 1000);
    assert.strictEqual(hits.length, 3, 'a long over counts again every 30 s: ' + JSON.stringify(hits));
    w.cat(false); t.run(60 * 1000);
    assert.strictEqual(hits.length, 3, 'nothing after the over');
  });

  await check('radio-tx: forward power counts only when it stays above the floor for 1 s; one glitch reading does nothing', () => {
    const t = fakeTimers(); const hits = []; const w = watch(t, hits);
    w.fwd(45); t.run(10 * 1000);
    assert.deepStrictEqual(hits, [], 'a single 45 W reading is a glitch');
    w.fwd(0.2); t.run(300); w.fwd(0.3); t.run(1000); w.fwd(0.4);
    assert.deepStrictEqual(hits, [], 'below the floor (noise) never counts');
    w.fwd(20); t.run(500); w.fwd(21);
    assert.deepStrictEqual(hits, [], 'only 0.5 s of power');
    t.run(500); w.fwd(22);
    assert.strictEqual(hits.length, 1, 'power for 1 s counts');
    t.run(5000);
    assert.strictEqual(hits.length, 1, 'readings stopped: the stale reading ends it, no repeat');
  });

  await check('radio-tx: a TX report that never ends stops counting after 10 minutes', () => {
    const t = fakeTimers(); const hits = []; const w = watch(t, hits);
    w.cat(true); t.run(60 * 60 * 1000);
    assert.ok(hits.length >= 20 && hits.length <= 21, 'capped: ' + hits.length);
    assert.ok(hits[hits.length - 1][0] <= OA.RADIO_TX_MAX_MS, 'nothing after the cap');
    w.cat(false); w.cat(true); t.run(1000);
    assert.strictEqual(hits[hits.length - 1][0], t.now, 'a new over counts again');
  });

  // ------------------------------------------------------------ 3. take-back, pure
  await check('take-back: only on owner-idle, from the device that was on the air, never during a take', () => {
    assert.strictEqual(PS.canTakeBack({ ownerHolds: true, ownerIdle: true }), true);
    assert.strictEqual(PS.canTakeBack({ ownerHolds: true, ownerIdle: false }), false, 'owner using it');
    assert.strictEqual(PS.canTakeBack({ ownerHolds: false, ownerIdle: true }), false, 'nothing held');
    assert.strictEqual(PS.canTakeBack({ ownerHolds: true, ownerIdle: true, standby: true }), false, 'a waiting second device');
    assert.strictEqual(PS.canTakeBack({ take: { at: T0 + 5 * MIN } }), false, 'owner-soon');
    assert.strictEqual(PS.canTakeBack({}), false);
    // A waiting second device is not offered a button it cannot use.
    assert.strictEqual(PS.forConnection({ ownerHolds: true, ownerIdle: true, standby: true }).reason, 'owner-has-radio');
  });

  // ------------------------------------------------------------ 4. the station
  const TOKEN = 'owner-token-200-4';
  const CODE = 'abcd1234';
  const SID = 'c'.repeat(64);
  const FLAG = ['pass-state'];

  function client(port) {
    const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const c = { ws, got: [], closed: null };
    ws.on('message', (raw) => { try { c.got.push(JSON.parse(raw)); } catch {} });
    ws.on('close', (code) => { c.closed = code; });
    ws.on('error', () => {});
    c.open = new Promise((r) => ws.on('open', r));
    c.send = (m) => ws.send(JSON.stringify(m));
    c.has = (type, pred) => c.got.some((m) => m.type === type && (!pred || pred(m)));
    c.count = (type) => c.got.filter((m) => m.type === type).length;
    c.last = (type) => { for (let i = c.got.length - 1; i >= 0; i--) if (c.got[i].type === type) return c.got[i]; return null; };
    return c;
  }
  function server(port) {
    const rs = new RemoteServer();
    const clock = { now: T0 };
    rs._clock = () => clock.now;
    rs.on('log', () => {});
    rs.setPassValidator(async (code) => ({
      code, privilege_class: 'general', max_power_w: 100, allowed_modes: [], expires_at: END,
      station_callsign: '', owner_callsign: 'N0CALL', status: 'active', guest_callsign: 'N1GST',
    }));
    const live = { live: false, paused: false, expiring: false, code: null, call: '', endsAt: END };
    rs.setPassAuthCallback(async (code) => { Object.assign(live, { live: true, code, call: 'N1GST' }); });
    rs.setPassLiveCheck(() => ({ ...live }));
    const offers = [];
    const resumed = [];
    rs.on('pass-paused', () => { live.paused = true; });
    rs.on('pass-resumed', (i) => { live.paused = false; resumed.push(i); });
    rs.on('pass-owner-idle-offered', (s) => offers.push(s));
    rs.start(port, TOKEN, { requireToken: true, certDir: os.tmpdir() });
    return { rs, clock, offers, resumed };
  }
  async function guest(port, platform, caps = FLAG) {
    const g = client(port);
    await g.open;
    g.send(protocol.buildClientHello({ clientVersion: 'test/1', clientPlatform: platform, capabilities: caps }));
    await sleep(30);
    g.send({ type: 'auth', mode: 'pass', passCode: CODE, sessionId: SID });
    await until(() => g.has('auth-ok') || g.has('auth-fail'));
    await sleep(60);
    return g;
  }
  async function owner(port) {
    const o = client(port);
    await o.open;
    o.send({ type: 'auth', token: TOKEN });
    await until(() => o.has('auth-ok') || o.has('auth-fail'));
    return o;
  }
  const answer = async (c, before) => { await until(() => c.got.length > before); await sleep(40); };

  await check('station: 5 idle minutes (fake clock, one timer) give owner-idle and the owner\'s status line; activity resets it', async () => {
    const PORT = 17591;
    const { rs, clock } = server(PORT);
    await sleep(400);
    try {
      const phone = await guest(PORT, 'ios');
      assert.ok(rs.takeOverPass('desktop'));
      await until(() => phone.last('pass-state') && phone.last('pass-state').reason === 'owner-has-radio');
      const timer = rs._ownerIdleTimer;
      assert.ok(timer, 'one idle timer is set at the take');
      // Not yet: 4 minutes.
      clock.now = T0 + 4 * MIN;
      rs.noteOwnerActivity('ptt');
      assert.strictEqual(rs._ownerIdleTimer, timer, 'activity moves the clock, not the timer (no poll, no re-arm per event)');
      clock.now = T0 + 5 * MIN;
      rs._ownerIdleCheck();
      await sleep(80);
      assert.strictEqual(phone.last('pass-state').reason, 'owner-has-radio', 'only 1 minute since the PTT');
      assert.ok(rs._ownerIdleTimer, 're-armed for the rest');
      clock.now = T0 + 9 * MIN;
      rs._ownerIdleCheck();
      await until(() => phone.last('pass-state').reason === 'owner-idle');
      assert.strictEqual(phone.last('pass-state').state, 'waiting');
      const st = rs.getPassOwnerControls().status;
      assert.strictEqual(st.text, 'You have the radio.');
      assert.strictEqual(st.sub, 'N1GST can take the radio back now: you haven\'t used it for 5 minutes.');
      assert.strictEqual(rs.isPassPaused(), true, 'nothing switched on its own');
      // The owner uses the radio again: back to owner-has-radio.
      clock.now = T0 + 10 * MIN;
      rs.noteOwnerActivity('tune');
      await until(() => phone.last('pass-state').reason === 'owner-has-radio');
      assert.ok(/paused until you give it back/.test(rs.getPassOwnerControls().status.sub));
      assert.ok(rs._ownerIdleTimer, 'and the wait starts again');
      phone.ws.close();
    } finally { rs.stop(); }
  });

  await check('station: passive things and a guest never count; an owner device\'s use does', async () => {
    const PORT = 17592;
    const { rs, clock } = server(PORT);
    await sleep(400);
    try {
      const phone = await guest(PORT, 'ios');
      const o = await owner(PORT);
      o.send({ type: 'pass-take-over' });
      await until(() => o.has('pass-take-over-ok') && rs.isPassPaused());
      const tookAt = rs.getPassOwnerControls().tookAt;
      assert.strictEqual(tookAt, T0);
      clock.now = T0 + 3 * MIN;
      for (const k of ['spots', 'decode', 'meter', 'cat-poll', 'scope', 'nonsense']) assert.strictEqual(rs.noteOwnerActivity(k), false, k);
      o.send({ type: 'ping', ts: 1 });
      o.send({ type: 'owner-presence', operating: true });
      o.send({ type: 'scope-subscribe', on: true });
      o.send({ type: 'jtcat-spectrum-subscribe', on: true });
      o.send({ type: 'ptt', state: false });
      phone.send({ type: 'tune', freqKhz: 7074 });   // a parked guest: dropped, never counted
      phone.send({ type: 'ptt', state: true });
      await sleep(200);
      assert.strictEqual(rs.getPassOwnerControls().lastActiveAt, T0, 'nothing passive moved the clock');
      o.send({ type: 'tune', freqKhz: 14074 });
      await until(() => rs.getPassOwnerControls().lastActiveAt === T0 + 3 * MIN);
      assert.strictEqual(rs.getPassOwnerControls().lastActiveAt, T0 + 3 * MIN, 'an owner device tuning is use');
      o.ws.close(); phone.ws.close();
    } finally { rs.stop(); }
  });

  await check('station: radio-reported TX during a hold resets the idle wait; the same outside a hold does nothing', async () => {
    const PORT = 17597;
    const { rs, clock } = server(PORT);
    await sleep(400);
    try {
      const phone = await guest(PORT, 'ios');
      clock.now = T0 - MIN;
      assert.strictEqual(rs.noteOwnerActivity('radio-tx'), false, "no hold: the guest's own TX is not the owner");
      clock.now = T0;
      rs.takeOverPass('desktop');
      await until(() => phone.last('pass-state').reason === 'owner-has-radio');
      // The owner on the hand mic at minute 4 (the watch fired after 1 s of TX).
      const tx = OA.createRadioTxWatch({ onActive: (k) => rs.noteOwnerActivity(k), now: () => clock.now, minMs: 0, repeatMs: 30 * MIN });
      clock.now = T0 + 4 * MIN;
      tx.cat(true);
      await sleep(30);
      tx.stop();
      assert.strictEqual(rs.getPassOwnerControls().lastActiveAt, T0 + 4 * MIN, 'the over counted');
      clock.now = T0 + 5 * MIN;
      rs._ownerIdleCheck();
      await sleep(80);
      assert.strictEqual(phone.last('pass-state').reason, 'owner-has-radio', 'no offer mid-QSO');
      clock.now = T0 + 9 * MIN;
      rs._ownerIdleCheck();
      await until(() => phone.last('pass-state').reason === 'owner-idle');
      assert.strictEqual(phone.last('pass-state').reason, 'owner-idle', '5 minutes after the over');
      phone.ws.close();
    } finally { rs.stop(); }
  });

  await check('station: take-back granted on owner-idle, to the device that was on the air; refused otherwise', async () => {
    const PORT = 17593;
    const { rs, clock, offers, resumed } = server(PORT);
    await sleep(400);
    try {
      const phone = await guest(PORT, 'ios');
      const pc = await guest(PORT, 'web');           // waits for the phone (other-device)
      assert.strictEqual(pc.last('pass-state').reason, 'other-device');
      rs.takeOverPass('desktop');
      await until(() => phone.last('pass-state').reason === 'owner-has-radio');
      // Refused while the owner is using it: the state comes back unchanged.
      let n = phone.got.length;
      phone.send({ type: 'pass-take-back' });
      await answer(phone, n);
      assert.strictEqual(phone.last('pass-state').reason, 'owner-has-radio');
      assert.strictEqual(rs.isPassPaused(), true);
      // 5 idle minutes: offered once.
      clock.now = T0 + 5 * MIN;
      rs._ownerIdleCheck();
      await until(() => phone.last('pass-state').reason === 'owner-idle');
      assert.strictEqual(pc.last('pass-state').reason, 'owner-has-radio', 'the waiting device is not offered a button it cannot use');
      assert.strictEqual(offers.length, 1);
      // The waiting second device is refused.
      n = pc.got.length;
      pc.send({ type: 'pass-take-back' });
      await answer(pc, n);
      assert.strictEqual(rs.isPassPaused(), true, 'not to the waiting device');
      // The device that was on the air takes it.
      phone.send({ type: 'pass-take-back' });
      await until(() => !rs.isPassPaused());
      await until(() => phone.last('pass-state').state === 'on-air');
      assert.strictEqual(phone.last('pass-state').reason, 'none');
      assert.ok(phone.has('pass-resumed'), 'older message alongside');
      assert.strictEqual(pc.last('pass-state').reason, 'other-device', 'the other device keeps waiting');
      assert.strictEqual(rs._client && rs._client._clientPlatform, 'ios', 'the phone operates again');
      assert.strictEqual(resumed.length, 1);
      assert.strictEqual(rs._ownerIdleTimer, null, 'no timer left behind');
      // On the air: another take-back is refused.
      n = phone.got.length;
      phone.send({ type: 'pass-take-back' });
      await answer(phone, n);
      assert.strictEqual(phone.last('pass-state').reason, 'none');
      phone.ws.close(); pc.ws.close();
    } finally { rs.stop(); }
  });

  await check('station: take-back refused during a pending take (owner-soon)', async () => {
    const PORT = 17594;
    const { rs } = server(PORT);
    await sleep(400);
    try {
      const phone = await guest(PORT, 'ios');
      assert.ok(rs.scheduleTakeOverPass({ message: 'Net soon', delayMs: 60 * MIN }).ok);
      await until(() => phone.last('pass-state').reason === 'owner-soon');
      const n = phone.got.length;
      phone.send({ type: 'pass-take-back' });
      await answer(phone, n);
      const s = phone.last('pass-state');
      assert.deepStrictEqual([s.state, s.reason, s.message], ['on-air', 'owner-soon', 'Net soon'], 'refused: the same state again');
      assert.strictEqual(rs.isPassPaused(), false);
      assert.ok(rs.cancelPassTake());
      phone.ws.close();
    } finally { rs.stop(); }
  });

  await check('station: the idle offer seam fires once per offer', async () => {
    const PORT = 17595;
    const { rs, clock, offers } = server(PORT);
    await sleep(400);
    try {
      const phone = await guest(PORT, 'ios');
      rs.takeOverPass('desktop');
      await sleep(80);
      clock.now = T0 + 5 * MIN;
      rs._ownerIdleCheck();
      rs._ownerIdleCheck();
      clock.now = T0 + 20 * MIN;
      rs._ownerIdleCheck();
      assert.strictEqual(offers.length, 1, 'once, however often the timer fires');
      assert.deepStrictEqual(offers[0], { code: CODE, call: 'N1GST', sessionId: SID, offeredAt: new Date(T0 + 5 * MIN).toISOString() });
      // Activity withdraws it; the next idle spell is a new offer.
      clock.now = T0 + 21 * MIN;
      rs.noteOwnerActivity('cw');
      clock.now = T0 + 26 * MIN;
      rs._ownerIdleCheck();
      assert.strictEqual(offers.length, 2);
      // Give it back clears it all.
      assert.ok(rs.resumePass());
      rs._ownerIdleCheck();
      assert.strictEqual(offers.length, 2);
      phone.ws.close();
    } finally { rs.stop(); }
  });

  await check('station: an old phone (no pass-state flag) keeps pass-paused, is never handed the radio, and waits for Give it back', async () => {
    const PORT = 17596;
    const { rs, clock } = server(PORT);
    await sleep(400);
    try {
      const old = await guest(PORT, 'ios', []);
      assert.ok(old.has('auth-ok'));
      rs.takeOverPass('desktop');
      await until(() => old.has('pass-paused'));
      clock.now = T0 + 30 * MIN;
      rs._ownerIdleCheck();
      await sleep(150);
      assert.ok(!old.has('pass-state'), 'no pass-state to an older client');
      assert.ok(!old.has('pass-resumed'), 'no automatic hand-back');
      old.send({ type: 'pass-take-back' });
      await sleep(150);
      assert.strictEqual(rs.isPassPaused(), true, 'an older client cannot take it back');
      // Even an owner device leaving hands nothing back (the old 2-minute rule).
      assert.ok(rs.resumePass(), 'Give it back');
      await until(() => old.has('pass-resumed'));
      old.ws.close();
    } finally { rs.stop(); }
  });

  // ------------------------------------------------------------ 5. guards and glue
  await check('the 2-minute automatic hand-back is gone (source guard)', () => {
    const rsSrc = read('lib/remote-server.js');
    for (const gone of ['OWNER_HOLD_MS', '_ownerHoldMs', '_ownerHoldTimer', '_maybeResumeAfterOwnerLeft', '_clearOwnerHold', '2 * 60 * 1000']) {
      assert.ok(!rsSrc.includes(gone), 'remote-server still has ' + gone);
    }
    assert.ok(!/resumePass\(\s*'device'\s*\)/.test(rsSrc), 'nothing hands a device take-over back on its own');
    const main = read('main.js');
    assert.ok(!/resumePass\(\s*'device'\s*\)/.test(main));
    assert.ok(/ipcMain\.handle\('pass-give-back'[\s\S]{0,300}resumePass\(\)/.test(main), 'the banner gives back any take-over');
    for (const f of ['lib/pass-wording.js', 'lib/pass-state.js', 'lib/pass-owner-controls.js']) {
      assert.ok(!/2[- ]minute|two minutes|OWNER_HOLD_MS/i.test(read(f)), f + ' still talks about the 2-minute hand-back');
    }
    // The wire contract ("two minutes" elsewhere in it is Winlink's gateway list).
    assert.ok(!/OWNER_HOLD_MS|2-minute (?:automatic )?hand-back|goes back to the guest in/i.test(read('docs/echocat-protocol.md')));
  });

  await check('wording: owner-idle in STATE_TABLE, consistent with the table, button Take the radio', () => {
    const row = W.STATE_TABLE['waiting/owner-idle'];
    assert.strictEqual(row.action, 'Take the radio');
    const w = W.describeState({ state: 'waiting', reason: 'owner-idle', endsAt: END }, { owner: 'n0call' });
    assert.strictEqual(w.title, 'The radio at N0CALL\'s station is free.');
    assert.strictEqual(w.line, 'N0CALL hasn\'t used it for 5 minutes. Press Take the radio to go back on the air. Your pass is still good.');
    assert.strictEqual(w.action, 'Take the radio');
    assert.strictEqual(w.stillGood, true);
    const anon = W.describeState({ state: 'waiting', reason: 'owner-idle' }, {});
    assert.ok(anon.line.startsWith('The owner hasn\'t used it'), anon.line);
    // Every other waiting reason keeps its own button; only owner-idle offers Take the radio.
    for (const [k, r] of Object.entries(W.STATE_TABLE)) if (k !== 'waiting/owner-idle') assert.notStrictEqual(r.action, 'Take the radio', k);
  });

  await check('glue: main notes owner activity at the station and wires the seam inside onRemoteServer; both remote surfaces send pass-take-back', () => {
    const main = read('main.js');
    assert.ok(/function noteOwnerActivity\(kind\)/.test(main));
    assert.ok(/function onOwnerIdleOffered\(session\)/.test(main), 'the Cloud push seam');
    const kinds = [...main.matchAll(/noteOwnerActivity\('([a-z-]+)'\)/g)].map((m) => m[1]);
    assert.ok(kinds.length >= 6, 'call sites: ' + kinds.join(','));
    for (const k of kinds) assert.ok(OA.isOwnerActivity(k), 'main names a kind that is not in the list: ' + k);
    for (const k of ['ptt', 'cw', 'tune', 'mode', 'winlink']) assert.ok(kinds.includes(k), 'main notes ' + k);
    assert.ok(/function handleRemotePtt\(state, opts = \{\}\) \{[\s\S]{0,900}if \(state\) noteOwnerActivity\('ptt'\);/.test(main), 'every key-down');
    assert.ok(/function winlinkSessionTouch\(\) \{[\s\S]{0,120}if \(!_winlinkSessionByGuest\) noteOwnerActivity\('winlink'\)/.test(main), 'Winlink session activity, the owner\'s only');
    assert.ok(/_winlinkSessionByGuest = !!\(passEnforcement && \['active', 'expiring'\]\.includes\(passEnforcement\.getState\(\)\)\);/.test(main),
      'a session started while the guest had the radio is the guest\'s');
    // The seam's listener lives inside an onRemoteServer(fn) block.
    const at = main.indexOf("rs.on('pass-owner-idle-offered'");
    assert.ok(at > 0 && main.lastIndexOf('onRemoteServer((rs) => {', at) > 0, 'inside onRemoteServer');
    assert.ok(!/remoteServer\.on\('pass-owner-idle-offered'/.test(main));
    assert.ok(/ipcMain\.handle\('remote-pass-take-back'/.test(main));
    // radio-tx: the radio's TX status from every CAT connection, and forward power.
    const conn = main.slice(main.indexOf('async function connectCat() {'), main.indexOf('async function connectCat() {') + 40000);
    assert.ok(/^  _radioTxWatch\.cat\(false\);/m.test(conn), 'a reconnect clears a stuck TX status');
    assert.strictEqual((conn.match(/cat\.on\('ptt', \(on\) => _radioTxWatch\.cat\(on\)\)/g) || []).length,
      (conn.match(/cat = new (RigController|CatClient)\(/g) || []).length, 'every CAT connection feeds the watch');
    assert.ok(/function sendCatFwdPower\(watts\) \{[\s\S]{0,120}_radioTxWatch\.fwd\(/.test(main), 'forward power feeds the watch');
    assert.ok(/createRadioTxWatch\(\{ onActive: \(kind\) => noteOwnerActivity\(kind\) \}\)/.test(main));
    assert.ok(/remotePassTakeBack: \(\) => ipcRenderer\.invoke\('remote-pass-take-back'\)/.test(read('preload.js')));
    assert.ok(/passTakeBack\(\)/.test(read('lib/remote-client.js')) && /type: 'pass-take-back'/.test(read('lib/remote-client.js')));
    const app = read('renderer/app.js');
    assert.ok(/rr-pass-take-back/.test(app) && /_remotePassTakeBack/.test(app));
    const web = read('renderer/remote.js');
    assert.ok(/w\.action === 'Take the radio'\) ask = \{ type: 'pass-take-back' \}/.test(web), 'ECHOCAT Web');
  });

  await check('POTACAT as a remote sends pass-take-back only on owner-idle', () => {
    const { RemoteClient } = require('../lib/remote-client');
    const c = Object.create(RemoteClient.prototype);
    require('events').EventEmitter.call(c);
    const sent = [];
    c._ws = { readyState: WebSocket.OPEN, close() {} };
    c._send = (m) => sent.push(m);
    c._target = { id: 't', name: 'shack' };
    c._authRetryAttempts = 0;
    c._handleMessage(JSON.stringify({ type: 'pass-state', state: 'waiting', reason: 'owner-has-radio', endsAt: END }));
    assert.strictEqual(c.passTakeBack(), false);
    c._handleMessage(JSON.stringify({ type: 'pass-state', state: 'waiting', reason: 'owner-idle', endsAt: END }));
    assert.strictEqual(c.passTakeBack(), true);
    assert.deepStrictEqual(sent, [{ type: 'pass-take-back' }]);
  });

  await check('docs: the protocol has pass-take-back and owner-idle, and no automatic hand-back', () => {
    const doc = read('docs/echocat-protocol.md');
    assert.ok(/\| `pass-take-back` \| C→S \|/.test(doc));
    assert.ok(doc.includes('owner-idle'));
    assert.ok(/[Nn]othing switches on its own/.test(doc));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
