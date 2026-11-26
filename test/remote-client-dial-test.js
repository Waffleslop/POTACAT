// RemoteClient dial robustness — regression suite (KE4EST crash, 2026-06-12).
//   1. An unreachable leg must NOT crash the process. RemoteClient
//      re-emitted ws 'error' events unconditionally; with no 'error'
//      listener attached (main.js never attached one), Node's
//      EventEmitter THREW, killing the app — and since activeTargetId
//      persists, the startup auto-dial crash-looped every launch.
//      Without the fix, this test process dies right here.
//   2. A fingerprint-mismatch leg must advance to the next candidate
//      exactly ONCE (mismatch terminates the socket, whose close event
//      also reported failure — the next leg used to get dialed twice).
// Run: node test/remote-client-dial-test.js

'use strict';

const { RemoteServer } = require('../lib/remote-server');
const { RemoteClient } = require('../lib/remote-client');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('=== remote-client dial robustness ===');

  // ── 1. unreachable leg, no 'error' listener → process survives ────
  {
    const c = new RemoteClient(
      { id: 'ct_dead', name: 'Unreachable shack', deviceToken: 'X', lanHost: 'wss://127.0.0.1:1' },
      { clientVersion: 'test', clientPlatform: 'desktop-test' }
    );
    // Mirror main.js's ensureRemoteClient: 'log' and friends, NO 'error'.
    const logs = [];
    c.on('log', m => logs.push(m));
    c.connect();
    await sleep(1200);
    check(true, 'process survived an unreachable leg with no error listener');
    check(typeof c.state().lastError === 'string' && c.state().lastError.length > 0,
      'transport error recorded in state().lastError (' + c.state().lastError + ')');
    check(logs.some(m => /error/i.test(m)), 'transport error surfaced via the log event');
    c.close();
  }

  // ── 2. fingerprint mismatch advances exactly once ─────────────────
  {
    const rs = new RemoteServer();
    rs._serverVersion = 'test';
    rs.start(17320, null, { requireToken: true });
    await sleep(500);

    const c = new RemoteClient(
      {
        id: 'ct_badpin', name: 'Wrong-pin shack', deviceToken: 'X',
        lanHost: 'wss://127.0.0.1:' + rs._port,
        fingerprint: 'AB'.repeat(32),       // deliberately wrong pin
        // Second leg: a name that never resolves (RFC 2606 .invalid). Never
        // 127.0.0.1 or localhost: the Tailscale leg always dials :7300, which on
        // a shack PC is the operator's live POTACAT, and that dial took over
        // their phone's session on every suite run (2026-11-26).
        tsHost: 'no-shack.invalid',
      },
      { clientVersion: 'test', clientPlatform: 'desktop-test' }
    );
    const logs = [];
    c.on('log', m => logs.push(m));
    c.connect();
    await sleep(2500); // a few dial rounds with backoff
    c.close();
    rs.stop();

    const lanDials = logs.filter(m => m.includes('dialing lan')).length;
    const tsDials = logs.filter(m => m.includes('dialing tailscale')).length;
    check(logs.some(m => m.includes('fingerprint mismatch')), 'wrong pin detected and refused');
    check(lanDials > 0 && tsDials === lanDials,
      `mismatch advances to the next leg exactly once per round (lan=${lanDials}, tailscale=${tsDials})`);
  }

  // ── 3. no test dials the live ECHOCAT port ───────────────────────
  {
    const fs = require('fs');
    const path = require('path');
    const bad = [];
    for (const f of fs.readdirSync(__dirname)) {
      if (!f.endsWith('.js')) continue;
      const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
      if (/wss?:\/\/(127\.0\.0\.1|localhost):7300\b/.test(src)) bad.push(f + ' (dials :7300)');
      if (/tsHost:\s*['"](127\.0\.0\.1|localhost)['"]/.test(src)) bad.push(f + ' (tsHost on this PC dials :7300)');
    }
    check(bad.length === 0, "no test dials the operator's live POTACAT on :7300" + (bad.length ? ': ' + bad.join(', ') : ''));
  }

  await sleep(100);
  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
