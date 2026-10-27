#!/usr/bin/env node
'use strict';
/**
 * A Guest Pass guest's contacts reach the GUEST's cloud logbook, sent by the
 * shack through the pass session's own route (lib/pass-qso-outbox.js; cloud
 * reply 2026-10-27). Queued on disk first; retried through outages; handed
 * back as a file only when the cloud will never take them.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassQsoOutbox, routeFor } = require('../lib/pass-qso-outbox');
const { buildAdifFields } = require('../lib/adif-writer');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const TOKEN = 'b'.repeat(64);
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pqo-')), 'outbox.json');
const fields = (call) => ({ CALL: call, QSO_DATE: '20261027', TIME_ON: '120000', MODE: 'FT8', OPERATOR: 'K3SBP', STATION_CALLSIGN: 'K3SBP', APP_POTACAT_STATION_LICENSEE: 'W7RTA' });
function reply(status, json) { return { ok: status >= 200 && status < 300, status, json: async () => json }; }
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => { const body = JSON.parse(init.body); calls.push({ url, body }); return handler(url, body, calls.length); };
  fn.calls = calls;
  return fn;
}
function outbox(fetch, opts = {}) {
  const now = { t: 1_000_000 };
  const box = new PassQsoOutbox({ file: opts.file || tmpFile(), fetch, now: () => now.t, backoffMs: [10, 20], baseUrl: 'https://api.test', ...opts });
  box.stop();
  return { box, now };
}

(async () => {
  console.log('PassQsoOutbox');
  await check('a contact is POSTed to its pass session route and leaves the queue when accepted', async () => {
    const fetch = fakeFetch((url, body) => reply(200, { accepted: body.changes.map((c) => c.uuid), conflicts: [], rejected: [], pass_session_id: 7 }));
    const { box } = outbox(fetch);
    const uuid = box.add({ code: 'abcd1234', token: TOKEN, call: 'K3SBP', fields: fields('W1AW') });
    box.stop();
    assert.ok(/^[0-9a-f-]{36}$/.test(uuid));
    await box.flush();
    assert.strictEqual(fetch.calls.length, 1);
    assert.strictEqual(fetch.calls[0].url, routeFor('https://api.test', 'abcd1234', TOKEN));
    const ch = fetch.calls[0].body.changes[0];
    assert.strictEqual(ch.uuid, uuid);
    assert.strictEqual(ch.adifFields.APP_POTACAT_UUID, uuid, 'the record carries its own uuid');
    assert.strictEqual(ch.adifFields.APP_POTACAT_STATION_LICENSEE, 'W7RTA');
    assert.strictEqual(ch.version, 1);
    assert.strictEqual(box.pending(), 0);
  });

  await check('no connection: kept, retried, and survives a restart', async () => {
    const file = tmpFile();
    let up = false;
    const fetch = fakeFetch((url, body) => { if (!up) throw new Error('ENOTFOUND'); return reply(200, { accepted: body.changes.map((c) => c.uuid) }); });
    const { box, now } = outbox(fetch, { file });
    box.add({ code: 'abcd1234', token: TOKEN, fields: fields('W1AW') });
    box.stop();
    await box.flush();
    box.stop();
    assert.strictEqual(box.pending(), 1);
    const again = new PassQsoOutbox({ file, fetch, now: () => now.t + 1000, backoffMs: [10], baseUrl: 'https://api.test' });
    again.stop();
    assert.strictEqual(again.pending(), 1, 'the queue came back from disk');
    up = true;
    await again.flush();
    again.stop();
    assert.strictEqual(again.pending(), 0);
  });

  await check('404 (route not deployed yet), 429 and 5xx are retried, never dropped', async () => {
    for (const status of [404, 429, 503]) {
      const fetch = fakeFetch(() => reply(status, { error: 'x' }));
      const { box } = outbox(fetch);
      let lost = 0;
      box.on('undelivered', () => { lost++; });
      box.add({ code: 'abcd1234', token: TOKEN, fields: fields('W1AW') });
      box.stop();
      await box.flush();
      box.stop();
      assert.strictEqual(box.pending(), 1, 'kept after ' + status);
      assert.strictEqual(lost, 0);
    }
  });

  await check('the route\'s not_found is retried for a day, then handed back', async () => {
    const fetch = fakeFetch(() => reply(404, { error: 'not_found' }));
    const { box, now } = outbox(fetch);
    let got = null;
    box.on('undelivered', (x) => { got = x; });
    box.add({ code: 'abcd1234', token: TOKEN, fields: fields('W1AW') });
    box.stop();
    await box.flush(); box.stop();
    assert.strictEqual(box.pending(), 1, 'kept at first');
    now.t += 25 * 3600 * 1000;
    await box.flush(); box.stop();
    assert.ok(got && got.entries.length === 1, 'handed back after a day');
  });

  await check('410 (session closed over a day ago) hands the contacts back for the file', async () => {
    const fetch = fakeFetch(() => reply(410, { error: 'pass_session_closed' }));
    const { box } = outbox(fetch);
    let got = null;
    box.on('undelivered', (x) => { got = x; });
    box.add({ code: 'abcd1234', token: TOKEN, call: 'K3SBP', fields: fields('W1AW') });
    box.stop();
    await box.flush();
    box.stop();
    assert.ok(got && got.entries.length === 1 && got.entries[0].fields.CALL === 'W1AW' && got.entries[0].call === 'K3SBP');
    assert.strictEqual(box.pending(), 0);
  });

  await check('a conflict (already held) and not_this_session (the device sent it first) both count as delivered', async () => {
    const fetch = fakeFetch((url, body) => reply(200, {
      accepted: [], conflicts: [{ uuid: body.changes[0].uuid, serverVersion: 1 }],
      rejected: [{ uuid: body.changes[1].uuid, reason: 'not_this_session' }],
    }));
    const { box } = outbox(fetch);
    let lost = 0;
    box.on('undelivered', () => { lost++; });
    box.add({ code: 'abcd1234', token: TOKEN, fields: fields('W1AW') });
    box.add({ code: 'abcd1234', token: TOKEN, fields: fields('N0CALL') });
    box.stop();
    await box.flush();
    box.stop();
    assert.strictEqual(fetch.calls.length, 1, 'one batch per session');
    assert.strictEqual(box.pending(), 0);
    assert.strictEqual(lost, 0);
  });

  await check('two sessions are two requests; more than 200 contacts are split', async () => {
    const fetch = fakeFetch((url, body) => reply(200, { accepted: body.changes.map((c) => c.uuid) }));
    const { box } = outbox(fetch);
    for (let i = 0; i < 201; i++) box.add({ code: 'abcd1234', token: TOKEN, fields: fields('W' + i) });
    box.add({ code: 'zzzz9999', token: 'c'.repeat(64), fields: fields('K1ABC') });
    box.stop();
    await box.flush();
    box.stop();
    assert.deepStrictEqual(fetch.calls.map((c) => c.body.changes.length).sort((a, b) => a - b), [1, 1, 200]);
    assert.strictEqual(box.pending(), 0);
  });

  await check('a week of failures hands the contact back', async () => {
    const fetch = fakeFetch(() => { throw new Error('offline'); });
    const { box, now } = outbox(fetch);
    let got = null;
    box.on('undelivered', (x) => { got = x; });
    box.add({ code: 'abcd1234', token: TOKEN, fields: fields('W1AW') });
    box.stop();
    now.t += 8 * 24 * 3600 * 1000;
    await box.flush();
    box.stop();
    assert.ok(got && got.entries.length === 1);
    assert.strictEqual(box.pending(), 0);
  });

  await check('the cloud copy carries the station licensee only when set', async () => {
    const f = buildAdifFields({ callsign: 'W1AW', frequency: '14074', mode: 'FT8', qsoDate: '20261027', timeOn: '1200', stationLicensee: 'W7RTA' });
    assert.strictEqual(f.APP_POTACAT_STATION_LICENSEE, 'W7RTA');
    assert.ok(!('APP_POTACAT_STATION_LICENSEE' in buildAdifFields({ callsign: 'W1AW', frequency: '14074', mode: 'FT8' })));
  });

  console.log('main.js wiring');
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  await check('a guest contact goes to the guest\'s logbook before any capability check, and never to the owner\'s file', async () => {
    const i = main.indexOf('if (isClientDriven && shouldForwardClientDriven())');
    const b = main.slice(i, i + 1500);
    const guestAt = b.indexOf('passGuestLogContact(');
    const dropAt = b.indexOf('if (!canReceive)');
    assert.ok(guestAt > 0 && guestAt < dropAt, 'a browser guest is no longer dropped');
    const fn = main.slice(main.indexOf('function passGuestLogContact('), main.indexOf('function passQsoWriteUndelivered('));
    assert.ok(/passQsoOutbox\.add\(/.test(fn) && /buildAdifFields\(qsoData\)/.test(fn));
    assert.ok(!/appendRecords|mutateLog|recordLogChanges/.test(fn), 'the owner\'s log is not written');
    assert.ok(/stationLicensee/.test(fn));
  });
  await check('undelivered contacts are written under guest-logs and said on screen', async () => {
    const fn = main.slice(main.indexOf('function passQsoWriteUndelivered('), main.indexOf('function buildAdifRecordFromFields('));
    assert.ok(/'guest-logs'/.test(fn) && /app-notice/.test(fn));
    assert.ok(/passQsoOutbox\.on\('undelivered', passQsoWriteUndelivered\)/.test(main));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
