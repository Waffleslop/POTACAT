#!/usr/bin/env node
'use strict';
// An n-fer's other parks, read from the activator's own spot comment (#353):
// which spot decides, what its comment must look like, when pota.app is asked,
// what the external logbook and a remote client are sent. The rule is the
// header of lib/nfer-refs.js; the refused comments are the two reviews' of
// PR #427, and test/fixtures/nfer-real-comments.json is a real pota.app sample.
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

test('rule (a): an n-fer word with a number, exactly that many parks, nothing else but neutral tokens', () => {
  const rows = [
    // comment, spotted park, extra parks logged
    // seen on pota.app, 2026-11-12:
    ['2Fer (DE-0157, DE-0288) - Self-spotted via World Radio League', 'DE-0157', ['DE-0288']],
    ['3-fer: US-4579 US-4576 US-4566', 'US-4579', ['US-4576', 'US-4566']],   // Ham2K PoLo
    ['2-fer: US-7461 US-3762', 'US-7461', ['US-3762']],
    ['3-fer: GB-0553 GB-2874 GB-0151', 'GB-0553', ['GB-2874', 'GB-0151']],
    ['2-fer: US-1611 US-6544', 'US-1611', ['US-6544']],
    ['3-fer DE-1197,DE-0941,DE-0034 FT8', 'DE-1197', ['DE-0941', 'DE-0034']],  // DK5UR, #353
    // shapes
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
    ['2fer US-1111 w/ US-2222', 'US-1111', ['US-2222']],
    ['2fer (US-1111/US-2222)', 'US-1111', ['US-2222']],
    ['2fer [US-1111, US-2222]', 'US-1111', ['US-2222']],
    ['2fer US–1111 US—2222', 'US-1111', ['US-2222']],  // en and em dashes
    ['2fer US-1111 &amp; US-2222', 'US-1111', ['US-2222']],
    ['2fer US-1111 &#38; US-2222', 'US-1111', ['US-2222']],
    ['CQ POTA 2-fer US-1111 US-2222 20m FT8 14.074 73 tnx', 'US-1111', ['US-2222']],
    ['2-fer: US-1111 US-2222 [Ham2K PoLo]', 'US-1111', ['US-2222']],
    ['2fer US-1111 US-2222 - Self spotted via HAMRS Pro.', 'US-1111', ['US-2222']],
    // the spot is AT the spotted park: "2-fer with the other one" counts it
    ['2fer with US-2222', 'US-1111', ['US-2222']],
    ['2-fer w/ US-2222 FT8', 'US-1111', ['US-2222']],
    ['2fer w US-2222', 'US-1111', ['US-2222']],
    ['2-fer: US-2222', 'US-1111', ['US-2222']],
    ['2fer us-2222 [PoLo]', 'US-1111', ['US-2222']],
    ['two-fer US-2222', 'US-1111', ['US-2222']],
  ];
  for (const [comment, spotted, want] of rows) {
    assert.deepStrictEqual(refs(comment, spotted), want, `${comment} @ ${spotted}`);
  }
});

// Third review of PR #427 (2026-11-12): with only a list of words to refuse,
// each of these, in the activator's own spot at US-1111, logged US-2222.
test('rule (a) is an allow-list: any other word, anywhere, means no extra parks', () => {
  for (const comment of [
    'Correction: not a 2fer with US-2222',
    'Correction: this is not a 2-fer with US-2222',
    'NOT 2fer with US-2222',
    'almost a 2fer with US-2222',
    '2fer US-2222 is next', '2fer US-2222 up next', '2fer US-2222 coming up', '2fer US-2222 in 30 min', '2fer US-2222 at 2pm',
    '2fer US-2222 after this', '2fer US-2222?', '2fer US-2222 failed',
    'maybe 2fer US-2222', 'possible 2fer US-2222', 'hoping for 2fer US-2222', 'will be 2fer US-2222', 'going for 2fer US-2222',
    'on the way to a 2fer US-2222', 'driving to the 2fer US-2222', 'en route 2fer US-2222', 'enroute 2fer US-2222',
    'Heading to my 2fer US-2222', '2fer US-2222 if time permits',
    'Completed 2fer US-2222', 'prior 2fer US-2222', 'ex 2fer US-2222', 'left the 2fer US-2222', 'just left 2fer US-2222',
    'coming from 2fer US-2222', 'did 2fer US-2222 this AM', 'activated 2fer US-2222 already', 'previous park was 2fer US-2222',
    'QSYing to 2fer US-2222', "QSY'd from 2fer US-2222",
    'worked K1ABC at his 2fer US-2222', 'K1ABC is 2fer US-2222', 'looking for K1ABC 2fer US-2222 US-3333',
    'TNX K1ABC for park-to-park 2fer US-2222', 'park 2 park 2fer US-2222', "P2P's welcome 2fer US-1111 US-2222", 'S2S 2fer US-2222',
    'TNX 2fer US-2222', 'tnx all 2fer US-2222', '2fer US-2222 hunter K1ABC tnx', 'Thx for the 2fer! US-1111 US-2222',
    'not a 2fer US-1111 US-2222', 'no longer 2fer US-1111 US-2222', "isn't a 2fer US-1111, US-2222",
    'no longer a 2fer with US-2222, only US-1111', 'US-1111 US-2222 is not a 2fer', 'Wish this was a 2fer US-1111 US-2222',
    '2fer US-1111 US-2222 cancelled', '2fer US-1111 US-2222 canceled, US-1111 only',
    '2fer tmrw US-1111 US-2222', '2fer tmw US-1111 US-2222', '2fer tomorrow US-1111 US-2222', 'Tomorrow: 2fer US-1111 US-2222',
    '2fer day US-2222 US-1111', '2nd park of 2fer rove US-2222',
    '2fer at 1800z US-1111 US-2222', '2fer US-1111 US-2222 at 1800z', 'in 1 hr 2fer US-1111 US-2222', '2fer US-1111 US-2222 in 1 hr',
    '2fer US-1111 US-2222 later, US-1111 only now', '2fer US-1111 US-2222 tomorrow, US-3333 today',
    '2fer US-1111 US-2222 tomorrow US-1111 today', '2fer US-1111 US-2222 then US-3333',
    'this morning 2fer with US-2222, now just US-1111', 'QRT. 2fer with US-2222 after lunch',
    // the activator has left: QRT is not neutral
    '2fer US-1111 US-2222 QRT', 'QRT 2fer US-1111 US-2222', 'QRT - 2fer US-1111 US-2222', 'QRT: was 2fer US-1111 US-2222', 'Qrt, 73 2fer US-1111 US-2222',
    'QRT 2Fer (US-1111, US-2222) - Self-spotted via World Radio League',
    // a WWFF or foreign reference in the list refuses the list; it is not skipped before counting
    '2fer US-1111 KFF-1111 US-3333', '3fer US-1111 US-2222 KFF-3333 US-4444', '2fer US-1111 KFF-1111', '2fer US-1111, CA-2222',
    '2-fer US-1111 and DE-0001', '2fer with DE-2222', '2-fer US-1111 FT8-1234',
    // the count
    '2fer US-1111 US-2222 US-3333', '3-fer US-1111 US-2222', '2fer: US-2222 & US-3333', 'US-1111 2fer US-2222 US-3333',
    'US-1111 and 2fer US-2222 US-3333', '2fer US-2222 US-3333',
    // not one list
    '2fer US-1111 14.074 US-2222', '2fer US-1111. US-2222', '2fer US-1111 - US-2222', 'US-1111 2fer, US-2222 next',
    'not US-2222, 2fer US-1111 US-3333', '2fer US-1111 US-2222 next US-3333', '2-fer US-1111 US-2222 (yesterday US-9999)',
    '2fer US-1111 US-2222, next 2fer US-3333 US-4444', '2fer US-1111 US-2222 QSY to US-3333 at 20z',
    // not an n-fer word, or two of them
    '2fer 2fer US-2222', '2fer US-2222 3fer US-3333 US-4444', '3fer US-2222 US-3333 2fer US-4444', '12fer US-2222', '1fer US-2222',
    '2fers US-2222', '2FER.US-2222', '2 fer sure US-1111 US-2222', 'US-1111 US-2222 N fer sure', 'US-1111 US-2222 n-fer',
    'offer US-1111 US-2222', 'transfer US-1111 US-2222', 'conifer US-1111 US-2222', 'refer US-1111 US-2222',
    'double US-1111 US-2222', '2x US-1111 US-2222', '2 x US-1111 US-2222', '2 parks US-1111 US-2222',
    '2fer US-1111 und US-2222',                   // no foreign-language joiners
    // references that are not references
    '2fer US-1111 US-222', '2fer US1111 US2222', '2fer US-01111 US-2222',
    // an app tag is a tag, not a sentence
    '2fer US-2222 [tomorrow]', '2fer US-2222 [not today]', '2fer US-2222 [a b c d e]', '2fer US-2222 [PoLo] [PoLo]',
    'Self-spotted via World Radio League 2fer US-2222 next', '2fer US-2222 - Self-spotted via P2P with K1ABC',
    '2fer US-1111 US-2222 tnx P2P US-3333', '2fer US-1111 US-2222 P2P', 'P2P 2-fer US-1111 US-2222', 'park to park 2fer US-1111 US-2222',
    'TU 2fer US-1111 US-2222', '73 2-fer US-1111 US-2222',
  ]) {
    assert.deepStrictEqual(refs(comment, 'US-1111', YES), [], comment);
  }
});

// Rule (b) of the earlier versions (a bare joined list, confirmed by the
// catalogue) is gone: in 384 real own-spot comments it never once meant an
// n-fer, and "US-1111, US-2222, US-3333" is how a plan is written.
test('no n-fer word, no extra parks: a list of parks may be a plan', () => {
  for (const comment of [
    'US-1111/US-2222',
    'US-1111, US-2222',
    'US-1111, US-2222, US-3333',
    'K-1111 & K-2222',
    'US-1111 + US-2222',
    'US-1111; US-2222',
    'us-1111 and us-2222',
    'US-1111 &amp; US-2222',
    '(US-1111,US-2222)',
    '[US-1111, US-2222]',
    'US-1111,US-2222.',
    'US-1111, US-2222 FT8',
    'US-1111/US-2222 20m FT8 14.074 FN20qr QRV',
    'CQ POTA US-1111, US-2222 14074.5 kHz 73 tnx',
    'US-1111, US-2222 [Ham2K PoLo]',
    'US-1111, US-2222 - Self-spotted via World Radio League',
    'US-1111 with US-2222',
    'US-1111 w/ US-2222',
  ]) {
    assert.deepStrictEqual(refs(comment, 'US-1111', YES), [], comment);
  }
});

test('neutral means neutral: a clock time, a made-up band, a short grid, thanks in front are not', () => {
  const ok = (tail) => refs('2fer US-1111 US-2222 ' + tail, 'US-1111', YES);
  for (const tail of ['FT8', 'CW', 'SSB', 'AM', '20M', '70cm', '14.074', '14074', '14074.5', '7.200 MHz', '7200KHZ', '21.300', '50.313',
    '7074', '3573', 'FN20ab', 'QRV', 'CQ POTA', '73', 'TU 73', 'tnx', 'FT8 20m 14.074 FN20qr 73']) {
    assert.deepStrictEqual(ok(tail), ['US-2222'], tail);
  }
  for (const tail of [
    '18.30',                                        // a time, not a frequency
    '1800', '1830', '1840', '20m 1800',             // four digits that read as a clock time
    '18000',                                        // 18.000 MHz is in no ham band
    '1800z', '18z', '1800utc', '2pm',
    '5M',                                           // not a band
    '20M 15M',                                      // one band label, not two
    'EM12', 'IN23', 'ON12', 'OK12',                 // four-character "grids" are words
    'this AM', '2', '1 of 2', 'RX', 'WX', 'K1ABC', 'S2S', 'W4C/WM-001', 'MA', 'QRT', 'QSY', 'NEXT',
    '\u{1F600}', 'https://x.y', '14.074-14.078', '73 TU P2P', 'KFF-0001',
  ]) {
    assert.deepStrictEqual(ok(tail), [], tail);
  }
  for (const comment of ['TNX 2fer US-1111 US-2222', 'TU 73 2fer US-1111 US-2222', '73 2fer US-1111 US-2222', 'NO73 2fer US-1111 US-2222']) {
    assert.deepStrictEqual(refs(comment, 'US-1111', YES), [], comment + ': thanks in front thank someone');
  }
});

// Fourth review: the app tag was "any bracket, any words after via".
test('an app signature is a known app\'s name and nothing else', () => {
  for (const comment of [
    '2Fer (US-1111, US-2222) - Self-spotted via World Radio League',   // real
    '2fer US-1111 US-2222 Self-spotted via World Radio League',
    '2fer US-1111 US-2222 - Self-spotted via WRL.',
    '2fer US-1111 US-2222 Self-spot via HAMRS Pro',                    // real form of HAMRS
    '2fer US-1111 US-2222 - Self spotted via HAMRS',
    '2fer US-1111 US-2222 Sent via Smart Logger',                      // real
    '2fer US-1111 US-2222 - via Tiles on the Air',                     // real
    '2fer US-1111 US-2222 via POTACAT',                                // real
    '2fer US-1111 US-2222 [Ham2K PoLo]', '2fer US-1111 US-2222 [PoLo]', '2fer US-1111 US-2222 [HAMRS]', '2fer US-1111 US-2222 [PW]',
    '[Ham2K PoLo] 2fer US-1111 US-2222',
    'FT8 14.074 2fer US-1111 US-2222 20M EM12KX 73 [Ham2K PoLo] ',
  ]) {
    assert.deepStrictEqual(refs(comment, 'US-1111', YES), ['US-2222'], comment);
  }
  for (const comment of [
    '2fer US-1111 US-2222 [wrong]', '2fer US-1111 US-2222 [moved]', '2fer US-1111 US-2222 [outside boundary]',
    '2fer US-1111 US-2222 [just one park]', '2fer US-1111 US-2222 [1fer]', '2fer US-1111 US-2222 [2 hours ago]',
    '2fer US-1111 US-2222 [failed]', '2fer US-1111 US-2222 [left]', '2fer US-1111 US-2222 [tomorrow]', '2fer US-1111 US-2222 [i am not there]',
    '2fer US-1111 US-2222 [PoLo wrong]', '2fer US-1111 US-2222 [not PoLo]', '2fer US-1111 US-2222 [PoLo] [PoLo]', '2fer US-1111 US-2222 [PoLo',
    '2fer US-1111 US-2222 Self-spotted via phone wrong park sorry',
    '2fer US-1111 US-2222 Self-spotted via polo second park closed',
    '2fer US-1111 US-2222 Self-spotted via app 1fer',
    '2fer US-1111 US-2222 Self-spotted via World Radio League wrong',
    '2fer US-1111 US-2222 wrong Self-spotted via World Radio League',
    '2fer US-1111 US-2222 Self-spotted via',
    '2fer US-1111 US-2222 Self-spotted',
    '2fer US-1111 US-2222 spotted via World Radio League by mistake',
    'Self-spotted via World Radio League 2fer US-2222 next',
    '2fer US-2222 - Self-spotted via P2P with K1ABC',
    'QRT 2fer US-1111 US-2222 - via Tiles on the Air',
  ]) {
    assert.deepStrictEqual(refs(comment, 'US-1111', YES), [], comment);
  }
  assert.deepStrictEqual([...N.APP_NAMES].sort(), ['HAM2K POLO', 'HAM2K PORTABLE LOGGER', 'HAMRS', 'HAMRS PRO', 'POLO', 'POTACAT', 'PW',
    'SMART LOGGER', 'TILES ON THE AIR', 'WORLD RADIO LEAGUE', 'WRL'], 'the whole list; adding a name is a decision');
});

// Fourth review: "-", "!", ":" and "(" were neutral anywhere.
test('punctuation is neutral only where real comments have it', () => {
  for (const comment of [
    '2-fer: US-1111 US-2222',                       // a colon right after the n-fer word
    '2fer (US-1111, US-2222)', '2fer [US-1111/US-2222]', '2FER (US-2222)',   // round the list
    'US-1111 (2fer US-2222)', 'US-1111, 2fer with US-2222', 'US-1111 2fer: US-2222',
    '2fer US-1111, US-2222', '2fer US-1111 + US-2222', '2fer US-1111 & US-2222', '2fer US-1111; US-2222', '2fer US-1111, and US-2222',
    '2fer US-1111 US-2222.',                        // one final full stop
    '2fer US-1111 US-2222 - Self-spotted via World Radio League',   // " - " before the app's tail
    '2fer w/ US-2222', '2fer: w/ US-2222',
  ]) {
    assert.deepStrictEqual(refs(comment, 'US-1111', YES), ['US-2222'], comment);
  }
  for (const comment of [
    '!2fer US-1111 US-2222', '2fer US-1111 US-2222!', '2fer! US-1111 US-2222', '2fer US-1111 US-2222 73!',
    '2fer US-1111 US-2222 :(', '2fer US-1111 US-2222 :-(', '2fer US-1111 US-2222 ;)', '2fer US-1111 US-2222 :',
    '-2fer US-1111 US-2222', '2fer US-1111 US-2222 -', '2fer - US-1111 US-2222', '- 2fer US-1111 US-2222',
    '2fer, US-1111 US-2222', '2fer US-1111 US-2222,', ', 2fer US-1111 US-2222', '2fer US-1111 US-2222 / FT8',
    '(2fer US-1111 US-2222', '2fer US-1111 US-2222)', '2fer (US-1111 US-2222', '2fer US-1111) US-2222', '2fer ((US-1111 US-2222))',
    '2fer [US-1111 US-2222', '2fer US-1111 US-2222]', 'US-1111 (2fer US-2222', 'US-1111 2fer ( US-2222', 'US-1111 2fer [ US-2222',
    '2fer US-1111 ,, US-2222', '2fer US-1111 , , US-2222', '2fer US-1111 + + US-2222', '2fer US-1111 & & US-2222', '2fer US-1111 ;; US-2222',
    '2fer US-1111 // US-2222', '2fer US-1111 and and US-2222', '2fer US-1111 and, US-2222',
    'US-1111 2fer :, US-2222', 'US-1111 2fer ,: US-2222', 'US-1111 2fer :( US-2222', 'US-1111 2fer ;( US-2222',
    '2fer US-1111 US-2222 .. .', '2fer. US-1111 US-2222', '2fer US-1111 US-2222 ?', '2fer US-1111 US-2222 *', '2fer US-1111 US-2222 #1',
    '2fer US-1111 US-2222 "not"', "2fer US-1111 US-2222 'maybe'",
    // and without the n-fer word they were plain lists anyway
    '-US-2222, US-1111', '!US-2222, US-1111', 'US-1111, US-2222 :-(',
  ]) {
    assert.deepStrictEqual(refs(comment, 'US-1111', YES), [], comment);
  }
});

test('the n-fer word and a park number are exact', () => {
  for (const comment of ['02fer US-2222', '002fer US-2222', '1fer US-2222', '11fer US-2222', '0fer US-2222', '2.fer US-2222', '2ferr US-2222', 'x2fer US-2222']) {
    assert.deepStrictEqual(refs(comment, 'US-1111', YES), [], comment);
  }
  // 4 digits, or 5 not starting with 0: "US-02222" is a typo, with or without a catalogue.
  for (const comment of ['2fer US-02222', '2fer US-1111 US-02222', '2fer US-222', '2fer US-222222', '2fer US-2222a', '2fer US-22-22']) {
    assert.deepStrictEqual(refs(comment), [], comment + ' (no catalogue)');
    assert.deepStrictEqual(refs(comment, 'US-1111', YES), [], comment);
  }
  assert.deepStrictEqual(refs('2fer US-22223'), ['US-22223']);
  assert.deepStrictEqual(refs('2fer US-1111 US-0222'), ['US-0222']);
  assert.deepStrictEqual(refs('10-fer US-1111 US-1112 US-1113 US-1114 US-1115 US-1116 US-1117 US-1118 US-1119 US-1120').length, 9);
});

// Every one of these logged a park the contact was not at (second review of
// PR #427, 2026-11-12). Refused even when the catalogue knows every park.
test('the second review\'s false positives: every one adds nothing', () => {
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
    'US-1111, US-2222 hunters tnx',
    'tnx for the P2Ps! US-1111, US-2222',
    'heading to US-1111, US-2222',
    'US-1111 / CA-2222',
    // the rest of that list
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
    'US-1111, US-2222 FT8 US-3333',                // a park outside the list
    'also US-2222', 'US-1111 also US-2222',
    'US-1111 und US-2222', 'US-1111 y US-2222', 'US-1111 と US-2222', 'US-1111、US-2222',
    'K-1111 KFF-1111 FT8',                         // the common US self-spot
    'QSY 20m FT8', 'FT8', '',
  ]) {
    assert.deepStrictEqual(refs(comment, 'US-1111', YES), [], comment);
  }
});

test('WWFF is refused whatever its prefix length: KFF-, GFF-, IFF-, FFF-, DLFF-', () => {
  for (const ff of ['KFF-1234', 'GFF-0012', 'IFF-0345', 'FFF-0456', 'DLFF-0123', 'VKFF-1234']) {
    assert.deepStrictEqual(refs(`2-fer US-1234, ${ff}`, 'US-1234', YES), [], ff);
    assert.deepStrictEqual(refs(`US-1234, ${ff}`, 'US-1234', YES), [], ff + ' in a plain list');
    assert.deepStrictEqual(refs(`2-fer US-1234, ${ff}, US-5678`, 'US-1234', YES), [], ff + ' between two parks: the list is not believed');
    assert.deepStrictEqual(refs(`3-fer US-1234, ${ff}, US-5678`, 'US-1234', YES), [], ff + ' counted as the third');
  }
  assert.deepStrictEqual(refs('2-fer KFF-1234 KFF-5678', 'KFF-1234', YES), [], 'a WWFF spot never starts a POTA n-fer');
});

test('the parks catalogue: a park it denies sinks the list; when it is not loaded the other checks stand', () => {
  const knows = (list) => (ref) => list.includes(ref);
  assert.deepStrictEqual(refs('2-fer US-1111 US-2222'), ['US-2222'], 'no catalogue at all');
  assert.deepStrictEqual(refs('2-fer US-1111 US-2222', 'US-1111', { parkKnown: () => null }), ['US-2222'], 'that country\'s list is not loaded');
  assert.deepStrictEqual(refs('2-fer US-1111 US-2222', 'US-1111', { parkKnown: () => undefined }), ['US-2222']);
  assert.deepStrictEqual(refs('2-fer US-1111 US-2222', 'US-1111', { parkKnown: () => false }), [], 'loaded, and it is no park');
  assert.deepStrictEqual(refs('2-fer US-1111 US-2222', 'US-1111', { parkKnown: knows(['US-2222']) }), ['US-2222']);
  assert.deepStrictEqual(refs('3-fer US-1111, US-2222, US-9999', 'US-1111', { parkKnown: knows(['US-1111', 'US-2222']) }), [], 'US-9999 is no park: the comment is not believed');
  assert.deepStrictEqual(refs('2-fer K-1111 K-2222', 'US-1111', { parkKnown: knows(['US-2222']) }), ['US-2222'], 'asked in the catalogue\'s own form');
  // a catalogue that throws is a catalogue that did not answer
  assert.deepStrictEqual(refs('2-fer US-1111 US-2222', 'US-1111', { parkKnown: () => { throw new Error('x'); } }), ['US-2222']);
});

test('list sizes: an n-fer adds at most nine parks', () => {
  const list = (n) => Array.from({ length: n }, (_, i) => 'US-' + String(1111 + i)).join(',');
  assert.strictEqual(refs('10-fer ' + list(10), 'US-1111', YES).length, 9);
  assert.deepStrictEqual(refs('10-fer ' + list(11), 'US-1111', YES), []);
  assert.deepStrictEqual(refs('11-fer ' + list(11), 'US-1111', YES), []);
  assert.deepStrictEqual(refs(list(4), 'US-1111', YES), [], 'and a list with no n-fer word adds none');
});

test('a comment over 500 characters is not read: a cut could hide a word or shorten a reference', () => {
  const pad = (n) => ('CQ '.repeat(Math.floor(n / 3)) + ' '.repeat(n % 3)); // n characters of something neutral
  // US-22223 cut to US-2222 at the limit: the first version logged US-2222.
  for (const n of [470, 478, 479, 480, 481, 482, 483, 484, 485]) {
    const c = pad(n) + ' 2fer US-1111 US-22223';
    const got = refs(c, 'US-1111', YES);
    assert.ok(got.length === 0 || (c.length <= 500 && got[0] === 'US-22223'), `pad ${n}: ${JSON.stringify(got)}`);
    assert.ok(!got.includes('US-2222'), 'never the shortened park, pad ' + n);
  }
  assert.deepStrictEqual(refs(pad(478) + ' 2fer US-1111 US-22223', 'US-1111', YES), ['US-22223'], '500 characters exactly is read whole');
  assert.deepStrictEqual(refs(pad(479) + ' 2fer US-1111 US-22223', 'US-1111', YES), []);
  // A trailing word past the limit is not neutral just because it was not seen.
  assert.deepStrictEqual(refs('2fer US-1111 US-2222' + ' '.repeat(481) + 'NEXT', 'US-1111', YES), []);
  assert.deepStrictEqual(refs('2fer US-1111 US-2222 ' + pad(480) + ' later', 'US-1111', YES), []);
  assert.deepStrictEqual(refs('2fer US-1111 US-2222' + ' '.repeat(600), 'US-1111', YES), ['US-2222'], 'trailing blanks are nothing');
  // ... and through the spot path, where the comment is trimmed and kept one character past the limit.
  const long = '2fer US-1111 US-2222' + ' '.repeat(481) + 'NEXT';
  assert.deepStrictEqual(extra([own(long)], 'US-1111'), []);
  assert.deepStrictEqual(extra([own('x'.repeat(100000))], 'US-1111'), []);
  assert.strictEqual(N.selfSpots([own('x'.repeat(100000))], 'K1ABC')[0].comments.length, 501, 'too long stays too long');
  assert.strictEqual(N.MAX_COMMENT, 500);
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
    '('.repeat(K), ' '.repeat(K), '&AMP;'.repeat(K / 5), '['.repeat(K), 'SELF-SPOTTED VIA '.repeat(K / 20),
    ('US-1111,US-2222 AND ').repeat(25).slice(0, 500), ('2FER ' + 'US-1111 US-2222 '.repeat(31)).slice(0, 500),
    '[ ' + 'A '.repeat(240) + ']', 'US-1111' + ' W'.repeat(240),
  ];
  N.commentRefs('2-fer US-1111 US-2222', 'US-1111'); // warm up
  for (const c of hostile) {
    const t0 = process.hrtime.bigint();
    N.commentRefs(c, 'US-1111', YES);
    N.nferExtraRefs({ call: 'K1ABC', spottedRef: 'US-1111', spots: [{ spotter: 'K1ABC', comments: c, spotTime: at('15:00') }], now: NOW, ...YES });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 50, `${ms.toFixed(1)} ms for ${c.slice(0, 12)}... (${c.length} chars)`);
  }
  const t0 = process.hrtime.bigint();
  N.nferExtraRefs({ call: 'K1ABC', spottedRef: 'US-1111', now: NOW, spots: Array.from({ length: 100 }, () => ({ spotter: 'K1ABC/' + 'A/'.repeat(50000), comments: 'x'.repeat(100000), spotTime: '2'.repeat(100000) })) });
  N.baseCall('A1A/'.repeat(25000));
  N.canonRef('A'.repeat(100000) + '-1234');
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 50, 'huge spotter, time and reference strings are not walked');
});

// The activator's own spot comments (and the other spotters' that name a park
// or say "fer") from four pota.app samples of 2026-11-12: comment
// text, park, own spot or not, and what the comment adds. Public spots.
test('real pota.app comments: only the plain n-fer forms add parks, and only from an own spot', () => {
  const rows = JSON.parse(readSrc(path.join(__dirname, 'fixtures', 'nfer-real-comments.json')));
  assert.ok(rows.length > 150 && rows.filter((r) => r.own).length > 100, 'the sample is there');
  const adds = [];
  for (const r of rows) {
    assert.deepStrictEqual(N.commentRefs(r.comment, r.park, YES), r.extra, `${r.park}: ${r.comment}`);
    const got = N.nferExtraRefs({ call: 'K1ABC', spottedRef: r.park, now: NOW, ...YES,
      spots: [{ spotter: r.own ? 'K1ABC' : 'W9XYZ', comments: r.comment, spotTime: at('15:00') }] });
    assert.deepStrictEqual(got, r.own ? r.extra : [], `${r.own ? 'own' : 'another spotter\'s'} spot at ${r.park}: ${r.comment}`);
    if (got.length) adds.push(r.comment);
  }
  assert.deepStrictEqual([...new Set(adds)].sort(), [
    '2-fer: CA-0076 CA-5288',                                           // VY2MG
    '2-fer: PT-0051 PT-0054',                                           // CS7BHA/P, spotted at PT-0054
    '2-fer: US-7461 US-3762',                                           // N4NN
    '2Fer (DE-0157, DE-0288) - Self-spotted via World Radio League',    // DL/NT6B
    '3-fer: GB-0553 GB-2874 GB-0151',                                   // M7VDS
    '3-fer: US-3544 US-4566 US-4578',                                   // N6FMD
    '3-fer: US-4579 US-4576 US-4566',                                   // K0RDY
  ]);
  const byComment = (c) => rows.find((r) => r.comment === c);
  assert.deepStrictEqual(byComment('QRT 2Fer (DE-0157, DE-0288) - Self-spotted via World Radio League').extra, [], 'QRT: they have left');
  assert.deepStrictEqual(byComment('3fer 4579,4576,4566').extra, [], 'numbers alone are not references');
  assert.strictEqual(byComment('3-fer: US-1586 US-10775 US-4581').own, false, 'a hunter repeating the n-fer is not the activator');
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
    ['W1ABC', 'W1ABCD', false],
    ['W1ABC', 'W1ABC-#', false],       // RBN
    ['W1ABC', 'W1ABC-7', false],
    ['W1ABC', '', false],
    ['', '', false],
    ['W1ABC/P', 'W1ABC', true],
    ['W1ABC', 'W1ABC/7', true],
    ['VE3/W1ABC', 'W1ABC', true],
    ['KH6/K1A', 'K1A', true],
    ['K1A/KH6', 'K1A', true],
  ]) {
    assert.deepStrictEqual(by(a, s), same ? ['US-2222'] : [], `${a} spotted by ${s}`);
    assert.strictEqual(N.baseCall(a), JtcatParser.baseCall(a), 'one definition: ' + a);
  }
  assert.ok(/return typeof call === 'string' && call\.length <= 40 \? JtcatParser\.baseCall\(call\) : '';/.test(readSrc(path.join(root, 'lib', 'nfer-refs.js'))));
});

test('the newest of their own spots decides alone', () => {
  // A newer plain spot after leaving the second park: nothing, whatever the older one said.
  assert.deepStrictEqual(extra([own('2-fer: US-1111 US-2222', '14:00'), own('QSY 20m FT8', '15:05')], 'US-1111'), []);
  assert.deepStrictEqual(extra([own('QSY 20m FT8', '15:05'), own('2-fer: US-1111 US-2222', '14:00')], 'US-1111'), [], 'whatever the order they arrive in');
  assert.deepStrictEqual(extra([own('2-fer: US-1111 US-2222', '14:00'), own('US-1111 40m FT8', '14:30')], 'US-1111'), []);
  assert.deepStrictEqual(extra([own('2-fer: US-1111 US-2222', '14:00'), own('', '14:30')], 'US-1111'), []);
  assert.deepStrictEqual(extra([own('2-fer: US-1111 US-2222', '14:00'), { spotter: 'K1ABC', comments: null, spotTime: at('14:30') }], 'US-1111'), []);
  assert.deepStrictEqual(extra([own('3-fer: US-4579 US-4576 US-4566', '14:59'), own('now US-4579 only', '15:02')], 'US-4579'), []);
  // Both are n-fers: the newest one's parks, never both.
  assert.deepStrictEqual(extra([own('2-fer US-1111, US-2222', '14:00'), own('2-fer US-1111, US-3333', '14:30')], 'US-1111'), ['US-3333']);
  assert.deepStrictEqual(extra([own('2-fer US-1111, US-3333', '14:30'), own('2-fer US-1111, US-2222', '14:00')], 'US-1111'), ['US-3333']);
  // Hunters' and skimmers' spots in between change nothing: they are not the activator's.
  assert.deepStrictEqual(extra([own('2-fer US-1111 US-2222', '14:40'), own('2-fer US-1111 US-9999', '15:08', 'K9XYZ'), own('20 dB 22 WPM CQ', '15:09', 'KM3T-#')], 'US-1111'), ['US-2222']);
  // Same instant, different lists: no answer.
  assert.deepStrictEqual(extra([own('2fer US-1111 US-2222', '15:00'), own('2fer US-1111 US-3333', '15:00')], 'US-1111'), []);
  assert.deepStrictEqual(extra([own('2fer US-1111 US-2222', '15:00'), own('QRT', '15:00')], 'US-1111'), []);
  assert.deepStrictEqual(extra([{ spotter: 'K1ABC', comments: '2fer US-1111 US-2222', spotTime: at('15:00') + 'Z' }, own('QRT', '15:00')], 'US-1111'), [], 'the same instant written two ways');
  assert.deepStrictEqual(extra([own('2fer US-1111 US-2222', '15:00'), own('2fer US-1111 US-2222', '15:00')], 'US-1111'), ['US-2222'], 'the same spot twice');
});

test('a spot whose time cannot be read might be the newest: nothing is added', () => {
  const nfer = own('2fer US-1111 US-2222', '14:30');
  for (const spotTime of ['', undefined, null, 'a moment ago', 'soon', '17:50', '1750', '2026', '2026-11-12', '11/12/2026 15:00',
    'Thu, 12 Nov 2026 15:00:00 GMT', String(NOW - 60000), NaN, Infinity, -5, {}, [], true, '2'.repeat(100000)]) {
    assert.deepStrictEqual(extra([nfer, { spotter: 'K1ABC', comments: 'QRT moved', spotTime }], 'US-1111'), [], 'newer spot with time ' + String(spotTime).slice(0, 30));
    assert.deepStrictEqual(extra([{ spotter: 'K1ABC', comments: '2fer US-1111 US-2222', spotTime }], 'US-1111'), [], 'an n-fer with time ' + String(spotTime).slice(0, 30));
  }
  // Another spotter's unreadable time is nobody's business.
  assert.deepStrictEqual(extra([nfer, { spotter: 'W9XYZ', comments: 'QRT', spotTime: '' }], 'US-1111'), ['US-2222']);
  // Times that ARE plain: pota.app's own form, with a zone, with a space, epoch seconds and milliseconds.
  for (const spotTime of [at('15:00'), '2026-11-12T15:00:00Z', '2026-11-12T15:00:00.250Z', '2026-11-12 15:00:00', '2026-11-12T17:00:00+02:00', NOW - 60000, Math.floor(NOW / 1000) - 60]) {
    assert.deepStrictEqual(extra([{ spotter: 'K1ABC', comments: '2fer US-1111 US-2222', spotTime }], 'US-1111'), ['US-2222'], String(spotTime));
  }
});

// Fourth review: with the PC clock 10 to 60 minutes slow, the newer "now only
// US-1111" looked like a spot from the future, was skipped, and the 70-minute-old
// 2-fer decided.
test('a spot from the future means our clock is wrong: nothing is added', () => {
  const real = Date.UTC(2026, 10, 12, 18, 0, 0);
  const isoAgo = (min) => new Date(real - min * 60000).toISOString().slice(0, 19);
  const spots = [{ spotter: 'K1ABC', comments: '2fer US-1111 US-2222', spotTime: isoAgo(70) }, { spotter: 'K1ABC', comments: 'now only US-1111', spotTime: isoAgo(3) }];
  for (const slow of [0, 4, 6, 10, 30, 60, 89, 120]) {
    assert.deepStrictEqual(N.nferExtraRefs({ call: 'K1ABC', spottedRef: 'US-1111', now: real - slow * 60000, spots }), [], `PC ${slow} min slow`);
  }
  // The newer spot seen only in the collected spots, at another park.
  for (const slow of [6, 10, 60]) {
    assert.deepStrictEqual(N.nferExtraRefs({ call: 'K1ABC', spottedRef: 'US-1111', now: real - slow * 60000, spots: spots.slice(0, 1),
      buffer: [{ callsign: 'K1ABC', reference: 'US-3333', spotter: 'K1ABC', comments: 'here now', spotTime: isoAgo(3) }] }), [], `PC ${slow} min slow, moved`);
  }
  // A future-dated spot of theirs refuses even when it is the n-fer itself, or sits at another park, or says nothing.
  const two = { spotter: 'K1ABC', comments: '2fer US-1111 US-2222', spotTime: isoAgo(20) };
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'K1ABC', spottedRef: 'US-1111', now: real, spots: [two] }), ['US-2222']);
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'K1ABC', spottedRef: 'US-1111', now: real, spots: [two, { spotter: 'K1ABC', comments: 'single park now', spotTime: isoAgo(-10) }] }), []);
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'K1ABC', spottedRef: 'US-1111', now: real, spots: [two, { spotter: 'K1ABC', comments: '', spotTime: isoAgo(-6) }] }), []);
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'K1ABC', spottedRef: 'US-1111', now: real, spots: [two],
    buffer: [{ callsign: 'K1ABC', reference: 'US-3333', spotter: 'K1ABC', comments: '', spotTime: isoAgo(-10) }] }), []);
  // Within the 5 minutes of skew a newer spot is simply the newest.
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'K1ABC', spottedRef: 'US-1111', now: real, spots: [two, { spotter: 'K1ABC', comments: 'single park now', spotTime: isoAgo(-4) }] }), []);
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'K1ABC', spottedRef: 'US-1111', now: real, spots: [{ ...two, spotTime: isoAgo(-4) }] }), ['US-2222']);
  // Somebody else's future-dated spot is not our business.
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'K1ABC', spottedRef: 'US-1111', now: real, spots: [two, { spotter: 'W9XYZ', comments: 'x', spotTime: isoAgo(-30) }] }), ['US-2222']);
  // A fast PC clock only makes spots look older: a 3-minute-old 2-fer still reads as theirs, until it looks over 90 minutes old.
  for (const fast of [10, 30, 60, 85]) assert.deepStrictEqual(N.nferExtraRefs({ call: 'K1ABC', spottedRef: 'US-1111', now: real + fast * 60000, spots: [{ ...two, spotTime: isoAgo(3) }] }), ['US-2222']);
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'K1ABC', spottedRef: 'US-1111', now: real + 95 * 60000, spots: [{ ...two, spotTime: isoAgo(3) }] }), []);
});

test('a time that cannot be true is a time that cannot be read', () => {
  const two = own('2fer US-1111 US-2222', '14:50');
  for (const spotTime of [5, 1, 1577836799, 1577836799000, 99999999999, 100000000000, 4102444800000, '2019-12-31T23:59:59', '1970-01-01T00:00:00',
    '0000-00-00T00:00:00', '2026-13-45T99:99:99', '2099-01-01T00:00:00']) {
    assert.deepStrictEqual(extra([two, { spotter: 'K1ABC', comments: 'single park now', spotTime }], 'US-1111'), [], 'a newer denial timed ' + spotTime);
    assert.deepStrictEqual(extra([{ spotter: 'K1ABC', comments: '2fer US-1111 US-2222', spotTime }], 'US-1111'), [], 'an n-fer timed ' + spotTime);
    assert.deepStrictEqual(N.nferExtraRefs({ call: 'K1ABC', spottedRef: 'US-1111', now: NOW, spots: [two],
      buffer: [{ callsign: 'K1ABC', reference: 'US-3333', spotter: 'K1ABC', comments: 'moved', spotTime }] }), [], 'a collected spot at another park timed ' + spotTime);
  }
  assert.deepStrictEqual(extra([two], 'US-1111'), ['US-2222']);
  // An OLD spot with a sound time is just old.
  assert.deepStrictEqual(extra([two, own('QRT', '09:00'), { spotter: 'K1ABC', comments: 'x', spotTime: '2026-11-01T10:00:00' }], 'US-1111'), ['US-2222']);
});

test('only spots from now: 90 minutes back (as the spot list match), 5 minutes of clock skew ahead', () => {
  const c = '2-fer US-1111, US-2222';
  const ago = (min, comment = c, spotter = 'K1ABC') => ({ spotter, comments: comment, spotTime: new Date(NOW - min * 60000).toISOString().slice(0, 19) });
  assert.deepStrictEqual(extra([ago(89)], 'US-1111'), ['US-2222']);
  assert.deepStrictEqual(extra([ago(91)], 'US-1111'), []);
  assert.deepStrictEqual(extra([ago(-4)], 'US-1111'), ['US-2222'], '4 min ahead: clock skew');
  assert.deepStrictEqual(extra([ago(-6)], 'US-1111'), [], '6 min ahead');
  // The second review's two: an n-fer comment 170 min old with a plain spot 5 min ago; one 100 min old with only hunters since.
  assert.deepStrictEqual(extra([ago(170, '2-fer: US-1111 US-2222'), ago(5, 'QSY 20m FT8')], 'US-1111'), []);
  assert.deepStrictEqual(extra([ago(100, '2fer US-1111 US-2222'), ago(2, 'tnx', 'K9XYZ'), ago(1, '2fer US-1111 US-2222', 'W9HUNT')], 'US-1111'), []);
  assert.deepStrictEqual(extra([{ spotter: 'K1ABC', comments: c, spotTime: '2026-11-11T15:00:00' }], 'US-1111'), [], 'yesterday');
  assert.strictEqual(N.MAX_SPOT_AGE_MS, require('../lib/hunted-park').MAX_SPOT_AGE_MS, 'one window for "spotted there now"');
  assert.strictEqual(N.MAX_SPOT_AGE_MS, 90 * 60 * 1000);
});

test('two activations on one day: only this afternoon\'s parks', () => {
  const day = [own('2-fer K-1111 K-2222', '09:00'), own('2-fer K-1111 K-3333', '14:40')];
  assert.deepStrictEqual(extra(day, 'US-1111'), ['US-3333']);
  assert.deepStrictEqual(extra(day.slice(0, 1), 'US-1111'), [], 'the morning spot alone is 6 hours old');
  assert.deepStrictEqual(extra(day.slice(0, 1), 'US-1111', { now: Date.UTC(2026, 10, 12, 9, 30) }), ['US-2222'], 'at 09:30 it was the morning\'s');
});

// POTACAT's collected spots hold every park the activator was spotted at, and
// one row per activator per poll. They are handed in as `buffer`.
const buf = (reference, comments, hhmm, spotter = 'W1ABC') => ({ _key: 'pota:' + hhmm + reference, callsign: 'W1ABC', reference, spotter, comments, source: 'pota', spotTime: at(hhmm) });
const go = (spots, buffer) => N.nferExtraRefs({ call: 'W1ABC', spottedRef: 'US-1111', spots, buffer, now: NOW, ...YES });

test('no fresh pota.app history: nothing is added, whatever the collected spots say', () => {
  const nfer = buf('US-1111', '2-fer US-1111 US-2222', '15:00');
  for (const none of [null, undefined, false, 'x', {}]) {
    assert.deepStrictEqual(go(none, [nfer]), [], 'history: ' + JSON.stringify(none));
  }
  assert.deepStrictEqual(go([], [nfer]), [], 'a history with none of their spots: the collected one is not enough');
  // The third review's case: the collected spots have the 3-fer and a skimmer's
  // spot after it; the activator's own "now US-4579 only" was never polled.
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'K0RDY', spottedRef: 'US-4579', now: NOW, ...YES, spots: null, buffer: [
    { callsign: 'K0RDY', reference: 'US-4579', spotter: 'K0RDY', comments: '3-fer: US-4579 US-4576 US-4566', spotTime: at('14:59') },
    { callsign: 'K0RDY', reference: 'US-4579', spotter: 'W3LPL-#', comments: '18 dB 20 WPM CQ', spotTime: at('15:03') }] }), []);
  // With the history it is the history's newest own spot that decides.
  assert.deepStrictEqual(go([own('2-fer US-1111 US-2222', '15:00', 'W1ABC')], []), ['US-2222']);
  assert.deepStrictEqual(go([own('2-fer US-1111 US-2222', '15:00', 'W1ABC')], [nfer]), ['US-2222'], 'the same spot from both');
});

test('the collected spots only ever take parks away', () => {
  const history = [own('2-fer US-1111 US-2222', '14:50', 'W1ABC')];
  // A newer own spot seen only in the collected spots still decides: plain, so nothing.
  assert.deepStrictEqual(go(history, [buf('US-1111', 'QSY 40m', '15:05')]), []);
  // Even when that newer collected spot is itself an n-fer, it adds nothing: it was not in the history.
  assert.deepStrictEqual(go(history, [buf('US-1111', '2-fer US-1111 US-3333', '15:05')]), []);
  assert.deepStrictEqual(go([own('FT8', '14:50', 'W1ABC')], [buf('US-1111', '2-fer US-1111 US-3333', '15:05')]), []);
  // Older collected spots, other people's collected spots: the history's newest stands.
  assert.deepStrictEqual(go(history, [buf('US-1111', 'QSY 40m', '14:40'), buf('US-1111', 'QRT', '15:05', 'K9XYZ')]), ['US-2222']);
  // A collected own spot with no readable time at this park: nothing.
  assert.deepStrictEqual(go(history, [{ callsign: 'W1ABC', reference: 'US-1111', spotter: 'W1ABC', comments: 'QRT', spotTime: '' }]), []);
});

test('their newest spot is at ANOTHER park: they have moved, nothing is added', () => {
  const history = [own('2-fer US-1111 US-2222', '14:30', 'W1ABC')];
  assert.deepStrictEqual(go(history, [buf('US-3333', 'now here', '15:05')]), []);
  assert.deepStrictEqual(go(history, [buf('US-3333', '', '15:05')]), []);
  assert.deepStrictEqual(go(history, [buf('US-2222', '2-fer US-2222 US-1111', '15:05')]), [], 'even naming this park: it was posted there');
  assert.deepStrictEqual(go(history, [buf('US-3333', 'now here', '14:30')]), [], 'the same instant at two parks');
  // Older spots elsewhere, and other people's spots of them elsewhere, change nothing.
  assert.deepStrictEqual(go(history, [buf('US-3333', 'first park', '13:50'), buf('US-3333', 'he moved', '15:05', 'K9XYZ')]), ['US-2222']);
  // A spot at another park never supplies parks for this one (the second review's rove).
  assert.deepStrictEqual(go([own('FT8', '15:07', 'W1ABC')], [buf('US-2222', 'US-2222, US-1111 at 1500z', '14:10')]), []);
  assert.deepStrictEqual(go([], [buf('US-2222', '2-fer US-2222 US-1111', '15:00')]), []);
  // The old and the new form of the US prefix are one park.
  assert.deepStrictEqual(go(history, [buf('K-1111', '2-fer US-1111 US-2222', '14:30')]), ['US-2222']);
  // An unreadable time on their spot at another park: it might be the newest, so nothing.
  assert.deepStrictEqual(go(history, [{ callsign: 'W1ABC', reference: 'US-3333', spotter: 'W1ABC', comments: 'x', spotTime: '' }]), []);
  assert.deepStrictEqual(go(history, [{ callsign: 'W1ABC', reference: 'US-3333', spotter: 'W1ABC', comments: 'x', spotTime: 5 }]), []);
});

test('hostile entries are skipped, not coerced', () => {
  const spots = [null, 5, 'x', [],
    { spotter: { toString() { return 'K1ABC'; } }, comments: '2fer US-1111 US-2222', spotTime: at('15:00') },
    { spotter: 'K1ABC', comments: ['2fer US-1111 US-2222'], spotTime: at('15:01') },
    { spotter: 'K1ABC', comments: { a: 1 }, spotTime: at('15:02') },
  ];
  assert.deepStrictEqual(extra(spots, 'US-1111'), []);
  assert.deepStrictEqual(N.nferExtraRefs({ call: {}, spottedRef: 'US-1111', spots, now: NOW }), []);
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'K1ABC', spottedRef: ['US-1111'], spots, now: NOW }), []);
  assert.deepStrictEqual(N.nferExtraRefs({ call: 'K1ABC', spottedRef: 'W4C/WM-001', spots: [own('2fer US-1111 US-2222')], now: NOW }), []);
  assert.deepStrictEqual(N.commentRefs(['2fer US-1111 US-2222'], 'US-1111'), []);
  assert.deepStrictEqual(N.commentRefs('2fer US-1111 US-2222', 'not a park'), []);
});

test('parks the spot list already matched are not repeated', () => {
  const spots = [own('3-fer US-1234, US-5678, US-0001')];
  assert.deepStrictEqual(extra(spots, 'US-1234', { known: ['US-1234', 'US-5678'] }), ['US-0001']);
  assert.deepStrictEqual(extra(spots, 'US-1234', { known: ['US-1234', 'K-5678', 'us-0001'] }), []);
  assert.deepStrictEqual(N.nferExtraRefs(), [], 'nothing in, nothing out');
});

// ---- the cache: only a fresh history ----------------------------------------

test('cache: one fetch per activator and park per 2 minutes, never waited on', async () => {
  let t = 1000000, calls = 0;
  const history = [own('2-fer US-1234, US-5678', '14:50'), own('2-fer US-1234, US-0009', '14:55', 'W9XYZ')];
  const c = new N.NferCache({ now: () => t, fetchHistory: async () => { calls++; return history; } });
  assert.strictEqual(c.fresh('K1ABC', 'US-1234'), null, 'never fetched: no history');
  assert.strictEqual(c.prefetch('K1ABC', 'US-1234'), undefined, 'nothing to await');
  assert.strictEqual(c.fresh('K1ABC', 'US-1234'), null, 'pending: no history yet');
  c.prefetch('K1ABC', 'US-1234');
  await wait(10);
  c.prefetch('K1ABC/P', 'K-1234');
  await wait(5);
  assert.strictEqual(calls, 1, 'one key for the call and the park, however they are written');
  const got = c.fresh('K1ABC', 'US-1234');
  assert.deepStrictEqual(got, [{ spotter: 'K1ABC', comments: '2-fer US-1234, US-5678', spotTime: at('14:50') }], 'their own spots, as spots');
  assert.deepStrictEqual(extra(got), ['US-5678']);
  t += 2 * 60 * 1000 + 1;
  c.prefetch('K1ABC', 'US-1234');
  await wait(5);
  assert.strictEqual(calls, 2, 'asked again once it is 2 minutes old');
  const many = new N.NferCache({ max: 3, fetchHistory: async () => [] });
  for (let i = 0; i < 10; i++) many.prefetch('K1ABC', 'US-100' + i);
  await wait(5);
  assert.strictEqual(many._map.size, 3, 'bounded');
});

test('cache: a history is used for 3 minutes after it arrived, then not at all', async () => {
  let t = 1000000;
  const c = new N.NferCache({ now: () => t, ttlMs: 1e12, fetchHistory: async () => [own('2-fer US-1234, US-5678', '14:50')] });
  c.prefetch('K1ABC', 'US-1234');
  await wait(5);
  t += 3 * 60 * 1000;
  assert.strictEqual(c.fresh('K1ABC', 'US-1234').length, 1, '3 minutes: still fresh');
  t += 1;
  assert.strictEqual(c.fresh('K1ABC', 'US-1234'), null, 'older: not used');
  assert.deepStrictEqual(c.get('K1ABC', 'US-1234'), []);
  assert.strictEqual(N.FRESH_MS, 3 * 60 * 1000);
});

test('cache: a failed or hung refresh never leaves the old spots deciding', async () => {
  // The third review's run: 3-fer at 15:59, "now US-4579 only" at 16:12, contacts at 16:00, 16:20 and later.
  const T0 = Date.UTC(2026, 10, 12, 16, 0, 0);
  const iso = (ms) => new Date(ms).toISOString().slice(0, 19);
  let clock = T0, mode = 'ok', calls = 0;
  const history = [{ spotter: 'K0RDY', comments: '3-fer: US-4579 US-4576 US-4566', spotTime: iso(T0 - 60000) }];
  const cache = new N.NferCache({ now: () => clock, fetchHistory: async () => { calls++; if (mode === 'fail') throw new Error('timeout'); if (mode === 'hang') return new Promise(() => {}); return history.slice(); } });
  const logAt = () => N.nferExtraRefs({ call: 'K0RDY', spottedRef: 'US-4579', now: clock, ...YES, spots: cache.fresh('K0RDY', 'US-4579') });
  cache.prefetch('K0RDY', 'US-4579'); await wait(5);
  assert.deepStrictEqual(logAt(), ['US-4576', 'US-4566'], '16:00, fresh history');
  history.unshift({ spotter: 'K0RDY', comments: 'now US-4579 only', spotTime: iso(T0 + 12 * 60000) });
  clock = T0 + 20 * 60000;
  assert.deepStrictEqual(logAt(), [], '16:20 before the new QSO fetched anything: the 16:00 history is 20 minutes old');
  cache.prefetch('K0RDY', 'US-4579'); await wait(5);
  assert.strictEqual(calls, 2, 'the second QSO fetches again');
  assert.deepStrictEqual(logAt(), [], '16:20: his newest own spot says one park');
  // pota.app fails from here: nothing old is kept.
  mode = 'fail';
  history.shift();
  for (const m of [31, 40, 60, 89]) {
    clock = T0 + m * 60000; cache.prefetch('K0RDY', 'US-4579'); await wait(5);
    assert.strictEqual(cache.fresh('K0RDY', 'US-4579'), null, `+${m} min, request failed`);
    assert.deepStrictEqual(logAt(), []);
  }
  assert.deepStrictEqual(cache._map.get('K0RDY|US-4579').spots, [], 'dropped, not kept for later');
  // It answers again, then a refresh fails within the 3 minutes: the failure wins.
  mode = 'ok'; clock += 61000;
  history[0] = { ...history[0], spotTime: iso(clock - 60000) }; // he re-spots the 3-fer
  cache.prefetch('K0RDY', 'US-4579'); await wait(5);
  assert.deepStrictEqual(logAt(), ['US-4576', 'US-4566']);
  mode = 'fail'; clock += 2 * 60000 + 1; cache.prefetch('K0RDY', 'US-4579'); await wait(5);
  assert.deepStrictEqual(logAt(), [], 'a failed refresh is not papered over with the last good answer');
  // A refresh that hangs: the last good answer serves until it is 3 minutes old, no longer.
  mode = 'ok'; clock += 61000; cache.prefetch('K0RDY', 'US-4579'); await wait(5);
  mode = 'hang'; clock += 2 * 60000 + 1; cache.prefetch('K0RDY', 'US-4579'); await wait(5);
  assert.deepStrictEqual(logAt(), ['US-4576', 'US-4566'], '2 minutes old, refresh pending');
  clock += 60000;
  assert.deepStrictEqual(logAt(), [], 'over 3 minutes old');
  const before = calls;
  clock += 15000; cache.prefetch('K0RDY', 'US-4579'); await wait(5);
  assert.strictEqual(calls, before + 1, 'a request that never settled is given up on after 15 s');
  // An answer that is not a list is a failure.
  const odd = new N.NferCache({ fetchHistory: async () => ({ error: 'x' }) });
  odd.prefetch('K1ABC', 'US-1111'); await wait(5);
  assert.strictEqual(odd.fresh('K1ABC', 'US-1111'), null);
});

test('cache: of a long history the NEWEST own spots are kept, whatever order it came in', async () => {
  const mins = (m) => new Date(NOW - m * 60000).toISOString().slice(0, 19);
  for (const order of ['ascending', 'descending', 'shuffled']) {
    // 150 own spots, one a minute; the newest says one park, the other 149 say 2-fer.
    let many = Array.from({ length: 150 }, (_, i) => ({ spotter: 'K1ABC', comments: i === 0 ? 'QSY single park' : '2fer US-1111 US-2222', spotTime: mins(i + 1) }));
    if (order === 'ascending') many = many.reverse();
    if (order === 'shuffled') many = many.map((x, i) => [(i * 7919) % 150, x]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
    const c = new N.NferCache({ now: () => NOW, fetchHistory: async () => many });
    c.prefetch('K1ABC', 'US-1111');
    await wait(5);
    const kept = c.fresh('K1ABC', 'US-1111');
    assert.strictEqual(kept.length, 100, order);
    assert.strictEqual(kept[0].comments, 'QSY single park', order + ': the newest is kept, first');
    assert.deepStrictEqual(extra(kept, 'US-1111'), [], order + ': and it decides');
  }
  // A spot with no readable time is kept too (it sorts first) and refuses.
  const odd = Array.from({ length: 150 }, (_, i) => ({ spotter: 'K1ABC', comments: '2fer US-1111 US-2222', spotTime: mins(i + 1) }));
  odd.push({ spotter: 'K1ABC', comments: 'moved', spotTime: '' });
  const c = new N.NferCache({ now: () => NOW, fetchHistory: async () => odd });
  c.prefetch('K1ABC', 'US-1111');
  await wait(5);
  assert.strictEqual(c.fresh('K1ABC', 'US-1111')[0].comments, 'moved');
  assert.deepStrictEqual(extra(c.fresh('K1ABC', 'US-1111'), 'US-1111'), []);
});

test('a QSO starts once: the state is broadcast on every step, the spot-list lookup is for the first', () => {
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
  assert.strictEqual(kept[0].comments.length, 501, 'one past the limit: too long stays too long');
  assert.ok(!('reference' in kept[0]), 'the history asked for call + park is at that park');
});

// ---- away from the shack ---------------------------------------------------

test('S2C jtcat-qso-logged goes only to clients that declared they understand it', () => {
  const { RemoteServer } = require('../lib/remote-server');
  const sent = [];
  const client = (name, caps) => ({ name, _clientCapabilities: caps });
  const clients = [
    client('new web', ['chunked-all-qsos', 'jtcat-qso-logged']),
    client('old phone', ['chunked-all-qsos', 'qso-delta']),       // would log "rx UNPARSEABLE" once per contact
    client('legacy, no hello', []),
    { name: 'no capabilities at all' },
    client('remote JTCAT window', ['qso-attributed', 'jtcat-qso-logged']),
    { name: 'Guest Pass session', _passSession: { id: 'p1' }, _clientCapabilities: ['chunked-all-qsos', 'jtcat-qso-logged'] }, // the log is the owner's
  ];
  const fake = { _openClients: () => clients, _sendTo: (c, msg) => sent.push([c.name, msg]) };
  const d = { callsign: 'DK5UR', parksText: 'at DE-1197 and DE-0941', parksNote: 'DE-0941: from their own spot comment', band: '20m', mode: 'FT8' };
  const n = RemoteServer.prototype.broadcastJtcatQsoLogged.call(fake, d);
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(sent.map((s) => s[0]), ['new web', 'remote JTCAT window']);
  assert.deepStrictEqual(sent[0][1], { type: 'jtcat-qso-logged', ...d });
  assert.strictEqual(RemoteServer.prototype.broadcastJtcatQsoLogged.call({ _openClients: () => [], _sendTo: () => { throw new Error('nobody'); } }, d), 0);
  // The two clients in this repo declare it; the registry and the wire contract say so.
  const web = readSrc(path.join(root, 'renderer', 'remote.js'));
  assert.ok(/capabilities: \['chunked-all-qsos', 'qso-delta', 'chunked-worked-qsos', 'local-cw-sidetone', 'jtcat-qso-logged'(, '[a-z0-9-]+')*\],/.test(web), 'ECHOCAT Web'); // later capabilities may follow (mail-folders-v2, #475)
  assert.ok(/capabilities: \['qso-attributed', 'log-error', 'diagnostic-snapshot', 'jtcat-qso-logged'\],/.test(readSrc(path.join(root, 'lib', 'remote-client.js'))), 'a desktop driving a remote shack');
  const reg = readSrc(path.join(root, 'lib', 'echocat-protocol.js'));
  assert.ok(/'jtcat-qso-logged': \{ dir: Dir\.S2C, feature: 'jtcat', fields: \{ callsign: f\.string, parksText: f\.optString, parksNote: f\.optString,/.test(reg));
  const doc = readSrc(path.join(root, 'docs', 'echocat-protocol.md'));
  assert.ok(doc.includes('| `jtcat-qso-logged` | S→C |') && doc.includes('only to a client whose `hello.capabilities` include `jtcat-qso-logged`'), 'in the wire contract, with its gate');
  assert.ok(doc.includes('never to a Guest Pass session'));
  assert.ok(/if \(c\._passSession\) continue;/.test(readSrc(path.join(root, 'lib', 'remote-server.js')).split('broadcastJtcatQsoLogged(data) {')[1].slice(0, 200)));
});

test('the shack sends one notice per JTCAT write; a remote JTCAT window shows the card; ECHOCAT Web toasts only parks read from a comment', () => {
  const B = require('../lib/remote-bridge');
  const write = fnBody('jtcatWriteLog');
  assert.ok(/if \(jtcatPopoutWin && !jtcatPopoutWin\.isDestroyed\(\)\) jtcatPopoutWin\.webContents\.send\('jtcat-qso-logged', logged\);/.test(write));
  assert.ok(/if \(remoteServer\) remoteServer\.broadcastJtcatQsoLogged\(logged\);/.test(write), 'the same payload as the JTCAT window');
  const d = { callsign: 'DK5UR', parksText: 'at DE-1197 and DE-0941', parksNote: 'DE-0941: from their own spot comment', band: '20m', mode: 'FT8' };
  assert.deepStrictEqual(B.IN['jtcat-qso-logged']({ type: 'jtcat-qso-logged', ...d }), [['jtcat-qso-logged', d]]);
  const web = readSrc(path.join(root, 'renderer', 'remote.js'));
  const i = web.indexOf("case 'jtcat-qso-logged': {");
  assert.ok(i > 0);
  const h = web.slice(i, web.indexOf("case 'jtcat-tx-status':", i));
  assert.ok(/if \(!msg\.parksNote\) break;/.test(h), 'an ordinary contact shows no new toast');
  assert.ok(/if \(logToast\.classList\.contains\('error'\) && !logToast\.classList\.contains\('hidden'\)\) break;/.test(h), 'an error toast on screen is not replaced');
  assert.ok(h.indexOf('if (!msg.parksNote) break;') < h.indexOf('showToast('));
  assert.ok(/let line = 'Logged ' \+ \(msg\.callsign \|\| ''\);/.test(h));
  assert.ok(/if \(msg\.parksText\) line \+= ' ' \+ msg\.parksText;/.test(h));
  assert.ok(/line \+= ' \(' \+ msg\.parksNote \+ '\)';/.test(h));
  assert.ok(/showToast\(line, 6000\);/.test(h), 'as text, long enough to read');
  assert.ok(!/innerHTML/.test(h));
  assert.strictEqual(N.loggedLine(d), 'Logged DK5UR at DE-1197 and DE-0941 (DE-0941: from their own spot comment)', 'the wording, in one place for the handoff');
  assert.strictEqual(N.loggedLine({ callsign: 'k1abc', parksText: 'at US-1111' }), 'Logged K1ABC at US-1111');
  assert.strictEqual(N.loggedLine({ callsign: 'K1ABC' }), 'Logged K1ABC');
});

test('the Log QSO review says which parks came from the comment, until the reference box is edited', () => {
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
  assert.ok(/item\.meta\.nferNote = NferRefs\.nferNote\(_nferLogged\.get\(item\.meta\.relogKey\)\);/.test(fnBody('jtcatShowLogReview')), 'main hands the note to the form');
  // The form: the note holds while the box is as offered, goes when it is edited, comes back when it is put back.
  const lp = readSrc(path.join(root, 'renderer', 'log-popout.js'));
  const m = /const refText = (\(v\) => [^\n]+;)\n\s*function reviewText\(p\) \{\n([\s\S]*?)\n  \}\n/.exec(lp);
  assert.ok(m, 'reviewText found');
  const mk = new Function('refInput', `const refText = ${m[1]} return function (p) {${m[2]}};`);
  const refInput = { value: 'DE-1197,DE-0941' };
  const reviewText = mk(refInput);
  assert.strictEqual(reviewText(p), 'Review before saving · DE-0941: from their own spot comment');
  refInput.value = 'de-1197, de-0941 ';
  assert.strictEqual(reviewText(p), 'Review before saving · DE-0941: from their own spot comment', 'case and blanks are not an edit');
  refInput.value = 'DE-1197';
  assert.strictEqual(reviewText({ ...p, waiting: 2 }), 'Review before saving · 2 more waiting', 'the operator took the park out: the note goes');
  refInput.value = 'DE-1197,DE-0941';
  assert.strictEqual(reviewText(p), 'Review before saving · DE-0941: from their own spot comment');
  assert.ok(/refInput\.addEventListener\('input', \(\) => \{\n\s*if \(reviewId && reviewShown && reviewShown\.nferNote\) reviewBar\.textContent = reviewText\(reviewShown\);/.test(lp), 'on every edit of the box');
  assert.ok(/reviewShown = p;\n\s*reviewBar\.textContent = reviewText\(p\);/.test(lp));
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

test('pota.app is asked while a QSO with the activator is under way, never per decoded station', () => {
  const lookup = fnBody('jtcatSpottedActivator');
  assert.ok(!/_nferCache|prefetch|fetchPotaSpotHistory/.test(lookup), 'the lookup every decode runs through asks nobody');
  const pre = fnBody('jtcatNferPrefetch');
  assert.ok(/if \(_nferQsoStart\.started\(owner, call\)\) \{/.test(pre), 'the spot-list lookup once per QSO');
  assert.ok(pre.indexOf('jtcatSpottedActivator(call)') > pre.indexOf('_nferQsoStart.started(owner, call)'));
  assert.ok(/if \(!jtcatNferEnabled\(\)\) return;/.test(pre), 'option off: no request at all');
  assert.ok(/if \(_nferQsoPark\[owner\] && jtcatNferEnabled\(\)\) _nferCache\.prefetch\(call, _nferQsoPark\[owner\]\);/.test(pre), 'again while the QSO lasts; the cache allows one request per 2 minutes');
  assert.ok(/if \(!call\) \{ _nferQsoPark\[owner\] = ''; return; \}/.test(pre), 'no QSO: nothing is asked');
  assert.strictEqual((main.match(/_nferCache\.prefetch\(/g) || []).length, 1, 'the one place that asks');
  assert.strictEqual((main.match(/fetchPotaSpotHistory\(/g) || []).length, 1, 'only through the cache');
  // Every QSO, whoever runs it and on whichever slice, passes one of the two broadcasts.
  assert.ok(/jtcatNferPrefetch\('remote', remoteJtcatQso\);/.test(fnBody('remoteJtcatBroadcastQso')), 'a phone\'s QSO');
  assert.ok(/jtcatNferPrefetch\('popout', popoutJtcatQso\);/.test(fnBody('popoutBroadcastQso')), 'the JTCAT window\'s QSO');
  const perSlice = main.match(/(popoutJtcatQso|remoteJtcatQso) = \{[^\n]*\n?[^\n]*sliceId: (replySliceId|sliceKey)[^\n]*\};/g) || [];
  assert.ok(perSlice.length >= 4, 'a slice\'s QSO is one of the same two QSO objects: ' + perSlice.length);
  assert.ok(!/(sliceQso|jtcatSliceQso|multiQso)\s*=/.test(main), 'there is no third kind of QSO that would miss the prefetch');
});

test('at the log write: only a fresh history adds parks, nothing is awaited, a throw cannot lose the contact', () => {
  assert.ok(!/await[^\n]*(_nferCache|jtcatNferPrefetch|jtcatNferExtras|fetchPotaSpotHistory)/.test(main), 'never awaited: the next TX message waits on the log write');
  assert.ok(!/\.then\([^\n]*_nferCache/.test(main));
  const ex = fnBody('jtcatNferExtras');
  assert.ok(/^function jtcatNferExtras\(call, spotted, knownRefs\) \{\n  try \{/.test(ex), 'the whole of it is inside the try');
  assert.ok(/\} catch \(err\) \{\n\s*sendCatLog\(`\[JTCAT\] n-fer: could not read[^\n]*\n\s*return \[\];\n\s*\}$/.test(ex), 'one CAT log line, then the spot-list park only');
  assert.ok(/const history = _nferCache\.fresh\(call, spotted\.ref\);\n\s*if \(!history\) \{/.test(ex), 'no history from the last 3 minutes: nothing is added');
  assert.ok(/spots: history,\n\s*buffer: _potaSpotHistory\.filter\(\(s\) => NferRefs\.baseCall\(s\.callsign\) === theirCall\),/.test(ex), 'the collected spots go in as the buffer, their spots at ANY park');
  assert.ok(!/_nferCache\.get\(/.test(main), 'never the cache without the freshness check');
  assert.ok(/now: StationClock\.now\(\),/.test(ex) && !/Date\.now\(\)/.test(ex), 'the time of the contact, by the corrected station clock');
  assert.ok(/parkKnown: jtcatParkKnown,/.test(ex));
  assert.ok(!/matchAll|\.comments|RegExp/.test(ex), 'no parsing in main.js');
  const log = fnBody('jtcatAutoLog');
  assert.ok(log.indexOf('q._logged = true;') < log.indexOf('jtcatNferExtras('), 'after the contact is marked logged');
  assert.ok(/const spotted = jtcatNferEnabled\(\) \? hunted\.refs\.find\(\(r\) => r\.sig === 'POTA'\) : null;/.test(log), 'option off: nothing is read');
  assert.ok(/const extra = jtcatNferExtras\(q\.call, spotted, hunted\.refs\.filter\(\(r\) => r\.sig === 'POTA'\)\.map\(\(r\) => r\.ref\)\);/.test(log));
  assert.ok(/for \(const ref of extra\) qsoData\.hunted\.push\(\{ sig: 'POTA', ref \}\);/.test(log), 'logged through logContact + qso-expand like every park');
  assert.ok(!/hunted\.refs\.push/.test(log), 'the spot list\'s refs stay the spot list\'s: a re-spot never uses a park read from a comment');
  const known = fnBody('jtcatParkKnown');
  assert.ok(/if \(!list \|\| !list\.map \|\| !list\.map\.size\) return null;/.test(known), 'list not loaded = no answer, not "unknown park"');
});

test('a park list that failed to load: asked again after 90 s, after 15 minutes when POTA said the program has no parks', () => {
  const en = fnBody('ensureParksForRef');
  assert.ok(/const failed = _parksNoList\.get\(program\);\n\s*if \(failed && Date\.now\(\) - failed\.at < failed\.ms\) return;/.test(en));
  assert.ok(/if \(program === parksDbPrefix \|\| _parksOther\.has\(program\)\) _parksNoList\.delete\(program\);/.test(en), 'a list that did load clears it');
  assert.ok(!/_parksNoList\.set/.test(en), 'how long is decided where the failure is known');
  const rd = fnBody('readParksProgram');
  assert.ok(/_parksNoList\.set\(prefix, \{ at: Date\.now\(\), ms: \/\^POTA has no parks\/\.test\(String\(err && err\.message\)\) \? PARKS_NO_LIST_MS : PARKS_RETRY_MS \}\);/.test(rd));
  assert.ok(/throw new Error\(`POTA has no parks for program \$\{prefix\}`\);/.test(rd), 'the message the 15 minutes hang on');
  assert.ok(/const PARKS_NO_LIST_MS = 15 \* 60 \* 1000;/.test(main) && /const PARKS_RETRY_MS = 90 \* 1000;/.test(main), 'a network blip hides a country from the park search for 90 s, not 15 minutes');
});

test('the n-fer block comes before any automatic re-spot (#351)', () => {
  const log = fnBody('jtcatAutoLog');
  const nfer = log.indexOf('jtcatNferExtras(');
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
