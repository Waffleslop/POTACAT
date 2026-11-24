#!/usr/bin/env node
'use strict';
// The QRZ XML fields the Contact details window shows (Discord "Jump",
// 2026-11-23): street address, photo, QSL flags, e-mail, licence class,
// aliases, IOTA, lat/lon and the time zone. parseQrzCallsign() is pure, so a
// fixture stands in for QRZ: no network in this test.
// Run: node test/qrz-detail-parse-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const Q = require('../lib/qrz');

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  const run = async () => {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
  };
  pending.push(run);
}
const fixture = (f) => readSrc(path.join(__dirname, 'fixtures', f));

console.log('QRZ: the fields the Contact details window shows');

test('parseQrzCallsign is exported', () => {
  assert.strictEqual(typeof Q.parseQrzCallsign, 'function');
});

test('a subscriber answer: every field the card needs', () => {
  const r = Q.parseQrzCallsign(fixture('qrz-callsign-subscriber.xml'));
  assert.ok(r, 'a record');
  assert.strictEqual(r.call, 'W1XYZ');
  assert.strictEqual(r.fname, 'Jane', 'ALL CAPS names are still title-cased and the middle initial dropped');
  assert.strictEqual(r.name, 'Sample');
  assert.strictEqual(r.nickname, 'Jan');
  assert.strictEqual(r.addr1, '12 Example Road');
  assert.strictEqual(r.addr2, 'Springfield');
  assert.strictEqual(r.state, 'MA');
  assert.strictEqual(r.zip, '01101');
  assert.strictEqual(r.county, 'Hampden');
  assert.strictEqual(r.country, 'United States');
  assert.strictEqual(r.land, 'United States');
  assert.strictEqual(r.attn, 'c/o Club Station');
  assert.strictEqual(r.dxcc, '291');
  assert.strictEqual(r.grid, 'FN32rc');
  assert.strictEqual(r.lat, '42.101400');
  assert.strictEqual(r.lon, '-72.589800');
  assert.strictEqual(r.geoloc, 'user');
  assert.strictEqual(r.cqzone, '5');
  assert.strictEqual(r.ituzone, '8');
  assert.strictEqual(r.iota, 'NA-046');
  assert.strictEqual(r.image, 'https://cdn-xml.qrz.com/z/w1xyz/photo.jpg');
  assert.strictEqual(r.email, 'jane@example.invalid');
  assert.strictEqual(r.url, 'https://example.invalid/w1xyz');
  assert.strictEqual(r.qslmgr, 'Direct or bureau');
  assert.strictEqual(r.eqsl, '0');
  assert.strictEqual(r.mqsl, '1');
  assert.strictEqual(r.lotw, '1');
  assert.strictEqual(r.class, 'E');
  assert.strictEqual(r.aliases, 'W1XYZ/P,KA1XYZ');
  assert.strictEqual(r.timezone, 'Eastern');
  assert.strictEqual(r.gmtOffset, '-5');
  assert.strictEqual(r.dst, 'Y');
  assert.strictEqual(r.detail, Q.DETAIL_VERSION, 'marked, so an older cached record can be told apart');
});

test('a non-subscriber answer: name and town only, every other field empty (not missing)', () => {
  const r = Q.parseQrzCallsign(fixture('qrz-callsign-nonsubscriber.xml'));
  assert.strictEqual(r.call, 'G4ABC');
  assert.strictEqual(r.fname, 'Peter');
  assert.strictEqual(r.name, "O'Brien");
  assert.strictEqual(r.addr2, 'Bristol');
  assert.strictEqual(r.country, 'England');
  for (const k of ['addr1', 'zip', 'image', 'email', 'lotw', 'mqsl', 'eqsl', 'class', 'lat', 'lon', 'gmtOffset', 'iota']) {
    assert.strictEqual(r[k], '', k);
  }
});

test('not found, an error page or nothing: null', () => {
  assert.strictEqual(Q.parseQrzCallsign('<QRZDatabase><Session><Error>Not found: XX9XX</Error></Session></QRZDatabase>'), null);
  assert.strictEqual(Q.parseQrzCallsign(''), null);
  assert.strictEqual(Q.parseQrzCallsign(null), null);
});

test('entities are decoded and only the <Callsign> block is read', () => {
  const xml = '<QRZDatabase><Callsign><call>K1AB</call><addr1>1 Smith &amp; Sons Rd</addr1></Callsign>' +
    '<Session><Key>k</Key><Message>call me</Message></Session></QRZDatabase>';
  const r = Q.parseQrzCallsign(xml);
  assert.strictEqual(r.addr1, '1 Smith & Sons Rd');
});

test('lookupDetails: a record cached before these fields is looked up again once', async () => {
  const c = new Q.QrzClient();
  c.configure('K3SBP', 'x');
  c._cache.set('W1XYZ', { call: 'W1XYZ', fname: 'Jane', name: 'Sample' }); // an older cache entry
  let lookups = 0;
  c._doLookup = async (call) => { lookups++; const r = Q.parseQrzCallsign(fixture('qrz-callsign-subscriber.xml')); c._cache.set(call, r); return r; };
  const a = await c.lookupDetails('W1XYZ/P');
  assert.strictEqual(lookups, 1);
  assert.strictEqual(a.addr1, '12 Example Road');
  const b = await c.lookupDetails('W1XYZ');
  assert.strictEqual(lookups, 1, 'the refreshed record is used from the cache');
  assert.strictEqual(b, a);
});

test('lookupDetails: a failed refresh keeps the older record instead of losing the name', async () => {
  const c = new Q.QrzClient();
  c.configure('K3SBP', 'x');
  const old = { call: 'G4ABC', fname: 'Peter', name: "O'Brien" };
  c._cache.set('G4ABC', old);
  c._doLookup = async () => null;
  const r = await c.lookupDetails('G4ABC');
  assert.strictEqual(r, old);
  assert.strictEqual(c.cached('G4ABC'), old);
});

test('the lookup itself goes through parseQrzCallsign (one parse, not two)', () => {
  const src = readSrc(path.join(__dirname, '..', 'lib', 'qrz.js'));
  const body = src.slice(src.indexOf('async _doLookup('), src.indexOf('async batchLookup('));
  assert.ok(/parseQrzCallsign\(xml\)/.test(body));
  assert.ok(!/extractTag\(xml, 'fname'\)/.test(body), 'no second field list inside _doLookup');
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(__dirname, '..', 'scripts', 'run-tests.js')).includes("'test/qrz-detail-parse-test.js'"));
});

(async () => {
  for (const run of pending) await run();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
