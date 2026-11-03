// Dire Wolf readiness without its "Ready to accept" line (Discord #bug-reports,
// 1.13.9): the AGW probe in spawnDirewolf called an undefined `net`, so every
// tick threw an uncaught ReferenceError that ended POTACAT, and a direwolf.exe
// that printed nothing to us was given up on after 15 s while it listened on
// 8010. Drives the probe against a silent listener the way main.js does.
// Run: node test/direwolf-agw-probe-test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const D = require('../lib/direwolf-process');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// main.js's readiness loop, minus the stdout half: probe every 500 ms until
// the port accepts or 15 s pass.
function waitLikeMain(port, { seconds = 15 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let lastProbe = null;
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (settled) return;
      D.probeAgwPort({ port }).then((r) => {
        if (settled) return;
        if (r.ok) { settled = true; clearInterval(timer); resolve({ ok: true, ms: Date.now() - t0 }); }
        else lastProbe = r;
      });
    }, 500);
    setTimeout(() => {
      if (settled) return;
      settled = true; clearInterval(timer);
      resolve({ ok: false, message: D.agwTimeoutMessage({ port, seconds, lastLines: [], lastProbe }) });
    }, seconds * 1000);
  });
}

(async () => {
  const uncaught = [];
  process.on('uncaughtException', (e) => uncaught.push(e));

  await test('a port that accepts reads as ready', async () => {
    const srv = net.createServer((s) => s.destroy());
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const r = await D.probeAgwPort({ port: srv.address().port });
    srv.close();
    assert.deepStrictEqual(r, { ok: true });
  });

  await test('a closed port is ECONNREFUSED, never a throw', async () => {
    const r = await D.probeAgwPort({ port: await freePort() });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, 'ECONNREFUSED');
  });

  await test('a connect that throws resolves instead of escaping the timer', async () => {
    const r = await D.probeAgwPort({ port: 8010, net: { connect: () => { throw Object.assign(new Error('x'), { code: 'EINVAL' }); } } });
    assert.deepStrictEqual(r, { ok: false, code: 'EINVAL' });
  });

  await test('a silent Dire Wolf that opens its port late is found ready, with no uncaught error', async () => {
    const port = await freePort();
    // A child that prints nothing and starts listening after 1.5 s.
    const child = spawn(process.execPath, ['-e',
      `setTimeout(() => require('net').createServer((s) => s.destroy()).listen(${port}, '127.0.0.1'), 1500); setTimeout(() => process.exit(0), 20000);`],
    { stdio: 'ignore' });
    try {
      const r = await waitLikeMain(port);
      assert.ok(r.ok, r.message);
      assert.ok(r.ms >= 1000 && r.ms < 5000, `ready after ${r.ms} ms`);
    } finally { child.kill(); }
    assert.deepStrictEqual(uncaught.map(String), []);
  });

  await test('nothing listening for the whole wait names the port and antivirus', async () => {
    const port = await freePort();
    const r = await waitLikeMain(port, { seconds: 2 });
    assert.strictEqual(r.ok, false);
    assert.ok(r.message.includes(`nothing was listening on 127.0.0.1:${port}`), r.message);
    assert.ok(/antivirus/.test(r.message));
    assert.deepStrictEqual(uncaught.map(String), []);
  });

  await test('timeout wording', () => {
    assert.ok(/it last said: a \| b$/.test(D.agwTimeoutMessage({ port: 8010, lastLines: ['a', 'b'], lastProbe: { ok: false, code: 'ECONNREFUSED' } })));
    const t = D.agwTimeoutMessage({ port: 8010, lastProbe: { ok: false, code: 'TIMEOUT' } });
    assert.ok(/gave TIMEOUT/.test(t) && !/antivirus/.test(t), t);
    assert.ok(/nothing was listening/.test(D.agwTimeoutMessage({ port: 8010 })));
  });

  await test('main.js: spawnDirewolf probes through the module, and no bare net.* without a local require', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const i = main.indexOf('async function spawnDirewolf(');
    const body = main.slice(i, main.indexOf('\nfunction killArdop', i));
    assert.ok(/DirewolfProcess\.probeAgwPort\(/.test(body));
    assert.ok(/DirewolfProcess\.agwTimeoutMessage\(/.test(body));
    // main.js has no module-level `net`; every bare use needs its own require nearby.
    const re = /(^|[^\w.$])net\.(connect|createConnection|createServer|Socket)\b/g;
    let m;
    while ((m = re.exec(main))) {
      const before = main.slice(Math.max(0, m.index - 3000), m.index);
      const line = main.slice(0, m.index).split('\n').length;
      assert.ok(/const net = require\('net'\)/.test(before), `main.js:${line} uses net.${m[2]} with no require('net') in scope`);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
