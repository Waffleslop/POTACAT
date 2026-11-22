#!/usr/bin/env node
'use strict';
// GitHub #200, #541 step 3: the owner's three controls in Share My Rig.
//
// Pinned here:
//   1. lib/pass-owner-controls.js: take now, take in 5 minutes (fake clock,
//      through takeAt), cancel the pending take, give back, cancel pass, no
//      claim during a take or a hold, the message carried and capped at 140
//   2. lib/pass-state.js: the step 4 seams (when the owner took the radio,
//      when the owner was last active)
//   3. the station (lib/remote-server.js): what the guest is told for each
//      control, and pass-claim refused while a take is pending
//   4. the glue: Share My Rig has the controls, says Cancel pass (never
//      Revoke), confirms inside the page, and main stays thin

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const OC = require('../lib/pass-owner-controls');
const PS = require('../lib/pass-state');
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
const fmt = (t) => new Date(t).toISOString().slice(11, 16); // a fixed clock face for tests

(async () => {
  console.log('=== #200 / #541 step 3: the owner\'s three controls ===');

  // ------------------------------------------------------------ 1. the module
  await check('take now: the owner holds the radio at once; the guest waits for the owner, with the message', () => {
    const r = OC.takeNow(OC.initial(), { now: T0, message: 'Club net in a minute' });
    assert.ok(r.ok && r.changed);
    assert.deepStrictEqual(r.controls.hold, { source: 'desktop', at: T0, lastActiveAt: T0, message: 'Club net in a minute' });
    assert.strictEqual(r.controls.take, null);
    const ps = PS.forConnection({ ownerHolds: !!r.controls.hold, message: r.controls.hold.message, endsAt: END });
    assert.deepStrictEqual([ps.state, ps.reason, ps.message], ['waiting', 'owner-has-radio', 'Club net in a minute']);
    const words = W.describeState(ps, { owner: 'N0CALL' });
    assert.ok(words.line.includes('Message from N0CALL: "Club net in a minute"'));
    assert.ok(words.line.includes('Your pass is still good.'));
    // No message: none is sent.
    const bare = OC.takeNow(OC.initial(), { now: T0 });
    assert.strictEqual(bare.controls.hold.message, '');
    assert.strictEqual(PS.forConnection({ ownerHolds: true, message: '' }).message, undefined);
    // Pressed again: the hold keeps its time; a new message replaces the old one.
    const again = OC.takeNow(r.controls, { now: T0 + MIN, message: 'Ten more minutes' });
    assert.strictEqual(again.controls.hold.at, T0);
    assert.strictEqual(again.controls.hold.message, 'Ten more minutes');
    assert.strictEqual(OC.takeNow(r.controls, { now: T0 + MIN }).changed, false);
  });

  await check('take in 5 minutes: on-air/owner-soon with takeAt and the message; the guest keeps the radio until takeAt, then the owner has it (fake clock)', () => {
    const r = OC.takeLater(OC.initial(), { now: T0, message: 'Net at 20:05' });
    assert.ok(r.ok);
    assert.strictEqual(OC.TAKE_DELAY_MS, 5 * MIN);
    assert.strictEqual(r.takeAt, T0 + 5 * MIN);
    assert.strictEqual(r.controls.hold, null);
    const ps = PS.forConnection({ take: r.controls.take, endsAt: END });
    assert.deepStrictEqual([ps.state, ps.reason, ps.takeAt, ps.message], ['on-air', 'owner-soon', '2026-11-14T20:05:00.000Z', 'Net at 20:05']);
    assert.strictEqual(W.describeState(ps, { owner: 'N0CALL' }).title, 'N0CALL will take the radio at 20:05 UTC.');
    let c = r.controls;
    for (const t of [T0 + MIN, T0 + 4 * MIN, T0 + 5 * MIN - 1]) {
      const k = OC.tick(c, t);
      assert.strictEqual(k.changed, false, 'still the guest\'s at ' + new Date(t).toISOString());
      assert.strictEqual(OC.msUntilTake(c, t), T0 + 5 * MIN - t);
      c = k.controls;
    }
    const due = OC.tick(c, T0 + 5 * MIN);
    assert.ok(due.changed, 'due at takeAt');
    assert.deepStrictEqual(due.controls.hold, { source: 'desktop', at: T0 + 5 * MIN, lastActiveAt: T0 + 5 * MIN, message: 'Net at 20:05' });
    assert.strictEqual(due.controls.take, null);
    const after = PS.forConnection({ ownerHolds: true, message: due.controls.hold.message });
    assert.deepStrictEqual([after.state, after.reason, after.message], ['waiting', 'owner-has-radio', 'Net at 20:05']);
    // Refused while the owner already holds the radio.
    assert.deepStrictEqual([OC.takeLater(due.controls, { now: T0 }).ok, OC.takeLater(due.controls, { now: T0 }).reason], [false, 'owner-holds']);
    // Take it now while pending: the hold carries the take's message.
    const now = OC.takeNow(r.controls, { now: T0 + 2 * MIN });
    assert.strictEqual(now.controls.hold.message, 'Net at 20:05');
    assert.strictEqual(now.controls.take, null);
  });

  await check('cancel the pending take: plain on-air again', () => {
    const r = OC.takeLater(OC.initial(), { now: T0, message: 'x' });
    const c = OC.cancelTake(r.controls);
    assert.ok(c.ok);
    assert.deepStrictEqual(c.controls, { hold: null, take: null });
    assert.strictEqual(OC.tick(c.controls, T0 + 10 * MIN).changed, false, 'nothing fires later');
    const ps = PS.forConnection({ take: c.controls.take, endsAt: END });
    assert.deepStrictEqual([ps.state, ps.reason, ps.takeAt, ps.message], ['on-air', 'none', undefined, undefined]);
    assert.strictEqual(OC.cancelTake(OC.initial()).ok, false, 'no take to cancel');
  });

  await check('give back: at once; refused when the owner does not hold the radio', () => {
    const held = OC.takeNow(OC.initial(), { now: T0, message: 'm' }).controls;
    const g = OC.giveBack(held);
    assert.ok(g.ok);
    assert.deepStrictEqual(g.controls, { hold: null, take: null });
    assert.strictEqual(PS.forConnection({ ownerHolds: false }).reason, 'none');
    assert.deepStrictEqual([OC.giveBack(OC.initial()).ok, OC.giveBack(OC.initial()).reason], [false, 'not-held']);
  });

  await check('cancel pass: ends for good; over/cancelled for the guest, revoked on the wire', () => {
    const r = OC.cancelPass();
    assert.deepStrictEqual(r.controls, { hold: null, take: null });
    assert.strictEqual(r.endReason, 'revoked', 'older phones know revoked');
    assert.deepStrictEqual([r.state.state, r.state.reason], ['over', 'cancelled']);
    assert.deepStrictEqual(PS.fromPassEnded(r.endReason), PS.build('over', 'cancelled'));
    assert.strictEqual(W.describeState(r.state, { owner: 'N0CALL' }).title, 'N0CALL cancelled your Guest Pass.');
    assert.strictEqual(W.isTerminalEndReason(r.endReason), true);
  });

  await check('claims refused during a take and while the owner holds the radio', () => {
    const pending = OC.takeLater(OC.initial(), { now: T0 }).controls;
    const held = OC.takeNow(OC.initial(), { now: T0 }).controls;
    assert.strictEqual(OC.claimBlocked(OC.initial()), false);
    assert.strictEqual(OC.claimBlocked(pending), true);
    assert.strictEqual(OC.claimBlocked(held), true);
    const base = { sameSession: true, standby: true };
    assert.strictEqual(PS.canClaim(base), true);
    assert.strictEqual(PS.canClaim({ ...base, take: pending.take }), false);
    assert.strictEqual(PS.canClaim({ ...base, ownerHolds: !!held.hold }), false);
    assert.strictEqual(PS.canClaim({ ...base, take: OC.cancelTake(pending).controls.take }), true, 'cancelled: claims work again');
  });

  await check('the message is carried, one line, and capped at 140 characters', () => {
    assert.strictEqual(OC.MESSAGE_MAX, 140);
    assert.strictEqual(PS.MESSAGE_MAX, 140);
    assert.strictEqual(OC.cleanMessage('  Back in\n ten\tminutes  '), 'Back in ten minutes');
    assert.strictEqual(OC.cleanMessage(null), '');
    const long = 'a'.repeat(200);
    assert.strictEqual(OC.cleanMessage(long).length, 140);
    const r = OC.takeLater(OC.initial(), { now: T0, message: long });
    assert.strictEqual(r.controls.take.message.length, 140);
    assert.strictEqual(OC.takeNow(OC.initial(), { now: T0, message: long }).controls.hold.message.length, 140);
    // The wire caps it too, whatever the station holds.
    assert.strictEqual(PS.build('waiting', 'owner-has-radio', { message: long }).message.length, 140);
    // Characters, not UTF-16 halves.
    const wide = '\u{1F4FB}'.repeat(150);
    assert.strictEqual(Array.from(OC.cleanMessage(wide)).length, 140);
  });

  await check('the owner\'s status line in plain words', () => {
    const name = { guest: 'n0call', fmtTime: fmt };
    assert.deepStrictEqual(OC.ownerStatus(OC.initial(), name), { kind: 'guest', text: 'N0CALL has the radio.', sub: '' });
    assert.strictEqual(OC.ownerStatus(OC.initial(), { ...name, connected: false }).sub, 'Not connected right now.');
    const pending = OC.takeLater(OC.initial(), { now: T0 }).controls;
    assert.deepStrictEqual(OC.ownerStatus(pending, name), { kind: 'take-pending', text: 'You take the radio at 20:05.', sub: 'N0CALL can keep operating until then.' });
    const held = OC.takeNow(OC.initial(), { now: T0 }).controls;
    assert.strictEqual(OC.ownerStatus(held, name).text, 'You have the radio.');
    assert.strictEqual(OC.ownerStatus(OC.initial(), {}).text, 'Your guest has the radio.');
    // The default clock face: 3:42 PM in local time.
    const d = new Date(2026, 10, 14, 15, 42);
    assert.strictEqual(OC.clockTime(d.getTime()), '3:42 PM');
    assert.strictEqual(OC.clockTime(new Date(2026, 10, 14, 0, 5).getTime()), '12:05 AM');
    assert.strictEqual(OC.ownerStatus(OC.takeLater(OC.initial(), { now: d.getTime() - 5 * MIN }).controls, { guest: 'N0CALL' }).text, 'You take the radio at 3:42 PM.');
  });

  // ------------------------------------------------------------ 2. step 4 seams
  await check('step 4 seams: when the owner took the radio and was last active, and for how long idle', () => {
    assert.deepStrictEqual(PS.ownerHoldFacts(null), { tookAt: null, lastActiveAt: null });
    const hold = OC.takeNow(OC.initial(), { now: T0 }).controls.hold;
    assert.deepStrictEqual(PS.ownerHoldFacts(hold), { tookAt: T0, lastActiveAt: T0 });
    assert.strictEqual(PS.ownerIdleMs(hold, T0 + 3 * MIN), 3 * MIN);
    const active = PS.noteOwnerActive(hold, T0 + 2 * MIN);
    assert.notStrictEqual(active, hold, 'a new object');
    assert.deepStrictEqual(PS.ownerHoldFacts(active), { tookAt: T0, lastActiveAt: T0 + 2 * MIN });
    assert.strictEqual(PS.ownerIdleMs(active, T0 + 7 * MIN), 5 * MIN);
    assert.strictEqual(PS.ownerHoldFacts(PS.noteOwnerActive(active, T0 + MIN)).lastActiveAt, T0 + 2 * MIN, 'never goes back');
    assert.strictEqual(PS.noteOwnerActive(null, T0), null);
    assert.strictEqual(PS.ownerIdleMs(null, T0), null);
  });

  // ------------------------------------------------------------ 3. the station
  const TOKEN = 'owner-token-200';
  const CODE = 'abcd1234';
  const SID = 'b'.repeat(64);
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
    c.last = (type) => { for (let i = c.got.length - 1; i >= 0; i--) if (c.got[i].type === type) return c.got[i]; return null; };
    return c;
  }
  function server(port) {
    const rs = new RemoteServer();
    rs.on('log', () => {});
    rs.setPassValidator(async (code) => ({
      code, privilege_class: 'general', max_power_w: 100, allowed_modes: [], expires_at: END,
      station_callsign: '', owner_callsign: 'N0CALL', status: 'active', guest_callsign: 'N1GST',
    }));
    const live = { live: false, paused: false, expiring: false, code: null, call: '', endsAt: END };
    rs.setPassAuthCallback(async (code) => { Object.assign(live, { live: true, code, call: 'N1GST' }); });
    rs.setPassLiveCheck(() => ({ ...live }));
    const events = [];
    rs.on('pass-paused', () => { live.paused = true; });
    rs.on('pass-resumed', () => { live.paused = false; });
    rs.on('pass-owner-controls', (c) => events.push(c));
    rs.start(port, TOKEN, { requireToken: true, certDir: os.tmpdir() });
    return { rs, live, events };
  }
  async function guest(port, platform) {
    const g = client(port);
    await g.open;
    g.send(protocol.buildClientHello({ clientVersion: 'test/1', clientPlatform: platform, capabilities: FLAG }));
    await sleep(30);
    g.send({ type: 'auth', mode: 'pass', passCode: CODE, sessionId: SID });
    await until(() => g.has('auth-ok') || g.has('auth-fail'));
    await sleep(60);
    return g;
  }

  await check('station: Take the radio now with a message; Give it back to the device that was on the air', async () => {
    const PORT = 17581;
    const { rs, events } = server(PORT);
    await sleep(400);
    try {
      const phone = await guest(PORT, 'ios');
      const pc = await guest(PORT, 'web');
      assert.strictEqual(phone.last('pass-state').reason, 'none');
      assert.ok(rs.takeOverPass('desktop', null, { message: '  Back in ten  ' }));
      await until(() => phone.last('pass-state').reason === 'owner-has-radio');
      assert.strictEqual(phone.last('pass-state').message, 'Back in ten');
      assert.strictEqual(pc.last('pass-state').reason, 'owner-has-radio');
      assert.ok(phone.has('pass-paused'), 'older message alongside');
      const snap = rs.getPassOwnerControls();
      assert.strictEqual(snap.held, true);
      assert.strictEqual(snap.message, 'Back in ten');
      assert.strictEqual(snap.status.text, 'You have the radio.');
      assert.ok(Number.isFinite(snap.tookAt) && snap.lastActiveAt === snap.tookAt, 'step 4 facts');
      assert.ok(events.some((e) => e.held), 'Share My Rig told');
      // A new message while holding replaces the old one.
      rs.takeOverPass('desktop', null, { message: 'Twenty, sorry' });
      await until(() => phone.last('pass-state').message === 'Twenty, sorry');
      // Give it back: any source (the owner at the desk).
      assert.ok(rs.resumePass());
      await until(() => phone.last('pass-state').state === 'on-air');
      assert.strictEqual(phone.last('pass-state').reason, 'none');
      assert.strictEqual(phone.last('pass-state').message, undefined);
      assert.strictEqual(pc.last('pass-state').reason, 'other-device', 'the other device keeps waiting');
      assert.strictEqual(rs.getPassOwnerControls().status.text, 'N1GST has the radio.');
      assert.strictEqual(rs.resumePass(), false, 'nothing to give back');
      phone.ws.close(); pc.ws.close();
    } finally { rs.stop(); }
  });

  await check('station: Take the radio in 5 minutes (short delay): owner-soon with takeAt and message, claim refused, then owner-has-radio at takeAt', async () => {
    const PORT = 17582;
    const { rs } = server(PORT);
    await sleep(400);
    try {
      const phone = await guest(PORT, 'ios');
      const pc = await guest(PORT, 'desktop-win');
      const before = Date.now();
      const r = rs.scheduleTakeOverPass({ message: 'Net soon', delayMs: 400 });
      assert.ok(r.ok, JSON.stringify(r));
      await until(() => phone.last('pass-state').reason === 'owner-soon');
      const s = phone.last('pass-state');
      assert.strictEqual(s.state, 'on-air');
      assert.strictEqual(s.message, 'Net soon');
      assert.ok(Date.parse(s.takeAt) >= before + 400 && Date.parse(s.takeAt) <= Date.now() + 400, 'takeAt');
      assert.strictEqual(rs._client && rs._client._clientPlatform, 'ios', 'the guest keeps operating');
      assert.strictEqual(rs.getPassOwnerControls().takeAt, Date.parse(s.takeAt));
      assert.ok(/^You take the radio at /.test(rs.getPassOwnerControls().status.text));
      // Claim refused while the take is pending.
      const n = pc.got.length;
      pc.send({ type: 'pass-claim' });
      await until(() => pc.got.length > n);
      assert.strictEqual(pc.last('pass-state').reason, 'other-device');
      assert.strictEqual(rs._client._clientPlatform, 'ios');
      // At takeAt the owner has the radio, with the take's message.
      await until(() => phone.last('pass-state').reason === 'owner-has-radio', 2000);
      assert.strictEqual(phone.last('pass-state').message, 'Net soon');
      assert.strictEqual(rs.isPassPaused(), true);
      assert.strictEqual(rs.getPassOwnerControls().takeAt, null);
      // Claim refused while the owner holds the radio.
      const m = pc.got.length;
      pc.send({ type: 'pass-claim' });
      await until(() => pc.got.length > m);
      assert.strictEqual(pc.last('pass-state').reason, 'owner-has-radio');
      // A second take while holding is refused.
      assert.deepStrictEqual(rs.scheduleTakeOverPass({}), { ok: false, reason: 'owner-holds' });
      phone.ws.close(); pc.ws.close();
    } finally { rs.stop(); }
  });

  await check('station: cancel the pending take returns to plain on-air; nothing fires later', async () => {
    const PORT = 17583;
    const { rs } = server(PORT);
    await sleep(400);
    try {
      const phone = await guest(PORT, 'android');
      assert.ok(rs.scheduleTakeOverPass({ message: 'm', delayMs: 300 }).ok);
      await until(() => phone.last('pass-state').reason === 'owner-soon');
      assert.ok(rs.cancelPassTake());
      await until(() => phone.last('pass-state').reason === 'none');
      assert.strictEqual(phone.last('pass-state').takeAt, undefined);
      await sleep(450);
      assert.strictEqual(phone.last('pass-state').reason, 'none', 'the timer was cleared');
      assert.strictEqual(rs.isPassPaused(), false);
      assert.strictEqual(rs.cancelPassTake(), false, 'nothing to cancel');
      phone.ws.close();
    } finally { rs.stop(); }
  });

  await check('station: Cancel pass ends a pending take; the guest is told over/cancelled, then pass-ended revoked', async () => {
    const PORT = 17584;
    const { rs } = server(PORT);
    await sleep(400);
    try {
      const phone = await guest(PORT, 'ios');
      assert.ok(rs.scheduleTakeOverPass({ delayMs: 60000 }).ok);
      rs.broadcastPassEnded(OC.cancelPass().endReason, CODE);
      await until(() => phone.has('pass-ended'));
      const over = phone.last('pass-state');
      assert.deepStrictEqual([over.state, over.reason], ['over', 'cancelled']);
      assert.strictEqual(phone.last('pass-ended').reason, 'revoked');
      assert.strictEqual(rs.getPassOwnerControls().takeAt, null, 'the take went with the pass');
      assert.strictEqual(rs._passTakeTimer, null);
    } finally { rs.stop(); }
  });

  await check('station: no guest, no take', async () => {
    const PORT = 17585;
    const { rs } = server(PORT);
    await sleep(400);
    try {
      assert.deepStrictEqual(rs.scheduleTakeOverPass({}), { ok: false, reason: 'no-guest' });
      assert.strictEqual(rs.takeOverPass('desktop'), false);
    } finally { rs.stop(); }
  });

  // ------------------------------------------------------------ 4. the glue
  await check('Share My Rig: the three controls, a status line, the message box; Cancel pass confirmed in the page', () => {
    const html = read('renderer/index.html');
    const dlg = html.slice(html.indexOf('<dialog id="share-rig-dialog">'), html.indexOf('</dialog>', html.indexOf('<dialog id="share-rig-dialog">')));
    for (const id of ['share-rig-live', 'share-rig-live-status', 'share-rig-take-now', 'share-rig-take-later', 'share-rig-cancel-take', 'share-rig-give-back', 'share-rig-cancel-pass', 'share-rig-live-confirm', 'share-rig-cancel-pass-yes', 'share-rig-cancel-pass-no', 'share-rig-live-message']) {
      assert.ok(dlg.includes('id="' + id + '"'), id);
    }
    assert.ok(dlg.includes('Message to the guest (optional)'));
    assert.ok(/id="share-rig-live-message"[^>]*maxlength="140"/.test(dlg));
    assert.ok(dlg.includes('>Take the radio:<') && dlg.includes('>Now<') && dlg.includes('>In 5 minutes<') && dlg.includes('>Give it back<') && dlg.includes('>Cancel pass<'));
    assert.ok(!/>\s*Revoke/.test(dlg), 'no Revoke label in Share My Rig');
    const app = read('renderer/app.js');
    const share = app.slice(app.indexOf('// ── Share Your Rig dialog'), app.indexOf('// ─── Remote Radios dialog'));
    assert.ok(share.length > 1000);
    assert.ok(!/confirm\(/.test(share), 'no browser confirm in Share My Rig');
    assert.ok(!/'Revoke|Revoke'|>Revoke</.test(share), 'no Revoke wording in Share My Rig');
    assert.ok(share.includes('passOwnerTake') && share.includes('passOwnerCancelTake') && share.includes('passOwnerGiveBack'));
  });

  await check('main stays glue: IPC calls the station, the listener is inside onRemoteServer', () => {
    const main = read('main.js');
    for (const ch of ['pass-owner-get', 'pass-owner-take', 'pass-owner-cancel-take', 'pass-owner-give-back']) {
      assert.ok(main.includes(`ipcMain.handle('${ch}'`), ch);
    }
    const i = main.indexOf("rs.on('pass-owner-controls'");
    assert.ok(i > 0);
    const block = main.lastIndexOf('onRemoteServer((rs) => {', i);
    assert.ok(block > 0 && i - block < 20000, 'inside onRemoteServer');
    assert.ok(!/remoteServer\.on\('pass-owner-controls'/.test(main));
    const pre = read('preload.js');
    for (const k of ['passOwnerGet', 'passOwnerTake', 'passOwnerCancelTake', 'passOwnerGiveBack', 'onPassOwnerControls']) assert.ok(pre.includes(k + ':'), k);
  });

  await check('docs: the protocol names the controls and keeps revoked on the wire', () => {
    const doc = read('docs/echocat-protocol.md');
    assert.ok(doc.includes('Take the radio, In 5 minutes'));
    assert.ok(doc.includes('Cancel pass'));
    assert.ok(/still `revoked` on the wire/.test(doc));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
