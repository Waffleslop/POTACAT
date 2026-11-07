#!/usr/bin/env node
'use strict';
/**
 * #142: realtime Club Log uploads go through an outbox (lib/clublog-outbox.js)
 * so Save never waits on Club Log, each QSO is sent with the credentials of the
 * operator it was logged for, and a refused login (403) pauses that account
 * instead of being retried with the same bad password on every QSO.
 * Every network call here is a fake: nothing reaches clublog.org.
 * Run: node test/clublog-outbox-test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClublogOutbox } = require('../lib/clublog-outbox');
const { CLUBLOG_REALTIME_URL } = require('../lib/clublog');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clo-')), 'clublog-outbox.json');
const KD9WI = { email: 'kd9wi@example.com', password: 'app-pw-1', callsign: 'KD9WI' };
const W9XYZ = { email: 'w9xyz@example.com', password: 'other-pw', callsign: 'W9XYZ' };
const adif = (call) => `<CALL:${call.length}>${call} <BAND:3>20m <MODE:3>FT8 <eor>`;

function fakePost(handler) {
  const calls = [];
  const fn = async (url, contentType, body) => {
    const p = new URLSearchParams(body);
    const c = { url, contentType, email: p.get('email'), password: p.get('password'), callsign: p.get('callsign'), api: p.get('api'), adif: p.get('adif') };
    calls.push(c);
    return handler(c, calls.length);
  };
  fn.calls = calls;
  return fn;
}
function outbox(post, opts = {}) {
  const now = { t: 1_000_000 };
  const logs = [];
  const box = new ClublogOutbox({
    file: opts.file || tmpFile(), post, getApiKey: opts.getApiKey || (async () => 'APIKEY'),
    now: () => now.t, backoffMs: [10, 20, 40], log: (m) => logs.push(m), ...opts,
  });
  box.stop();
  return { box, now, logs };
}
const ok = () => ({ status: 200, body: 'OK' });

(async () => {
  console.log('ClublogOutbox');

  await check('add returns at once; a 200 sends the realtime form and removes the entry', async () => {
    const post = fakePost(ok);
    const { box, logs } = outbox(post);
    const uuid = box.add({ creds: KD9WI, adif: adif('N0CAL'), uuid: 'u-1', call: 'N0CAL' });
    box.stop();
    assert.strictEqual(uuid, 'u-1');
    assert.strictEqual(post.calls.length, 0, 'nothing is sent inside add()');
    assert.strictEqual(box.pending(), 1);
    await box.flush();
    assert.strictEqual(post.calls.length, 1);
    const c = post.calls[0];
    assert.strictEqual(c.url, CLUBLOG_REALTIME_URL);
    assert.strictEqual(c.contentType, 'application/x-www-form-urlencoded');
    assert.deepStrictEqual([c.email, c.password, c.callsign, c.api, c.adif], [KD9WI.email, KD9WI.password, 'KD9WI', 'APIKEY', adif('N0CAL')]);
    assert.strictEqual(box.pending(), 0);
    assert.ok(logs.some((l) => /^\[ClubLog\] QSO sent: N0CAL/.test(l)), logs.join('\n'));
  });

  await check('400 Dupe counts as delivered and is removed', async () => {
    const post = fakePost(() => ({ status: 400, body: 'Dupe' }));
    const { box, logs } = outbox(post);
    box.add({ creds: KD9WI, adif: adif('N0CAL'), uuid: 'u-1', call: 'N0CAL' });
    await box.flush();
    assert.strictEqual(box.pending(), 0);
    assert.ok(logs.some((l) => /^\[ClubLog\] Dupe \(already there\): N0CAL/.test(l)), logs.join('\n'));
  });

  await check('400 for any other reason: given up once, logged as FAILED, not retried', async () => {
    const post = fakePost(() => ({ status: 400, body: 'Invalid ADIF' }));
    const { box, logs, now } = outbox(post);
    box.add({ creds: KD9WI, adif: adif('N0CAL'), uuid: 'u-1', call: 'N0CAL' });
    await box.flush();
    assert.strictEqual(box.pending(), 0);
    now.t += 100000; await box.flush();
    assert.strictEqual(post.calls.length, 1);
    assert.strictEqual(logs.filter((l) => /^\[ClubLog\] FAILED: N0CAL/.test(l)).length, 1);
  });

  await check('403 pauses the account: held, logged once, same creds never post again', async () => {
    const post = fakePost(() => ({ status: 403, body: 'Forbidden' }));
    const { box, logs, now } = outbox(post);
    box.add({ creds: KD9WI, adif: adif('N0CAL'), uuid: 'u-1', call: 'N0CAL' });
    box.add({ creds: KD9WI, adif: adif('N1CAL'), uuid: 'u-2', call: 'N1CAL' });
    await box.flush();
    assert.strictEqual(post.calls.length, 1, 'the second contact is held, not sent with the same bad login');
    assert.strictEqual(box.pending(), 2, 'nothing is dropped');
    assert.ok(box.isPaused(KD9WI));
    box.add({ creds: KD9WI, adif: adif('N2CAL'), uuid: 'u-3', call: 'N2CAL' });
    now.t += 1e6; await box.flush();
    assert.strictEqual(post.calls.length, 1, 'a new QSO with the same creds does not post');
    assert.strictEqual(box.pending(), 3);
    const pausedLines = logs.filter((l) => l === '[ClubLog] paused for KD9WI: login refused, fix email/Application Password in Settings');
    assert.strictEqual(pausedLines.length, 1, logs.join('\n'));
  });

  await check('a changed password clears the pause and the held queue goes with the new one', async () => {
    const post = fakePost((c) => (c.password === 'app-pw-1' ? { status: 403, body: '' } : ok()));
    const { box } = outbox(post);
    box.add({ creds: KD9WI, adif: adif('N0CAL'), uuid: 'u-1', call: 'N0CAL' });
    await box.flush();
    assert.ok(box.isPaused(KD9WI));
    const fixed = { ...KD9WI, password: 'app-pw-2' };
    box.add({ creds: fixed, adif: adif('N1CAL'), uuid: 'u-2', call: 'N1CAL' });
    box.stop();
    assert.ok(!box.isPaused(fixed));
    await box.flush();
    assert.strictEqual(box.pending(), 0);
    const sent = post.calls.slice(1);
    assert.strictEqual(sent.length, 2);
    assert.ok(sent.every((c) => c.password === 'app-pw-2'), 'held contacts use the corrected password');
  });

  await check('re-saving Settings with new credentials (updateCredentials) clears the pause', async () => {
    const post = fakePost((c) => (c.password === 'app-pw-1' ? { status: 403, body: '' } : ok()));
    const { box } = outbox(post);
    box.add({ creds: KD9WI, adif: adif('N0CAL'), uuid: 'u-1', call: 'N0CAL' });
    await box.flush();
    box.updateCredentials(KD9WI); box.stop();
    assert.ok(box.isPaused(KD9WI), 'the same credentials keep the pause');
    box.updateCredentials({ ...KD9WI, password: 'app-pw-2' }); box.stop();
    assert.ok(!box.isPaused(KD9WI));
    await box.flush();
    assert.strictEqual(box.pending(), 0);
  });

  await check('bulk upload result: 403 sets the pause, 200 clears it', async () => {
    const post = fakePost(ok);
    const { box } = outbox(post);
    box.noteBulkResult(KD9WI, { ok: false, auth: true });
    assert.ok(box.isPaused(KD9WI));
    box.add({ creds: KD9WI, adif: adif('N0CAL'), uuid: 'u-1', call: 'N0CAL' });
    await box.flush();
    assert.strictEqual(post.calls.length, 0);
    box.noteBulkResult(KD9WI, { ok: true }); box.stop();
    assert.ok(!box.isPaused(KD9WI));
    await box.flush();
    assert.strictEqual(post.calls.length, 1);
    assert.strictEqual(box.pending(), 0);
  });

  await check('no connection / 5xx: retried on the backoff ladder, "N contacts queued" on the 1st and 5th attempt', async () => {
    let up = false;
    const post = fakePost(() => (up ? ok() : { status: 503, body: '' }));
    const { box, now, logs } = outbox(post);
    box.add({ creds: KD9WI, adif: adif('N0CAL'), uuid: 'u-1', call: 'N0CAL' });
    await box.flush();
    assert.strictEqual(box.pending(), 1);
    assert.strictEqual(post.calls.length, 1);
    await box.flush();
    assert.strictEqual(post.calls.length, 1, 'not resent before the backoff');
    for (let i = 0; i < 4; i++) { now.t += 1000; await box.flush(); }
    assert.strictEqual(post.calls.length, 5);
    const queued = logs.filter((l) => /^\[ClubLog\] 1 contact queued/.test(l));
    assert.strictEqual(queued.length, 2, logs.join('\n'));
    up = true; now.t += 1000; await box.flush();
    assert.strictEqual(box.pending(), 0);
  });

  await check('status 0 (network error) is a retry; a missing API key is a retry, not a drop', async () => {
    let key = '';
    const post = fakePost(() => ({ status: 0, body: 'ECONNRESET' }));
    const { box, now } = outbox(post, { getApiKey: async () => key });
    box.add({ creds: KD9WI, adif: adif('N0CAL'), uuid: 'u-1', call: 'N0CAL' });
    await box.flush();
    assert.strictEqual(post.calls.length, 0, 'no key, nothing posted');
    assert.strictEqual(box.pending(), 1);
    key = 'APIKEY'; now.t += 1000; await box.flush();
    assert.strictEqual(post.calls.length, 1);
    assert.strictEqual(box.pending(), 1);
  });

  await check('given up after 7 days, logged as FAILED', async () => {
    const post = fakePost(() => ({ status: 503, body: '' }));
    const { box, now, logs } = outbox(post);
    box.add({ creds: KD9WI, adif: adif('N0CAL'), uuid: 'u-1', call: 'N0CAL' });
    await box.flush();
    now.t += 7 * 24 * 3600 * 1000 + 1;
    await box.flush();
    assert.strictEqual(box.pending(), 0);
    assert.ok(logs.some((l) => /^\[ClubLog\] FAILED: N0CAL/.test(l)), logs.join('\n'));
  });

  await check('the queue and the pause survive a restart (file round-trip)', async () => {
    const file = tmpFile();
    const post = fakePost(() => ({ status: 403, body: '' }));
    const { box, now } = outbox(post, { file });
    box.add({ creds: KD9WI, adif: adif('N0CAL'), uuid: 'u-1', call: 'N0CAL' });
    box.add({ creds: W9XYZ, adif: adif('N1CAL'), uuid: 'u-2', call: 'N1CAL' });
    await box.flush();
    box.stop();
    const post2 = fakePost(ok);
    const again = new ClublogOutbox({ file, post: post2, getApiKey: async () => 'APIKEY', now: () => now.t + 1e6, backoffMs: [10] });
    again.stop();
    assert.strictEqual(again.pending(), 2);
    assert.ok(again.isPaused(KD9WI) && again.isPaused(W9XYZ));
    again.noteBulkResult(W9XYZ, { ok: true }); again.stop();
    await again.flush();
    assert.strictEqual(post2.calls.length, 1);
    assert.strictEqual(post2.calls[0].callsign, 'W9XYZ');
    assert.strictEqual(again.pending(), 1, 'KD9WI stays held');
  });

  await check('two operators each post with their own credentials; one refused login does not hold the other', async () => {
    const post = fakePost((c) => (c.callsign === 'KD9WI' ? { status: 403, body: '' } : ok()));
    const { box } = outbox(post);
    box.add({ creds: KD9WI, adif: adif('N0CAL'), uuid: 'u-1', call: 'N0CAL' });
    box.add({ creds: W9XYZ, adif: adif('N0CAL'), uuid: 'u-2', call: 'N0CAL' });
    box.add({ creds: W9XYZ, adif: adif('N1CAL'), uuid: 'u-3', call: 'N1CAL' });
    await box.flush();
    const byCall = (call) => post.calls.filter((c) => c.callsign === call);
    assert.strictEqual(byCall('KD9WI').length, 1);
    assert.strictEqual(byCall('W9XYZ').length, 2);
    assert.ok(byCall('W9XYZ').every((c) => c.email === W9XYZ.email && c.password === W9XYZ.password));
    assert.ok(byCall('KD9WI').every((c) => c.email === KD9WI.email && c.password === KD9WI.password));
    assert.strictEqual(box.pending(), 1);
  });

  await check('refuses an entry without email, password, callsign or ADIF', async () => {
    const { box } = outbox(fakePost(ok));
    assert.strictEqual(box.add({ creds: { ...KD9WI, password: '' }, adif: adif('N0CAL') }), null);
    assert.strictEqual(box.add({ creds: { ...KD9WI, callsign: '' }, adif: adif('N0CAL') }), null);
    assert.strictEqual(box.add({ creds: KD9WI, adif: '' }), null);
    assert.strictEqual(box.pending(), 0);
  });

  await check('main.js wiring: started at launch, bulk result and saved Settings reach the queue, old awaited sender gone', async () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(/initPassQsoOutbox\(\);\n\s*try \{ initClublogOutbox\(\); \}/.test(main));
    assert.ok(/post: postToClublog,\n\s*getApiKey: getClublogApiKey,/.test(main));
    assert.ok(/clublogOutbox\.noteBulkResult\(\{ email, password, callsign \}, r\)/.test(main));
    assert.ok(/has\('clublogPassword'\)[^\n]*\)\) \{\n\s*try \{ clublogOutbox\.updateCredentials\(clublogCredsOf\(settings\)\); \}/.test(main));
    assert.ok(!/function sendQsoToClublog\(/.test(main));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
