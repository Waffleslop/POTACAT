#!/usr/bin/env node
'use strict';
// APRS A3: messages over the radio. The messenger's radio outbox on a fake
// clock (one press per try unless the default-off automatic retry is on; a
// refusal ends the message; the radio busy wait; nothing to APRS-IS), radio
// acks only with the default-off setting, our own frames ignored, the frame
// built like the radio beacon, the words, and one message end to end through
// the real radio run (lib/aprs-rf-beacon.js) and gate (lib/aprs-rf-gate.js)
// against a fake shim and modem. No radio, no APRS-IS.
// Run: node test/aprs-rf-message-test.js

const assert = require('assert');
const { createMessenger, MAX_TRIES, RETRY_DELAYS_MS, LINK_WAIT_MS, statusWords } = require('../lib/aprs-messenger');
const RM = require('../lib/aprs-rf-message');
const R = require('../lib/aprs-rf-beacon');
const G = require('../lib/aprs-rf-gate');

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }

function rig({ autoRetry = false, autoAck = false, radioFree = true } = {}) {
  const r = { t: 1000000, sent: [], jobs: [], autoRetry, autoAck, radioFree };
  r.m = createMessenger({
    now: () => r.t, myCall: 'K3SBP-10', myBase: 'K3SBP',
    send: (l) => { r.sent.push(l); return true; }, canSend: () => true,
    sendRadio: (job) => { if (!r.radioFree) return false; r.jobs.push(job); return true; },
    radioAutoRetry: () => r.autoRetry, radioAutoAck: () => r.autoAck,
  });
  r.at = (sec) => { r.t += sec * 1000; return r.m.tick(); };
  r.done = (res) => { const j = r.jobs[r.jobs.length - 1]; return r.m.radioDone(j.key, res); };
  return r;
}
const out = (r, call = 'KC3ZZZ-7') => r.m.thread(call).filter((x) => x.dir === 'out').pop();
const SENT = { ok: true, confirmed: true };
const RF_IN = (body) => 'KC3ZZZ-7>APDR16,WIDE1-1*,WIDE2-1::' + body;

console.log('APRS messages over the radio');

test('Send over Radio: the first try is a radio job, never an APRS-IS line', () => {
  const r = rig();
  const c = r.m.compose('kc3zzz-7', 'QSY 146.52', { over: 'radio' });
  assert.ok(c.ok);
  assert.strictEqual(statusWords(c.msg), 'Waiting for the radio');
  r.m.tick();
  assert.strictEqual(r.jobs.length, 1);
  assert.strictEqual(r.jobs[0].kind, 'message');
  assert.strictEqual(r.jobs[0].info, ':KC3ZZZ-7 :QSY 146.52{1');
  assert.deepStrictEqual(r.sent, [], 'nothing to the internet');
  assert.strictEqual(r.m.needsLink(), false, 'a radio message never wants the APRS-IS uplink');
  assert.strictEqual(r.m.needsRadio(), true);
  assert.strictEqual(out(r).status, 'Sending on the radio');
});

test('manual retries (setting off): after the schedule wait the next try waits for a press', () => {
  const r = rig();
  r.m.compose('KC3ZZZ-7', 'test', { over: 'radio' });
  r.m.tick();
  r.done(SENT);
  assert.strictEqual(out(r).status, 'Sent on the radio, try 1 of 5');
  assert.strictEqual(r.at(RETRY_DELAYS_MS[0] / 1000 + 1), null, 'no wake: nothing more goes by itself');
  assert.strictEqual(r.jobs.length, 1, 'no second transmission without a press');
  assert.ok(/No ack yet: press Try again/.test(out(r).status));
  r.at(3600);
  assert.strictEqual(r.jobs.length, 1, 'still nothing an hour later');
  assert.ok(r.m.tryAgain(out(r).lid).ok);
  r.m.tick();
  assert.strictEqual(r.jobs.length, 2, 'one press, one try');
  assert.strictEqual(out(r).status, 'Sending on the radio, try 2 of 5');
  assert.strictEqual(r.m.tryAgain(out(r).lid).ok, false, 'no second press while it goes out');
  r.done(SENT);
  r.m.tick();
  assert.strictEqual(r.jobs.length, 2);
});

test('automatic retries (setting on, default off): the messenger schedule, five tries, then no reply', () => {
  const r = rig({ autoRetry: true });
  r.m.compose('KC3ZZZ-7', 'test', { over: 'radio' });
  r.m.tick(); r.done(SENT);
  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
    assert.strictEqual(r.at(RETRY_DELAYS_MS[i] / 1000 - 1), RETRY_DELAYS_MS[i] - (RETRY_DELAYS_MS[i] - 1000), 'not early');
    assert.strictEqual(r.jobs.length, i + 1);
    r.at(1);
    assert.strictEqual(r.jobs.length, i + 2, 'try ' + (i + 2) + ' on time');
    r.done(SENT);
  }
  assert.strictEqual(out(r).tries, MAX_TRIES);
  r.at(300);
  assert.strictEqual(out(r).state, 'failed');
  assert.strictEqual(out(r).status, 'No reply after 5 tries on the radio');
  assert.strictEqual(r.jobs.length, MAX_TRIES);
});

test('an ack stops the retries; heard on the radio or via APRS-IS alike', () => {
  const r = rig({ autoRetry: true });
  r.m.compose('KC3ZZZ-7', 'test', { over: 'radio' });
  r.m.tick(); r.done(SENT);
  r.m.receive(RF_IN('K3SBP    :ack1'), { via: 'radio' });
  assert.strictEqual(out(r).status, 'Delivered (ack)');
  r.at(600);
  assert.strictEqual(r.jobs.length, 1);
});

test('a refusal ends the message in the refusal\'s words; nothing keeps trying', () => {
  const r = rig({ autoRetry: true });
  r.m.compose('KC3ZZZ-7', 'test', { over: 'radio' });
  r.m.tick();
  r.done({ ok: false, reason: 'no-clear-channel', sentence: 'The channel stayed busy, so nothing was sent.' });
  assert.strictEqual(out(r).state, 'failed');
  assert.strictEqual(out(r).status, 'Not sent on the radio: The channel stayed busy, so nothing was sent');
  r.at(600);
  assert.strictEqual(r.jobs.length, 1);
  const r2 = rig({ autoRetry: true });
  r2.m.compose('KC3ZZZ-7', 'test', { over: 'radio' });
  r2.m.tick(); r2.done(SENT);
  r2.at(30); r2.done({ ok: false, sentence: 'Another mode has the radio.' });
  assert.strictEqual(out(r2).status, 'Stopped after try 1: Another mode has the radio');
});

test('keyed but not confirmed counts as a try and says so', () => {
  const r = rig();
  r.m.compose('KC3ZZZ-7', 'test', { over: 'radio' });
  r.m.tick();
  r.done({ ok: true, confirmed: false, sentence: R.SENT_SENTENCES.noReadback });
  assert.strictEqual(out(r).status, 'Sent on the radio, try 1 of 5 (the radio could not confirm it transmitted)');
});

test('the radio busy with another packet: the try waits, then ends after the link wait', () => {
  const r = rig({ radioFree: false });
  r.m.compose('KC3ZZZ-7', 'test', { over: 'radio' });
  assert.strictEqual(r.m.tick(), 5000);
  r.at(LINK_WAIT_MS / 1000);
  assert.strictEqual(out(r).state, 'failed');
  assert.strictEqual(out(r).status, 'The radio stayed busy, so it was not sent');
});

test('Stop while it goes out: the message stops and its result does not restart it', () => {
  const r = rig({ autoRetry: true });
  r.m.compose('KC3ZZZ-7', 'test', { over: 'radio' });
  r.m.tick();
  assert.strictEqual(r.m.radioJob.lid, out(r).lid, 'main can abort the run for this message');
  assert.ok(r.m.stop(out(r).lid));
  r.done({ ok: false, reason: 'aborted', sentence: 'The beacon was stopped: Stop was pressed.' });
  assert.strictEqual(out(r).state, 'stopped');
  r.at(600);
  assert.strictEqual(r.jobs.length, 1);
});

test('messages heard on the radio: marked via radio, acked over the internet as in A1', () => {
  const r = rig();
  const x = r.m.receive(RF_IN('K3SBP-7  :hello from the park{AB'), { via: 'radio' });
  assert.strictEqual(x.kind, 'message');
  const m = r.m.thread('KC3ZZZ-7')[0];
  assert.strictEqual(m.via, 'radio');
  assert.deepStrictEqual(r.sent, ['K3SBP-10>APZPCT,TCPIP*::KC3ZZZ-7 :ackAB']);
  r.m.tick();
  assert.deepStrictEqual(r.jobs, [], 'auto-ack on the radio is off by default: nothing transmits');
});

test('auto-ack on the radio (setting on, default off): one ack job per copy heard', () => {
  const r = rig({ autoAck: true });
  r.m.receive(RF_IN('K3SBP    :hi{7'), { via: 'radio' });
  r.m.receive(RF_IN('K3SBP    :hi{7'), { via: 'radio' }); // the digipeated copy seconds later
  r.m.tick();
  assert.strictEqual(r.jobs.length, 1);
  assert.deepStrictEqual([r.jobs[0].kind, r.jobs[0].info], ['ack', ':KC3ZZZ-7 :ack7']);
  r.done(SENT);
  r.at(40);
  r.m.receive(RF_IN('K3SBP    :hi{7'), { via: 'radio' }); // the sender retries: our ack was lost
  r.m.tick();
  assert.strictEqual(r.jobs.length, 2, 'acked again');
  // Heard over the internet: never acked on the radio.
  const r2 = rig({ autoAck: true });
  r2.m.receive('KC3ZZZ-7>APDR16,TCPIP*,qAC,T2TEST::K3SBP    :hi{8', { via: 'internet' });
  r2.m.tick();
  assert.deepStrictEqual(r2.jobs, []);
  // Turned off before the ack went: it does not go.
  const r3 = rig({ autoAck: true, radioFree: false });
  r3.m.receive(RF_IN('K3SBP    :hi{9'), { via: 'radio' });
  r3.m.tick();
  r3.autoAck = false; r3.radioFree = true;
  r3.at(5);
  assert.deepStrictEqual(r3.jobs, []);
});

test('our own radio frame digipeated back is not a message to us', () => {
  const r = rig();
  const x = r.m.receive('K3SBP>APZPCT,W3XYZ-1*,WIDE2-1::K3SBP-9  :to my mobile{3', { via: 'radio', ownCalls: ['K3SBP'] });
  assert.strictEqual(x.kind, null);
  assert.deepStrictEqual(r.m.list(), []);
});

test('a restart: a radio message going out comes back as not sent, with no radio state', () => {
  const r = rig();
  r.m.compose('KC3ZZZ-7', 'test', { over: 'radio' });
  r.m.tick();
  const r2 = createMessenger({ now: () => r.t, myCall: 'K3SBP-10', myBase: 'K3SBP', state: JSON.parse(JSON.stringify(r.m.serialize())) });
  const m = r2.thread('KC3ZZZ-7')[0];
  assert.strictEqual(m.state, 'failed');
  assert.strictEqual(m.radioBusy, undefined);
  assert.strictEqual(r2.needsRadio(), false);
});

test('automatic radio transmissions run on 2 m only; 30 m stays one press each', () => {
  // Casey 2026-11-21: "Automatic retries on 30m too"; acks stay 2 m only.
  assert.strictEqual(RM.autoAllowed(true, '2m', 'retry'), true);
  assert.strictEqual(RM.autoAllowed(true, '30m', 'retry'), true);
  assert.strictEqual(RM.autoAllowed(true, '2m', 'ack'), true);
  assert.strictEqual(RM.autoAllowed(true, '30m', 'ack'), false);
  assert.strictEqual(RM.autoAllowed(false, '2m', 'retry'), false);
  assert.strictEqual(RM.autoAllowed(undefined, '30m', 'retry'), false, 'off unless turned on');
});

test('the frame: source, tocall and path as the radio beacon, the chapter 14 field', () => {
  const f = RM.buildRfFrame({ settingsCall: 'K3SBP', band: '2m', ssid: 7, info: ':KC3ZZZ-7 :QSY 146.52{1' });
  assert.ok(f.ok);
  assert.strictEqual(f.packet, 'K3SBP-7>APZPCT,WIDE1-1,WIDE2-1::KC3ZZZ-7 :QSY 146.52{1');
  assert.deepStrictEqual(R.agwRequest(f), { callFrom: 'K3SBP-7', callTo: 'APZPCT', via: ['WIDE1-1', 'WIDE2-1'], info: ':KC3ZZZ-7 :QSY 146.52{1' });
  const h = RM.buildRfFrame({ settingsCall: 'K3SBP', band: '30m', info: ':KC3ZZZ-7 :ack7' });
  assert.strictEqual(h.packet, 'K3SBP>APZPCT,WIDE1-1::KC3ZZZ-7 :ack7');
  assert.ok(R.capFor({ band: '2m', packet: f.packet, txDelayMs: 300, txTailMs: 100, drainMs: 300 }).capMs <= 2200, 'the 2 m cap holds for a full message');
  const long = RM.buildRfFrame({ settingsCall: 'K3SBP', band: '30m', info: ':KC3ZZZ-7 :' + 'x'.repeat(67) + '{99999' });
  assert.ok(R.capFor({ band: '30m', packet: long.packet, txDelayMs: 300, txTailMs: 100, drainMs: 300 }).capMs < 6500, 'the 30 m cap holds for the longest message');
  assert.strictEqual(RM.buildRfFrame({ settingsCall: 'N0CALL', band: '2m', info: ':KC3ZZZ-7 :x' }).ok, false, 'a real callsign');
  assert.strictEqual(RM.buildRfFrame({ settingsCall: 'K3SBP', band: '6m', info: ':KC3ZZZ-7 :x' }).ok, false);
  assert.strictEqual(RM.buildRfFrame({ settingsCall: 'K3SBP', band: '2m', info: '' }).ok, false);
});

test('words: the gate\'s and the run\'s beacon sentences read as a message\'s', () => {
  assert.strictEqual(RM.messageWords(G.SENTENCES.listen), 'Turn on Listen on my radio first. The message goes out on the frequency it listens on.');
  assert.strictEqual(RM.messageWords(G.SENTENCES.window), 'Open the APRS window to send over the radio.');
  assert.strictEqual(RM.messageWords(G.SENTENCES.remote), 'Messages over the radio go out from the computer the radio is connected to.');
  assert.strictEqual(RM.messageWords('The beacon ran past 2.1 s, so POTACAT unkeyed the radio.'), 'The message ran past 2.1 s, so POTACAT unkeyed the radio.');
  for (const s of Object.values(G.SENTENCES).concat(Object.values(R.SENT_SENTENCES))) assert.ok(!/beacon/i.test(RM.messageWords(s)), s);
});

test('Send over: Radio is enabled only while the gate allows it; busy still lets it queue', () => {
  assert.deepStrictEqual(RM.radioChoice({ allowed: true }), { enabled: true, why: '' });
  assert.deepStrictEqual(RM.radioChoice({ allowed: false, reason: 'busy', why: 'A beacon is going out now.' }), { enabled: true, why: '' });
  const off = RM.radioChoice({ allowed: false, reason: 'listen', why: G.SENTENCES.listen });
  assert.strictEqual(off.enabled, false);
  assert.ok(/^Turn on Listen on my radio first\./.test(off.why));
  assert.strictEqual(RM.radioChoice(null).enabled, false);
});

// ── end to end: messenger -> frame -> the real radio run and gate, fake shim and modem ──
function fakeTimers() {
  let t = 0, id = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { id++; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (h) => { timers.delete(h); },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [k, v] of timers) if (v.at <= end && (!next || v.at < next[1].at)) next = [k, v];
        if (!next) break;
        timers.delete(next[0]); t = next[1].at; next[1].fn();
        await Promise.resolve();
      }
      t = end;
      await new Promise((r) => setImmediate(r));
    },
  };
}

function station(o = {}) {
  const tm = fakeTimers();
  const st = { windowOpen: true, listenOn: true, listenState: 'listening', band: '2m', settingsCall: 'K3SBP', aprsHz: 144390000, dialHz: 144390000, radioOwner: 'none', pttKeyed: false, otherTx: '', swrTripped: false, modemFound: true, inFlight: false };
  const modemSent = [];
  let onPtt = null;
  const keys = [];
  let run = null;
  const runner = R.createRfBeacon({
    now: tm.now, setTimer: tm.setTimer, clearTimer: tm.clearTimer, log: () => {},
    begin: () => { st.radioOwner = 'aprs'; return true; },
    end: () => { st.radioOwner = 'none'; },
    startShim: async (fn) => { onPtt = fn; return 4551; },
    stopShim: () => { onPtt = null; },
    startModem: async () => ({ send: (req) => { modemSent.push(req); return true; }, kill() {}, onExit() {} }),
    restoreListen: () => {},
    mayKey: () => G.mayKey(Object.assign({}, st, { inFlight: runner.inFlight() })),
    key: () => { keys.push('key'); return true; },
    unkey: () => { keys.push('unkey'); return Promise.resolve(); },
    txProof: () => ({ canConfirm: true, minMs: 0 }),
  });
  const results = [];
  const m = createMessenger({
    now: tm.now, myCall: 'K3SBP-10', myBase: 'K3SBP', send: () => { throw new Error('APRS-IS must not be used'); }, canSend: () => false,
    radioAutoRetry: () => RM.autoAllowed(o.autoRetry === true, st.band, 'retry'),
    radioAutoAck: () => RM.autoAllowed(o.autoAck === true, st.band, 'ack'),
    sendRadio: (job) => {
      if (runner.inFlight()) return false;
      // main's order: the gate, then the frame, then the run.
      const no = G.readiness(Object.assign({}, st, { inFlight: runner.inFlight() }));
      const f = RM.buildRfFrame({ settingsCall: st.settingsCall, band: st.band, info: job.info });
      const go = no ? Promise.resolve({ ok: false, reason: no.reason, sentence: RM.messageWords(no.sentence) })
        : runner.send({ packet: f, capMs: R.capFor({ band: st.band, packet: f.packet, txDelayMs: 300, txTailMs: 100, drainMs: 300 }).capMs });
      go.then((res) => { results.push(res); m.radioDone(job.key, res.sentence ? Object.assign({}, res, { sentence: RM.messageWords(res.sentence) }) : res); });
      return true;
    },
  });
  const dw = async (on) => { const r = onPtt ? onPtt(on) : 'no-shim'; if (on && r === true) runner.noteRadioTx(true); await tm.advance(0); return r; };
  return { tm, st, m, runner, modemSent, keys, results, dw, get onPtt() { return onPtt; } };
}
const flush = () => new Promise((r) => setImmediate(r));

test('end to end: one press, one frame over the fake shim, keyed once through the gate, then waits for a press', async () => {
  const s = station();
  s.m.compose('KC3ZZZ-7', 'QSY 146.52', { over: 'radio' });
  s.m.tick();
  await flush(); await flush();
  assert.strictEqual(s.modemSent.length, 1);
  assert.strictEqual(s.modemSent[0].info, ':KC3ZZZ-7 :QSY 146.52{1');
  assert.strictEqual(await s.dw(true), true, 'the gate lets the in-flight message key');
  assert.strictEqual(await s.dw(true), false, 'a second key-down is refused');
  await s.dw(false);
  await flush();
  assert.deepStrictEqual(s.results, [{ ok: true, confirmed: true }]);
  const msg = s.m.thread('KC3ZZZ-7')[0];
  assert.strictEqual(msg.status, 'Sent on the radio, try 1 of 5');
  await s.tm.advance(600000); s.m.tick(); await flush();
  assert.strictEqual(s.modemSent.length, 1, 'automatic retries are off by default');
});

test('end to end: a key-down nobody asked for is refused by the gate', async () => {
  const s = station();
  s.m.compose('KC3ZZZ-7', 'x', { over: 'radio' });
  s.m.tick(); await flush(); await flush();
  await s.dw(true); await s.dw(false); await flush();
  assert.strictEqual(s.runner.inFlight(), false);
  assert.strictEqual(G.mayKey(Object.assign({}, s.st, { inFlight: false })).sentence, 'No beacon was asked for, so the radio was not keyed.');
});

test('end to end: Listen off refuses in plain words and never keys', async () => {
  const s = station();
  s.st.listenOn = false;
  s.m.compose('KC3ZZZ-7', 'x', { over: 'radio' });
  s.m.tick(); await flush(); await flush();
  assert.strictEqual(s.modemSent.length, 0);
  assert.deepStrictEqual(s.keys, []);
  assert.strictEqual(s.m.thread('KC3ZZZ-7')[0].status, 'Not sent on the radio: Turn on Listen on my radio first. The message goes out on the frequency it listens on');
});

test('end to end: the cap unkeys a message that runs long', async () => {
  const s = station();
  s.m.compose('KC3ZZZ-7', 'x', { over: 'radio' });
  s.m.tick(); await flush(); await flush();
  await s.dw(true);
  await s.tm.advance(5000);
  await flush();
  assert.deepStrictEqual(s.keys, ['key', 'unkey']);
  assert.strictEqual(s.results[0].reason, 'cap');
  assert.ok(/^Not sent on the radio: The message ran past/.test(s.m.thread('KC3ZZZ-7')[0].status));
});

test('end to end: auto-ack on 30 m never transmits, even with the setting on', async () => {
  const s = station({ autoAck: true });
  s.st.band = '30m'; s.st.aprsHz = 10147600; s.st.dialHz = 10147600;
  s.m.receive('KC3ZZZ-7>APDR16::K3SBP    :hi{7', { via: 'radio' });
  s.m.tick(); await flush();
  assert.strictEqual(s.modemSent.length, 0);
  const t = station({ autoAck: true });
  t.m.receive('KC3ZZZ-7>APDR16::K3SBP    :hi{7', { via: 'radio' });
  t.m.tick(); await flush(); await flush();
  assert.strictEqual(t.modemSent.length, 1, 'on 2 m with the setting on: one ack');
  assert.strictEqual(t.modemSent[0].info, ':KC3ZZZ-7 :ack7');
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
