// Outbound fetch never offers Brotli — lib/fetch-policy.js (CVE-2026-111497,
// Electron 39 has no fixed Node). A real loopback HTTPS server echoes the
// Accept-Encoding it received. HTTPS, not HTTP: undici offers `br` only on
// https: URLs (plain http gets "gzip, deflate" already), and every host
// POTACAT fetches is https.
'use strict';
const assert = require('assert');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../lib/fetch-policy');
const { getOrCreateTlsCert } = require('../lib/remote-server');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e)); }
}

(async () => {
  console.log('pure');
  await test('an init with no Accept-Encoding gets gzip, deflate; a named one is kept', () => {
    assert.strictEqual(P.withoutBrotli().headers.get('accept-encoding'), 'gzip, deflate');
    assert.strictEqual(P.withoutBrotli({ headers: { 'Content-Type': 'application/json' } }).headers.get('accept-encoding'), 'gzip, deflate');
    assert.strictEqual(P.withoutBrotli({ headers: { 'Accept-Encoding': 'identity' } }).headers.get('accept-encoding'), 'identity');
    assert.ok(!/\bbr\b/.test(P.SAFE_ACCEPT_ENCODING));
    const init = { method: 'POST', body: 'x', headers: [['x-a', '1']] };
    const out = P.withoutBrotli(init);
    assert.strictEqual(out.method, 'POST');
    assert.strictEqual(out.headers.get('x-a'), '1');
  });

  console.log('live (HTTPS, self-signed)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-fetch-policy-'));
  const cert = getOrCreateTlsCert(tmp, {});
  const seen = [];
  const srv = https.createServer({ cert: cert.cert, key: cert.key }, (req, res) => { seen.push(req.headers['accept-encoding'] || ''); res.end('ok'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${srv.address().port}`;
  const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    await test('unwrapped Node fetch offers br over https (the reason this exists)', async () => {
      await fetch(base + '/plain');
      assert.ok(/\bbr\b/.test(seen[seen.length - 1]), 'Node offered: ' + seen[seen.length - 1]);
    });
    await test('installed once: plain call, init without headers, init with headers, a Request — none offer br', async () => {
      assert.strictEqual(P.installNoBrotliFetch(globalThis), true);
      assert.strictEqual(P.installNoBrotliFetch(globalThis), false, 'idempotent');
      await fetch(base + '/a');
      await fetch(base + '/b', { method: 'POST', body: 'x' });
      await fetch(base + '/c', { headers: { 'X-Thing': '1' } });
      await fetch(new Request(base + '/d', { headers: { 'X-Thing': '2' } }));
      for (const ae of seen.slice(-4)) assert.strictEqual(ae, 'gzip, deflate', 'sent: ' + ae);
    });
    await test('a caller that names its own Accept-Encoding is left alone', async () => {
      await fetch(base + '/e', { headers: { 'Accept-Encoding': 'identity' } });
      assert.strictEqual(seen[seen.length - 1], 'identity');
    });
  } finally {
    if (prevTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
    // Let the TLS sockets close before the process ends: a hard process.exit
    // with handles still closing trips libuv's async.c assertion on Windows.
    await new Promise((r) => srv.close(r));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }

  console.log('wiring');
  await test('main.js installs it before any module that fetches is loaded', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    const at = main.indexOf("require('./lib/fetch-policy').installNoBrotliFetch(globalThis);");
    assert.ok(at > 0, 'installed in main.js');
    const firstLibRequire = main.search(/require\('\.\/lib\/(?!fetch-policy)/);
    assert.ok(at < firstLibRequire, 'before the first lib require (' + at + ' < ' + firstLibRequire + ')');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
