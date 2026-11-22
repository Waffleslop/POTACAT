// After an Abort, Connect works again without restarting POTACAT (#430).
//
// Pat (the Winlink mail program POTACAT runs) went on reporting "connected"
// after an Abort: POTACAT had ended the session and stopped the modem, and Pat
// was waiting on a modem that was gone. Every Connect saw that and refused
// with "Pat is still on the last call — wait a few seconds and try again".
// Waiting never helped; only restarting POTACAT did.
//
// The rule (lib/winlink-pat-recover.js): a call Pat reports while no session
// of POTACAT's is running is nobody's. Pat is restarted and the Connect goes
// on. The reason the check exists stays true: a session never starts while
// Pat still reports a call (a VARA dial that ignored the first disconnect
// kept asking for PTT for 45 s after Stop, K3SBP 2026-10-23).
// Run: node test/winlink-pat-recover-test.js
'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const path = require('path');
const R = require('../lib/winlink-pat-recover');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js')).replace(/\r\n/g, '\n');
function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  const j = src.indexOf('\nfunction ', i + 10);
  return src.slice(i, j < 0 ? i + 6000 : j);
}

/**
 * A stand-in for Pat. `call` is what its status reports; `dialing` models a
 * dial that goes on asking for PTT until the process is stopped; `disconnects`
 * says whether a disconnect request ends the call (the stuck Pat: it does not).
 */
function fakePat({ call = '', obeysDisconnect = false, restartWorks = true, cleanAfterRestart = true } = {}) {
  const pat = {
    call, log: [], restarts: 0, pttRequests: 0, alive: true,
    status: async () => ({ connected: pat.call === 'connected', dialing: pat.call === 'dialing' }),
    busy: async () => R.patBusyWord(await pat.status()),
    disconnect: async () => { pat.log.push('disconnect'); if (obeysDisconnect) pat.call = ''; },
    restart: async (why) => {
      pat.log.push('restart: ' + why); pat.restarts++;
      if (!restartWorks) { pat.alive = false; return false; }
      if (cleanAfterRestart) pat.call = '';      // a new process has no call and no dial
      return true;
    },
    // What a dial does while it lives: it asks the radio for PTT.
    tick: () => { if (pat.alive && pat.call === 'dialing') pat.pttRequests++; },
  };
  return pat;
}

(async () => {
  console.log('winlink: Pat stuck on the last call (#430)');

  await test('Pat\'s status in one word, whatever the case of its keys', () => {
    assert.strictEqual(R.patBusyWord({ connected: true, dialing: false }), 'on');
    assert.strictEqual(R.patBusyWord({ Connected: true }), 'on');
    assert.strictEqual(R.patBusyWord({ connected: false, dialing: true }), 'hanging up');
    assert.strictEqual(R.patBusyWord({ Dialing: true }), 'hanging up');
    assert.strictEqual(R.patBusyWord({ connected: false, dialing: false, remote_addr: '' }), '');
    assert.strictEqual(R.patBusyWord(null), '');
    assert.strictEqual(R.patBusyWord('ok'), '');
  });

  await test('the decision: go when Pat is idle, restart once when it is not, refuse only when the restart did not clear it', () => {
    assert.strictEqual(R.connectStep({ busy: '', sessionActive: false, restarted: false }), 'go');
    assert.strictEqual(R.connectStep({ busy: 'on', sessionActive: false, restarted: false }), 'restart');
    assert.strictEqual(R.connectStep({ busy: 'hanging up', sessionActive: false, restarted: false }), 'restart');
    assert.strictEqual(R.connectStep({ busy: '', sessionActive: false, restarted: true, restartOk: true }), 'go');
    assert.strictEqual(R.connectStep({ busy: 'on', sessionActive: false, restarted: true, restartOk: true }), 'refuse', 'never a second restart, never a session on top of a call');
    assert.strictEqual(R.connectStep({ busy: '', sessionActive: false, restarted: true, restartOk: false }), 'refuse');
    for (const busy of ['', 'on', 'hanging up']) {
      assert.strictEqual(R.connectStep({ busy, sessionActive: true, restarted: false }), 'refuse', 'Pat is never restarted under a running session');
    }
  });

  await test('the check that runs by itself after an Abort restarts Pat only when it is stuck and nothing is running', () => {
    assert.strictEqual(R.afterAbortStep({ busy: 'on', sessionActive: false, patRunning: true }), 'restart');
    assert.strictEqual(R.afterAbortStep({ busy: 'hanging up', sessionActive: false, patRunning: true }), 'restart');
    assert.strictEqual(R.afterAbortStep({ busy: '', sessionActive: false, patRunning: true }), 'leave', 'Pat let go by itself: nothing to do');
    assert.strictEqual(R.afterAbortStep({ busy: 'on', sessionActive: true, patRunning: true }), 'leave', 'the operator connected again: that session is not disturbed');
    assert.strictEqual(R.afterAbortStep({ busy: 'on', sessionActive: false, patRunning: false }), 'leave');
    assert.ok(R.AFTER_ABORT_CHECK_MS >= 8000 && R.AFTER_ABORT_CHECK_MS <= 15000, 'after the 6 s by which the session has ended');
  });

  await test('the issue as filed: Pat reports "connected" after an Abort, Connect restarts it and goes on', async () => {
    const pat = fakePat({ call: 'connected' });
    const lines = [];
    const r = await R.clearForConnect({ busy: pat.busy, sessionActive: () => false, restart: pat.restart, log: (l) => lines.push(l) });
    assert.deepStrictEqual(r, { ok: true, restarted: true });
    assert.strictEqual(pat.restarts, 1);
    assert.strictEqual(await pat.busy(), '', 'Pat reports no call when the session starts');
    assert.ok(lines.some((l) => /Pat still reports the last call \(connected\) and no session is running: restarting Pat/.test(l)), 'logged: ' + lines.join(' | '));
    assert.ok(lines.some((l) => /Pat is back and reports no call/.test(l)));
  });

  await test('an idle Pat is never restarted, and nothing is logged', async () => {
    const pat = fakePat({ call: '' });
    const lines = [];
    const r = await R.clearForConnect({ busy: pat.busy, sessionActive: () => false, restart: pat.restart, log: (l) => lines.push(l) });
    assert.deepStrictEqual(r, { ok: true, restarted: false });
    assert.strictEqual(pat.restarts, 0);
    assert.strictEqual(lines.length, 0);
  });

  await test('the refusal says what is true, and no longer tells the operator to wait for something that never ends', async () => {
    assert.strictEqual(R.RESTARTING_TEXT, 'Winlink is restarting. Try again in a few seconds.');
    const dead = fakePat({ call: 'connected', restartWorks: false });
    const r1 = await R.clearForConnect({ busy: dead.busy, sessionActive: () => false, restart: dead.restart });
    assert.deepStrictEqual(r1, { ok: false, restarted: true, error: R.RESTARTING_TEXT, reason: 'pat-restarting' });
    const thrown = await R.clearForConnect({ busy: async () => 'on', sessionActive: () => false, restart: async () => { throw new Error('spawn EPERM'); } });
    assert.strictEqual(thrown.ok, false);
    assert.strictEqual(thrown.error, R.RESTARTING_TEXT);
    assert.ok(!/still .* the last call — wait a few seconds/.test(main), 'the old sentence is gone from main.js');
    assert.ok(!/reason: 'pat-busy'/.test(main));
  });

  // ── the VARA path: the reason the check exists ─────────────────────────────
  await test('VARA: a dial that ignores the disconnect is ended by the restart, before the new session starts', async () => {
    const pat = fakePat({ call: 'dialing', obeysDisconnect: false });
    await pat.disconnect();                       // Stop: Pat was told, and went on dialing
    for (let i = 0; i < 5; i++) pat.tick();
    assert.strictEqual(pat.pttRequests, 5, 'the dial is alive and asking for PTT (the 2026-10-23 fault)');
    assert.strictEqual(await pat.busy(), 'hanging up');
    const order = [];
    const r = await R.clearForConnect({
      busy: async () => { const w = await pat.busy(); order.push('status:' + (w || 'idle')); return w; },
      sessionActive: () => false,
      restart: async (why) => { order.push('restart'); return pat.restart(why); },
    });
    assert.deepStrictEqual(order, ['status:hanging up', 'restart', 'status:idle'], 'Pat is asked again after the restart, and only then does the Connect go on');
    assert.deepStrictEqual(r, { ok: true, restarted: true });
    const before = pat.pttRequests;
    for (let i = 0; i < 5; i++) pat.tick();
    assert.strictEqual(pat.pttRequests, before, 'no PTT request from the old dial after the restart');
  });

  await test('VARA: if Pat still reports a dial after the restart, the Connect is refused (never a session on top of a dial)', async () => {
    const pat = fakePat({ call: 'dialing', cleanAfterRestart: false });
    const lines = [];
    const r = await R.clearForConnect({ busy: pat.busy, sessionActive: () => false, restart: pat.restart, log: (l) => lines.push(l) });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, R.RESTARTING_TEXT);
    assert.strictEqual(pat.restarts, 1, 'one restart, not a loop');
    assert.ok(lines.some((l) => /still reports a call .*refused/.test(l)));
  });

  await test('VARA: clearForConnect can never answer ok while Pat reports a call (every combination)', async () => {
    for (const call of ['', 'connected', 'dialing']) {
      for (const restartWorks of [true, false]) {
        for (const cleanAfterRestart of [true, false]) {
          for (const session of [false, true]) {
            const pat = fakePat({ call, restartWorks, cleanAfterRestart });
            const r = await R.clearForConnect({ busy: pat.busy, sessionActive: () => session, restart: pat.restart });
            const tag = JSON.stringify({ call, restartWorks, cleanAfterRestart, session });
            if (r.ok) assert.strictEqual(await pat.busy(), '', 'ok with a call still up: ' + tag);
            if (session) assert.strictEqual(pat.restarts, 0, 'restarted under a session: ' + tag);
            assert.ok(pat.restarts <= 1, tag);
          }
        }
      }
    }
  });

  await test('the restart in main.js stops Pat\'s process (which ends a dial), keeps the VARA port Pat was given, and is one at a time', () => {
    const rs = fnBody(main, 'winlinkRestartPat');
    const kill = rs.indexOf('killPat();');
    const spawn = rs.indexOf('await spawnPat();');
    assert.ok(kill > 0 && spawn > kill, 'the old process is stopped before the new one starts');
    assert.ok(/writePatConfig\(\{ varaAddr: _patVaraAddr \|\| undefined \}\);/.test(rs), 'a Mercury or VARA port already handed to Pat is kept');
    assert.ok(/if \(_winlinkPatRestart\) return _winlinkPatRestart;/.test(rs), 'single flight');
    assert.ok(/if \(winlinkSessionActive\(\)\) \{ winlinkLog\('Pat is not restarted: a session is running'\); return false; \}/.test(rs));
    assert.ok(/await winlinkWaitPatReady\(15000\)/.test(rs));
    assert.ok(!/stopWinlinkShim|killArdop|killDirewolf|disconnectWinlink/.test(rs), 'in place: the radio control shim and the modems are not touched');
    // killPat marks the process as stopped by POTACAT, so its exit is not reported as "Pat stopped".
    assert.ok(/patProc\._potacatStopping = true; try \{ patProc\.kill\(\); \}/.test(fnBody(main, 'killPat')));
  });

  await test('Connect asks Pat before anything is tuned, keyed or started, for every mode', () => {
    const start = main.slice(main.indexOf('async function winlinkStartSession('), main.indexOf('async function winlinkEnterFmDataBeforeDial('));
    const ask = start.indexOf('await WinlinkPatRecover.clearForConnect({');
    assert.ok(ask > 0);
    for (const later of ['acquireRadio(\'winlink\')', 'winlinkState.setSession({', 'await spawnArdop()', 'tuneRadio(', 'patClient.connect(url)', '_winlinkShimArmed = true']) {
      assert.ok(start.indexOf(later) > ask, later + ' comes after Pat is asked');
    }
    assert.ok(/if \(!clear\.ok\) return \{ ok: false, error: clear\.error, reason: clear\.reason \};/.test(start));
    assert.ok(/restart: winlinkRestartPat,/.test(start));
    assert.ok(start.indexOf("if (winlinkSessionActive()) return { ok: false, error: 'A Winlink session is already running' };") < ask, 'a running session is refused first: Pat is not restarted under it');
  });

  await test('an Abort arms the check that runs by itself; turning Winlink off or quitting disarms it', () => {
    assert.ok(/winlinkArmAfterAbortCheck\(\);\n\}/.test(fnBody(main, 'winlinkAbortSession')));
    const arm = fnBody(main, 'winlinkArmAfterAbortCheck');
    assert.ok(/WinlinkPatRecover\.afterAbort\(\{/.test(arm) && /\}, WinlinkPatRecover\.AFTER_ABORT_CHECK_MS\);/.test(arm));
    assert.ok(/patRunning: \(\) => !!\(patClient && patProc\)/.test(arm));
    assert.ok(/clearTimeout\(_winlinkAfterAbortTimer\); _winlinkAfterAbortTimer = null;\n {2}if \(winlinkSessionActive\(\)\)/.test(fnBody(main, 'disconnectWinlink')));
  });

  await test('the background check: restarts a stuck Pat, leaves an idle one and a running session alone', async () => {
    const stuck = fakePat({ call: 'connected' });
    assert.strictEqual(await R.afterAbort({ busy: stuck.busy, sessionActive: () => false, patRunning: () => true, restart: stuck.restart }), 'restarted');
    const idle = fakePat({ call: '' });
    assert.strictEqual(await R.afterAbort({ busy: idle.busy, sessionActive: () => false, patRunning: () => true, restart: idle.restart }), 'left');
    assert.strictEqual(idle.restarts, 0);
    const live = fakePat({ call: 'connected' });
    assert.strictEqual(await R.afterAbort({ busy: live.busy, sessionActive: () => true, patRunning: () => true, restart: live.restart }), 'left');
    assert.strictEqual(live.restarts, 0, 'a new session that is connected is Pat doing its job');
    const dead = fakePat({ call: 'connected', restartWorks: false });
    assert.strictEqual(await R.afterAbort({ busy: dead.busy, sessionActive: () => false, patRunning: () => true, restart: dead.restart }), 'restart-failed');
  });

  await test('while Pat restarts, nothing starts a second Pat beside it', () => {
    const ens = fnBody(main, 'winlinkEnsureStarted');
    const wait = ens.indexOf('if (_winlinkPatRestart) { try { await _winlinkPatRestart; } catch {} }');
    assert.ok(wait > 0 && wait < ens.indexOf('connectWinlink()'), 'the restart is awaited before a start is considered');
  });

  await test('this test is in the list CI runs', () => {
    assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/winlink-pat-recover-test.js'"));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
