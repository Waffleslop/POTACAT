#!/usr/bin/env node
'use strict';
// An n-fer's other parks, read from the activator's own spot comment (#353):
// which comment counts, which references in it, when pota.app is asked, what
// the external logbook is sent. The rule is the header of lib/nfer-refs.js.
// No network: https.get is stubbed for lib/pota.js, the cache takes a fake fetch.
// Run: node test/nfer-refs-test.js
const assert = require('assert');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');
const { readSrc } = require('./_src');
const N = require('../lib/nfer-refs');
const LF = require('../lib/logger-forward');
const { expandContact } = require('../lib/qso-expand');
const { buildAdifRecord } = require('../lib/adif-writer');
const Pota = require('../lib/pota');
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
const html = readSrc(path.join(root, 'renderer', 'jtcat-popout.html'));
const popout = readSrc(path.join(root, 'renderer', 'jtcat-popout.js'));

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The contact is at 15:10 UTC.
const NOW = Date.UTC(2026, 10, 12, 15, 10, 0);
const at = (hhmm) => `2026-11-12T${hhmm}:00`; // pota.app's shape: UTC, no zone
const own = (comments, hhmm = '15:00', spotter = 'K1ABC') => ({ spotter, comments, spotTime: at(hhmm) });
const extra = (spots, spottedRef = 'US-1234', over = {}) => N.nferExtraRefs({ call: 'K1ABC', spottedRef, spots, now: NOW, ...over });

// ---- one comment -----------------------------------------------------------

test('the comments named in the review, one by one', () => {
  const rows = [
    // comment, spotted park, extra parks logged
    ['3-fer DE-1197,DE-0941,DE-0034 FT8', 'DE-1197', ['DE-0941', 'DE-0034']],
    ['K-1234 KFF-1234 FT8', 'US-1234', []],                      // WWFF is not a POTA park
    ['K-1234 KFF-1234 FT8', 'K-1234', []],
    ['2-fer US-1234 US-5678', 'US-1234', ['US-5678']],            // the modern form
    ['2-fer K-1234 K-5678', 'US-1234', ['US-5678']],              // the old US prefix is the same park
    ['US-1234, US-5678 FT8', 'US-1234', ['US-5678']],
    ['US-1234 + US-5678', 'US-1234', ['US-5678']],
    ['US-1234/US-5678 20m', 'US-1234', ['US-5678']],
    ['us-1234 and us-5678 cq', 'US-1234', ['US-5678']],
    ['US-1234 2fer with US-5678', 'US-1234', ['US-5678']],
    ['twofer US-1234 US-5678', 'US-1234', ['US-5678']],
    ['US-1234 US-5678 FT8', 'US-1234', []],                      // side by side, nothing says n-fer
    ['US-1111 P2P with K-1234', 'US-1111', []],
    ['P2P K-1234, US-1111', 'US-1111', []],
    ['US-1234 QSY to K-5678 next', 'US-1234', []],
    ['US-1234, US-5678 next', 'US-1234', []],
    ['worked US-1234, US-5678', 'US-1234', []],
    ['2-fer K-1234 K-5678 (yesterday K-9999)', 'US-1234', ['US-5678']],
    ['2-fer US-1234 US-5678 was at US-9999', 'US-1234', ['US-5678']],
    ['2-fer US-1234 US-5678 US-9999', 'US-1234', []],            // says two, lists three
    ['FT8-1234 US-1234', 'US-1234', []],
    ['2-fer US-1234 FT8-1234', 'US-1234', []],
    ['2-fer US-1234 and DE-0001', 'US-1234', []],                // another country
    ['2-fer US-1234 GFF-0012 US-5678', 'US-1234', ['US-5678']],
    ['2-fer DE-0001 DLFF-0123 DE-0002', 'DE-0001', ['DE-0002']],
  ];
  for (const [comment, spotted, want] of rows) {
    assert.deepStrictEqual(N.commentRefs(comment, spotted), want, `${comment} @ ${spotted}`);
  }
});

test('a comment that does not name the spotted park says nothing about this contact', () => {
  assert.strictEqual(N.commentRefs('P2P with K-1234', 'US-1111'), null);
  assert.strictEqual(N.commentRefs('QSY to K-5678 next', 'US-1234'), null);
  assert.strictEqual(N.commentRefs('2-fer US-2222 US-3333', 'US-1111'), null);
  assert.strictEqual(N.commentRefs('', 'US-1111'), null);
  assert.strictEqual(N.commentRefs('CQ FT8 20m', 'US-1111'), null);
});

test('WWFF is refused whatever its prefix length: KFF-, GFF-, IFF-, FFF-, DLFF-', () => {
  for (const ff of ['KFF-1234', 'GFF-0012', 'IFF-0345', 'FFF-0456', 'DLFF-0123', 'VKFF-1234']) {
    const p = ff.replace(/FF-.*/, '');
    assert.deepStrictEqual(N.commentRefs(`2-fer US-1234, ${ff}`, 'US-1234'), [], ff);
    assert.deepStrictEqual(N.commentRefs(`3-fer US-1234, ${ff}, US-5678`, 'US-1234'), ['US-5678'], ff + ' between two parks');
    assert.ok(p.length >= 1);
  }
  assert.deepStrictEqual(extra([own('2-fer KFF-1234 KFF-5678')], 'KFF-1234'), [], 'a WWFF spot never starts a POTA n-fer');
});

test('the parks catalogue decides when that country\'s list is loaded', () => {
  const comment = '3-fer US-1234, US-5678, US-9999';
  const knows = (list) => (ref) => list.includes(ref);
  assert.deepStrictEqual(N.commentRefs(comment, 'US-1234', { parkKnown: knows(['US-1234', 'US-5678']) }), ['US-5678'], 'US-9999 is no park');
  assert.deepStrictEqual(N.commentRefs(comment, 'US-1234', { parkKnown: () => null }), ['US-5678', 'US-9999'], 'list not loaded: the other checks stand');
  assert.deepStrictEqual(N.commentRefs(comment, 'US-1234', { parkKnown: () => false }), []);
  assert.deepStrictEqual(N.commentRefs(comment, 'US-1234'), ['US-5678', 'US-9999']);
  assert.deepStrictEqual(N.commentRefs('2-fer K-1234 K-5678', 'US-1234', { parkKnown: knows(['US-5678']) }), ['US-5678'], 'asked in the catalogue\'s own form');
});

test('a list longer than a 10-fer is not believed', () => {
  const many = Array.from({ length: 12 }, (_, i) => 'US-' + String(1000 + i)).join(',');
  assert.deepStrictEqual(N.commentRefs(many, 'US-1000'), []);
  const ten = Array.from({ length: 10 }, (_, i) => 'US-' + String(1000 + i)).join(',');
  assert.strictEqual(N.commentRefs(ten, 'US-1000').length, 9);
});

// ---- which comment ---------------------------------------------------------

test('only the activator\'s own spots; RBN and hunters naming other parks do not count', () => {
  const spots = [
    own('3-fer DE-1197,DE-0941,DE-0034 FT8', '14:50', 'DK5UR'),
    own('RBN -15 dB DE-1197, DE-9999', '15:05', 'OE6ADD-#'),
    own('P2P DE-1197, DE-0001', '15:06', 'DA2PK'),
  ];
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'DK5UR', spottedRef: 'DE-1197', spots, now: NOW }), ['DE-0941', 'DE-0034']);
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'DK5UR/P', spottedRef: 'DE-1197', spots, now: NOW }), ['DE-0941', 'DE-0034'], 'portable suffix');
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'DA2PK', spottedRef: 'DE-1197', spots, now: NOW }), [], 'and a P2P list is no n-fer');
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'DK5UR', spottedRef: 'DE-1197', spots: spots.slice(1), now: NOW }), []);
});

test('one comment at a time: refs are never added together across comments', () => {
  // The first names the spotted park, the second does not: the second's parks stay out.
  assert.deepStrictEqual(extra([own('2-fer US-1234, US-5678', '14:00'), own('QSY to US-7777, US-8888 next', '14:30')]), ['US-5678']);
  assert.deepStrictEqual(extra([own('US-1234 FT8', '14:00'), own('2-fer US-7777, US-8888', '14:30')]), []);
  // Both name it: the newest decides alone.
  assert.deepStrictEqual(extra([own('2-fer US-1234, US-5678', '14:00'), own('2-fer US-1234, US-6666', '14:30')]), ['US-6666']);
  assert.deepStrictEqual(extra([own('2-fer US-1234, US-6666', '14:30'), own('2-fer US-1234, US-5678', '14:00')]), ['US-6666'], 'whatever the order they arrive in');
  // The newest that names the park says it is alone now.
  assert.deepStrictEqual(extra([own('2-fer US-1234, US-5678', '14:00'), own('US-1234 40m FT8', '14:30')]), []);
});

test('two activations on one day: only this afternoon\'s parks', () => {
  const day = [own('2-fer K-1111 K-2222', '09:00'), own('2-fer K-1111 K-3333', '14:40')];
  assert.deepStrictEqual(extra(day, 'US-1111'), ['US-3333']);
  assert.deepStrictEqual(extra(day.slice(0, 1), 'US-1111'), [], 'the morning spot alone is 6 hours old');
  // And at 09:30 the morning's, not the afternoon's (which has not happened yet).
  assert.deepStrictEqual(extra(day, 'US-1111', { now: Date.UTC(2026, 10, 12, 9, 30) }), ['US-2222']);
});

test('only spots from this activation: 3 hours back, 5 minutes of clock skew ahead', () => {
  const c = '2-fer US-1234, US-5678';
  assert.deepStrictEqual(extra([own(c, '12:11')]), ['US-5678'], '2 h 59 min old');
  assert.deepStrictEqual(extra([own(c, '12:09')]), [], '3 h 1 min old');
  assert.deepStrictEqual(extra([own(c, '15:14')]), ['US-5678'], '4 min ahead: clock skew');
  assert.deepStrictEqual(extra([own(c, '15:16')]), [], '6 min ahead');
  assert.deepStrictEqual(extra([{ spotter: 'K1ABC', comments: c, spotTime: '2026-11-11T15:00:00' }]), [], 'yesterday');
  assert.deepStrictEqual(extra([{ spotter: 'K1ABC', comments: c }]), [], 'no time: not used');
  assert.deepStrictEqual(extra([{ spotter: 'K1ABC', comments: c, spotTime: 'soon' }]), [], 'unreadable time: not used');
  assert.deepStrictEqual(extra([{ spotter: 'K1ABC', comments: c, spotTime: '2026-11-12T15:00:00Z' }]), ['US-5678'], 'a zone is read as given');
  assert.strictEqual(N.MAX_SPOT_AGE_MS, 3 * 60 * 60 * 1000);
});

test('the time limit covers both sources: pota.app history and POTACAT\'s collected spots', () => {
  // main.js hands both as one list; the collected buffer's shape has callsign/reference too.
  const history = [own('2-fer US-1234, US-2222', '08:00')];
  const collected = [{ _key: 'pota:1', callsign: 'K1ABC', reference: 'US-1234', spotter: 'K1ABC', comments: '2-fer US-1234, US-3333', source: 'pota', spotTime: at('07:00') }];
  assert.deepStrictEqual(extra(history.concat(collected)), []);
  collected[0].spotTime = at('14:55');
  assert.deepStrictEqual(extra(history.concat(collected)), ['US-3333']);
});

test('parks the spot list already matched are not repeated', () => {
  const spots = [own('3-fer US-1234, US-5678, US-0001')];
  assert.deepStrictEqual(extra(spots, 'US-1234', { known: ['US-1234', 'US-5678'] }), ['US-0001']);
  assert.deepStrictEqual(extra(spots, 'US-1234', { known: ['US-1234', 'K-5678', 'us-0001'] }), []);
  assert.deepStrictEqual(N.nferExtraRefs(), [], 'nothing in, nothing out');
});

// ---- the cache and the prefetch --------------------------------------------

test('cache: one fetch per activator and park, read without waiting, the time rule applied at log time', async () => {
  let calls = 0;
  const history = [own('2-fer US-1234, US-5678', '14:50'), own('P2P US-1234, US-0009', '14:55', 'W9XYZ')];
  const c = new N.NferCache({ fetchHistory: async () => { calls++; return history; } });
  assert.deepStrictEqual(c.get('K1ABC', 'US-1234'), [], 'nothing before the fetch lands');
  assert.strictEqual(c.prefetch('K1ABC', 'US-1234'), undefined, 'nothing to await');
  c.prefetch('K1ABC', 'US-1234');
  await wait(10);
  c.prefetch('K1ABC/P', 'K-1234');
  assert.strictEqual(calls, 1);
  const got = c.get('K1ABC', 'US-1234');
  assert.deepStrictEqual(got, [{ spotter: 'K1ABC', comments: '2-fer US-1234, US-5678', spotTime: at('14:50') }], 'their own spots, as spots');
  assert.deepStrictEqual(extra(got), ['US-5678']);
  assert.deepStrictEqual(extra(got, 'US-1234', { now: NOW + 4 * 3600 * 1000 }), [], 'the same cached spot is too old four hours on');
});

test('cache: a failed fetch is no extras and is tried again later; a hung one does not hold the key for good', async () => {
  let t = 1000000;
  let calls = 0;
  const failing = new N.NferCache({ now: () => t, fetchHistory: async () => { calls++; throw new Error('down'); } });
  failing.prefetch('K1ABC', 'US-1234');
  await wait(10);
  assert.deepStrictEqual(failing.get('K1ABC', 'US-1234'), []);
  failing.prefetch('K1ABC', 'US-1234');
  assert.strictEqual(calls, 1, 'not hammered');
  t += 5 * 60 * 1000 + 1;
  failing.prefetch('K1ABC', 'US-1234');
  await wait(5);
  assert.strictEqual(calls, 2, 'tried again after 5 minutes');

  let hung = 0;
  const stuck = new N.NferCache({ now: () => t, fetchHistory: () => { hung++; return new Promise(() => {}); } });
  stuck.prefetch('K1ABC', 'US-1234');
  await wait(5);
  stuck.prefetch('K1ABC', 'US-1234');
  assert.strictEqual(hung, 1, 'one request while it is in flight');
  t += 15 * 1000 + 1;
  stuck.prefetch('K1ABC', 'US-1234');
  await wait(5);
  assert.strictEqual(hung, 2, 'a request that never settled is given up on after 15 s');
  assert.deepStrictEqual(stuck.get('K1ABC', 'US-1234'), []);
});

test('cache: bounded', async () => {
  const c = new N.NferCache({ max: 3, fetchHistory: async () => [] });
  for (let i = 0; i < 10; i++) c.prefetch('K1ABC', 'US-100' + i);
  await wait(5);
  assert.strictEqual(c._map.size, 3);
});

test('a QSO starts once: the state is broadcast on every step, the prefetch is for the first', () => {
  const g = new N.QsoStartGate();
  assert.strictEqual(g.started('popout', 'K1ABC'), true);
  assert.strictEqual(g.started('popout', 'K1ABC'), false);
  assert.strictEqual(g.started('popout', 'k1abc'), false);
  assert.strictEqual(g.started('remote', 'K1ABC'), true, 'the phone\'s QSO is its own');
  assert.strictEqual(g.started('popout', null), false, 'idle, or calling CQ with nobody yet');
  assert.strictEqual(g.started('popout', 'K1ABC'), true, 'the same station again later is a new QSO');
  assert.strictEqual(g.started('popout', 'W9XYZ'), true);
});

// ---- lib/pota.js: the request ----------------------------------------------

function stubHttps(handler) {
  const real = https.get;
  const seen = [];
  https.get = (url, opts, cb) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = (err) => { req.destroyed = true; if (err) setImmediate(() => req.emit('error', err)); };
    seen.push({ url, req });
    handler(url, cb, req);
    return req;
  };
  return { seen, restore: () => { https.get = real; } };
}
function answer(cb, status, body) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.resume = () => {};
  setImmediate(() => { cb(res); setImmediate(() => { if (body != null) res.emit('data', body); res.emit('end'); }); });
}

test('pota.app history is /spot/comments/{call}/{ref}, and it answers a list', async () => {
  const s = stubHttps((url, cb) => answer(cb, 200, JSON.stringify([{ spotter: 'K1ABC', comments: '2-fer' }])));
  try {
    const got = await Pota.fetchSpotHistory('k1abc', 'US-1234');
    assert.strictEqual(s.seen[0].url, 'https://api.pota.app/spot/comments/K1ABC/US-1234');
    assert.deepStrictEqual(got, [{ spotter: 'K1ABC', comments: '2-fer' }]);
  } finally { s.restore(); }
  const s404 = stubHttps((url, cb) => answer(cb, 404, null));
  try { assert.deepStrictEqual(await Pota.fetchSpotHistory('K1ABC', 'US-1234'), []); } finally { s404.restore(); }
  const s500 = stubHttps((url, cb) => answer(cb, 500, null));
  try { await assert.rejects(Pota.fetchSpotHistory('K1ABC', 'US-1234'), /HTTP 500/); } finally { s500.restore(); }
  assert.deepStrictEqual(await Pota.fetchSpotHistory('', 'US-1234'), [], 'no call: no request');
});

test('a request that hangs is aborted and rejects: 10 s by default', async () => {
  const s = stubHttps(() => { /* never answers */ });
  try {
    const t0 = Date.now();
    await assert.rejects(Pota.fetchSpotHistory('K1ABC', 'US-1234', { timeoutMs: 30 }), /did not answer/);
    assert.ok(Date.now() - t0 < 2000);
    assert.strictEqual(s.seen[0].req.destroyed, true, 'the socket is closed, not left open');
  } finally { s.restore(); }
  // Headers arrive, the body never ends: still aborted.
  const slow = stubHttps((url, cb) => { const res = new EventEmitter(); res.statusCode = 200; res.resume = () => {}; setImmediate(() => cb(res)); });
  try {
    await assert.rejects(Pota.fetchSpotHistory('K1ABC', 'US-1234', { timeoutMs: 30 }), /did not answer/);
    assert.strictEqual(slow.seen[0].req.destroyed, true);
  } finally { slow.restore(); }
  const src = readSrc(path.join(root, 'lib', 'pota.js'));
  assert.ok(/const SPOT_HISTORY_TIMEOUT_MS = 10000;/.test(src));
  // Through the cache a hang is just "no extra parks", and the key is free again.
  const hang = stubHttps(() => {});
  try {
    const c = new N.NferCache({ fetchHistory: (call, ref) => Pota.fetchSpotHistory(call, ref, { timeoutMs: 20 }), failTtlMs: 0 });
    c.prefetch('K1ABC', 'US-1234');
    await wait(60);
    assert.strictEqual(c._map.get('K1ABC|US-1234').pending, false);
    c.prefetch('K1ABC', 'US-1234');
    await wait(60);
    assert.strictEqual(hang.seen.length, 2);
  } finally { hang.restore(); }
});

// ---- what is forwarded -----------------------------------------------------

const QSO = { callsign: 'K1ABC', frequency: '14074', mode: 'FT8', band: '20m', qsoDate: '20261112', timeOn: '151000', rstSent: '-10', rstRcvd: '-12', comment: 'JTCAT FT8' };
const ctx = { now: NOW, parkInfo: () => null, callInfo: () => null };
const OPS = { sendToLogbook: true, logbookType: 'n3fjp', extraUdpEnabled: true, qrzLogbook: true, qrzApiKey: 'k' };
// saveQsoRecord gives every record its uuid before it is written or forwarded.
const stamp = (r, i) => { r.uuid = '00000000-0000-4000-8000-00000000000' + i; };
async function forwarded(rec) {
  const sent = { logbook: [], udp: [], qrz: [] };
  await LF.forwardToLoggers(rec, OPS, {
    forwardToLogbook: async (q) => { sent.logbook.push(q); },
    sendExtraUdp: async (q) => { sent.udp.push(q); },
    sendToQrzLogbook: async (q) => { sent.qrz.push(q); },
  });
  return sent;
}

test('a single-park contact is forwarded as before: the same object, the same bytes', async () => {
  for (const entry of [
    { ...QSO, hunted: [{ sig: 'POTA', ref: 'US-1111' }] },
    { ...QSO, sig: 'POTA', sigInfo: 'US-1111', potaRef: 'US-1111' },
    { ...QSO, hunted: [{ sig: 'WWFF', ref: 'KFF-1111' }, { sig: 'POTA', ref: 'US-1111' }] }, // one park, two programs
    { ...QSO, hunted: [{ sig: 'SOTA', ref: 'W1/HA-001' }] },
    { ...QSO },
  ]) {
    const recs = expandContact(entry, ctx);
    recs.forEach(stamp);
    for (const r of recs) assert.ok(!('forwardPotaRefs' in r), 'no forward flag: ' + JSON.stringify(entry.hunted || entry.sigInfo || 'plain'));
    const before = buildAdifRecord(recs[0]);
    const sent = await forwarded(recs[0]);
    for (const path of ['logbook', 'udp', 'qrz']) {
      assert.strictEqual(sent[path].length, 1, path);
      assert.strictEqual(sent[path][0], recs[0], path + ': the record itself, untouched');
      assert.strictEqual(buildAdifRecord(sent[path][0]), before, path + ': byte-identical ADIF (N3FJP, Log4OM UDP, HRD, QRZ all send this)');
    }
    for (const r of recs.slice(1)) {
      const s = await forwarded(r);
      assert.deepStrictEqual([s.logbook.length, s.udp.length, s.qrz.length], [0, 0, 0], 'the other program\'s copy is still not forwarded');
    }
  }
});

test('an n-fer: the first forwarded record carries every POTA park as a comma list in POTA_REF, and nothing else changes', async () => {
  const recs = expandContact({ ...QSO, hunted: [{ sig: 'POTA', ref: 'US-1111' }, { sig: 'POTA', ref: 'US-2222' }, { sig: 'POTA', ref: 'US-3333' }] }, ctx);
  recs.forEach(stamp);
  assert.deepStrictEqual(recs.map((r) => r.potaRef), ['US-1111', 'US-2222', 'US-3333'], 'the local log: one park per record');
  assert.deepStrictEqual(recs.map((r) => r.forwardPotaRefs), ['US-1111,US-2222,US-3333', undefined, undefined]);
  assert.deepStrictEqual(recs.map((r) => !!r.skipLogbookForward), [false, true, true]);
  const localAdif = buildAdifRecord(recs[0]);
  assert.ok(localAdif.includes('<POTA_REF:7>US-1111'), 'the local file and the Cloud copy keep the one park');
  assert.ok(!/forward/i.test(localAdif), 'the flag is never written');

  const sent = await forwarded(recs[0]);
  for (const path of ['logbook', 'udp', 'qrz']) {
    const q = sent[path][0];
    assert.strictEqual(q.potaRef, 'US-1111,US-2222,US-3333', path);
    assert.strictEqual(q.forwardPotaRefs, undefined);
    const { potaRef, ...rest } = q;
    const { potaRef: _p, forwardPotaRefs: _f, ...orig } = recs[0];
    assert.deepStrictEqual(rest, orig, path + ': every other field as it was (SIG, SIG_INFO, times, reports)');
    const adif = buildAdifRecord(q);
    assert.ok(adif.includes('<POTA_REF:23>US-1111,US-2222,US-3333'), adif);
    assert.strictEqual(adif.replace('<POTA_REF:23>US-1111,US-2222,US-3333', '<POTA_REF:7>US-1111'), localAdif, 'POTA_REF is the only difference');
  }
  assert.strictEqual(recs[0].potaRef, 'US-1111', 'the record that was written locally is not changed by forwarding');
  for (const r of recs.slice(1)) {
    const s = await forwarded(r);
    assert.deepStrictEqual([s.logbook.length, s.udp.length, s.qrz.length], [0, 0, 0], 'one QSO in the external logbook, not three');
  }
});

test('any surface: the Log QSO form\'s two-park contact and a POTA + WWFF n-fer', () => {
  const form = expandContact({ ...QSO, mode: 'SSB', sig: 'POTA', sigInfo: 'US-1111,US-2222', potaRef: 'US-1111,US-2222' }, ctx);
  assert.deepStrictEqual(form.map((r) => r.forwardPotaRefs), ['US-1111,US-2222', undefined]);
  const mixed = expandContact({ ...QSO, hunted: [{ sig: 'WWFF', ref: 'KFF-1111' }, { sig: 'POTA', ref: 'US-1111' }, { sig: 'POTA', ref: 'US-2222' }] }, ctx);
  assert.deepStrictEqual(mixed.map((r) => r.forwardPotaRefs), ['US-1111,US-2222', undefined, undefined]);
  assert.strictEqual(mixed[0].sig, 'WWFF');
  const multiOp = expandContact({ ...QSO, callsign: 'K1ABC,W9XYZ', hunted: [{ sig: 'POTA', ref: 'US-1111' }, { sig: 'POTA', ref: 'US-2222' }] }, ctx);
  assert.deepStrictEqual(multiOp.map((r) => r.forwardPotaRefs), ['US-1111,US-2222', undefined, 'US-1111,US-2222', undefined], 'each callsign is one QSO');
  const qe = readSrc(path.join(root, 'lib', 'qso-expand.js'));
  assert.ok(/else if \(potaAll\.length > 1\) r\.forwardPotaRefs = potaAll\.join\(','\);/.test(qe));
  assert.ok(/forwardPotaRefs/.test(qe.slice(0, qe.indexOf("const { stripSigTag }"))), 'the forward rule in the header says so');
});

// ---- the logged card -------------------------------------------------------

test('the QSO logged card says where: "at US-1111 and US-2222", and which parks came from the comment', () => {
  assert.strictEqual(N.parksText([]), '');
  assert.strictEqual(N.parksText(['US-1111']), 'at US-1111');
  assert.strictEqual(N.parksText(['US-1111', 'US-2222']), 'at US-1111 and US-2222');
  assert.strictEqual(N.parksText(['DE-1197', 'DE-0941', 'DE-0034']), 'at DE-1197, DE-0941 and DE-0034');
  assert.strictEqual(N.nferNote([]), '');
  assert.strictEqual(N.nferNote(['US-2222']), 'US-2222: from their own spot comment');
  assert.strictEqual(N.nferNote(['DE-0941', 'DE-0034']), 'DE-0941 and DE-0034: from their own spot comment');
  assert.ok(html.includes('<div id="jp-qso-card-parks" class="jp-qso-card-parks"></div>'));
  assert.ok(html.includes('<div id="jp-qso-card-note" class="jp-qso-card-note"></div>'));
  assert.ok(/\.jp-qso-card-parks:empty, \.jp-qso-card-note:empty \{ display: none; \}/.test(html), 'no gap in the card for a contact at no park');
  assert.ok(/getElementById\('jp-qso-card-parks'\)\.textContent = data\.parksText \|\| ''/.test(popout), 'text, never HTML');
  assert.ok(/getElementById\('jp-qso-card-note'\)\.textContent = data\.parksNote \|\| ''/.test(popout));
  assert.ok(/parksText: NferRefs\.parksText\(loggedAt\),\n\s*parksNote: NferRefs\.nferNote\(fromComment\),/.test(main));
  assert.ok(/const loggedAt = \[\.\.\.new Set\(\(res\.records \|\| \[\]\)\.map\(\(r\) => r\.sigInfo\)\.filter\(Boolean\)\)\];/.test(main), 'what was really written, after any edit in the Log QSO window');
});

// ---- the option ------------------------------------------------------------

test('the option: in the JTCAT options, the existing row pattern, ON by default (Casey 2026-11-12)', () => {
  const row = /<button id="jp-nfer-parks" class="jp-opt-row">\s*<span class="jp-opt-label">([^<]+)<\/span>\s*<span class="jp-opt-help">([^<]+)<\/span>\s*<\/button>/.exec(html);
  assert.ok(row, 'label + help, like its neighbours');
  assert.strictEqual(row[1], 'Log every park of a two-fer');
  assert.ok(/Off = JTCAT logs only the park in the spot list\.$/.test(row[2]));
  assert.ok(html.indexOf('id="jp-nfer-parks"') > html.indexOf('id="jp-hunt-spotted"') && html.indexOf('id="jp-nfer-parks"') < html.indexOf('id="jp-qso-card"'));
  assert.ok(/nferParks = s\.jtcatNferParks !== false;/.test(popout), 'unset = on');
  assert.ok(/var nferParks = true;/.test(popout));
  assert.ok(/window\.api\.saveSettings\(\{ jtcatNferParks: nferParks \}\);/.test(popout));
  assert.ok(/function jtcatNferEnabled\(\) \{\n\s*return settings\.jtcatNferParks !== false;\n\}/.test(main), 'unset = on at the shack too');
  // A remote JTCAT window and a phone set it on the shack; every device is told.
  assert.strictEqual(require('../lib/remote-bridge').JTCAT_PREFS.jtcatNferParks, 'boolean');
  assert.strictEqual(require('../lib/remote-bridge').acceptPref('jtcatNferParks', false), false);
  assert.ok(/jtcatNferParks: settings\.jtcatNferParks !== false,/.test(main), 'in the settings a device receives');
  assert.ok(/if \(key === 'jtcatNferParks'\) updateRemoteSettings\(\);/.test(main));
  assert.ok(/if \(has\('jtcatNferParks'\)\) updateRemoteSettings\(\);/.test(main));
});

// ---- main.js is glue -------------------------------------------------------

function fnBody(name) {
  const i = main.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name);
  return main.slice(i, main.indexOf('\n}\n', i));
}

test('pota.app is asked when a QSO with the activator starts, never per decoded station', () => {
  const lookup = fnBody('jtcatSpottedActivator');
  assert.ok(!/_nferCache|prefetch|fetchPotaSpotHistory/.test(lookup), 'the lookup every decode runs through asks nobody');
  const pre = fnBody('jtcatNferPrefetch');
  assert.ok(/if \(!_nferQsoStart\.started\(owner, qso && qso\.call\)\) return;/.test(pre), 'once per QSO');
  assert.ok(/if \(!jtcatNferEnabled\(\)\) return;/.test(pre), 'option off: no request at all');
  assert.ok(/_nferCache\.prefetch\(qso\.call, pota\.ref\);/.test(pre));
  assert.strictEqual((main.match(/_nferCache\.prefetch\(/g) || []).length, 1, 'the one place that asks');
  assert.ok(/jtcatNferPrefetch\('remote', remoteJtcatQso\);/.test(fnBody('remoteJtcatBroadcastQso')), 'a phone\'s QSO');
  assert.ok(/jtcatNferPrefetch\('popout', popoutJtcatQso\);/.test(fnBody('popoutBroadcastQso')), 'the JTCAT window\'s QSO');
  assert.strictEqual((main.match(/fetchPotaSpotHistory\(/g) || []).length, 1, 'only through the cache');
});

test('logging never waits on the network; the rule is the library\'s', () => {
  assert.ok(!/await[^\n]*(_nferCache|jtcatNferPrefetch|fetchPotaSpotHistory)/.test(main), 'never awaited: the next TX message waits on the log write');
  assert.ok(!/\.then\([^\n]*_nferCache/.test(main));
  const log = fnBody('jtcatAutoLog');
  assert.ok(/const spotted = jtcatNferEnabled\(\) \? hunted\.refs\.find\(\(r\) => r\.sig === 'POTA'\) : null;/.test(log), 'option off: nothing is read');
  assert.ok(/NferRefs\.nferExtraRefs\(\{\n\s*call: q\.call, spottedRef: spotted\.ref, now: Date\.now\(\),/.test(log), 'the time of the contact');
  assert.ok(/spots: _nferCache\.get\(q\.call, spotted\.ref\)\n\s*\.concat\(_potaSpotHistory\.filter\(/.test(log), 'both sources go through the one rule');
  assert.ok(/parkKnown: jtcatParkKnown,/.test(log));
  assert.ok(/for \(const ref of extra\) qsoData\.hunted\.push\(\{ sig: 'POTA', ref \}\);/.test(log), 'logged through logContact + qso-expand like every park');
  assert.ok(!/hunted\.refs\.push/.test(log), 'the spot list\'s refs stay the spot list\'s: a re-spot never uses a park read from a comment');
  assert.ok(!/POTA_REF_RE|matchAll|\.comments/.test(log), 'no parsing in main.js');
  const known = fnBody('jtcatParkKnown');
  assert.ok(/if \(!list \|\| !list\.map \|\| !list\.map\.size\) return null;/.test(known), 'list not loaded = no answer, not "unknown park"');
});

test('the n-fer block comes before any automatic re-spot (#351)', () => {
  const log = fnBody('jtcatAutoLog');
  const nfer = log.indexOf('NferRefs.nferExtraRefs(');
  assert.ok(nfer > 0);
  for (const name of ['jtcatApplyAutoRespot', 'jtcatAutoRespotPlan', 'applyAutoRespot']) {
    const i = log.indexOf(name);
    if (i >= 0) assert.ok(nfer < i, name + ' runs after the n-fer block');
  }
});

test('the stale notes are gone', () => {
  assert.ok(!/returns empty even/.test(main), 'the spot-history handler no longer calls pota.app\'s history dead');
  assert.ok(/\/spot\/comments\/\{call\}\/\{ref\}; JTCAT's n-fer lookup reads it, lib\/nfer-refs\.js/.test(main));
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/nfer-refs-test.js'"));
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message || e)); }
  }
  console.log(`\nn-fer refs: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
