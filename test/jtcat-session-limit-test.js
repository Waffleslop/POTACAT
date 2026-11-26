#!/usr/bin/env node
'use strict';
// JTCAT session limit: "Stop Run and Hunt after N minutes" (W5XY 2026-11-25).
// The pure rule (lib/jtcat-session-limit.js), then the real main.js glue
// (jtcatSessionLimitStart / Tick / Stop and rearmCq) run against a fake clock
// with the Run and Hunt stop functions stubbed, then the wiring and the
// JTCAT window's option row.
// Run: node test/jtcat-session-limit-test.js
const assert = require('assert');
const path = require('path');
const vm = require('vm');
const { readSrc } = require('./_src');
const SL = require('../lib/jtcat-session-limit');

let pass = 0, fail = 0;
const pending = [];
function test(name, fn) {
  pending.push(async () => {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
  });
}
const R = (p) => readSrc(path.join(__dirname, '..', p));
const MAIN = R('main.js');
function extract(src, header) {
  const i = src.indexOf(header);
  assert.ok(i >= 0, 'missing ' + header);
  const open = src.indexOf(') {', i) + 2;
  let d = 0;
  for (let k = open; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced');
}
const MIN = 60000;
const ON = (m) => ({ jtcatSessionLimitOn: true, jtcatSessionLimitMin: m });

// ── the pure rule ──────────────────────────────────────────────────────────
test('off by default: a missing key, false or a truthy non-true value starts no timer', () => {
  for (const s of [{}, undefined, { jtcatSessionLimitOn: false }, { jtcatSessionLimitOn: 'yes' }, { jtcatSessionLimitMin: 30 }]) {
    const st = SL.start(SL.createState(), { kind: 'run', owner: 'popout', now: 0, settings: s });
    assert.strictEqual(SL.isArmed(st), false);
    assert.strictEqual(SL.decide(st, { now: 10 * 60 * MIN, running: true, qsoInProgress: false }), 'none');
    assert.strictEqual(SL.mayStartNew(st, 10 * 60 * MIN), true);
    assert.strictEqual(SL.statusText(st, 0), '');
  }
});

test('minutes: default 60, clamped to 5..240', () => {
  assert.strictEqual(SL.DEFAULT_MIN, 60);
  assert.strictEqual(SL.clampMinutes(undefined), 60);
  assert.strictEqual(SL.clampMinutes(''), 60);
  assert.strictEqual(SL.clampMinutes('abc'), 60);
  assert.strictEqual(SL.clampMinutes(1), 5);
  assert.strictEqual(SL.clampMinutes(999), 240);
  assert.strictEqual(SL.clampMinutes('90'), 90);
  assert.strictEqual(SL.clampMinutes(44.6), 45);
  const st = SL.start(SL.createState(), { kind: 'hunt', owner: 'popout', now: 0, settings: { jtcatSessionLimitOn: true } });
  assert.strictEqual(st.deadline, 60 * MIN);
});

test('stops after N minutes, not before', () => {
  const st = SL.start(SL.createState(), { kind: 'run', owner: 'popout', now: 1000, settings: ON(30) });
  assert.strictEqual(SL.decide(st, { now: 1000 + 30 * MIN - 1, running: true, qsoInProgress: false }), 'none');
  assert.strictEqual(SL.decide(st, { now: 1000 + 30 * MIN, running: true, qsoInProgress: false }), 'stop');
});

test('waits for a contact in progress, then stops', () => {
  const st = SL.start(SL.createState(), { kind: 'run', owner: 'popout', now: 0, settings: ON(5) });
  assert.strictEqual(SL.decide(st, { now: 6 * MIN, running: true, qsoInProgress: true }), 'wait');
  assert.strictEqual(SL.decide(st, { now: 7 * MIN, running: true, qsoInProgress: false }), 'stop');
  assert.strictEqual(SL.qsoInProgress({ call: 'W1ABC', phase: 'cq-report' }), true);
  assert.strictEqual(SL.qsoInProgress({ call: 'W1ABC', phase: '73' }), true, 'our 73 still has to go out');
  assert.strictEqual(SL.qsoInProgress({ call: 'W1ABC', phase: 'done' }), false);
  assert.strictEqual(SL.qsoInProgress({ call: null, phase: 'cq', mode: 'cq' }), false, 'a CQ nobody answered is not a contact');
  assert.strictEqual(SL.qsoInProgress(null), false);
});

test('no new CQ or Hunt call after the deadline', () => {
  const st = SL.start(SL.createState(), { kind: 'hunt', owner: 'popout', now: 0, settings: ON(5) });
  assert.strictEqual(SL.mayStartNew(st, 5 * MIN - 1), true);
  assert.strictEqual(SL.mayStartNew(st, 5 * MIN), false);
  assert.strictEqual(SL.mayStartNew(st, 50 * MIN), false);
});

test('a manual stop clears the timer of that kind only', () => {
  const st = SL.start(SL.createState(), { kind: 'run', owner: 'popout', now: 0, settings: ON(10) });
  SL.noteStop(st, 'hunt');
  assert.strictEqual(SL.isArmed(st), true, 'a Hunt stop leaves a Run timer');
  SL.noteStop(st, 'run');
  assert.strictEqual(SL.isArmed(st), false);
  assert.strictEqual(SL.mayStartNew(st, 99 * MIN), true);
  const st2 = SL.start(SL.createState(), { kind: 'hunt', owner: 'popout', now: 0, settings: ON(10) });
  assert.strictEqual(SL.decide(st2, { now: MIN, running: false, qsoInProgress: false }), 'clear', 'nothing running clears it');
});

test('a restart starts the count again', () => {
  const st = SL.createState();
  SL.start(st, { kind: 'run', owner: 'popout', now: 0, settings: ON(10) });
  SL.start(st, { kind: 'run', owner: 'popout', now: 8 * MIN, settings: ON(10) });
  assert.strictEqual(st.deadline, 18 * MIN);
  assert.strictEqual(SL.decide(st, { now: 12 * MIN, running: true, qsoInProgress: false }), 'none');
  SL.start(st, { kind: 'hunt', owner: 'popout', now: 9 * MIN, settings: {} });
  assert.strictEqual(SL.isArmed(st), false, 'starting with the option off clears an old timer');
});

test('Run and Hunt both: the texts name the right one', () => {
  const run = SL.start(SL.createState(), { kind: 'run', owner: 'popout', now: 0, settings: ON(60) });
  assert.strictEqual(SL.statusText(run, 18 * MIN), 'Run: 42 min left');
  assert.strictEqual(SL.statusText(run, 18 * MIN + 1), 'Run: 42 min left', 'rounds up');
  assert.strictEqual(SL.stopReason(run), 'time limit (60 min)');
  assert.strictEqual(SL.stopNotice(run), 'Run stopped: your 60-minute limit ran out.');
  assert.strictEqual(SL.statusText(run, 60 * MIN), 'Run: time is up, stopping after this contact');
  const hunt = SL.start(SL.createState(), { kind: 'hunt', owner: 'popout', now: 0, settings: ON(90) });
  assert.strictEqual(SL.statusText(hunt, 0), 'Hunt: 90 min left');
  assert.strictEqual(SL.stopNotice(hunt), 'Hunt stopped: your 90-minute limit ran out.');
});

test('a remote owner gets the same timer', () => {
  const st = SL.start(SL.createState(), { kind: 'run', owner: 'remote', now: 0, settings: ON(5) });
  assert.strictEqual(st.owner, 'remote');
  assert.strictEqual(SL.decide(st, { now: 5 * MIN, running: true, qsoInProgress: false }), 'stop');
});

// ── the real main.js glue against a fake clock ─────────────────────────────
function harness(settings, opts) {
  const o = opts || {};
  const calls = [];
  const sent = [];
  const ctx = {
    JtcatSessionLimit: SL, settings, console,
    clock: 0,
    jtcatFullAutoCq: false, jtcatFullAutoCqOwner: null, jtcatAutoCqMode: 'off', jtcatAutoCqOwner: null,
    jtcatHuntFallbackMode: '', popoutJtcatQso: null, remoteJtcatQso: null, jtcatFullAutoCqModifier: '',
    jtcatPopoutWin: { isDestroyed: () => false, webContents: { send: (ch, p) => sent.push([ch, p]) } },
    remoteServer: { hasClient: () => true, broadcastJtcatQsoState: (p) => calls.push(['phone', p.error]) },
    sendCatLog: (l) => calls.push(['log', l]),
    jtcatChimeTxStopped: (r) => calls.push(['chime', r]),
    stopFullAutoCq: (reason, opts) => { calls.push(['stopRun', reason, !!(opts && opts.quiet)]); SL.noteStop(ctx._st, 'run'); ctx.jtcatFullAutoCq = false; },
    setJtcatHuntMode: (m, owner) => { calls.push(['hunt', m, owner]); if (m === 'off') SL.noteStop(ctx._st, 'hunt'); ctx.jtcatAutoCqMode = m; },
    jtcatBuildCqQso: async () => { calls.push(['newCQ']); return { phase: 'cq', txMsg: 'CQ K3SBP FN20' }; },
    remoteJtcatBroadcastQso: () => {}, popoutBroadcastQso: () => {},
    jtcatFullAutoCqUnanswered: 0, jtcatFullAutoCqPaused: false, jtcatFullAutoCqLastActivity: 0,
    // the Hunt-to-Run fallback start and the real setJtcatHuntMode's neighbours
    jtcatHuntQuietPeriods: 0, JTCAT_HUNT_FALLBACK_PERIODS: 4,
    startFullAutoCq: async (owner, mod, so) => { calls.push(['startRun', owner, !!(so && so.auto)]); ctx.jtcatFullAutoCq = true; return true; },
    broadcastAutoCqState: () => {}, _jtcatSpottedHuntLogged: new Set(), jtcatAutoCqWorkedSession: new Set(),
    jtcatModeHopEnabled: () => false,
  };
  const names = ['jtcatSessionLimitStart', 'jtcatSessionLimitPush', 'jtcatSessionLimitTick', 'jtcatSessionLimitStop',
    'jtcatSessionLimitBlocksTx', 'jtcatSessionLimitClear', 'rearmCq', 'jtcatHuntFallbackStart'];
  if (o.realHunt) { names.push('setJtcatHuntMode'); delete ctx.setJtcatHuntMode; }
  const isAsync = (n) => n === 'rearmCq' || n === 'jtcatHuntFallbackStart';
  const fns = names.map((n) => extract(MAIN, (isAsync(n) ? 'async ' : '') + 'function ' + n + '(')).join('\n');
  const src = `const Date = { now: () => clock };
var _jtcatSessionLimit = JtcatSessionLimit.createState(); var _jtcatSessionLimitNotice = '';
${fns}
_st = _jtcatSessionLimit;
api = { start: jtcatSessionLimitStart, tick: jtcatSessionLimitTick, rearmCq, blocksTx: jtcatSessionLimitBlocksTx,
  clearAll: jtcatSessionLimitClear, fallbackStart: jtcatHuntFallbackStart,
  huntMode: (typeof setJtcatHuntMode === 'function' ? setJtcatHuntMode : null) };`;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return { ctx, calls, sent, ...ctx.api, last: () => sent.filter((x) => x[0] === 'jtcat-session-limit').pop() };
}

test('main: off by default, Run goes on past any time', () => {
  const h = harness({});
  h.ctx.jtcatFullAutoCq = true;
  h.start('run', 'popout');
  h.ctx.clock = 500 * MIN;
  h.tick();
  assert.ok(!h.calls.some((c) => c[0] === 'stopRun'));
});

test('main: Run stops at the deadline, quietly with the reason, chimes, says why, logs a CAT line', () => {
  const h = harness(ON(60));
  h.ctx.jtcatFullAutoCq = true;
  h.start('run', 'popout');
  h.ctx.popoutJtcatQso = { call: null, phase: 'cq' };
  h.ctx.clock = 18 * MIN; h.tick();
  assert.strictEqual(h.last()[1].text, 'Run: 42 min left');
  h.ctx.clock = 60 * MIN; h.tick();
  assert.deepStrictEqual(h.calls.find((c) => c[0] === 'stopRun'), ['stopRun', 'time limit (60 min)', true]);
  assert.ok(h.calls.some((c) => c[0] === 'chime' && c[1] === 'time-limit'));
  assert.ok(h.calls.some((c) => c[0] === 'log' && c[1] === '[JTCAT] Run stopped: your 60-minute limit ran out. (time limit (60 min))'));
  assert.ok(h.sent.some((s) => s[0] === 'jtcat-qso-notice' && s[1].message === 'Run stopped: your 60-minute limit ran out.'));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(h.last()[1])), { text: 'Run stopped: your 60-minute limit ran out.', stopped: true });
});

test('main: a contact in progress at the deadline finishes first', () => {
  const h = harness(ON(5));
  h.ctx.jtcatFullAutoCq = true;
  h.start('run', 'popout');
  h.ctx.popoutJtcatQso = { call: 'W1ABC', phase: 'cq-rr73' };
  h.ctx.clock = 6 * MIN; h.tick();
  assert.ok(!h.calls.some((c) => c[0] === 'stopRun'), 'not cut mid-exchange');
  assert.strictEqual(h.last()[1].text, 'Run: time is up, stopping after this contact');
  h.ctx.popoutJtcatQso.phase = 'done';
  h.ctx.clock = 6.25 * MIN; h.tick();
  assert.ok(h.calls.some((c) => c[0] === 'stopRun'));
});

test('main: rearmCq calls no new CQ after the deadline and stops Run instead', async () => {
  const h = harness(ON(5));
  h.ctx.jtcatFullAutoCq = true; h.ctx.jtcatFullAutoCqOwner = 'popout';
  h.start('run', 'popout');
  h.ctx.clock = 4 * MIN;
  assert.strictEqual(await h.rearmCq('popout'), true);
  assert.strictEqual(h.calls.filter((c) => c[0] === 'newCQ').length, 1, 'before the deadline Run carries on');
  h.ctx.clock = 5 * MIN;
  assert.strictEqual(await h.rearmCq('popout'), false);
  assert.strictEqual(h.calls.filter((c) => c[0] === 'newCQ').length, 1, 'no CQ after it');
  assert.ok(h.calls.some((c) => c[0] === 'stopRun' && c[1] === 'time limit (5 min)'));
});

test('main: Hunt stops the same way, and the phone hears why', () => {
  const h = harness(ON(30));
  h.ctx.jtcatAutoCqMode = 'pota'; h.ctx.jtcatAutoCqOwner = 'popout';
  h.start('hunt', 'popout');
  h.ctx.clock = 30 * MIN; h.tick();
  assert.ok(h.calls.some((c) => c[0] === 'hunt' && c[1] === 'off'));
  assert.ok(h.calls.some((c) => c[0] === 'phone' && c[1] === 'Hunt stopped: your 30-minute limit ran out.'));
  assert.ok(h.calls.some((c) => c[0] === 'chime' && c[1] === 'time-limit'));
});

test('main: a Hunt session whose fallback Run is calling CQ stops both, and Hunt reads off', () => {
  const h = harness(ON(30));
  h.ctx.jtcatAutoCqMode = 'all'; h.ctx.jtcatAutoCqOwner = 'popout';
  h.start('hunt', 'popout');
  // the Hunt-to-Run fallback: Run on, Hunt parked in jtcatHuntFallbackMode
  const realStop = h.ctx.stopFullAutoCq;
  h.ctx.stopFullAutoCq = (r, o) => { h.ctx.jtcatHuntFallbackMode = ''; realStop(r, o); }; // any Run stop ends the fallback's claim
  h.ctx.jtcatFullAutoCq = true; h.ctx.jtcatHuntFallbackMode = 'all'; h.ctx.jtcatAutoCqMode = 'off';
  h.ctx.popoutJtcatQso = { call: null, phase: 'cq' };
  h.ctx.clock = 30 * MIN; h.tick();
  assert.ok(h.calls.some((c) => c[0] === 'stopRun' && c[1] === 'time limit (30 min)'));
  assert.ok(h.calls.some((c) => c[0] === 'hunt' && c[1] === 'off'), 'Hunt is set off too, so every surface stops showing it');
  assert.ok(h.calls.some((c) => c[0] === 'log' && /Hunt stopped: your 30-minute limit ran out/.test(c[1])));
});

test('main: a phone-started Run (owner remote) is enforced here', () => {
  const h = harness(ON(5));
  h.ctx.jtcatFullAutoCq = true; h.ctx.jtcatFullAutoCqOwner = 'remote';
  h.start('run', 'remote');
  h.ctx.remoteJtcatQso = { call: 'K1XYZ', phase: 'cq-report' };
  h.ctx.clock = 5 * MIN; h.tick();
  assert.ok(!h.calls.some((c) => c[0] === 'stopRun'), 'the phone contact finishes first');
  h.ctx.remoteJtcatQso = { call: null, phase: 'cq' };
  h.ctx.clock = 5.25 * MIN; h.tick();
  assert.ok(h.calls.some((c) => c[0] === 'stopRun' && c[1] === 'time limit (5 min)'));
});

test('main: a manual stop clears it; nothing is stopped later', () => {
  const h = harness(ON(5));
  h.ctx.jtcatFullAutoCq = true;
  h.start('run', 'popout');
  h.ctx.stopFullAutoCq('stopped by operator');
  h.calls.length = 0;
  h.ctx.clock = 10 * MIN; h.tick();
  assert.ok(!h.calls.some((c) => c[0] === 'stopRun' || c[0] === 'chime'));
  assert.strictEqual(h.last()[1].text, '');
});

test('lib: unticking mid-session ends the timer; new minutes move the deadline from the start', () => {
  const st = SL.start(SL.createState(), { kind: 'run', owner: 'popout', now: 0, settings: ON(60) });
  SL.applySettings(st, ON(30));
  assert.strictEqual(st.deadline, 30 * MIN);
  assert.strictEqual(SL.statusText(st, 10 * MIN), 'Run: 20 min left');
  SL.applySettings(st, { jtcatSessionLimitOn: false, jtcatSessionLimitMin: 30 });
  assert.strictEqual(SL.isArmed(st), false);
  const off = SL.createState();
  SL.applySettings(off, ON(30));
  assert.strictEqual(SL.isArmed(off), false, 'ticking it on mid-session waits for the next start');
});

test("lib: blocksTx only stops Run's own CQ with no partner, after the deadline", () => {
  const st = SL.start(SL.createState(), { kind: 'run', owner: 'popout', now: 0, settings: ON(5) });
  const cq = { call: null, phase: 'cq' };
  assert.strictEqual(SL.blocksTx(st, { now: 5 * MIN - 1, settings: ON(5), runOn: true, qso: cq }), false, 'before the deadline');
  assert.strictEqual(SL.blocksTx(st, { now: 5 * MIN, settings: ON(5), runOn: true, qso: cq }), true, 'the repeating CQ after it');
  assert.strictEqual(SL.blocksTx(st, { now: 5 * MIN, settings: ON(5), runOn: true, qso: { call: 'W1ABC', phase: 'cq-rr73' } }), false, 'a contact finishes');
  assert.strictEqual(SL.blocksTx(st, { now: 5 * MIN, settings: ON(5), runOn: false, qso: { call: 'W1ABC', phase: '73' } }), false, "Hunt's contact finishes");
  assert.strictEqual(SL.blocksTx(st, { now: 5 * MIN, settings: {}, runOn: true, qso: cq }), false, 'unticked: no limit');
});

test("lib: blocksTx refuses only a CQ; a non-CQ message (an operator reply) still keys", () => {
  const st = SL.start(SL.createState(), { kind: 'run', owner: 'remote', now: 0, settings: ON(5) });
  const a = { now: 6 * MIN, settings: ON(5), runOn: true, qso: { call: null, phase: 'cq' } };
  for (const m of ['CQ K3SBP FN20', 'CQ POTA K3SBP FN20', 'CQ FD K3SBP FN20', ' cq dx K3SBP FN20']) {
    assert.strictEqual(SL.blocksTx(st, { ...a, message: m }), true, m);
  }
  for (const m of ['W1ABC K3SBP FN20', 'W1ABC K3SBP R-12', 'W1ABC K3SBP 73', 'CQK3SBP']) {
    assert.strictEqual(SL.blocksTx(st, { ...a, message: m }), false, m);
  }
  assert.strictEqual(SL.blocksTx(st, a), true, 'no message given: the old rule');
});

test("main: after the deadline an operator reply from the other surface keys and does not stop Run", () => {
  // Run on the phone, its CQ shell has no partner; the operator answers a
  // station in the JTCAT window. That is not Run's CQ: it goes out, and Run is
  // left for the decode tick (which waits for the window's contact).
  const h = harness(ON(5));
  h.ctx.jtcatFullAutoCq = true; h.ctx.jtcatFullAutoCqOwner = 'remote';
  h.start('run', 'remote');
  h.ctx.remoteJtcatQso = { call: null, phase: 'cq' };
  h.ctx.popoutJtcatQso = { call: 'W1ABC', phase: 'reply' };
  h.ctx.clock = 6 * MIN;
  assert.strictEqual(h.blocksTx('W1ABC K3SBP FN20'), false);
  assert.strictEqual(h.blocksTx('CQ K3SBP FN20'), true, "Run's own CQ is still refused");
  h.tick();
  assert.ok(!h.calls.some((c) => c[0] === 'stopRun'), 'the contact in the window finishes first');
});

test("main: tx-start after the deadline does not key Run's repeating CQ (desktop and phone owner)", () => {
  const h = harness(ON(5));
  h.ctx.jtcatFullAutoCq = true; h.ctx.jtcatFullAutoCqOwner = 'popout';
  h.start('run', 'popout');
  h.ctx.popoutJtcatQso = { call: null, phase: 'cq' };
  h.ctx.clock = 4.9 * MIN; h.tick(); // the last decode before the deadline: nothing to do
  assert.ok(!h.calls.some((c) => c[0] === 'stopRun'));
  assert.strictEqual(h.blocksTx(), false);
  h.ctx.clock = 5.05 * MIN; // the next slot, before the next decode
  assert.strictEqual(h.blocksTx(), true, 'the CQ is refused at key-down');
  const remote = harness(ON(5));
  remote.ctx.jtcatFullAutoCq = true; remote.ctx.jtcatFullAutoCqOwner = 'remote';
  remote.start('run', 'remote');
  remote.ctx.remoteJtcatQso = { call: 'K1XYZ', phase: 'cq-report' };
  remote.ctx.clock = 6 * MIN;
  assert.strictEqual(remote.blocksTx(), false, 'a phone Run contact in progress still keys');
  remote.ctx.remoteJtcatQso = { call: null, phase: 'cq' };
  assert.strictEqual(remote.blocksTx(), true);
});

test('main: the Hunt-to-Run fallback calls no CQ after the deadline', async () => {
  const h = harness(ON(5));
  h.ctx.jtcatAutoCqMode = 'all'; h.ctx.jtcatAutoCqOwner = 'popout';
  h.start('hunt', 'popout');
  h.ctx.clock = 4 * MIN;
  await h.fallbackStart();
  assert.ok(h.calls.some((c) => c[0] === 'startRun' && c[2] === true), 'before the deadline the fallback starts');
  const h2 = harness(ON(5));
  h2.ctx.jtcatAutoCqMode = 'all'; h2.ctx.jtcatAutoCqOwner = 'popout';
  h2.start('hunt', 'popout');
  h2.ctx.clock = 5 * MIN;
  await h2.fallbackStart();
  assert.ok(!h2.calls.some((c) => c[0] === 'startRun'), 'no fallback CQ after it');
  assert.ok(h2.calls.some((c) => c[0] === 'hunt' && c[1] === 'off'), 'Hunt stops instead');
});

test('main: unticking mid-session ends the limit at the next check; new minutes apply at once', () => {
  const h = harness(ON(60));
  h.ctx.jtcatFullAutoCq = true;
  h.start('run', 'popout');
  h.ctx.settings.jtcatSessionLimitMin = 20;
  h.ctx.clock = 5 * MIN; h.tick();
  assert.strictEqual(h.last()[1].text, 'Run: 15 min left');
  h.ctx.settings.jtcatSessionLimitOn = false;
  h.ctx.clock = 6 * MIN; h.tick();
  assert.strictEqual(h.last()[1].text, '', 'the countdown goes away');
  h.ctx.clock = 500 * MIN; h.tick();
  assert.ok(!h.calls.some((c) => c[0] === 'stopRun'), 'and nothing stops');
});

test("main: a Hunt pick while the operator's Run is on keeps the Run timer, and Hunt Off leaves it", () => {
  const h = harness(ON(60), { realHunt: true });
  h.ctx.jtcatFullAutoCq = true; h.ctx.jtcatFullAutoCqOwner = 'popout';
  h.start('run', 'popout');
  h.ctx.clock = 20 * MIN;
  h.huntMode('pota', 'popout');
  assert.strictEqual(h.ctx._st.kind, 'run');
  assert.strictEqual(h.ctx._st.deadline, 60 * MIN, 'not replaced');
  h.huntMode('off', 'popout');
  assert.strictEqual(h.ctx._st.kind, 'run', 'Hunt Off does not clear the Run timer');
  const g = harness(ON(30), { realHunt: true });
  g.ctx.clock = 3 * MIN;
  g.huntMode('all', 'popout');
  assert.strictEqual(g.ctx._st.kind, 'hunt', 'Hunt from off, Run off: a Hunt timer');
  assert.strictEqual(g.ctx._st.deadline, 33 * MIN);
  g.ctx.clock = 4 * MIN;
  g.huntMode('pota', 'popout');
  assert.strictEqual(g.ctx._st.deadline, 33 * MIN, 'another target is the same session');
  g.huntMode('off', 'popout');
  assert.strictEqual(SL.isArmed(g.ctx._st), false, 'Hunt Off clears a Hunt timer');
});

test('main: stopping the engine clears the timer and the countdown', () => {
  const h = harness(ON(60));
  h.ctx.jtcatFullAutoCq = true;
  h.start('run', 'popout');
  h.clearAll();
  assert.strictEqual(SL.isArmed(h.ctx._st), false);
  assert.strictEqual(h.last()[1].text, '');
});

test("wiring: both tx-start dispatches refuse Run's CQ after the deadline, after the watchdog and before PTT and the try stamp", () => {
  const single = MAIN.indexOf("jtcatRefuseTx('the Run time limit ran out');");
  assert.ok(single > 0);
  assert.ok(/jtcatRefuseTx\('the Run time limit ran out'\);\n\s*jtcatSessionLimitStop\(\);\n\s*return;/.test(MAIN));
  assert.ok(MAIN.lastIndexOf('jtcatTxWatchdogStop();', single) > single - 600, 'right after the watchdog guard');
  const acq = MAIN.indexOf("acquireRadio('jtcat');", single);
  const stamp = MAIN.indexOf('ft8Engine._lastTxPeriodKey = jtcatPeriodUtc(modeForTx);', single);
  assert.ok(acq > single && acq - single < 200 && stamp > acq, 'before the radio is taken, every audio route and the try stamp');
  const multi = MAIN.indexOf('if (jtcatSessionLimitBlocksTx(data.message)) { // same as the single-slice tx-start');
  assert.ok(multi > 0);
  assert.ok(/engine\._txEnabled = false;[\s\S]*engine\.txComplete\(\);[\s\S]*jtcatSessionLimitStop\(\);\n\s*return;/.test(MAIN.slice(multi, multi + 260)));
  const mStamp = MAIN.indexOf("engine._lastTxPeriodKey = jtcatPeriodUtc(engine._mode || 'FT8');", multi);
  assert.ok(mStamp > multi && mStamp - multi < 1500, 'before the multi-slice try stamp and PTT');
  assert.strictEqual((MAIN.match(/if \(jtcatSessionLimitBlocksTx\(data\.message\)\)/g) || []).length, 2, 'both dispatches pass the text being keyed');
  assert.strictEqual((MAIN.match(/jtcatSessionLimitBlocksTx\(/g) || []).length, 3, 'the definition and the two dispatches, nowhere else');
});

test('wiring: the Hunt-to-Run fallback asks the deadline before startFullAutoCq', () => {
  const fb = extract(MAIN, 'async function jtcatHuntFallbackStart(');
  const chk = fb.indexOf('if (!JtcatSessionLimit.mayStartNew(_jtcatSessionLimit, Date.now())) { jtcatSessionLimitStop(); return; }');
  assert.ok(chk > 0 && chk < fb.indexOf('startFullAutoCq('));
});

test('wiring: the engine stopping clears the timer (startJtcat and jtcat-start-multi run stopJtcat first)', () => {
  assert.ok(/jtcatSessionLimitClear\(\);/.test(extract(MAIN, 'function stopJtcat(')));
  const sj = extract(MAIN, 'function startJtcat(');
  assert.ok(sj.indexOf('stopJtcat();') >= 0 && sj.indexOf('stopJtcat();') < sj.indexOf("jtcatAutoCqMode = 'off';"));
  const at = MAIN.indexOf("ipcMain.on('jtcat-start-multi'");
  const multi = MAIN.slice(at, at + 800);
  assert.ok(multi.indexOf('stopJtcat();') > 0 && multi.indexOf('stopJtcat();') < multi.indexOf("jtcatAutoCqMode = 'off';"));
});

test('wiring: the tick re-reads the settings every decode period', () => {
  assert.ok(/JtcatSessionLimit\.applySettings\(_jtcatSessionLimit, settings\);/.test(extract(MAIN, 'function jtcatSessionLimitTick(')));
});

// ── wiring ─────────────────────────────────────────────────────────────────
test('wiring: Run starts it (not the Hunt fallback), every Run stop clears a Run timer', () => {
  assert.ok(/const JtcatSessionLimit = require\('\.\/lib\/jtcat-session-limit'\);/.test(MAIN));
  const start = extract(MAIN, 'async function startFullAutoCq(');
  assert.ok(/if \(!auto\) jtcatSessionLimitStart\('run', owner\);/.test(start));
  assert.ok(/JtcatSessionLimit\.noteStop\(_jtcatSessionLimit, 'run'\);/.test(extract(MAIN, 'function stopFullAutoCq(')));
});

test('wiring: Hunt starts it from off, keeps it on a target change, clears it on off', () => {
  const body = extract(MAIN, 'function setJtcatHuntMode(');
  assert.ok(/const wasHunting = jtcatAutoCqMode !== 'off' \|\| !!jtcatHuntFallbackMode;/.test(body));
  assert.ok(/const runOn = jtcatFullAutoCq && !jtcatHuntFallbackMode;/.test(body), "the operator's own Run, not the fallback");
  assert.ok(/if \(m === 'off'\) \{ if \(!runOn\) JtcatSessionLimit\.noteStop\(_jtcatSessionLimit, 'hunt'\); \}\n\s*else if \(!wasHunting && !runOn\) jtcatSessionLimitStart\('hunt', owner\);/.test(body));
  assert.ok(body.indexOf('const wasHunting') < body.indexOf('jtcatHuntFallbackMode = \'\''), 'read before the fallback is cleared');
  assert.ok(body.indexOf('const runOn') < body.indexOf('jtcatHuntFallbackMode = \'\''), 'read before the fallback is cleared');
});

test('wiring: checked every decode cycle in both decode paths, before the Hunt-to-Run fallback', () => {
  assert.ok(/^function jtcatFullAutoCqWatchdog\(\) \{\n  jtcatSessionLimitTick\(\);/m.test(MAIN));
  const calls = [...MAIN.matchAll(/jtcatFullAutoCqWatchdog\(\);/g)].map((m) => m.index);
  assert.strictEqual(calls.length, 2, 'single-engine and multi-slice paths');
  for (const at of calls) {
    const fb = MAIN.indexOf('jtcatHuntCqFallbackTick(data.results', at);
    assert.ok(fb > at && fb - at < 6000, 'the limit is checked before the fallback can call CQ');
  }
});

test('wiring: the limit is checked before anything else in the decode paths can answer a caller (#1067 jtcatRunCallersTick)', () => {
  // Run answering waiting callers (PR #1067) must run after the limit's tick, so a
  // past-deadline Run with no partner is stopped before it can engage anyone.
  const sites = [...MAIN.matchAll(/jtcatRunCallersTick\(data\.results/g)].map((m) => m.index);
  for (const at of sites) {
    const wd = MAIN.lastIndexOf('jtcatFullAutoCqWatchdog();', at);
    assert.ok(wd > 0 && at - wd < 400, 'jtcatRunCallersTick comes right after jtcatFullAutoCqWatchdog()');
  }
});

test('wiring: no new CQ (rearmCq) and no new Hunt call after the deadline', () => {
  const rearm = extract(MAIN, 'async function rearmCq(');
  assert.ok(/if \(!JtcatSessionLimit\.mayStartNew\(_jtcatSessionLimit, Date\.now\(\)\)\) \{ jtcatSessionLimitStop\(\); return false; \}/.test(rearm));
  assert.ok(rearm.indexOf('mayStartNew') < rearm.indexOf('jtcatBuildCqQso'));
});

test('wiring: in rearmCq the deadline is checked FIRST, before anything that could answer a waiting caller or call CQ', () => {
  // Only the owner check may come before it. Anything rearmCq does after a QSO
  // (answer a caller who is waiting, build a CQ, transmit) sits below it.
  const rearm = extract(MAIN, 'async function rearmCq(');
  const stmts = rearm.slice(rearm.indexOf('{') + 1).split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
  assert.strictEqual(stmts[0], 'if (!jtcatFullAutoCq || jtcatFullAutoCqOwner !== owner) return false;');
  assert.strictEqual(stmts[1], 'if (!JtcatSessionLimit.mayStartNew(_jtcatSessionLimit, Date.now())) { jtcatSessionLimitStop(); return false; }');
  for (const later of ['jtcatRunAnswerWaiting', 'jtcatBuildCqQso', 'setTxMessage', '_txEnabled', 'tryImmediateTx']) {
    const at = rearm.indexOf(later);
    if (at >= 0) assert.ok(at > rearm.indexOf('mayStartNew'), later + ' comes after the deadline check');
  }
});

test('main: after the deadline rearmCq returns before doing anything else (no answer, no CQ)', async () => {
  const h = harness(ON(5));
  h.ctx.jtcatFullAutoCq = true; h.ctx.jtcatFullAutoCqOwner = 'popout';
  h.start('run', 'popout');
  h.ctx.clock = 5 * MIN;
  const before = h.calls.length;
  assert.strictEqual(await h.rearmCq('popout'), false);
  const after = h.calls.slice(before).map((c) => c[0]);
  assert.ok(!after.includes('newCQ'), 'no CQ');
  assert.deepStrictEqual(after.filter((k) => k !== 'log' && k !== 'chime'), ['stopRun'], 'only the stop runs');
  const guard = MAIN.indexOf("if (jtcatAutoCqMode !== 'off' && !popoutJtcatQso && !remoteJtcatQso) {");
  // The limit is checked right before the Hunt picker (the direct-caller answer
  // and the CQ pick): past the deadline with no contact in progress it turns
  // Hunt off, so the guard below is false and no new call starts.
  const tick = MAIN.lastIndexOf('jtcatSessionLimitTick();', guard);
  assert.ok(guard > 0 && tick > 0 && guard - tick < 300, 'checked immediately before the Hunt picker');
  assert.strictEqual(MAIN.slice(tick, guard).replace(/\/\/[^\n]*\n/g, '').replace(/\s+/g, ' ').trim(), 'jtcatSessionLimitTick();', 'nothing in between');
  const direct = MAIN.indexOf('jtcatTryAnswerDirectCaller(results, myCall, myGrid)', guard);
  const pick = MAIN.indexOf('jtcatWorkableCallers(results, myCall, { filterMode: jtcatAutoCqMode })', guard);
  assert.ok(direct > tick && pick > tick && direct - guard < 2000 && pick - guard < 2000, 'the direct-caller answer and the CQ pick sit after the check, inside that guard');
});

test('wiring: it only stops, through the existing stop functions', () => {
  const stop = extract(MAIN, 'function jtcatSessionLimitStop(');
  assert.ok(/stopFullAutoCq\(reason, \{ quiet: true \}\)/.test(stop));
  assert.ok(/setJtcatHuntMode\('off', jtcatAutoCqOwner\)/.test(stop));
  for (const name of ['jtcatSessionLimitStart', 'jtcatSessionLimitPush', 'jtcatSessionLimitTick', 'jtcatSessionLimitStop']) {
    const b = extract(MAIN, 'function ' + name + '(');
    assert.ok(!/_txEnabled = true|setTxMessage|tryImmediateTx|startFullAutoCq|jtcatBuildCqQso|rearmCq\(/.test(b), name + ' never transmits');
  }
});

test('the JTCAT window: the row under "Stop calling after", saved and clamped by the shared rule', () => {
  const html = R('renderer/jtcat-popout.html');
  const row = html.indexOf('<input type="checkbox" id="jp-session-limit-on"> Stop Run and Hunt after <input id="jp-session-limit-min" type="number" min="5" max="240" value="60"> minutes');
  assert.ok(row > 0, 'the label');
  assert.ok(row > html.indexOf('id="jp-calling-time"') && row < html.indexOf('id="jp-rework-days"'), 'beside "Stop calling after"');
  assert.ok(!/id="jp-session-limit-on" checked/.test(html), 'off by default');
  assert.ok(html.indexOf('<script src="../lib/jtcat-session-limit.js"></script>') > 0 &&
    html.indexOf('<script src="../lib/jtcat-session-limit.js"></script>') < html.indexOf('<script src="jtcat-popout.js"></script>'));
  assert.ok(/<div id="jp-session-limit" class="jp-hunt-status jp-session-limit" hidden aria-live="polite"><\/div>/.test(html), 'the status line under the bar');
  const js = R('renderer/jtcat-popout.js');
  assert.ok(/sessionLimitOn\.checked = window\.JtcatSessionLimit\.isOn\(s\);/.test(js));
  assert.ok(/sessionLimitMin\.value = window\.JtcatSessionLimit\.clampMinutes\(s\.jtcatSessionLimitMin\);/.test(js));
  assert.ok(/window\.api\.saveSettings\(\{ jtcatSessionLimitOn: sessionLimitOn\.checked \}\);/.test(js));
  assert.ok(/var n = window\.JtcatSessionLimit\.clampMinutes\(sessionLimitMin\.value\);[\s\S]{0,80}window\.api\.saveSettings\(\{ jtcatSessionLimitMin: n \}\);/.test(js));
  assert.ok(/onJtcatSessionLimit: \(cb\) => ipcRenderer\.on\('jtcat-session-limit'/.test(R('preload-jtcat-popout.js')));
});

test('per-profile operating policy, documented', () => {
  const g = (MAIN.match(/GLOBAL_KEYS?\s*=\s*(?:new Set\()?\[[\s\S]*?\]/) || [''])[0];
  assert.ok(!g.includes('jtcatSessionLimit'), 'not machine-wide');
  assert.ok(R('docs/JTCAT.md').includes('jtcatSessionLimitOn'));
  assert.ok(R('docs/settings-reference-dev.md').includes('`jtcatSessionLimitOn`'));
});

(async () => {
  for (const t of pending) await t();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
