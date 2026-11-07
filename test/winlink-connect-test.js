// /api/connect is the one Pat request that answers at the END of a radio
// session — many minutes on 1200-baud packet. Under fetch() it was cut at
// exactly five minutes by undici's headers timeout with nothing but "fetch
// failed" in the log (N5XHI, FT-857 + TI-3000, #128). connect() now goes over
// http.request with no timeout unless one is asked for; every other request
// still goes through fetch, and a VARA connect and an ARDOP connect send the
// same request. Fake Pat, real sockets.
// Run: node test/winlink-connect-test.js
'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const http = require('http');
const path = require('path');
const { WinlinkClient, PatHttpError } = require('../lib/winlink-client');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

/** A fake Pat that records every request; `handler(req, res, body)` answers. */
function fakePat(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
      handler(req, res, body);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  })));
}

(async () => {
  console.log('winlink-client /api/connect (#128)');

  await test('a session longer than the per-request timeout is not cut off; other requests still obey it', async () => {
    const pat = await fakePat((req, res) => {
      if (req.url.startsWith('/api/connect')) setTimeout(() => res.end(JSON.stringify({ NumReceived: 3 })), 1200);
      else setTimeout(() => res.end('[]'), 1200);
    });
    const c = new WinlinkClient({ port: pat.port, timeoutMs: 400 });
    const t0 = Date.now();
    assert.strictEqual(await c.connect('ax25+agwpe:///W5AUY-10?freq=145070'), 3);
    assert.ok(Date.now() - t0 >= 1100, 'waited for Pat');
    await assert.rejects(() => c.mailbox('in'), /did not answer within/, 'the mailbox list is still capped by timeoutMs');
    await pat.close();
  });

  await test('an injected connect timeout names itself (the only timeout the call can have)', async () => {
    const pat = await fakePat((req, res) => setTimeout(() => res.end('{}'), 1500));
    const c = new WinlinkClient({ port: pat.port, connectTimeoutMs: 500 });
    await assert.rejects(() => c.connect('ardop:///W1AW-10?freq=7101.5'), /connect: Pat did not answer within 1 s \(connect timeout\)/);
    await pat.close();
  });

  await test('a connection Pat drops is named by its cause, never "fetch failed"', async () => {
    const pat = await fakePat((req) => setTimeout(() => req.socket.destroy(), 100));
    const c = new WinlinkClient({ port: pat.port });
    let err;
    try { await c.connect('ardop:///W1AW-10?freq=7101.5'); } catch (e) { err = e; }
    assert.ok(err, 'rejected');
    assert.ok(/^connect: lost the connection to Pat before it answered \((ECONNRESET|socket hang up|closed)\)$/.test(err.message), err.message);
    assert.ok(!/fetch failed/.test(err.message));
    await pat.close();
  });

  await test('Pat\'s 500 "Session failure" is still a PatHttpError carrying the body', async () => {
    const pat = await fakePat((req, res) => { res.statusCode = 500; res.end('Session failure\n{"NumReceived":0}'); });
    const c = new WinlinkClient({ port: pat.port });
    let err;
    try { await c.connect('ardop:///W1AW-10?freq=7101.5'); } catch (e) { err = e; }
    assert.ok(err instanceof PatHttpError, 'PatHttpError');
    assert.strictEqual(err.status, 500);
    assert.ok(/^connect: HTTP 500 — Session failure/.test(err.message), err.message);
    // and an empty 200 body is zero received, as before
    const ok = await fakePat((req, res) => res.end(''));
    assert.strictEqual(await new WinlinkClient({ port: ok.port }).connect('x'), 0);
    await ok.close();
    await pat.close();
  });

  await test('a VARA connect and an ARDOP connect send the same request (method, path shape, headers, body)', async () => {
    const pat = await fakePat((req, res) => res.end(JSON.stringify({ NumReceived: 0 })));
    const c = new WinlinkClient({ port: pat.port });
    const vara = 'varahf:///W1AW-10?freq=7101.5&bw=500';
    const ardop = 'ardop:///W1AW-10?freq=7101.5';
    await c.connect(vara);
    await c.connect(ardop);
    const [a, b] = pat.requests;
    assert.strictEqual(a.method, 'GET');
    assert.strictEqual(b.method, 'GET');
    assert.strictEqual(a.url, '/api/connect?url=' + encodeURIComponent(vara));
    assert.strictEqual(b.url, '/api/connect?url=' + encodeURIComponent(ardop));
    assert.strictEqual(a.body, '');
    assert.strictEqual(b.body, '');
    assert.deepStrictEqual(a.headers, b.headers, 'identical headers');
    assert.strictEqual(a.headers.host, `127.0.0.1:${pat.port}`);
    assert.strictEqual(a.headers.accept, '*/*');
    console.log('       request headers sent: ' + Object.keys(a.headers).sort().join(', '));
    await pat.close();
  });

  await test('source: http.request is used by connect() only; _req (every other request) is unchanged', () => {
    const src = readSrc(path.join(__dirname, '..', 'lib', 'winlink-client.js'));
    const start = src.indexOf('  connect(url) {');
    const end = src.indexOf('  /** Ask Pat to end the session');
    assert.ok(start > 0 && end > start, 'connect() found');
    const body = src.slice(start, end);
    assert.ok(/http\.request\(/.test(body));
    assert.ok(!/fetch\(/.test(body), 'connect() no longer uses fetch');
    assert.strictEqual((src.match(/http\.request\(/g) || []).length, 1, 'nothing else moved to http.request');
    const rest = src.slice(0, start) + src.slice(end);
    assert.ok(/const res = await fetch\(this\.base \+ path, \{ method, body, headers, signal: ctl\.signal \}\);/.test(rest), '_req still fetches as before');
    const req = src.slice(src.indexOf('  async _req('), src.indexOf('  async status()'));
    assert.ok(!/connectTimeoutMs|http\.request/.test(req), '_req knows nothing of the connect-only timeout or transport');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
