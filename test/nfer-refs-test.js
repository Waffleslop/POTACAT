#!/usr/bin/env node
'use strict';
// An n-fer's other parks, read from the activator's own spot comment (#353):
// which spot decides, what its comment must look like, when pota.app is asked,
// what the external logbook and a remote client are sent. The rule is the
// header of lib/nfer-refs.js; the refused comments are the second review's.
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

const YES = { parkKnown: () => true };   // the country's park list is loaded and has them all
const refs = (comment, spotted = 'US-1111', opts) => N.commentRefs(comment, spotted, opts);

test('rule (a): the comment says n-fer with a number, and lists exactly that many parks', () => {
  const rows = [
    // comment, spotted park, extra parks logged
    ['3-fer DE-1197,DE-0941,DE-0034 FT8', 'DE-1197', ['DE-0941', 'DE-0034']],
    ['2-fer: US-1611 US-6544', 'US-1611', ['US-6544']],          // the Ham2K PoLo form, live on pota.app
    ['2-fer US-1234 US-5678', 'US-1234', ['US-5678']],
    ['2-fer K-1234 K-5678', 'US-1234', ['US-5678']],              // the old US prefix is the same park
    ['2fer K-1111 US-2222', 'US-1111', ['US-2222']],
    ['2fer us-1111  us-2222   ft8', 'US-1111', ['US-2222']],
    ['3 fer US-1111 US-2222 US-3333', 'US-1111', ['US-2222', 'US-3333']],
    ['two fer US-1111 US-2222', 'US-1111', ['US-2222']],
    ['twofer US-1111 + US-2222 cq', 'US-1111', ['US-2222']],
    ['K-1111/K-2222/K-3333 3fer', 'US-1111', ['US-2222', 'US-3333']],
    ['US-1111 2fer with US-2222', 'US-1111', ['US-2222']],
    ['US-1111 (2fer US-2222)', 'US-1111', ['US-2222']],
    ['2-fer with US-1111 and US-2222', 'US-1111', ['US-2222']],
    ['2fer US–1111 US—2222', 'US-1111', ['US-2222']],  // en and em dashes
    ['2fer US-1111 &amp; US-2222', 'US-1111', ['US-2222']],
    ['2fer US-1111 &#38; US-2222', 'US-1111', ['US-2222']],
    ['2-fer K-1234 K-5678 (yesterday K-9999)', 'US-1234', ['US-5678']],
    ['2fer US-1111 US-2222 next US-3333', 'US-1111', ['US-2222']],
    ['2fer US-1111 US-2222, next 2fer US-3333 US-4444', 'US-1111', ['US-2222']],
    ['2fer US-1111 US-2222 QSY to US-3333 at 20z', 'US-1111', ['US-2222']],
    ['2-fer US-1234 GFF-0012 US-5678', 'US-1234', ['US-5678']],  // a WWFF reference in the list is not a park
    ['x'.repeat(300) + ' 2fer US-1111 US-2222', 'US-1111', ['US-2222']],
    // the spot is AT the spotted park: "2-fer with the other one" counts it
    ['2fer with US-2222', 'US-1111', ['US-2222']],
    ['2-fer w/ US-2222 FT8', 'US-1111', ['US-2222']],
    ['2-fer US-2222', 'US-1111', ['US-2222']],
  ];
  for (const [comment, spotted, want] of rows) {
    assert.deepStrictEqual(refs(comment, spotted), want, `${comment.slice(-60)} @ ${spotted}`);
  }
});

test('rule (a) refuses: a count that does not match, P2P anywhere, another place or time', () => {
  for (const comment of [
    '2fer US-1111 US-2222 US-3333',               // says two, lists three
    '3-fer US-1111 US-2222',                      // says three, lists two
    '3-fer US-1111, KFF-1111, US-2222',           // the third is WWFF
    '2-fer US-1111 and DE-0001',                  // another country
    '2-fer US-1111 FT8-1234',
    '2fer US-2222 US-3333',                       // two others, and the spot is at US-1111: three
    '2fer US-1111 US-222',                        // not a reference
    '2fer US1111 US2222',
    '2fer US-1111 US-2222 tnx P2P US-3333',       // P2P anywhere
    '2fer US-1111 US-2222 P2P',
    'P2P 2-fer US-1111 US-2222',
    'park to park 2fer US-1111 US-2222',
    'QSY to 2-fer US-1111 US-2222',
    'next 2fer US-1111 US-2222',
    'worked 2-fer US-1111 US-2222',
    'yesterday 2fer US-1111, US-2222',
    'rove 2fer US-1111 US-2222',
    '2fer US-1111 US-2222 next',
    '2fer US-1111 US-2222 later today',
    '2fer US-1111, US-2222 tomorrow',
    '2fer US-1111 US-2222 planned',
    '2fer US-1111 US-2222 maybe',
    '2fer yesterday at US-2222 US-3333, today just US-1111',
    '2fer US-1111 und US-2222',                   // no foreign-language joiners
    'US-1111 US-2222 N fer sure',                 // a bare "N fer" is not a number
    'US-1111 US-2222 n-fer',
    'transfer station US-1111 US-2222',
    'US-1111 US-2222 conifer trail',
    '2 x US-1111 US-2222',
    'double US-1111 US-2222',
    '1-fer US-1111 US-2222',
    '12-fer US-1111 US-2222',
  ]) {
    assert.deepStrictEqual(refs(comment, 'US-1111', YES), [], comment);
  }
});

test('rule (b): no n-fer word, a joined list, nothing else but neutral tokens, the catalogue confirms', () => {
  for (const comment of [
    'US-1111/US-2222',
    'US-1111, US-2222',
    'K-1111 & K-2222',
    'US-1111 + US-2222',
    'US-1111; US-2222',
    'us-1111 and us-2222',
    'US-1111 &amp; US-2222',
    'US-1111 &#38; US-2222',
    '(US-1111,US-2222)',
    'US-1111,US-2222.',
    'US-1111, US-2222 FT8',
    'US-1111/US-2222 20m FT8 14.074 FN20 QRV',
    'CQ POTA US-1111, US-2222 14074.5 kHz 73 tnx',
    'US-1111, KFF-1111, US-2222 CW',              // a WWFF reference beside it is neutral
    'FT8 20M: US-2222 / US-1111!',
  ]) {
    assert.deepStrictEqual(refs(comment, 'US-1111', YES), ['US-2222'], comment);
  }
  assert.deepStrictEqual(refs('US-1111, US-2222, US-3333, US-4444 FT8', 'US-1111', YES), ['US-2222', 'US-3333', 'US-4444']);
});

// Every one of these logged a park the contact was not at (second review of
// PR #427, 2026-11-12). Refused even when the catalogue knows every park.
test('the reviewer\'s false positives: every one adds nothing', () => {
  for (const comment of [
    'Rove today: US-1111, US-2222, US-3333',
    'Park 1 of 3: US-1111, US-2222, US-3333',
    'Plan US-1111/US-2222/US-3333',
    'Rover US-1111, US-2222, US-3333 FT8 all day',
    'US-1111, US-2222 at 1800z',
    'US-1111, US-2222 after lunch',
    'US-1111 & US-2222 in 1 hour',
    'US-1111 + US-2222 tonight',
    'US-1111, US-2222 is next',
    'US-1111 and US-2222 coming up',
    'US-1111, US-2222 maybe',
    'US-1111 and US-2222 if time permits',
    'US-1111 + US-2222 (planned)',
    'US-1111, US-2222 this morning',
    'US-1111, US-2222 was earlier',
    'US-1111; US-2222 was this morning',
    'US-1111/US-2222 P2P tnx',
    'US-1111 & US-2222 P2P',
    'P2P w/ W1XYZ @ US-2222 & US-1111',
    'US-2222 and US-1111 done, QRT',
    'finished US-2222 and US-1111 last one',
    'US-2222, US-1111 - second park of the day',
    'Last 15 min at US-1111, US-2222 at 2100',
    'US-1111,US-2222,US-3333,US-4444,US-5555,US-6666,US-7777,US-8888,US-9999,US-1212', // a bare 10-park list
    // questionable ones: refused too
    'today US-1111 and US-2222',
    'US-1111 / US-2222 ?',
    'US-1111 US-2222 N fer sure',
    'US-1111, US-2222 hunters tnx',
    'tnx for the P2Ps! US-1111, US-2222',
    'heading to US-1111, US-2222',
    'US-1111 / CA-2222',
    // the rest of the reviewer's list
    'moving to US-2222', 'US-1111 moving to US-2222', 'was at US-2222', 'US-1111 then US-2222', 'US-1111, then US-2222',
    'P2P US-2222', 'thx US-2222 for P2P', 'US-1111 - US-2222 later', 'US-1111 / US-2222 later today',
    'US-1111 now, US-2222 @ 15z', 'done with US-2222, now US-1111', 'Sorry, not US-2222, US-1111 is correct',
    'correction US-1111 not US-2222', 'US-1111 (not US-2222)', 'US-1111, not US-2222', 'US-1111 & not US-2222',
    'US-1111 near US-2222', 'US-1111 QRT, QSY US-2222', 'QRT US-1111, US-2222 in 30',
    'US-1111 & US-2222 tomorrow', 'Tomorrow US-1111 & US-2222', 'US-1111 & US-2222 yesterday', 'US-1111 or US-2222?',
    'US-1111 hunters: tnx US-2222, US-3333',
    // ... and what the first rule let through on purpose
    'US-1111 US-2222 FT8',                         // side by side, nothing joins them
    'US-1111 US-2222',
    'US-1111, US-2222 1800',                       // four bare digits may be a time
    'US-1111, US-2222 FT8 US-3333',                // a park outside the list
    'also US-2222', 'US-1111 also US-2222',
    'US-1111 und US-2222', 'US-1111 y US-2222', 'US-1111 と US-2222', 'US-1111、US-2222',
    'QSY 20m FT8', 'FT8', '',
  ]) {
    assert.deepStrictEqual(refs(comment, 'US-1111', YES), [], comment);
  }
});

test('WWFF is refused whatever its prefix length: KFF-, GFF-, IFF-, FFF-, DLFF-', () => {
  for (const ff of ['KFF-1234', 'GFF-0012', 'IFF-0345', 'FFF-0456', 'DLFF-0123', 'VKFF-1234']) {
    assert.deepStrictEqual(refs(`2-fer US-1234, ${ff}`, 'US-1234', YES), [], ff);
    assert.deepStrictEqual(refs(`US-1234, ${ff}`, 'US-1234', YES), [], ff + ' in a plain list');
    assert.deepStrictEqual(refs(`2-fer US-1234, ${ff}, US-5678`, 'US-1234', YES), ['US-5678'], ff + ' between two parks');
  }
  assert.deepStrictEqual(refs('K-1234 KFF-1234 FT8', 'US-1234', YES), [], 'the common US self-spot');
  assert.deepStrictEqual(refs('2-fer KFF-1234 KFF-5678', 'KFF-1234', YES), [], 'a WWFF spot never starts a POTA n-fer');
});

test('the parks catalogue: (b) needs its yes, (a) stands without it, a park it denies sinks the list', () => {
  const knows = (list) => (ref) => list.includes(ref);
  // (b): unknown = refuse
  assert.deepStrictEqual(refs('US-1111, US-2222'), [], 'no catalogue at all');
  assert.deepStrictEqual(refs('US-1111, US-2222', 'US-1111', { parkKnown: () => null }), [], 'that country\'s list is not loaded');
  assert.deepStrictEqual(refs('US-1111, US-2222', 'US-1111', { parkKnown: knows(['US-2222']) }), ['US-2222']);
  assert.deepStrictEqual(refs('US-1111, US-2222, US-3333', 'US-1111', { parkKnown: knows(['US-2222']) }), [], 'one unknown park: none of the list');
  // (a): not loaded = the other checks stand
  assert.deepStrictEqual(refs('2-fer US-1111 US-2222'), ['US-2222']);
  assert.deepStrictEqual(refs('2-fer US-1111 US-2222', 'US-1111', { parkKnown: () => null }), ['US-2222']);
  assert.deepStrictEqual(refs('3-fer US-1111, US-2222, US-9999', 'US-1111', { parkKnown: knows(['US-1111', 'US-2222']) }), [], 'US-9999 is no park: the comment is not believed');
  assert.deepStrictEqual(refs('2-fer K-1111 K-2222', 'US-1111', { parkKnown: knows(['US-2222']) }), ['US-2222'], 'asked in the catalogue\'s own form');
});

test('list sizes: a plain list adds at most three parks, an n-fer at most nine', () => {
  const list = (n) => Array.from({ length: n }, (_, i) => 'US-' + String(1111 + i)).join(',');
  assert.strictEqual(refs(list(4), 'US-1111', YES).length, 3);
  assert.deepStrictEqual(refs(list(5), 'US-1111', YES), []);
  assert.strictEqual(refs('10-fer ' + list(10), 'US-1111', YES).length, 9);
  assert.deepStrictEqual(refs('10-fer ' + list(11), 'US-1111', YES), []);
});

test('a hostile comment costs nothing: 100 kB strings in well under 50 ms each', () => {
  const K = 100000;
  const hostile = [
    'A'.repeat(K) + '-B US-1111, US-2222',
    'A-'.repeat(K / 2) + ' US-1111, US-2222',
    '2FER' + ' '.repeat(K) + 'US-1111 US-2222',
    '2FER '.repeat(K / 5) + 'US-1111 US-2222',
    '1'.repeat(K) + ' US-1111 US-2222',
    Array.from({ length: 12000 }, (_, i) => 'US-' + String(10000 + i)).join(',') + ',US-1111',
    'US-1111, US-2222 ' + 'A-'.repeat(K / 2),
    "'".repeat(K) + '-X US-1111,US-2222',
    ('A'.repeat(50) + '-').repeat(2000) + ' US-1111, US-2222',
    '2-FER US-1111 ' + 'US-2222 & '.repeat(K / 10),
    '('.repeat(K), ' '.repeat(K), '&AMP;'.repeat(K / 5),
  ];
  N.commentRefs('2-fer US-1111 US-2222', 'US-1111'); // warm up
  for (const c of hostile) {
    const t0 = process.hrtime.bigint();
    N.commentRefs(c, 'US-1111', YES);
    N.nferExtraRefs({ call: 'K1ABC', spottedRef: 'US-1111', spots: [{ spotter: 'K1ABC', comments: c, spotTime: at('15:00') }], now: NOW, ...YES });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 50, `${ms.toFixed(1)} ms for ${c.slice(0, 12)}... (${c.length} chars)`);
  }
  assert.strictEqual(N.MAX_COMMENT, 500);
  assert.strictEqual(N.selfSpots([{ spotter: 'K1ABC', comments: 'x'.repeat(K), spotTime: at('15:00') }], 'K1ABC')[0].comments.length, 500, 'what is kept is cut too');
  assert.deepStrictEqual(refs('y'.repeat(600) + ' 2fer US-1111 US-2222'), [], 'past 500 characters nothing is read');
});

// ---- which spot ------------------------------------------------------------

test('only the activator\'s own spots; RBN and hunters naming other parks do not count', () => {
  const spots = [
    own('3-fer DE-1197,DE-0941,DE-0034 FT8', '14:50', 'DK5UR'),
    own('RBN -15 dB DE-1197, DE-9999', '15:05', 'OE6ADD-#'),
    own('2-fer DE-1197, DE-0001', '15:06', 'DA2PK'),
  ];
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'DK5UR', spottedRef: 'DE-1197', spots, now: NOW }), ['DE-0941', 'DE-0034']);
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'DK5UR/P', spottedRef: 'DE-1197', spots, now: NOW }), ['DE-0941', 'DE-0034'], 'portable suffix');
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'DK5UR', spottedRef: 'DE-1197', spots: spots.slice(1), now: NOW }), []);
});

test('whose spot: the repo\'s one base-call rule, so KH6/K1A is never KH6/W7X', () => {
  const JtcatParser = require('../renderer/jtcat-parser');
  const by = (activator, spotter) => N.nferExtraRefs({ call: activator, spottedRef: 'US-1111', now: NOW, spots: [own('2fer US-1111 US-2222', '15:05', spotter)] });
  for (const [a, s, same] of [
    ['KH6/K1A', 'KH6/W7X', false],     // both used to reduce to KH6: a stranger's spot counted
    ['EA8/G4A', 'EA8/M0B', false],
    ['VE3/N1A', 'VE3XYZ', false],
    ['W1ABC', 'W1AW', false],
    ['W1ABC', 'W1ABC-#', false],       // RBN
    ['W1ABC', 'W1ABC-7', false],
    ['W1ABC/P', 'W1ABC', true],
    ['W1ABC', 'W1ABC/7', true],
    ['VE3/W1ABC', 'W1ABC', true],
    ['KH6/K1A', 'K1A', true],
    ['K1A/KH6', 'K1A', true],
  ]) {
    assert.deepStrictEqual(by(a, s), same ? ['US-2222'] : [], `${a} spotted by ${s}`);
    assert.strictEqual(N.baseCall(a), JtcatParser.baseCall(a), 'one definition: ' + a);
  }
  assert.ok(/function baseCall\(call\) \{\n\s*return typeof call === 'string' \? JtcatParser\.baseCall\(call\) : '';\n\}/.test(readSrc(path.join(root, 'lib', 'nfer-refs.js'))));
});

test('the newest of their own spots at the park decides alone', () => {
  // A newer plain spot after leaving the second park: nothing, whatever the older one said.
  assert.deepStrictEqual(extra([own('2-fer: US-1111 US-2222', '14:00'), own('QSY 20m FT8', '15:05')], 'US-1111'), []);
  assert.deepStrictEqual(extra([own('QSY 20m FT8', '15:05'), own('2-fer: US-1111 US-2222', '14:00')], 'US-1111'), [], 'whatever the order they arrive in');
  assert.deepStrictEqual(extra([own('2-fer: US-1111 US-2222', '14:00'), own('US-1111 40m FT8', '14:30')], 'US-1111'), []);
  assert.deepStrictEqual(extra([own('2-fer: US-1111 US-2222', '14:00'), own('', '14:30')], 'US-1111'), []);
  // Both are n-fers: the newest one's parks, never both.
  assert.deepStrictEqual(extra([own('2-fer US-1111, US-2222', '14:00'), own('2-fer US-1111, US-3333', '14:30')], 'US-1111'), ['US-3333']);
  assert.deepStrictEqual(extra([own('2-fer US-1111, US-3333', '14:30'), own('2-fer US-1111, US-2222', '14:00')], 'US-1111'), ['US-3333']);
  // Hunters' spots in between change nothing: they are not the activator's.
  assert.deepStrictEqual(extra([own('2-fer US-1111 US-2222', '14:40'), own('tnx 2-fer US-1111 US-9999', '15:08', 'K9XYZ')], 'US-1111'), ['US-2222']);
  // Same instant, different lists: no answer.
  assert.deepStrictEqual(extra([own('2fer US-1111 US-2222', '15:00'), own('2fer US-1111 US-3333', '15:00')], 'US-1111'), []);
  assert.deepStrictEqual(extra([own('2fer US-1111 US-2222', '15:00'), own('2fer US-1111 US-2222', '15:00')], 'US-1111'), ['US-2222'], 'the same spot from both sources');
});

test('only spots from now: 90 minutes back (as the spot list match), 5 minutes of clock skew ahead', () => {
  const c = '2-fer US-1111, US-2222';
  const ago = (min, comment = c, spotter = 'K1ABC') => ({ spotter, comments: comment, spotTime: new Date(NOW - min * 60000).toISOString().slice(0, 19) });
  assert.deepStrictEqual(extra([ago(89)], 'US-1111'), ['US-2222']);
  assert.deepStrictEqual(extra([ago(91)], 'US-1111'), []);
  assert.deepStrictEqual(extra([ago(-4)], 'US-1111'), ['US-2222'], '4 min ahead: clock skew');
  assert.deepStrictEqual(extra([ago(-6)], 'US-1111'), [], '6 min ahead');
  // The reviewer's two: an n-fer comment 170 min old with a plain spot 5 min ago; one 100 min old with only hunters since.
  assert.deepStrictEqual(extra([ago(170, '2-fer: US-1111 US-2222'), ago(5, 'QSY 20m FT8')], 'US-1111'), []);
  assert.deepStrictEqual(extra([ago(100, '2fer US-1111 US-2222'), ago(2, 'tnx', 'K9XYZ'), ago(1, '2fer US-1111 US-2222', 'W9HUNT')], 'US-1111'), []);
  assert.deepStrictEqual(extra([{ spotter: 'K1ABC', comments: c, spotTime: '2026-11-11T15:00:00' }], 'US-1111'), [], 'yesterday');
  assert.deepStrictEqual(extra([{ spotter: 'K1ABC', comments: c }], 'US-1111'), [], 'no time: not used');
  assert.deepStrictEqual(extra([{ spotter: 'K1ABC', comments: c, spotTime: 'soon' }], 'US-1111'), [], 'unreadable time: not used');
  for (const spotTime of ['2026-11-12T15:00:00Z', '2026-11-12 15:00:00', '2026-11-12T17:00:00+02:00', NOW - 60000]) {
    assert.deepStrictEqual(extra([{ spotter: 'K1ABC', comments: c, spotTime }], 'US-1111'), ['US-2222'], String(spotTime));
  }
  assert.strictEqual(N.MAX_SPOT_AGE_MS, require('../lib/hunted-park').MAX_SPOT_AGE_MS, 'one window for "spotted there now"');
  assert.strictEqual(N.MAX_SPOT_AGE_MS, 90 * 60 * 1000);
});

test('two activations on one day: only this afternoon\'s parks', () => {
  const day = [own('2-fer K-1111 K-2222', '09:00'), own('2-fer K-1111 K-3333', '14:40')];
  assert.deepStrictEqual(extra(day, 'US-1111'), ['US-3333']);
  assert.deepStrictEqual(extra(day.slice(0, 1), 'US-1111'), [], 'the morning spot alone is 6 hours old');
  assert.deepStrictEqual(extra(day, 'US-1111', { now: Date.UTC(2026, 10, 12, 9, 30) }), ['US-2222'], 'at 09:30 the morning\'s; the afternoon has not happened');
});

test('a spot posted at another park says nothing about this one (POTACAT\'s collected buffer has every park)', () => {
  const buf = (reference, comments, hhmm) => ({ _key: 'pota:' + hhmm, callsign: 'W1ABC', reference, spotter: 'W1ABC', comments, source: 'pota', spotTime: at(hhmm) });
  const go = (spots) => N.nferExtraRefs({ call: 'W1ABC', spottedRef: 'US-1111', spots, now: NOW, ...YES });
  // The reviewer's rove: an hour ago at US-2222 "US-2222, US-1111 at 1500z", now at US-1111 "FT8".
  assert.deepStrictEqual(go([buf('US-2222', 'US-2222, US-1111 at 1500z', '14:10'), buf('US-1111', 'FT8', '15:07')]), []);
  assert.deepStrictEqual(go([buf('US-2222', '2-fer: US-2222 US-3333', '13:50'), buf('US-2222', 'US-2222, US-1111', '14:10'), buf('US-1111', 'FT8', '15:07')]), []);
  // Even with nothing newer at US-1111, the other park's spot is not read.
  assert.deepStrictEqual(go([buf('US-2222', '2-fer US-2222 US-1111', '15:00')]), []);
  assert.deepStrictEqual(go([buf('US-2222', 'US-2222, US-1111', '15:00')]), []);
  // At the spotted park (in either form of the prefix) it is.
  assert.deepStrictEqual(go([buf('US-1111', '2-fer US-2222 US-1111', '15:00')]), ['US-2222']);
  assert.deepStrictEqual(go([buf('K-1111', 'US-1111, US-2222 FT8', '15:00')]), ['US-2222']);
  // pota.app's history for call + park carries no reference: every entry is at that park.
  assert.deepStrictEqual(go([own('2fer with US-2222', '15:00', 'W1ABC')]), ['US-2222']);
});

test('hostile entries are skipped, not coerced', () => {
  const spots = [null, 5, 'x', [],
    { spotter: { toString() { return 'K1ABC'; } }, comments: '2fer US-1111 US-2222', spotTime: at('15:00') },
    { spotter: 'K1ABC', comments: ['2fer US-1111 US-2222'], spotTime: at('15:01') },
    { spotter: 'K1ABC', comments: { a: 1 }, spotTime: at('15:02') },
    { spotter: 'K1ABC', comments: '2fer US-1111 US-2222', spotTime: { valueOf() { return NOW; } } },
  ];
  assert.deepStrictEqual(extra(spots, 'US-1111'), []);
  assert.deepStrictEqual(N.nferExtraRefs({ call: {}, spottedRef: 'US-1111', spots, now: NOW }), []);
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'K1ABC', spottedRef: ['US-1111'], spots, now: NOW }), []);
  assert.deepStrictEqual(N.commentRefs(['2fer US-1111 US-2222'], 'US-1111'), []);
  assert.deepStrictEqual(N.commentRefs('2fer US-1111 US-2222', 'not a park'), []);
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

test('an answer that is not a spot history is cut off at 512 kB and never parsed', async () => {
  const big = stubHttps((url, cb) => {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.resume = () => {};
    setImmediate(() => {
      cb(res);
      setImmediate(() => { for (let i = 0; i < 9; i++) res.emit('data', Buffer.alloc(64 * 1024, 0x20)); res.emit('end'); });
    });
  });
  try {
    await assert.rejects(Pota.fetchSpotHistory('K1ABC', 'US-1234'), /over 512 kB/);
    assert.strictEqual(big.seen[0].req.destroyed, true, 'the download is stopped');
  } finally { big.restore(); }
  const ok = stubHttps((url, cb) => answer(cb, 200, Buffer.from(JSON.stringify([{ spotter: 'K1ABC', comments: 'x'.repeat(4000) }]))));
  try { assert.strictEqual((await Pota.fetchSpotHistory('K1ABC', 'US-1234')).length, 1); } finally { ok.restore(); }
  // What the cache keeps from an answer is bounded too.
  const c = new N.NferCache({ fetchHistory: async () => Array.from({ length: 5000 }, (_, i) => ({ spotter: 'K1ABC', reference: 'US-9999', comments: 'c'.repeat(9000), spotTime: at('15:00') })) });
  c.prefetch('K1ABC', 'US-1234');
  await wait(20);
  const kept = c.get('K1ABC', 'US-1234');
  assert.strictEqual(kept.length, 100);
  assert.strictEqual(kept[0].comments.length, 500);
  assert.ok(!('reference' in kept[0]), 'the history asked for call + park is at that park');
});

// ---- away from the shack ---------------------------------------------------

test('remote clients are told: S2C jtcat-qso-logged carries the park text', () => {
  const Proto = require('../lib/echocat-protocol');
  const B = require('../lib/remote-bridge');
  const reg = readSrc(path.join(root, 'lib', 'echocat-protocol.js'));
  assert.ok(/'jtcat-qso-logged': \{ dir: Dir\.S2C, feature: 'jtcat', fields: \{ callsign: f\.string, parksText: f\.optString, parksNote: f\.optString,/.test(reg));
  assert.ok(JSON.stringify(Proto).includes('jtcat-qso-logged') || /jtcat-qso-logged/.test(reg));
  // The shack sends it to every client at the write.
  const server = readSrc(path.join(root, 'lib', 'remote-server.js'));
  assert.ok(/broadcastJtcatQsoLogged\(data\) \{\n\s*if \(this\.hasClient\(\)\) this\._sendToAll\(\{ type: 'jtcat-qso-logged', \.\.\.data \}\);/.test(server));
  const write = fnBody('jtcatWriteLog');
  assert.ok(/if \(jtcatPopoutWin && !jtcatPopoutWin\.isDestroyed\(\)\) jtcatPopoutWin\.webContents\.send\('jtcat-qso-logged', logged\);/.test(write));
  assert.ok(/if \(remoteServer\) remoteServer\.broadcastJtcatQsoLogged\(logged\);/.test(write), 'the same payload as the JTCAT window');
  // A remote JTCAT window (desktop to desktop) shows the same card.
  const d = { callsign: 'DK5UR', parksText: 'at DE-1197 and DE-0941', parksNote: 'DE-0941: from their own spot comment', band: '20m', mode: 'FT8' };
  assert.deepStrictEqual(B.IN['jtcat-qso-logged']({ type: 'jtcat-qso-logged', ...d }), [['jtcat-qso-logged', d]]);
  // ECHOCAT Web: a toast, as text.
  const web = readSrc(path.join(root, 'renderer', 'remote.js'));
  const i = web.indexOf("case 'jtcat-qso-logged': {");
  assert.ok(i > 0);
  const h = web.slice(i, web.indexOf('break;', i));
  assert.ok(/let line = 'Logged ' \+ \(msg\.callsign \|\| ''\);/.test(h));
  assert.ok(/if \(msg\.parksText\) line \+= ' ' \+ msg\.parksText;/.test(h));
  assert.ok(/if \(msg\.parksNote\) line \+= ' \(' \+ msg\.parksNote \+ '\)';/.test(h));
  assert.ok(/showToast\(line, msg\.parksNote \? 6000 : 3000\);/.test(h), 'textContent, and longer when there is a note to read');
  assert.ok(!/innerHTML/.test(h));
  assert.strictEqual(N.loggedLine(d), 'Logged DK5UR at DE-1197 and DE-0941 (DE-0941: from their own spot comment)', 'the wording, in one place for the handoff');
  assert.strictEqual(N.loggedLine({ callsign: 'k1abc', parksText: 'at US-1111' }), 'Logged K1ABC at US-1111');
  assert.strictEqual(N.loggedLine({ callsign: 'K1ABC' }), 'Logged K1ABC');
  assert.ok(readSrc(path.join(root, 'docs', 'echocat-protocol.md')).includes('| `jtcat-qso-logged` | S→C |'), 'in the wire contract');
});

test('the Log QSO review says which parks came from the comment, before Save', () => {
  const { LogReviewQueue, prefillFor } = require('../lib/log-review');
  const q = new LogReviewQueue();
  const record = { callsign: 'DK5UR', frequency: '14074', mode: 'FT8', hunted: [{ sig: 'POTA', ref: 'DE-1197' }, { sig: 'POTA', ref: 'DE-0941' }] };
  q.add(record, { relogKey: 'k', nferNote: N.nferNote(['DE-0941']) });
  const p = prefillFor(q.current, 0);
  assert.strictEqual(p.reference, 'DE-1197,DE-0941', 'both parks in the reference box, to edit');
  assert.strictEqual(p.nferNote, 'DE-0941: from their own spot comment');
  const q2 = new LogReviewQueue();
  q2.add({ ...record, hunted: [{ sig: 'POTA', ref: 'DE-1197' }] }, { relogKey: 'k' });
  assert.strictEqual(prefillFor(q2.current, 0).nferNote, '');
  const lp = readSrc(path.join(root, 'renderer', 'log-popout.js'));
  assert.ok(/\+ \(p\.nferNote \? ' · ' \+ p\.nferNote : ''\);/.test(lp), 'in the review bar, as text');
  assert.ok(/reviewBar\.textContent = reviewText\(p\);/.test(lp));
  assert.ok(/item\.meta\.nferNote = NferRefs\.nferNote\(_nferLogged\.get\(item\.meta\.relogKey\)\);/.test(fnBody('jtcatShowLogReview')), 'main hands the note to the form');
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
  assert.ok(/\.concat\(_potaSpotHistory\.filter\(\(s\) => NferRefs\.baseCall\(s\.callsign\) === theirCall\n\s*&& NferRefs\.canonRef\(s\.reference\) === atPark\)\),/.test(log), 'the collected buffer: their spots AT the spotted park only');
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
