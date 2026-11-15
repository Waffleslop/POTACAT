#!/usr/bin/env node
'use strict';
// GitHub #541 step 2: pass-state, four states with a reason, one wording table.
//
// Pinned here:
//   1. lib/pass-state.js: the states and reasons, the precedence of the
//      station's facts, the claim rule, Cloud's validate-session answers and
//      the older auth-fail codes mapped to the same shape
//   2. lib/pass-wording.js describeState: a sentence for every state and
//      reason; "Your pass is still good." on every state but over
//   3. the station (lib/remote-server.js): pass-state on connect and on every
//      change, only to a client with the 'pass-state' flag; a second device on
//      the same pass session waits; pass-claim swaps; refused while the owner
//      holds the radio; a refused connection carries passState next to the
//      older fields; older clients keep today's behaviour
//   4. POTACAT as a remote (lib/remote-client.js) and ECHOCAT Web advertise the
//      flag and show the state

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const PS = require('../lib/pass-state');
const W = require('../lib/pass-wording');
const protocol = require('../lib/echocat-protocol');
const { RemoteServer } = require('../lib/remote-server');
const { RemoteClient } = require('../lib/remote-client');

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

const END = '2026-11-14T20:30:00.000Z';

(async () => {
  console.log('=== #541 step 2: pass-state ===');

  // ------------------------------------------------------------ 1. the module
  await check('four states; each reason belongs to one state; unknown pairs are never built', () => {
    assert.deepStrictEqual(PS.STATES, ['on-air', 'waiting', 'reconnecting', 'over']);
    for (const r of ['cancelled', 'expired', 'unknown']) assert.ok(PS.REASONS.over.includes(r));
    for (const r of ['owner-has-radio', 'owner-idle', 'other-device', 'other-guest', 'rig-in-use', 'not_started']) assert.ok(PS.REASONS.waiting.includes(r));
    assert.ok(PS.REASONS.reconnecting.includes('check-failed'));
    assert.strictEqual(PS.build('over', 'check-failed'), null);
    assert.strictEqual(PS.build('lost', 'none'), null);
    const m = PS.build('on-air', 'none', { endsAt: END });
    assert.deepStrictEqual(m, { type: 'pass-state', state: 'on-air', reason: 'none', endsAt: END });
    assert.strictEqual(PS.build('on-air', 'none').endsAt, null, 'endsAt is always present');
    assert.ok(protocol.validate(m, protocol.Dir.S2C).ok, 'registered S2C');
    assert.ok(protocol.validate({ type: 'pass-claim' }, protocol.Dir.C2S).ok, 'pass-claim registered C2S');
  });

  await check('the station\'s facts: owner first, then the other device, then a pending take, then ends-soon', () => {
    assert.strictEqual(PS.forConnection({ endsAt: END }).reason, 'none');
    assert.strictEqual(PS.forConnection({ expiring: true }).reason, 'ends-soon');
    const soon = PS.forConnection({ take: { at: '2026-11-14T19:05:00Z', message: 'Net at 19:05' }, expiring: true });
    assert.deepStrictEqual([soon.state, soon.reason, soon.takeAt, soon.message], ['on-air', 'owner-soon', '2026-11-14T19:05:00.000Z', 'Net at 19:05']);
    const other = PS.forConnection({ standby: true, onAirDevice: 'iPhone or iPad', take: { at: Date.now() } });
    assert.deepStrictEqual([other.state, other.reason, other.device], ['waiting', 'other-device', 'iPhone or iPad']);
    const held = PS.forConnection({ ownerHolds: true, standby: true, message: 'Back in ten' });
    assert.deepStrictEqual([held.state, held.reason, held.message], ['waiting', 'owner-has-radio', 'Back in ten']);
    assert.strictEqual(PS.forConnection({ ownerHolds: true, ownerIdle: true }).reason, 'owner-idle');
  });

  await check('claim rule: same pass session, waiting for the other device, never while the owner holds the radio or a take is pending', () => {
    assert.strictEqual(PS.canClaim({ sameSession: true, standby: true }), true);
    assert.strictEqual(PS.canClaim({ sameSession: false, standby: true }), false, 'another session');
    assert.strictEqual(PS.canClaim({ sameSession: true, standby: false }), false, 'already on air');
    assert.strictEqual(PS.canClaim({ sameSession: true, standby: true, ownerHolds: true }), false, 'owner-has-radio');
    assert.strictEqual(PS.canClaim({ sameSession: true, standby: true, ownerHolds: true, ownerIdle: true }), false, 'owner-idle');
    assert.strictEqual(PS.canClaim({ sameSession: true, standby: true, take: { at: Date.now() + 60000 } }), false, 'pending take');
    assert.ok(PS.ownerHoldsReason('owner-has-radio') && PS.ownerHoldsReason('owner-idle') && !PS.ownerHoldsReason('other-device'));
  });

  await check('Cloud validate-session: 410 pass_over -> over with its reason (not_started waits, takeAt = at); 404 -> over/unknown; 429, 5xx, other 410 -> check-failed', () => {
    const at = '2026-11-14T18:00:00Z';
    const c = (st, b) => { const m = PS.fromCloudAnswer(st, b); return m && [m.state, m.reason, m.takeAt || null]; };
    assert.deepStrictEqual(c(410, { error: 'pass_over', reason: 'cancelled', at }), ['over', 'cancelled', null]);
    assert.deepStrictEqual(c(410, { error: 'pass_over', reason: 'expired', at }), ['over', 'expired', null]);
    assert.strictEqual(PS.fromCloudAnswer(410, { error: 'pass_over', reason: 'expired', at }).endsAt, '2026-11-14T18:00:00.000Z', 'the expiry time fills endsAt');
    assert.deepStrictEqual(c(410, { error: 'pass_over', reason: 'not_started', at }), ['waiting', 'not_started', '2026-11-14T18:00:00.000Z']);
    assert.deepStrictEqual(c(404, { error: 'not_found' }), ['over', 'unknown', null]);
    for (const [st, b] of [[429, { error: 'rate_limited' }], [500, null], [502, {}], [503, { error: 'x' }],
      [410, { error: 'pass_session_closed' }], [410, { error: 'owner_entitlement_expired' }], [404, null], [403, { error: 'pass_session_mismatch' }]]) {
      assert.deepStrictEqual(c(st, b), ['reconnecting', 'check-failed', null], st + ' ' + JSON.stringify(b));
    }
    assert.strictEqual(PS.fromCloudAnswer(200, { code: 'abcd1234' }), null, 'valid is not a refusal');
  });

  await check('older auth-fail codes and pass-ended reasons map to the same shape', () => {
    const f = (p) => { const m = PS.fromAuthFail(p); return m && m.state + '/' + m.reason; };
    assert.strictEqual(f({ code: 'pass_check_failed' }), 'reconnecting/check-failed');
    assert.strictEqual(f({ code: 'rig_in_use', by: 'owner' }), 'waiting/owner-has-radio');
    assert.strictEqual(f({ code: 'rig_in_use', by: 'guest' }), 'waiting/other-guest');
    assert.strictEqual(f({ code: 'rig_in_use' }), 'waiting/rig-in-use');
    assert.strictEqual(f({ code: 'pass_not_valid', passReason: 'cancelled' }), 'over/cancelled');
    assert.strictEqual(f({ code: 'pass_not_valid', passReason: 'not_started', passAt: END }), 'waiting/not_started');
    assert.strictEqual(f({ code: 'pass_not_valid' }), 'over/unknown');
    assert.strictEqual(PS.fromAuthFail({ code: '' }), null);
    assert.strictEqual(PS.fromPassEnded('expired').reason, 'expired');
    assert.strictEqual(PS.fromPassEnded('revoked').reason, 'cancelled');
    for (const r of ['left', 'disconnected', 'superseded', 'owner_override']) assert.strictEqual(PS.fromPassEnded(r), null, r);
    assert.deepStrictEqual(['ios', 'android', 'desktop-win', 'web', 'x'].map(PS.deviceName), ['iPhone or iPad', 'Android phone', 'POTACAT desktop', 'web browser', '']);
    assert.ok(PS.same(PS.build('on-air', 'none', { endsAt: END }), PS.build('on-air', 'none', { endsAt: END })));
    assert.ok(!PS.same(PS.build('waiting', 'other-device', { device: 'a' }), PS.build('waiting', 'other-device', { device: 'b' })));
  });

  await check('the pass profile read at load: 429, 5xx or no answer is a failed check; Cloud\'s pass_over stays final', async () => {
    const { PassEnforcement } = require('../lib/pass-enforcement');
    const realFetch = global.fetch;
    const codeFor = async (impl) => {
      global.fetch = impl;
      const pe = new PassEnforcement({ revalidateMs: 0, log: () => {} });
      try { await pe.loadPass('abcd1234'); return 'loaded'; }
      catch (e) { assert.strictEqual(pe.getState(), 'idle'); return e.code || 'final'; }
    };
    try {
      const r = (status, body) => async () => ({ status, ok: status < 300, statusText: '', json: async () => body });
      assert.strictEqual(await codeFor(r(429, {})), 'pass_check_failed');
      assert.strictEqual(await codeFor(r(503, null)), 'pass_check_failed');
      assert.strictEqual(await codeFor(async () => { throw new Error('ENOTFOUND'); }), 'pass_check_failed');
      assert.strictEqual(await codeFor(r(410, { error: 'pass_over', reason: 'cancelled' })), 'final');
    } finally { global.fetch = realFetch; }
  });

  // ------------------------------------------------------------ 2. the words
  await check('every state and reason has a sentence; still good on every state but over', () => {
    for (const state of PS.STATES) {
      for (const reason of PS.REASONS[state]) {
        assert.ok(W.STATE_TABLE[state + '/' + reason], 'table row for ' + state + '/' + reason);
        const w = W.describeState({ state, reason, endsAt: END, takeAt: END, device: 'iPhone or iPad' }, { owner: 'k3sbp' });
        assert.ok(w.title, state + '/' + reason + ' has a title');
        assert.ok(!/\{[A-Z]+\}/.test(w.text), 'no placeholder left: ' + w.text);
        assert.ok(!/revok/i.test(w.text), 'never "revoked": ' + w.text);
        if (state === 'over') {
          assert.ok(w.terminal && !w.stillGood && !/still good/.test(w.text), w.text);
        } else {
          assert.ok(!w.terminal && w.stillGood, state + '/' + reason);
          assert.ok(w.line.endsWith(W.STILL_GOOD), 'ends with still good: ' + w.text);
        }
        // Without times or names, a sentence still reads.
        const bare = W.describeState({ state, reason });
        assert.ok(bare.title && !/\{[A-Z]+\}/.test(bare.text), 'bare: ' + bare.text);
      }
    }
    assert.strictEqual(W.describeState({ state: 'x', reason: 'y' }).title, '');
  });

  await check('the key sentences', () => {
    const t = (state, reason, extra) => W.describeState({ state, reason, endsAt: END, ...(extra || {}) }, { owner: 'K3SBP' });
    assert.strictEqual(t('waiting', 'owner-has-radio').title, 'Waiting: K3SBP is using the radio.');
    assert.strictEqual(t('waiting', 'other-device', { device: 'iPhone or iPad' }).title, 'Your pass is in use on your iPhone or iPad.');
    assert.strictEqual(t('waiting', 'other-device', { device: 'iPhone or iPad' }).action, 'Use it here instead');
    assert.strictEqual(t('waiting', 'other-device').title, 'Your pass is in use on another device.');
    assert.strictEqual(t('reconnecting', 'check-failed').text, 'Couldn\'t check your pass just now. Trying again. Your pass is still good.');
    assert.strictEqual(t('over', 'expired').text, 'Your Guest Pass ended at 20:30 UTC.');
    assert.strictEqual(t('over', 'cancelled').text, 'K3SBP cancelled your Guest Pass.');
    assert.strictEqual(t('over', 'unknown').text, 'This pass code is not known. Check the link from K3SBP.');
    assert.strictEqual(t('waiting', 'not_started', { takeAt: '2026-11-15T14:00:00Z' }).title, 'This pass starts at 14:00 UTC 2026-11-15. POTACAT connects then.');
    assert.strictEqual(W.describeState({ state: 'waiting', reason: 'not_started', takeAt: '2026-11-15T14:00:00Z' }, { app: 'ECHOCAT' }).title,
      'This pass starts at 14:00 UTC 2026-11-15. ECHOCAT connects then.');
    assert.strictEqual(t('on-air', 'none').text, 'You\'re on the air. Your pass runs until 20:30 UTC. Your pass is still good.');
    const soon = t('on-air', 'owner-soon', { takeAt: '2026-11-14T19:05:00Z', message: 'Net starts at 19:05' });
    assert.strictEqual(soon.text, 'K3SBP will take the radio at 19:05 UTC. You can keep operating until then. Message from K3SBP: "Net starts at 19:05" Your pass is still good.');
    assert.strictEqual(W.describeState({ state: 'over', reason: 'cancelled' }).title, 'The owner cancelled your Guest Pass.', 'no owner known');
  });

  // ------------------------------------------------------------ 3. the station
  const TOKEN = 'pass-state-token';
  const CODE = 'abcd1234';
  const SID = 'a'.repeat(64);

  function client(port) {
    const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    const c = { ws, got: [], closed: null };
    ws.on('message', (raw) => { try { c.got.push(JSON.parse(raw)); } catch {} });
    ws.on('close', (code) => { c.closed = code; });
    ws.on('error', () => {});
    c.open = new Promise((r) => ws.on('open', r));
    c.send = (m) => ws.send(JSON.stringify(m));
    c.has = (type, pred) => c.got.some((m) => m.type === type && (!pred || pred(m)));
    c.last = (type) => { for (let i = c.got.length - 1; i >= 0; i--) if (c.got[i].type === type) return c.got[i]; return null; };
    c.states = () => c.got.filter((m) => m.type === 'pass-state').map((m) => m.state + '/' + m.reason);
    return c;
  }
  function server(port, opts) {
    const o = opts || {};
    const rs = new RemoteServer();
    rs.on('log', () => {});
    rs.setPassValidator(async (code) => (o.validator ? o.validator(code) : {
      code, privilege_class: 'general', max_power_w: 100, allowed_modes: [], expires_at: END,
      station_callsign: '', owner_callsign: 'W7RTA', status: 'active', guest_callsign: 'K3SBP',
    }));
    const live = { live: false, paused: false, expiring: false, code: null, call: '', endsAt: END };
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
    return { rs, live };
  }
  async function guest(port, platform, caps, sid) {
    const g = client(port);
    await g.open;
    g.send(protocol.buildClientHello({ clientVersion: 'test/1', clientPlatform: platform, capabilities: caps }));
    await sleep(30);
    g.send({ type: 'auth', mode: 'pass', passCode: CODE, sessionId: sid || SID });
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
  const FLAG = ['pass-state'];

  await check('the station advertises pass-state; a guest with the flag gets on-air on connect, one without gets none', async () => {
    const PORT = 17561;
    const { rs } = server(PORT);
    await sleep(400);
    try {
      const a = await guest(PORT, 'ios', FLAG);
      const hello = a.got.find((m) => m.type === 'hello');
      assert.ok(hello && hello.capabilities.includes('pass-state'), 'advertised');
      assert.ok(a.has('auth-ok'));
      assert.deepStrictEqual(a.states(), ['on-air/none']);
      assert.strictEqual(a.last('pass-state').endsAt, END);
      a.ws.close();
      await sleep(100);
      const b = await guest(PORT, 'ios', []);
      assert.ok(b.has('auth-ok'));
      assert.deepStrictEqual(b.states(), [], 'no pass-state without the flag');
      b.ws.close();
    } finally { rs.stop(); }
  });

  await check('a second device on the same pass session waits (other-device, naming the device on air); pass-claim swaps with no redial', async () => {
    const PORT = 17562;
    const { rs } = server(PORT);
    await sleep(400);
    try {
      const phone = await guest(PORT, 'ios', FLAG);
      const pc = await guest(PORT, 'desktop-win', FLAG);
      assert.ok(pc.has('auth-ok'), 'the second device is accepted');
      assert.ok(!phone.has('kicked'), 'the phone keeps the radio');
      const w = pc.last('pass-state');
      assert.deepStrictEqual([w.state, w.reason, w.device], ['waiting', 'other-device', 'iPhone or iPad']);
      assert.strictEqual(rs._client && rs._client._clientPlatform, 'ios', 'the phone is the client on air');
      // A waiting device cannot drive the radio.
      const before = pc.got.length;
      pc.send({ type: 'tune', freqKhz: 14074, mode: 'USB' });
      await sleep(100);
      assert.ok(!pc.got.slice(before).some((m) => m.type === 'refused'), 'dropped silently, like a paused guest');

      pc.send({ type: 'pass-claim' });
      await until(() => pc.last('pass-state').state === 'on-air' && phone.last('pass-state').state === 'waiting');
      assert.deepStrictEqual([pc.last('pass-state').state, pc.last('pass-state').reason], ['on-air', 'none']);
      const p = phone.last('pass-state');
      assert.deepStrictEqual([p.state, p.reason, p.device], ['waiting', 'other-device', 'POTACAT desktop']);
      assert.strictEqual(phone.closed, null, 'the phone stays connected');
      assert.strictEqual(pc.closed, null, 'no redial');
      assert.strictEqual(rs._client && rs._client._clientPlatform, 'desktop-win');
      assert.ok(!phone.has('kicked') && !pc.has('kicked'));

      // And back.
      phone.send({ type: 'pass-claim' });
      await until(() => phone.last('pass-state').state === 'on-air');
      assert.strictEqual(pc.last('pass-state').reason, 'other-device');
      assert.strictEqual(pc.last('pass-state').device, 'iPhone or iPad');

      // A claim from the device already on air is refused with its state.
      const n = phone.got.length;
      phone.send({ type: 'pass-claim' });
      await until(() => phone.got.length > n);
      assert.strictEqual(phone.last('pass-state').state, 'on-air');
      phone.ws.close(); pc.ws.close();
    } finally { rs.stop(); }
  });

  await check('while the owner holds the radio a claim is refused with the current state; both devices wait for the owner; give it back restores each', async () => {
    const PORT = 17563;
    const { rs } = server(PORT);
    await sleep(400);
    try {
      const phone = await guest(PORT, 'ios', FLAG);
      const pc = await guest(PORT, 'desktop-mac', FLAG);
      assert.ok(rs.takeOverPass('desktop'));
      await until(() => phone.last('pass-state').reason === 'owner-has-radio' && pc.last('pass-state').reason === 'owner-has-radio');
      assert.ok(phone.has('pass-paused'), 'the older message is still sent alongside');
      const n = pc.got.length;
      pc.send({ type: 'pass-claim' });
      await until(() => pc.got.length > n);
      assert.strictEqual(pc.last('pass-state').reason, 'owner-has-radio', 'refused: the current state again');
      assert.ok(rs.resumePass('desktop'));
      await until(() => phone.last('pass-state').state === 'on-air');
      assert.strictEqual(pc.last('pass-state').reason, 'other-device', 'the second device waits for the phone again, not the owner');
      assert.ok(!pc.has('pass-resumed'), 'the waiting device is not handed the radio');
      phone.ws.close(); pc.ws.close();
    } finally { rs.stop(); }
  });

  await check('a pending take refuses a claim (shaped for step 3)', async () => {
    const PORT = 17564;
    const { rs } = server(PORT);
    await sleep(400);
    try {
      const phone = await guest(PORT, 'ios', FLAG);
      const pc = await guest(PORT, 'web', FLAG);
      rs._passTake = { at: Date.now() + 5 * 60000, message: 'Net soon' };
      rs.broadcastPassState();
      await until(() => phone.last('pass-state').reason === 'owner-soon');
      assert.strictEqual(phone.last('pass-state').message, 'Net soon');
      const n = pc.got.length;
      pc.send({ type: 'pass-claim' });
      await until(() => pc.got.length > n);
      assert.strictEqual(pc.last('pass-state').reason, 'other-device');
      assert.strictEqual(rs._client && rs._client._clientPlatform, 'ios', 'the phone keeps the radio');
      rs._passTake = null;
      phone.ws.close(); pc.ws.close();
    } finally { rs.stop(); }
  });

  await check('the device on air leaves: the waiting device takes the radio', async () => {
    const PORT = 17565;
    const { rs } = server(PORT);
    await sleep(400);
    try {
      const phone = await guest(PORT, 'android', FLAG);
      const pc = await guest(PORT, 'desktop-linux', FLAG);
      assert.strictEqual(pc.last('pass-state').device, 'Android phone');
      phone.ws.close();
      await until(() => pc.last('pass-state').state === 'on-air');
      assert.strictEqual(pc.last('pass-state').reason, 'none');
      assert.strictEqual(rs._client && rs._client._clientPlatform, 'desktop-linux');
      pc.ws.close();
    } finally { rs.stop(); }
  });

  await check('older clients keep today\'s behaviour: a second device without the flag takes the radio (kicked)', async () => {
    const PORT = 17566;
    const { rs } = server(PORT);
    await sleep(400);
    try {
      const phone = await guest(PORT, 'ios', FLAG);
      const old = await guest(PORT, 'desktop-win', []);
      assert.ok(old.has('auth-ok'));
      await until(() => phone.has('kicked'));
      assert.ok(phone.has('kicked'), 'the newest device without the flag displaces as before');
      assert.deepStrictEqual(old.states(), []);
      old.ws.close();
    } finally { rs.stop(); }
  });

  await check('a refused connection carries passState next to the older fields; without the flag, the older fields only', async () => {
    const PORT = 17567;
    const { rs } = server(PORT);
    await sleep(400);
    try {
      const o = await owner(PORT); // operating, no pass on the rig
      const g = await guest(PORT, 'ios', FLAG);
      const f = g.last('auth-fail');
      assert.ok(f, 'refused');
      assert.deepStrictEqual([f.code, f.by, f.state, f.stateReason], ['rig_in_use', 'owner', 'waiting', 'owner'], 'step 1 fields unchanged');
      assert.ok(typeof f.reason === 'string' && typeof f.text === 'string');
      assert.deepStrictEqual([f.passState.state, f.passState.reason, f.passState.endsAt], ['waiting', 'owner-has-radio', END]);
      assert.strictEqual(f.passState.type, undefined);
      const g2 = await guest(PORT, 'ios', []);
      assert.strictEqual(g2.last('auth-fail').passState, undefined);
      o.ws.close(); g.ws.close(); g2.ws.close();
    } finally { rs.stop(); }
  });

  await check('refusals for Cloud answers: not valid -> over / not_started waiting; check failed -> reconnecting', async () => {
    const PORT = 17568;
    let answer = null;
    const { rs } = server(PORT, { validator: async () => { if (answer instanceof Error) throw answer; return answer; } });
    await sleep(400);
    try {
      answer = { code: null, notValid: true, reason: 'cancelled', at: null };
      let g = await guest(PORT, 'web', FLAG);
      assert.deepStrictEqual([g.last('auth-fail').passState.state, g.last('auth-fail').passState.reason], ['over', 'cancelled']);
      g.ws.close();
      answer = { code: null, notValid: true, reason: 'not_started', at: '2026-11-15T14:00:00Z' };
      g = await guest(PORT, 'web', FLAG);
      assert.deepStrictEqual([g.last('auth-fail').passState.state, g.last('auth-fail').passState.reason, g.last('auth-fail').passState.takeAt],
        ['waiting', 'not_started', '2026-11-15T14:00:00.000Z']);
      g.ws.close();
      answer = Object.assign(new Error('Cloud rate limit'), { code: 'pass_check_failed' });
      g = await guest(PORT, 'web', FLAG);
      assert.deepStrictEqual([g.last('auth-fail').code, g.last('auth-fail').passState.state, g.last('auth-fail').passState.reason],
        ['pass_check_failed', 'reconnecting', 'check-failed']);
      g.ws.close();
    } finally { rs.stop(); }
  });

  await check('an expired or cancelled pass says over before pass-ended; another ending says nothing new', async () => {
    const PORT = 17569;
    const { rs } = server(PORT);
    await sleep(400);
    try {
      const g = await guest(PORT, 'ios', FLAG);
      rs.broadcastPassEnded('expired', CODE);
      await until(() => g.has('pass-ended'));
      const i = g.got.findIndex((m) => m.type === 'pass-state' && m.state === 'over');
      const j = g.got.findIndex((m) => m.type === 'pass-ended');
      assert.ok(i >= 0 && i < j, 'over first, then pass-ended');
      assert.strictEqual(g.got[i].reason, 'expired');
      const g2 = await guest(PORT, 'ios', FLAG);
      rs.broadcastPassEnded('left', CODE);
      await until(() => g2.has('pass-ended'));
      assert.ok(!g2.got.some((m) => m.type === 'pass-state' && m.state === 'over'), 'left: the pass is still good');
    } finally { rs.stop(); }
  });

  await check('expiring: on-air / ends-soon follows main\'s broadcast', async () => {
    const PORT = 17570;
    const { rs, live } = server(PORT);
    await sleep(400);
    try {
      const g = await guest(PORT, 'ios', FLAG);
      const n = g.states().length;
      rs.broadcastPassState();
      await sleep(80);
      assert.strictEqual(g.states().length, n, 'nothing changed: nothing sent');
      live.expiring = true;
      rs.broadcastPassState();
      await until(() => g.last('pass-state').reason === 'ends-soon');
      assert.strictEqual(g.last('pass-state').reason, 'ends-soon');
      g.ws.close();
    } finally { rs.stop(); }
  });

  // ------------------------------------------------------------ 4. the clients
  await check('POTACAT as a remote advertises pass-state, emits it, keeps passState on a refusal, and claims when asked', () => {
    const c = Object.create(RemoteClient.prototype);
    require('events').EventEmitter.call(c);
    const sent = [];
    c._ws = { readyState: WebSocket.OPEN, close() {} };
    c._send = (m) => sent.push(m);
    c._target = { id: 't', name: 'shack' };
    c._authRetryAttempts = 0;
    const got = [];
    c.on('pass-state', (p) => got.push(p));
    c._claimPending = true;
    c._handleMessage(JSON.stringify({ type: 'pass-state', state: 'waiting', reason: 'other-device', endsAt: END, device: 'iPhone or iPad' }));
    assert.deepStrictEqual(got[0], { state: 'waiting', reason: 'other-device', endsAt: END, device: 'iPhone or iPad' });
    assert.ok(sent.some((m) => m.type === 'pass-claim'), 'a PC that asked for the rig back claims it');
    assert.strictEqual(c._passState.reason, 'other-device');
    sent.length = 0;
    c._handleMessage(JSON.stringify({ type: 'pass-state', state: 'waiting', reason: 'other-device', endsAt: END }));
    assert.ok(!sent.some((m) => m.type === 'pass-claim'), 'only once');
    let fail = null;
    c.on('auth-fail', (f) => { fail = f; });
    c._handleMessage(JSON.stringify({ type: 'auth-fail', reason: 'busy', code: 'rig_in_use', by: 'owner', passState: { state: 'waiting', reason: 'owner-has-radio', endsAt: END } }));
    assert.deepStrictEqual(fail.passState, { state: 'waiting', reason: 'owner-has-radio', endsAt: END });
    assert.ok(/'pass-state'\]/.test(read('lib/remote-client.js')), 'hello capability');
  });

  await check('ECHOCAT Web and the POTACAT renderer read the one table; main stays glue', () => {
    const web = read('renderer/remote.js');
    assert.ok(/'mail-folders-v2', 'pass-state'\]/.test(web), 'ECHOCAT Web advertises the flag');
    assert.ok(/case 'pass-state':/.test(web) && /PassWording\.describeState/.test(web) && /type: 'pass-claim'/.test(web));
    const css = read('renderer/remote.css');
    const block = css.slice(css.indexOf('#pass-banner .pass-state-btn'), css.indexOf('#pass-banner .pass-state-btn:disabled'));
    assert.ok(block && !/#[0-9a-f]{3,6}\b/i.test(block), 'theme tokens only');
    const app = read('renderer/app.js');
    assert.ok(/onRemotePassState/.test(app) && /PassWording\.describeState/.test(app) && /rr-pass-claim/.test(app));
    assert.ok(/remotePassClaim/.test(read('preload.js')));
    const main = read('main.js');
    assert.ok(/remoteClient\.on\('pass-state'/.test(main) && /ipcMain\.handle\('remote-pass-claim'/.test(main));
    assert.ok(/expiring: st === 'expiring'/.test(main), 'main tells the station when the pass is expiring');
    assert.ok(/'pass-state',\n/.test(read('lib/remote-server.js')), 'capability advertised');
    assert.ok(/pass-state/.test(read('docs/echocat-protocol.md')) && /pass-claim/.test(read('docs/echocat-protocol.md')), 'wire contract');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
