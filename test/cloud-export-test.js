// CloudSyncClient.downloadAdif — regression suite against a local HTTP
// server. Covers the two hardening behaviors from the cloud handoff doc
// (DESKTOP_HANDOFF_EXPORT.md):
//   1. expired access token → 401 → refresh + retry once (not a dead button)
//   2. temp-file-then-rename — an interrupted stream never leaves a
//      truncated .adi at the user's chosen path
// Run: node test/cloud-export-test.js

'use strict';
const { readSrc } = require('./_src');

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CloudSyncClient = require('../lib/cloud-sync');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const ADIF_BODY = 'POTACAT cloud export\n<adif_ver:5>3.1.4<eoh>\n'
  + '<call:5>K3SBP<band:3>20m<eor>\n<call:6>KM4CFT<band:3>40m<eor>\n';

// Tiny stub of api.potacat.com: /v1/sync/export/adif + /v1/auth/refresh.
// `behavior` is mutated per test case.
function startServer(behavior) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/v1/auth/refresh' && req.method === 'POST') {
      behavior.refreshCalls++;
      if (behavior.refreshFails) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'refresh token revoked' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accessToken: 'FRESH-TOKEN', refreshToken: 'FRESH-REFRESH' }));
      return;
    }
    if (req.url === '/v1/sync/export/adif' && req.method === 'GET') {
      const auth = req.headers.authorization || '';
      behavior.exportCalls.push(auth);
      if (behavior.mode === 'expired-then-ok' && auth !== 'Bearer FRESH-TOKEN') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'token expired' }));
        return;
      }
      if (behavior.mode === '500') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'boom' }));
        return;
      }
      if (behavior.mode === '404') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'User not found' }));
        return;
      }
      if (behavior.mode === 'disconnect-midstream') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.write(ADIF_BODY.slice(0, 30)); // partial…
        setTimeout(() => res.destroy(), 30); // …then drop the socket
        return;
      }
      // happy path — stream in two chunks
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write(ADIF_BODY.slice(0, 40));
      setTimeout(() => res.end(ADIF_BODY.slice(40)), 20);
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

function makeClient(port, opts = {}) {
  return new CloudSyncClient({
    apiBase: `http://127.0.0.1:${port}`,
    accessToken: 'STALE-TOKEN',
    refreshToken: 'OLD-REFRESH',
    deviceId: 'test-device',
    ...opts,
  });
}

(async () => {
  console.log('=== cloud-export ===');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-export-test-'));
  const behavior = { mode: 'ok', exportCalls: [], refreshCalls: 0 };
  const srv = await startServer(behavior);
  const port = srv.address().port;

  // ── happy path ────────────────────────────────────────────────────
  {
    behavior.mode = 'ok'; behavior.exportCalls = []; behavior.refreshCalls = 0;
    const dest = path.join(tmpDir, 'happy.adi');
    const client = makeClient(port);
    const out = await client.downloadAdif(dest);
    check(out === dest, 'downloadAdif resolves with the destination path');
    check(readSrc(dest) === ADIF_BODY, 'streamed chunks reassemble byte-for-byte');
    check(!fs.existsSync(dest + '.download'), 'no .download temp file left behind');
    check(behavior.refreshCalls === 0, 'valid token does not trigger a refresh');
  }

  // ── expired token → refresh + retry once ─────────────────────────
  {
    behavior.mode = 'expired-then-ok'; behavior.exportCalls = []; behavior.refreshCalls = 0;
    const dest = path.join(tmpDir, 'refresh.adi');
    let persisted = null;
    const client = makeClient(port, { onTokenRefresh: (a, r) => { persisted = { a, r }; } });
    await client.downloadAdif(dest);
    check(behavior.refreshCalls === 1, '401 triggers exactly one token refresh');
    check(behavior.exportCalls.length === 2
      && behavior.exportCalls[0] === 'Bearer STALE-TOKEN'
      && behavior.exportCalls[1] === 'Bearer FRESH-TOKEN',
      'retry re-sends the export request with the fresh token');
    check(persisted && persisted.a === 'FRESH-TOKEN' && persisted.r === 'FRESH-REFRESH',
      'refreshed tokens are persisted via onTokenRefresh');
    check(readSrc(dest) === ADIF_BODY, 'file is complete after the retry');
  }

  // ── interrupted stream → no truncated file at dest ───────────────
  {
    behavior.mode = 'disconnect-midstream'; behavior.exportCalls = [];
    const dest = path.join(tmpDir, 'truncated.adi');
    const client = makeClient(port, { accessToken: 'FRESH-TOKEN' });
    let err = null;
    try { await client.downloadAdif(dest); } catch (e) { err = e; }
    check(err != null, 'mid-stream disconnect rejects');
    check(!fs.existsSync(dest), 'no truncated file at the chosen path');
    await sleep(50); // let any straggling stream callbacks run
    check(!fs.existsSync(dest + '.download'), 'temp file is cleaned up after the failure');
  }

  // ── server error ─────────────────────────────────────────────────
  {
    behavior.mode = '500'; behavior.exportCalls = [];
    const dest = path.join(tmpDir, 'err.adi');
    const client = makeClient(port, { accessToken: 'FRESH-TOKEN' });
    let err = null;
    try { await client.downloadAdif(dest); } catch (e) { err = e; }
    check(err && /HTTP 500/.test(err.message), 'HTTP 500 rejects with the status');
    check(!fs.existsSync(dest) && !fs.existsSync(dest + '.download'), '500 leaves no files behind');
  }

  // ── account deleted server-side ──────────────────────────────────
  {
    behavior.mode = '404'; behavior.exportCalls = [];
    const dest = path.join(tmpDir, 'gone.adi');
    const client = makeClient(port, { accessToken: 'FRESH-TOKEN' });
    let err = null;
    try { await client.downloadAdif(dest); } catch (e) { err = e; }
    check(err && err.message === 'ACCOUNT_NOT_FOUND', '404 rejects as ACCOUNT_NOT_FOUND (re-sign-in signal)');
    check(!fs.existsSync(dest) && !fs.existsSync(dest + '.download'), '404 leaves no files behind');
  }

  // ── expired token AND failed refresh ─────────────────────────────
  {
    behavior.mode = 'expired-then-ok'; behavior.exportCalls = [];
    behavior.refreshCalls = 0; behavior.refreshFails = true;
    const dest = path.join(tmpDir, 'norefresh.adi');
    const client = makeClient(port); // stale token, refresh will 401
    let err = null;
    try { await client.downloadAdif(dest); } catch (e) { err = e; }
    behavior.refreshFails = false;
    check(err && /^Token refresh failed/.test(err.message),
      'failed refresh surfaces as Token refresh failed (re-sign-in signal)');
    check(behavior.exportCalls.length === 1, 'no second export attempt when the refresh fails');
  }

  // ── signed out ───────────────────────────────────────────────────
  {
    const client = new CloudSyncClient({ apiBase: `http://127.0.0.1:${port}` });
    let err = null;
    try { await client.downloadAdif(path.join(tmpDir, 'never.adi')); } catch (e) { err = e; }
    check(err && /Not authenticated/.test(err.message), 'no tokens → Not authenticated, no request');
  }

  srv.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  console.log('\n' + '='.repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
