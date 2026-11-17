#!/usr/bin/env node
'use strict';
// Activation review fix 1: a QRZ lookup over a stalled link must give up.
// httpGet set a timeout option but had no 'timeout' handler, so a socket that
// connected and then went silent never settled. QSO logging from a phone waits
// on that lookup, so the phone's "logged" reply waited forever on a weak link.
// A local server accepts the connection and never answers (the TLS handshake
// never completes); every QRZ request helper must reject within its timeout.
// Run: node test/qrz-request-timeout-test.js
const assert = require('assert');
const net = require('net');
const { _http } = require('../lib/qrz');

let pass = 0, fail = 0;

function silentServer() {
  const sockets = new Set();
  const server = net.createServer((sock) => { sockets.add(sock); sock.on('error', () => {}); });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => { for (const s of sockets) s.destroy(); server.close(); },
    }));
  });
}

// Settles with the outcome, or 'hung' if the request is still open past the deadline.
function outcome(promise, deadlineMs) {
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve({ hung: true }), deadlineMs); });
  return Promise.race([
    promise.then((v) => ({ resolved: v }), (err) => ({ rejected: err })),
    deadline,
  ]).finally(() => clearTimeout(timer));
}

async function check(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (err) { fail++; console.log('  FAIL ' + name + ': ' + err.message); }
}

(async () => {
  assert.ok(_http && typeof _http.httpGet === 'function', 'lib/qrz exports _http.httpGet');
  const srv = await silentServer();
  const url = `https://127.0.0.1:${srv.port}/xml/current/`;

  await check('httpGet rejects within its timeout when the server never answers', async () => {
    const t0 = Date.now();
    const r = await outcome(_http.httpGet(url, 300), 3000);
    assert.ok(!r.hung, 'httpGet still waiting after 3 s on a 300 ms timeout');
    assert.ok(r.rejected, 'httpGet should reject, not resolve');
    assert.match(r.rejected.message, /timed out/i);
    assert.ok(Date.now() - t0 < 2000, 'rejected too late: ' + (Date.now() - t0) + ' ms');
  });

  await check('httpPost rejects within its timeout when the server never answers', async () => {
    const r = await outcome(_http.httpPost(url, 'KEY=x&ACTION=STATUS', 'POTACAT-test', 300), 3000);
    assert.ok(!r.hung, 'httpPost still waiting after 3 s on a 300 ms timeout');
    assert.ok(r.rejected, 'httpPost should reject, not resolve');
    assert.match(r.rejected.message, /timed out/i);
  });

  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
