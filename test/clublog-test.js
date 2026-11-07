#!/usr/bin/env node
'use strict';
// Club Log upload — the form/multipart bytes and the response map ARE
// the integration contract. Run: node test/clublog-test.js
const assert = require('assert');
const { buildRealtimeForm, buildPutlogsMultipart, mapClublogResponse, credentialKey } = require('../lib/clublog');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('realtime form carries all five fields, callsign uppercased, adif intact', () => {
  const adif = '<CALL:5>N0CAL <BAND:3>20m <MODE:3>FT8 <eor>';
  const form = buildRealtimeForm({ email: 'op@example.com', password: 'app-pw', callsign: 'k3sbp', api: 'KEY123', adif });
  const p = new URLSearchParams(form);
  assert.strictEqual(p.get('email'), 'op@example.com');
  assert.strictEqual(p.get('password'), 'app-pw');
  assert.strictEqual(p.get('callsign'), 'K3SBP');
  assert.strictEqual(p.get('api'), 'KEY123');
  assert.strictEqual(p.get('adif'), adif);
});

test('putlogs multipart: fixed boundary, all fields, file part byte-exact', () => {
  const { contentType, body } = buildPutlogsMultipart(
    { email: 'e', password: 'p', callsign: 'k3sbp', api: 'K', filename: 'log.adi', fileContent: '<eor>' }, 'BOUND');
  assert.strictEqual(contentType, 'multipart/form-data; boundary=BOUND');
  const s = body.toString();
  assert.ok(s.includes('--BOUND\r\nContent-Disposition: form-data; name="email"\r\n\r\ne\r\n'));
  assert.ok(s.includes('name="callsign"\r\n\r\nK3SBP\r\n'));
  assert.ok(s.includes('name="file"; filename="log.adi"'));
  assert.ok(s.includes('\r\n\r\n<eor>\r\n--BOUND--\r\n'));
});

test('response map: 200 ok, 400-dupe is success, 403 names the login, 5xx says retry', () => {
  assert.strictEqual(mapClublogResponse(200, '', 'bulk').ok, true);
  const dupe = mapClublogResponse(400, 'Dupe', 'realtime');
  assert.strictEqual(dupe.ok, true);
  assert.strictEqual(dupe.dupe, true);
  const rej = mapClublogResponse(400, 'Bad ADIF', 'realtime');
  assert.strictEqual(rej.ok, false);
  assert.ok(rej.message.includes('Bad ADIF'));
  const auth = mapClublogResponse(403, '', 'realtime');
  assert.strictEqual(auth.ok, false);
  assert.strictEqual(auth.auth, true);
  assert.ok(/Application Password/.test(auth.message));
  assert.ok(/try again/.test(mapClublogResponse(503, '', 'bulk').message));
});

// #142: a 403 pauses one account until its credentials change; this key is
// what "changed" means.
test('credentialKey is stable and differs on any field (email, password, callsign)', () => {
  const c = { email: 'op@example.com', password: 'app-pw', callsign: 'K3SBP' };
  const k = credentialKey(c);
  assert.ok(/^[0-9a-f]{64}$/.test(k), 'sha256 hex');
  assert.strictEqual(credentialKey({ ...c }), k);
  assert.strictEqual(credentialKey({ ...c, callsign: 'k3sbp' }), k, 'callsign case does not matter');
  assert.notStrictEqual(credentialKey({ ...c, email: 'other@example.com' }), k);
  assert.notStrictEqual(credentialKey({ ...c, password: 'app-pw2' }), k);
  assert.notStrictEqual(credentialKey({ ...c, callsign: 'W9XYZ' }), k);
});

console.log(`\nClubLog: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
