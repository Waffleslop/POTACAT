#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// FT8 engine worker lifecycle tests (K3SBP 2026-09-13):
//   - _respawnWorker() must yield exactly ONE replacement. terminate()
//     delivers the old worker's 'exit' (code 1) asynchronously, after the
//     replacement is already up; the old `_respawning` flag was cleared
//     synchronously, so that late exit spawned a THIRD worker — two "FT8
//     worker ready (native)" lines in the log and an orphan decoder.
//   - a worker we replaced must not feed the engine (ready/decodes/watchdog).
//   - a genuine crash still restarts once, and stop() cancels a pending restart.
//   - setMode() re-seeds the watchdog stamp: WSPR (120 s cycle) -> FT8 (15 s)
//     with the last WSPR stamp fired the 2.5-cycle watchdog at the first FT8
//     boundary (41.3 s > 37.5 s) and respawned a healthy worker.
//
// worker_threads.Worker is stubbed BEFORE the engine is required, so no
// thread and no native addon is involved. Run: node test/ft8-worker-respawn-test.js
// =====================================================================

const EventEmitter = require('events');
const wt = require('worker_threads');

const spawned = [];
class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.terminated = false;
    spawned.push(this);
  }
  postMessage() {}
  terminate() {
    this.terminated = true;
    // Real terminate(): the 'exit' event lands on a later tick, code 1.
    setImmediate(() => this.emit('exit', 1));
    return Promise.resolve(1);
  }
}
wt.Worker = FakeWorker;

const { Ft8Engine } = require('../lib/ft8-engine');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ FAIL: ' + msg); } }
function section(n) { console.log('\n=== ' + n + ' ==='); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The engine's own console chatter ("Worker exited with code 1, restarting")
// is expected here; keep the test output readable.
const realError = console.error, realLog = console.log;
function quiet(on) {
  console.error = on ? () => {} : realError;
  console.log = on ? (...a) => { const s = String(a[0]); if (s.startsWith('  ') || s.startsWith('\n===')) realLog(...a); } : realLog;
}

function makeEngine() {
  const e = new Ft8Engine();
  e._running = true; // a started engine without start()'s tick timer
  e._spawnWorker();
  return e;
}

(async () => {
  quiet(true);

  section('_respawnWorker() spawns exactly one replacement');
  {
    spawned.length = 0;
    const e = makeEngine();
    const first = spawned[0];
    ok(spawned.length === 1 && e._worker === first, 'one worker after spawn');
    e._respawnWorker();
    ok(first.terminated, 'the old worker was terminated');
    ok(spawned.length === 2 && e._worker === spawned[1], 'the replacement is live immediately');
    await sleep(1300); // the old worker's late exit + the 1 s restart window
    ok(spawned.length === 2, `no third worker from the old worker's late exit (spawned ${spawned.length})`);
    ok(e._worker === spawned[1], 'the replacement is still the live worker');
    e._running = false;
  }

  section('a replaced worker cannot feed the engine');
  {
    spawned.length = 0;
    const e = makeEngine();
    const old = spawned[0];
    e._respawnWorker();
    const live = spawned[1];
    e._lastWorkerResponseMs = 12345;
    old.emit('message', { type: 'ready', native: true });
    ok(e._workerReady === false, "the old worker's late 'ready' is ignored");
    ok(e._lastWorkerResponseMs === 12345, "the old worker's message does not pet the watchdog");
    live.emit('message', { type: 'ready', native: true });
    ok(e._workerReady === true, "the live worker's 'ready' is honoured");
    ok(e._lastWorkerResponseMs !== 12345, "the live worker's message pets the watchdog");
    let errors = 0;
    e.on('error', () => errors++);
    old.emit('error', new Error('stale'));
    ok(errors === 0, "the old worker's error is not surfaced");
    await sleep(50);
    e._running = false;
  }

  section('a genuine crash restarts once; stop() cancels a pending restart');
  {
    spawned.length = 0;
    const e = makeEngine();
    spawned[0].emit('exit', 1); // crash, not our terminate
    ok(e._worker === null && e._workerReady === false, 'crash clears the live worker');
    await sleep(1100);
    ok(spawned.length === 2 && e._worker === spawned[1], `one restart after 1 s (spawned ${spawned.length})`);
    ok(e._lastWorkerResponseMs > 0, 'the restart re-seeds the watchdog stamp');

    spawned[1].emit('exit', 1);
    e.stop();
    await sleep(1100);
    ok(spawned.length === 2, 'stop() during the restart window: no new worker');
    ok(e._worker === null, 'nothing live after stop()');

    // A clean exit (code 0) never restarts.
    spawned.length = 0;
    const e2 = makeEngine();
    spawned[0].emit('exit', 0);
    await sleep(1100);
    ok(spawned.length === 1, 'exit code 0 does not restart');
    e2._running = false;
  }

  section('setMode() re-seeds the watchdog stamp for the new cycle length');
  {
    const e = new Ft8Engine();
    e.setMode('WSPR');
    const stale = Date.now() - 100_000; // a legitimate last-decode age on a 120 s cycle
    e._lastWorkerResponseMs = stale;
    e.setMode('FT8');
    ok(Date.now() - e._lastWorkerResponseMs < 500, 'WSPR -> FT8 moves the stamp to now (was 100 s old: 41.3 s > 37.5 s false fire)');

    e._lastWorkerResponseMs = stale;
    e.setMode('FT8');
    ok(e._lastWorkerResponseMs === stale, 'same mode again leaves the stamp alone');

    e._lastWorkerResponseMs = 0;
    e.setMode('FT4');
    ok(e._lastWorkerResponseMs === 0, 'a zero stamp (no worker alive) stays zero — the spawn seeds it');
  }

  quiet(false);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { quiet(false); console.error(err); process.exit(1); });
