'use strict';
// GitHub #541: a valid Guest Pass is never shown as revoked.
//
// A guest used one pass on the phone and on POTACAT as a remote. Cloud never
// revoked it, yet POTACAT said it had been and gave up. Pinned here:
//   1. the words (lib/pass-wording.js), shared by POTACAT-as-remote and ECHOCAT Web
//   2. the station's reading of Cloud's answers (lib/pass-validate.js), by the
//      `error` field: 410 pass_over / 404 not_found = not valid; 429, 5xx,
//      timeout, network, any other 410 = check failed (retry, never "revoked")
//   3. the station's auth-fail codes (lib/remote-server.js _authenticatePass)
//   4. POTACAT-as-remote keeps the code and retries (lib/remote-client.js)
//   5. the 60 s live re-read ends a session only on pass_over / not_found
//   6. pass-ended with left / disconnected / superseded / owner_override leaves
//      the pass row usable (main.js)

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const W = require('../lib/pass-wording');
const { createPassValidator, classifyCloudPassAnswer, liveSessionEndReason, RATE_LIMIT_BACKOFF_MS } = require('../lib/pass-validate');
const { RemoteClient } = require('../lib/remote-client');
const { RemoteServer } = require('../lib/remote-server');

let passed = 0, failed = 0;
const pending = [];
function check(name, fn) {
  pending.push((async () => {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
  })());
}

console.log('=== #541 Guest Pass states ===');

// ---------------------------------------------------------------- 1. words
check('rig_in_use by owner: waiting, pass still good, Try now, retry every minute', () => {
  const w = W.describe({ kind: 'auth-fail', code: 'rig_in_use', by: 'owner', owner: 'k3sbp' });
  assert.strictEqual(w.title, 'Waiting: K3SBP is using the radio');
  assert.strictEqual(w.line, 'Your pass is still good.');
  assert.strictEqual(w.stillGood, true);
  assert.strictEqual(w.terminal, false);
  assert.strictEqual(w.action, 'Try now');
  assert.strictEqual(W.retryDelayMs('rig_in_use', 0), 60000);
  assert.strictEqual(W.retryDelayMs('rig_in_use', 7), 60000);
});
check('rig_in_use by guest: another guest', () => {
  const w = W.describe({ kind: 'auth-fail', code: 'rig_in_use', by: 'guest', owner: 'K3SBP' });
  assert.strictEqual(w.title, 'Another guest is using the radio.');
  assert.strictEqual(w.line, 'Your pass is still good.');
  assert.strictEqual(w.terminal, false);
});
check('pass_check_failed: trying again, never revoked, back-off 30 s 1 2 4 5 5 min', () => {
  const w = W.describe({ kind: 'auth-fail', code: 'pass_check_failed', owner: 'K3SBP' });
  assert.strictEqual(w.title, 'Couldn\'t check your pass just now. Trying again.');
  assert.strictEqual(w.terminal, false);
  assert.strictEqual(w.stillGood, true, 'a failed check says the pass is still good');
  assert.ok(/Your pass is still good\./.test(w.line));
  assert.ok(!/revok/i.test(w.title + w.line));
  assert.deepStrictEqual([0, 1, 2, 3, 4, 9].map((n) => W.retryDelayMs('pass_check_failed', n)),
    [30000, 60000, 120000, 240000, 300000, 300000]);
});
check('pass_not_valid: cancelled / expired / unknown are terminal; not_started waits for its start', () => {
  const c = W.describe({ kind: 'auth-fail', code: 'pass_not_valid', reason: 'cancelled', owner: 'k3sbp' });
  assert.strictEqual(c.title, 'K3SBP cancelled your Guest Pass.');
  assert.strictEqual(c.terminal, true);
  const e = W.describe({ kind: 'auth-fail', code: 'pass_not_valid', reason: 'expired', at: '2026-11-14T18:05:00Z' });
  assert.strictEqual(e.title, 'Your Guest Pass ended at 18:05 UTC.');
  assert.strictEqual(e.terminal, true);
  const u = W.describe({ kind: 'auth-fail', code: 'pass_not_valid', reason: 'unknown', owner: 'K3SBP' });
  assert.strictEqual(u.title, 'This pass code is not known. Check the link from K3SBP.');
  assert.strictEqual(u.terminal, true);
  const s = W.describe({ kind: 'auth-fail', code: 'pass_not_valid', reason: 'not_started', at: '2026-11-15T14:00:00Z' });
  assert.strictEqual(s.title, 'This pass starts at 14:00 UTC 2026-11-15. POTACAT connects then.');
  assert.strictEqual(s.terminal, false);
  assert.strictEqual(W.isRetryableAuthFail('pass_not_valid', 'not_started'), true);
  assert.strictEqual(W.isRetryableAuthFail('pass_not_valid', 'cancelled'), false);
  const now = Date.parse('2026-11-15T13:00:00Z');
  assert.strictEqual(W.retryDelayMs('pass_not_valid', 0, { reason: 'not_started', at: '2026-11-15T13:10:00Z', now }), 10 * 60000 + 5000);
  assert.strictEqual(W.retryDelayMs('pass_not_valid', 0, { reason: 'cancelled', now }), null);
});
check('an older station\'s bare refusal is final but never says revoked', () => {
  const w = W.describe({ kind: 'auth-fail', code: '', owner: 'K3SBP' });
  assert.strictEqual(w.terminal, true);
  assert.ok(!/revok/i.test(w.title + w.line));
  assert.strictEqual(W.isRetryableAuthFail(''), false);
  assert.strictEqual(W.retryDelayMs('', 0), null);
});
check('kicked by another of the guest\'s devices: standing by, pass still good, Use it here instead', () => {
  const p = W.describe({ kind: 'kicked', device: 'ios' });
  assert.strictEqual(p.title, 'Your phone has the radio. One device at a time.');
  assert.strictEqual(p.line, 'Your pass is still good.');
  assert.strictEqual(p.action, 'Use it here instead');
  assert.strictEqual(W.describe({ kind: 'kicked', device: 'desktop-win32' }).title, 'Your other device has the radio. One device at a time.');
});
check('pass-paused: waiting, keep listening, pass still good', () => {
  const w = W.describe({ kind: 'paused', owner: 'K3SBP' });
  assert.strictEqual(w.title, 'Waiting: K3SBP is using the radio.');
  assert.strictEqual(w.line, 'You can keep listening. You\'re back on the air as soon as K3SBP gives it back. Your pass is still good.');
  assert.strictEqual(w.terminal, false);
});
check('pass-ended: only expired and revoked end the pass', () => {
  for (const r of ['left', 'disconnected', 'superseded', 'owner_override']) {
    const w = W.describe({ kind: 'pass-ended', reason: r, owner: 'K3SBP' });
    assert.strictEqual(w.terminal, false, r);
    assert.strictEqual(w.line, 'Your pass is still good.', r);
    assert.strictEqual(w.action, 'Connect again', r);
    assert.strictEqual(W.isTerminalEndReason(r), false, r);
  }
  assert.strictEqual(W.describe({ kind: 'pass-ended', reason: 'expired', endsAt: Date.parse('2026-11-14T09:30:00Z') }).title, 'Your Guest Pass ended at 09:30 UTC.');
  assert.strictEqual(W.describe({ kind: 'pass-ended', reason: 'revoked', owner: 'k3sbp' }).title, 'K3SBP cancelled your Guest Pass.');
  assert.strictEqual(W.isTerminalEndReason('expired'), true);
  assert.strictEqual(W.isTerminalEndReason('revoked'), true);
});
check('redeem errors in words; a raw snake_case code is never shown', () => {
  assert.strictEqual(W.redeemErrorText('pass_claimed_by_another', 'x'), 'This pass is already in use with another account. Sign in with the account you used first.');
  assert.strictEqual(W.redeemErrorText('cannot_redeem_own_pass', 'x'), 'This is your own pass. Send the link to your guest.');
  assert.strictEqual(W.redeemErrorText('pass_for_another_callsign', 'x'), 'This pass was made for another callsign. Sign in as that operator, or ask the owner for a pass in your callsign.');
  assert.strictEqual(W.redeemErrorText('some_new_code', 'Redeem failed (HTTP 409)'), 'Redeem failed (HTTP 409)');
  assert.strictEqual(W.redeemErrorText('', 'Redeem failed (HTTP 500)'), 'Redeem failed (HTTP 500)');
});

// ---------------------------------------------------------- 2. Cloud answers
const TOKEN = 'a'.repeat(64);
function resp(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => { if (body === undefined) throw new Error('no json'); return body; } };
}
check('classifier reads the error field, not the status alone', () => {
  assert.deepStrictEqual(classifyCloudPassAnswer(410, { error: 'pass_over', reason: 'cancelled', at: 'T' }), { kind: 'not_valid', reason: 'cancelled', at: 'T' });
  assert.strictEqual(classifyCloudPassAnswer(410, { error: 'pass_over', reason: 'expired' }).reason, 'expired');
  assert.strictEqual(classifyCloudPassAnswer(410, { error: 'pass_over', reason: 'not_started' }).reason, 'not_started');
  assert.deepStrictEqual(classifyCloudPassAnswer(404, { error: 'not_found', reason: 'unknown' }), { kind: 'not_valid', reason: 'unknown', at: null });
  assert.strictEqual(classifyCloudPassAnswer(404, null).kind, 'check_failed', 'a 404 that is not Cloud\'s answer is not a verdict');
  assert.strictEqual(classifyCloudPassAnswer(410, { error: 'owner_entitlement_expired' }).kind, 'check_failed');
  assert.strictEqual(classifyCloudPassAnswer(410, { error: 'pass_session_closed' }).kind, 'check_failed');
  assert.strictEqual(classifyCloudPassAnswer(429, { error: 'rate_limited' }).kind, 'check_failed');
  for (const s of [500, 502, 503, 504]) assert.strictEqual(classifyCloudPassAnswer(s, null).kind, 'check_failed', String(s));
  assert.strictEqual(classifyCloudPassAnswer(200, { code: 'abc' }).kind, 'valid');
});
check('validator: valid -> profile; pass_over / not_found -> not valid with reason and at', async () => {
  let answer = resp(200, { code: 'brave-otter-sings-loud', owner_callsign: 'K3SBP' });
  const v = createPassValidator({ fetch: async () => answer });
  assert.strictEqual((await v('c', TOKEN)).code, 'brave-otter-sings-loud');
  answer = resp(410, { error: 'pass_over', reason: 'cancelled', at: '2026-11-14T18:00:00Z' });
  assert.deepStrictEqual(await v('c', TOKEN), { code: null, notValid: true, reason: 'cancelled', at: '2026-11-14T18:00:00Z' });
  answer = resp(404, { error: 'not_found', reason: 'unknown' });
  assert.deepStrictEqual(await v('c', TOKEN), { code: null, notValid: true, reason: 'unknown', at: null });
  assert.strictEqual(await v('c', 'short'), null, 'a malformed token is refused without asking Cloud');
});
check('validator: 5xx, network error, timeout, other 410 -> throws pass_check_failed', async () => {
  for (const f of [
    async () => resp(503, { error: 'validate_failed' }),
    async () => resp(500, undefined),
    async () => { throw new Error('ECONNRESET'); },
    async () => resp(410, { error: 'owner_entitlement_expired' }),
  ]) {
    const v = createPassValidator({ fetch: f });
    await assert.rejects(() => v('c', TOKEN), (e) => e.code === 'pass_check_failed');
  }
  const slow = createPassValidator({ timeoutMs: 20, fetch: (_u, o) => new Promise((_r, rej) => o.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); })) });
  await assert.rejects(() => slow('c', TOKEN), (e) => e.code === 'pass_check_failed' && /timeout/.test(e.message));
});
check('validator: a 429 waits 5 minutes before asking Cloud again for that pass', async () => {
  let t = 1000000, calls = 0;
  const v = createPassValidator({ now: () => t, fetch: async () => { calls++; return resp(429, { error: 'rate_limited' }); } });
  await assert.rejects(() => v('c', TOKEN), (e) => e.code === 'pass_check_failed');
  t += RATE_LIMIT_BACKOFF_MS - 1000;
  await assert.rejects(() => v('c', TOKEN), (e) => e.code === 'pass_check_failed');
  assert.strictEqual(calls, 1, 'no Cloud call inside the 5 min back-off');
  t += 2000;
  await assert.rejects(() => v('c', TOKEN), (e) => e.code === 'pass_check_failed');
  assert.strictEqual(calls, 2, 'asks again after 5 min');
  assert.strictEqual(RATE_LIMIT_BACKOFF_MS, 5 * 60 * 1000);
});

// ------------------------------------------------- 3. station's auth-fail
function fakeServer(validator) {
  const rs = Object.create(RemoteServer.prototype);
  rs._passValidator = validator;
  rs._passPause = null;
  rs._anyOwnerOperating = () => false;
  rs._passLiveInfo = () => ({ live: false });
  const sent = [];
  rs._sendTo = (_ws, m) => sent.push(m);
  rs.emit = () => true;
  return { rs, sent };
}
check('station: Cloud could not answer -> auth-fail pass_check_failed, reason never says revoked', async () => {
  const { rs, sent } = fakeServer(async () => { const e = new Error('Cloud error 503'); e.code = 'pass_check_failed'; throw e; });
  await rs._authenticatePass({ _socket: {} }, { passCode: 'brave-otter', sessionId: TOKEN }, {});
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].type, 'auth-fail');
  assert.strictEqual(sent[0].code, 'pass_check_failed');
  assert.strictEqual(sent[0].reason, 'Couldn\'t check your pass just now. Trying again.');
  assert.ok(!/revok/i.test(sent[0].reason), 'older phones read "revoked" as a dead pass');
  assert.strictEqual(sent[0].state, 'reconnecting');
  assert.strictEqual(sent[0].stateReason, 'check-failed');
  assert.strictEqual(sent[0].text, "Couldn't check your pass just now. Trying again. Your pass is still good.");
});
check('station: owner on the radio -> auth-fail rig_in_use, state waiting / owner, text with the owner call', async () => {
  const { rs, sent } = fakeServer(async () => ({ code: 'brave-otter', owner_callsign: 'K3SBP' }));
  rs._anyOwnerOperating = () => true;
  await rs._authenticatePass({ _socket: {} }, { passCode: 'brave-otter', sessionId: TOKEN }, {});
  assert.deepStrictEqual(
    { reason: sent[0].reason, code: sent[0].code, by: sent[0].by, state: sent[0].state, stateReason: sent[0].stateReason, text: sent[0].text },
    { reason: 'The owner is operating this radio.', code: 'rig_in_use', by: 'owner', state: 'waiting', stateReason: 'owner', text: 'Waiting: K3SBP is using the radio Your pass is still good.' });
  assert.ok(!('_owner' in sent[0]));
});
check('station: another guest has the radio -> waiting / other-guest', async () => {
  const { rs, sent } = fakeServer(async () => ({ code: 'brave-otter', owner_callsign: 'K3SBP' }));
  rs._onPassAuth = async () => { const e = new Error('Another guest is using the radio.'); e.code = 'rig_in_use'; e.by = 'guest'; throw e; };
  await rs._authenticatePass({ _socket: {} }, { passCode: 'brave-otter', sessionId: TOKEN }, {});
  assert.strictEqual(sent[0].code, 'rig_in_use');
  assert.strictEqual(sent[0].state, 'waiting');
  assert.strictEqual(sent[0].stateReason, 'other-guest');
  assert.strictEqual(sent[0].text, 'Another guest is using the radio. Your pass is still good.');
});
check('station: Cloud says not valid -> auth-fail pass_not_valid with Cloud\'s reason and time; old reason kept', async () => {
  const { rs, sent } = fakeServer(async () => ({ code: null, notValid: true, reason: 'cancelled', at: '2026-11-14T18:00:00Z' }));
  await rs._authenticatePass({ _socket: {} }, { passCode: 'brave-otter', sessionId: TOKEN }, {});
  assert.strictEqual(sent[0].code, 'pass_not_valid');
  assert.strictEqual(sent[0].passReason, 'cancelled');
  assert.strictEqual(sent[0].passAt, '2026-11-14T18:00:00Z');
  assert.strictEqual(sent[0].reason, 'Pass not found, expired, revoked, or session not recognized');
  assert.strictEqual(sent[0].state, 'over');
  assert.strictEqual(sent[0].stateReason, 'cancelled');
  assert.strictEqual(sent[0].text, 'The owner cancelled your Guest Pass.');
});
check('auth-fail state fields for every pass_not_valid reason', () => {
  for (const r of ['expired', 'cancelled', 'not_started', 'unknown']) {
    const f = W.authFailFields({ code: 'pass_not_valid', reason: r, at: '2026-11-15T14:00:00Z', owner: 'K3SBP' });
    assert.strictEqual(f.state, 'over'); assert.strictEqual(f.stateReason, r);
    assert.ok(f.text.length > 0);
  }
  assert.strictEqual(W.authFailFields({ code: 'pass_not_valid' }).stateReason, 'unknown');
  assert.strictEqual(W.authFailFields({ code: '' }), null);
});

// ------------------------------------------- 4. POTACAT-as-remote client
function fakeClient() {
  const c = new RemoteClient({ id: 'gp-x', kind: 'pass', name: 'K3SBP (Guest Pass)', passCode: 'x', passSessionId: TOKEN });
  c._ws = { readyState: 1, close() {}, send() {} };
  const events = [];
  c.on('auth-fail', (e) => events.push(e));
  c.on('log', () => {});
  return { c, events };
}
check('remote client keeps code and by, and asks again in a minute when the rig is in use', () => {
  const { c, events } = fakeClient();
  c._handleMessage(JSON.stringify({ type: 'auth-fail', reason: 'The owner is operating this radio.', code: 'rig_in_use', by: 'owner' }));
  assert.strictEqual(events[0].code, 'rig_in_use');
  assert.strictEqual(events[0].by, 'owner');
  assert.strictEqual(events[0].retryInMs, 60000);
  assert.strictEqual(c._closed, false, 'a busy rig is not a dead pass');
  let delay = null;
  const realSet = global.setTimeout;
  global.setTimeout = (fn, ms) => { delay = ms; return 1; };
  try { c._scheduleReconnect(); } finally { global.setTimeout = realSet; }
  assert.strictEqual(delay, 60000, 'the reconnect waits the minute, not the 1 s link back-off');
  c.close();
});
check('remote client backs off on pass_check_failed and stops only on pass_not_valid or a bare refusal', () => {
  const a = fakeClient();
  a.c._handleMessage(JSON.stringify({ type: 'auth-fail', reason: 'x', code: 'pass_check_failed' }));
  a.c._handleMessage(JSON.stringify({ type: 'auth-fail', reason: 'x', code: 'pass_check_failed' }));
  assert.deepStrictEqual(a.events.map((e) => e.retryInMs), [30000, 60000]);
  assert.strictEqual(a.c._closed, false);
  a.c.close();
  const b = fakeClient();
  b.c._handleMessage(JSON.stringify({ type: 'auth-fail', reason: 'x', code: 'pass_not_valid', passReason: 'cancelled' }));
  assert.strictEqual(b.events[0].retryInMs, null);
  assert.strictEqual(b.events[0].passReason, 'cancelled');
  assert.strictEqual(b.c._closed, true);
  const d = fakeClient();
  d.c._handleMessage(JSON.stringify({ type: 'auth-fail', reason: 'Pass not found, expired, revoked, or session not recognized' }));
  assert.strictEqual(d.events[0].retryInMs, null);
  assert.strictEqual(d.c._closed, true, 'an older station cannot say why: final');
});
check('remote client surfaces pass-paused and pass-resumed', () => {
  const { c } = fakeClient();
  const seen = [];
  c.on('pass-paused', () => seen.push('paused'));
  c.on('pass-resumed', () => seen.push('resumed'));
  c._handleMessage(JSON.stringify({ type: 'pass-paused', by: 'owner' }));
  c._handleMessage(JSON.stringify({ type: 'pass-resumed' }));
  assert.deepStrictEqual(seen, ['paused', 'resumed']);
  c.close();
});

// -------------------------------------------- 5. the live 60 s re-read
check('live re-read ends a session only on pass_over or not_found', () => {
  assert.strictEqual(liveSessionEndReason(410, { error: 'pass_over', reason: 'cancelled' }), 'revoked');
  assert.strictEqual(liveSessionEndReason(410, { error: 'pass_over', reason: 'expired' }), 'expired');
  assert.strictEqual(liveSessionEndReason(404, { error: 'not_found', reason: 'unknown' }), 'revoked');
  assert.strictEqual(liveSessionEndReason(410, { error: 'pass_over', reason: 'not_started' }), null);
  for (const [s, b] of [[429, { error: 'rate_limited' }], [500, null], [503, {}], [410, { error: 'owner_entitlement_expired' }], [404, null], [200, { code: 'x' }]]) {
    assert.strictEqual(liveSessionEndReason(s, b), null, s + ' ' + JSON.stringify(b));
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'pass-enforcement.js'), 'utf8');
  const body = src.slice(src.indexOf('async _revalidate()'), src.indexOf('  _modeMatchesAllowedList(mode, allowed) {'));
  assert.ok(/liveSessionEndReason\(res\.status, pass\)/.test(body), '_revalidate reads Cloud through liveSessionEndReason');
  assert.ok(!/res\.status === 404/.test(body), 'no status-only 404 = revoked');
});

// ------------------------------------- 6. main.js pass-ended keeps the row
check('pass-ended marks the row used up only for expired / revoked', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const i = src.indexOf("remoteClient.on('pass-ended'");
  assert.ok(i > 0);
  const body = src.slice(i, src.indexOf("remoteClient.on('revoked'", i));
  const guard = body.indexOf('PassWording.isTerminalEndReason(reason)');
  const stamp = body.indexOf('target.expiresAt =');
  assert.ok(guard > 0 && stamp > guard, 'expiresAt is written only behind isTerminalEndReason');
  assert.ok(/if \(passOver\) \{\s*target\.expiresAt/.test(body), 'the stamp sits inside if (passOver)');
  // The redeem errors go through the shared words (F).
  assert.ok(/PassWording\.redeemErrorText\(r\.body && r\.body\.error/.test(src));
});
check('ECHOCAT Web gets the shared words inlined and handles pass-paused / pass-resumed', () => {
  const rsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'remote-server.js'), 'utf8');
  assert.ok(rsSrc.includes("['pass-wording-js', 'pass-wording.js']"));
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote.html'), 'utf8').includes('<!-- pass-wording-js -->'));
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8').includes('../lib/pass-wording.js'));
  const web = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote.js'), 'utf8');
  assert.ok(/case 'pass-paused':/.test(web) && /case 'pass-resumed':/.test(web));
  assert.ok(/PassWording\.isRetryableAuthFail\(msg\.code/.test(web));
});

Promise.all(pending).then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
