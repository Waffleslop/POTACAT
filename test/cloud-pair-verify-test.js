'use strict';
// Two desktops on one Cloud address (CLOUD_TO_DESKTOP handoff 2026-11-26, KI7LIK).
// The member picked the shack that was not running the tunnel; Cloud refused the
// pairing code with 403 shack_mismatch and a message + hint, and the browser
// showed only "Sign-in failed". Now:
//   1. every verify refusal (token_unknown/used/expired, account_mismatch,
//      shack_mismatch) reaches the sign-in page as Cloud's own words, as text;
//   2. a shack Cloud marks holds_cloud_host: false is not offered for pairing.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const V = require('../lib/cloud-pair-verify');
const CloudShacks = require('../lib/cloud-shacks');
const WebGate = require('../lib/echocat-web-gate');
const CloudSyncClient = require('../lib/cloud-sync');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const tests = [];
function t(name, fn) { tests.push([name, fn]); }

const SHACK_MISMATCH = {
  error: 'shack_mismatch',
  message: 'That pairing code was issued for a different shack on this account.',
  hint: 'Pick this shack in the list on the other computer and pair again.',
};
const TOKEN_USED = { error: 'token_used', message: 'That pairing code was already used.', hint: 'Go back and pair again.' };

// ── The pure rules ──────────────────────────────────────────────────────

t('a 403 refusal (err.code + err.body, as cloud-sync rejects) keeps message and hint', () => {
  const err = Object.assign(new Error(SHACK_MISMATCH.message), { code: 'shack_mismatch', status: 403, body: SHACK_MISMATCH });
  assert.deepStrictEqual(V.verifyFailure(err), SHACK_MISMATCH);
  assert.strictEqual(V.isVerifyRefusal(err), true);
});

t('a 401 refusal (AUTH_EXPIRED with the body) reads its code from the body', () => {
  const err = Object.assign(new Error('AUTH_EXPIRED'), { status: 401, body: TOKEN_USED });
  assert.deepStrictEqual(V.verifyFailure(err), TOKEN_USED);
  assert.strictEqual(V.isVerifyRefusal(err), true);
  const jwt = Object.assign(new Error('AUTH_EXPIRED'), { status: 401, body: { error: 'Token expired' } });
  assert.strictEqual(V.isVerifyRefusal(jwt), false, 'the shack\'s own sign-in expiring is not a code refusal');
});

t('every verify code is covered', () => {
  assert.deepStrictEqual(V.VERIFY_CODES.slice().sort(),
    ['account_mismatch', 'shack_mismatch', 'token_expired', 'token_unknown', 'token_used']);
  for (const code of V.VERIFY_CODES) {
    const f = V.verifyFailure(Object.assign(new Error('x'), { body: { error: code, message: 'M ' + code, hint: 'H' } }));
    assert.strictEqual(f.error, code);
    assert.strictEqual(V.pairErrorText(V.pairAccountErrorBody(f), 'fallback'), 'M ' + code + ' H');
  }
});

t('no message: a plain fallback, never an empty error', () => {
  assert.deepStrictEqual(V.verifyFailure(new Error('getaddrinfo ENOTFOUND api.potacat.com')),
    { error: 'getaddrinfo ENOTFOUND api.potacat.com', message: '', hint: '' });
  assert.deepStrictEqual(V.verifyFailure(null), { error: 'verify denied', message: '', hint: '' });
  assert.deepStrictEqual(V.pairAccountErrorBody({ error: 'token_used', message: '', hint: 'H' }), { error: 'token_used' },
    'a hint alone is not shown');
  assert.deepStrictEqual(V.pairAccountErrorBody({}), { error: 'verify rejected' });
  assert.strictEqual(V.pairErrorText({ error: 'x' }, 'Sign-in failed. Go back and try again.'), 'Sign-in failed. Go back and try again.');
  assert.strictEqual(V.pairErrorText(null, 'F'), 'F');
  assert.strictEqual(V.pairErrorText({ message: 'Only the message.' }, 'F'), 'Only the message.');
});

t('server text is cleaned: one line, no control characters, capped', () => {
  const f = V.verifyFailure({ body: { error: 'token_used\n<b>', message: 'Line one\r\nline\u0007 two', hint: 'x'.repeat(1000) } });
  assert.strictEqual(f.error, 'token_usedb');
  assert.strictEqual(f.message, 'Line one line two');
  assert.ok(f.hint.length <= V.TEXT_MAX && f.hint.endsWith('...'));
  assert.strictEqual(V.pairAccountErrorBody({ error: 'e', message: 5, hint: {} }).message, undefined);
});

t('holds_cloud_host false is hidden; absent and true stay listed', () => {
  const rows = [
    { device_id: 'a', holds_cloud_host: true },
    { device_id: 'b', holds_cloud_host: false },
    { device_id: 'c' },
    null,
  ];
  assert.deepStrictEqual(CloudShacks.listableShacks(rows).map((d) => d.device_id), ['a', 'c']);
  assert.deepStrictEqual(CloudShacks.listableShacks(undefined), []);
  assert.strictEqual(CloudShacks.listableShacks(rows)[0], rows[0], 'rows pass through unchanged');
});

// ── The browser sign-in page ────────────────────────────────────────────

// Runs the connect page's script against a tiny fake DOM: the browser lands
// with #pair=<token>, POSTs it, and gets `reply` back with `status`.
async function runConnectPage(status, reply) {
  const html = WebGate.buildConnectPageHtml();
  const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, hidden: false, textContent: '', href: '' });
  const document = { getElementById: el };
  const location = { host: 'k3sbp.potacat.com', hash: '#pair=' + 'a'.repeat(64), search: '', pathname: '/', replace() {} };
  const history = { replaceState() {} };
  let settle;
  const done = new Promise((r) => { settle = r; });
  const fetch = () => Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(reply) })
    .finally(() => setTimeout(settle, 0));
  new Function('document', 'location', 'history', 'fetch', 'URLSearchParams', src)(document, location, history, fetch, URLSearchParams);
  await done;
  return el('error');
}

t('shack_mismatch: the page shows Cloud\'s message and hint, not "Sign-in failed"', async () => {
  const box = await runConnectPage(401, V.pairAccountErrorBody(SHACK_MISMATCH));
  assert.strictEqual(box.hidden, false);
  assert.strictEqual(box.textContent, SHACK_MISMATCH.message + ' ' + SHACK_MISMATCH.hint);
});

t('a reply without a message keeps the page\'s own plain words', async () => {
  assert.strictEqual((await runConnectPage(401, { error: 'token_expired' })).textContent,
    'That sign-in link expired. Go back and try again.');
  assert.strictEqual((await runConnectPage(401, { error: 'token_unknown' })).textContent,
    'That sign-in link is not known to POTACAT Cloud. Go back and try again.');
  assert.strictEqual((await runConnectPage(401, { error: 'something_new' })).textContent,
    'Sign-in failed. Go back and try again.');
});

t('server text lands as text: markup is shown literally, never parsed', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const box = await runConnectPage(401, { error: 'token_used', message: evil });
  assert.strictEqual(box.textContent, evil);
  const src = WebGate.buildConnectPageHtml();
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src), 'the page never writes HTML');
});

t('the page is still one constant string (nothing about this install)', () => {
  assert.strictEqual(WebGate.buildConnectPageHtml(), WebGate.buildConnectPageHtml());
  assert.ok(WebGate.buildConnectPageHtml().includes('var pairErrorText = function pairErrorText('));
});

// ── The wiring ──────────────────────────────────────────────────────────

t('CloudSyncClient: a 401 refusal keeps its body (message stays AUTH_EXPIRED)', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(TOKEN_USED));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const c = new CloudSyncClient({ apiBase: 'http://127.0.0.1:' + server.address().port, accessToken: 'jwt' });
    const err = await c.verifyPairToken('a'.repeat(64), 'shack-1').then(() => null, (e) => e);
    assert.ok(err, 'rejected');
    assert.strictEqual(err.message, 'AUTH_EXPIRED');
    assert.strictEqual(err.status, 401);
    assert.deepStrictEqual(err.body, TOKEN_USED);
    assert.deepStrictEqual(V.verifyFailure(err), TOKEN_USED);
  } finally { server.close(); }
});

t('main.js and remote-server.js pass the refusal through', () => {
  const main = read('main.js');
  const handler = main.slice(main.indexOf("remoteServer.on('verify-pair-token'"), main.indexOf("remoteServer.emit('verify-pair-token-result', resultPayload);\n  });"));
  assert.ok(/verifyFailure\(err\)/.test(handler), 'the verify handler uses verifyFailure');
  assert.ok(/message: f\.message, hint: f\.hint/.test(handler));
  const rs = read('lib/remote-server.js');
  assert.ok(/PairVerify\.pairAccountErrorBody\(verifyResult\)/.test(rs), '/api/pair-account answers with the refusal body');
  const redeem = main.slice(main.indexOf('function _doPairAccountRedeem('), main.indexOf('function _doPairRedeem('));
  assert.ok(/pairErrorText\(j, /.test(redeem), 'a desktop pairing reads Cloud\'s words too');
});

t('main.js lists only shacks that hold their Cloud address', () => {
  const main = read('main.js');
  const find = main.slice(main.indexOf("ipcMain.handle('cloud-find-shacks'"), main.indexOf("ipcMain.handle('cloud-pair-shack'"));
  assert.ok(/CloudShacks\.listableShacks\(r && r\.devices\)/.test(find));
});

(async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok ' + name); }
    catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; }
  }
  console.log(`cloud-pair-verify: ${passed}/${tests.length} passed`);
})();
