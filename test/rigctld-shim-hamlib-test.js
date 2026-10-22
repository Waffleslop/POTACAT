// The rigctld shim (lib/rigctld-server.js) against REAL Hamlib: the bundled
// rigctld runs as Hamlib's NET rigctl client (rig model 2) of the shim —
// exactly how Dire Wolf keys through POTACAT for AX.25 — and commands sent to
// that rigctld must arrive at the shim's hooks. Hamlib's client opens with
// \chk_vfo + the long \dump_state handshake; a shim that only knew Pat's six
// commands was refused here.
//
// Needs assets/hamlib/rigctld[.exe] (committed on Windows; CI stages it on
// mac/Linux). SKIPs when it is absent.
// Run: node test/rigctld-shim-hamlib-test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { createRigctldServer } = require('../lib/rigctld-server');

const bin = path.join(__dirname, '..', 'assets', 'hamlib', process.platform === 'win32' ? 'rigctld.exe' : 'rigctld');
if (!fs.existsSync(bin)) { console.log('SKIP: no bundled rigctld'); process.exit(0); }

const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const calls = [];
  let ptt = false;
  let freq = 145050000;
  const shim = createRigctldServer({
    getFreqHz: () => freq,
    setFreqHz: (hz) => { calls.push(['F', hz]); freq = hz; return true; },
    getPtt: () => ptt,
    setPtt: (on) => { calls.push(['T', on]); ptt = on; return true; },
  }, { host: '127.0.0.1' });
  const shimPort = await shim.listen(0);
  const frontPort = await freePort();
  const proc = spawn(bin, ['-m', '2', '-r', `127.0.0.1:${shimPort}`, '-T', '127.0.0.1', '-t', String(frontPort)], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  let failed = false;
  try {
    // rigctld opens the NET rig (our shim) lazily or at start; give it a moment.
    let sock;
    for (let i = 0; i < 40 && !sock; i++) {
      await wait(150);
      sock = await new Promise((r) => { const s = net.connect(frontPort, '127.0.0.1'); s.once('connect', () => r(s)); s.once('error', () => r(null)); });
    }
    assert.ok(sock, 'rigctld (as a NET rigctl client of the shim) came up: ' + stderr.slice(-300));
    let buf = '';
    sock.on('data', (d) => { buf += d; });
    const ask = async (cmd) => { buf = ''; sock.write(cmd + '\n'); for (let i = 0; i < 40 && !/\n/.test(buf); i++) await wait(50); return buf.trim(); };
    assert.strictEqual(await ask('f'), '145050000', 'get_freq came through the shim');
    assert.match(await ask('F 7101500'), /RPRT 0/);
    assert.match(await ask('T 1'), /RPRT 0/);
    assert.strictEqual(await ask('t'), '1');
    assert.match(await ask('T 0'), /RPRT 0/);
    assert.deepStrictEqual(calls, [['F', 7101500], ['T', true], ['T', false]]);
    sock.destroy();
    console.log('  ok  Hamlib 4.x NET rigctl client opens the shim (dump_state handshake) and keys/tunes through it');
  } catch (e) {
    failed = true;
    console.log('  FAIL ' + e.message);
  } finally {
    try { proc.kill(); } catch {}
    await shim.close();
  }
  console.log(failed ? '\n0 passed, 1 failed' : '\n1 passed, 0 failed');
  process.exit(failed ? 1 : 0);
})();
