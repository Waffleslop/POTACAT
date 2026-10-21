#!/usr/bin/env node
'use strict';
// JTTY chats (lib/jtty-chats.js): which rows make up a conversation, the
// auto "THEIR MY" prefix, bubble text, unread and idle, and the open/close
// state. The cases are the ECHOCAT app's (__tests__/jttyChats.test.ts) so
// the two sides prove the same rules, plus the desktop's two additions: a
// line whose FIRST word is the station with no readable sender is addressed
// TO them (not theirs), and a chat closed mid-line stays closed.
// Run: node test/jtty-chats-test.js
const assert = require('assert');
const C = require('../lib/jtty-chats');
const JttyMacros = require('../lib/jtty-macros');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const ME = 'K3SBP';
let n = 0;
const rx = (text, freqHz, utcMs, complete = true) => ({ key: 'rx-' + (++n), kind: 'rx', text, complete, freqHz, snrDb: -10, utcMs });
const tx = (text, utcMs) => ({ key: 'tx-' + (++n), kind: 'tx', text, complete: true, freqHz: 1640, snrDb: null, utcMs });
const texts = (rows) => rows.map(r => r.text);

console.log('JTTY chats');

test('senderOf is the one in lib/jtty-macros.js', () => {
  for (const t of ['CQ W9XYZ EN52', 'K3SBP W9XYZ -09 GA', 'W9XYZ', 'FB NICE SIGS', 'K3SBP 599 001', 'K9NW RR73; KI5QQG <P4/WE9V> -04']) {
    assert.strictEqual(C.senderOf(t), JttyMacros.senderOf(t), t);
  }
});

test('a freeform ragchew stays in its chat by frequency (the phone\'s case)', () => {
  const rows = [
    rx('CQ W9XYZ EN52', 1640, 1),
    rx('CQ N4QRS EM73', 1210, 2),
    tx('W9XYZ K3SBP FN20', 3),
    rx('K3SBP W9XYZ -09 GA CASEY TNX FER CALL', 1641, 4),
    tx('W9XYZ K3SBP R-11 RIG HERE FLEX 8600', 5),
    rx('FB. IC-7300 AND A VERTICAL HERE', 1639, 6), // no calls, their frequency
    rx('HELLO FROM OHIO', 2440, 7),                  // no calls, elsewhere
    rx('VE3ABC KC1TUV -13', 1645, 8),                // on frequency but someone else's QSO
    rx('K3SBP K2DEF FN31', 1642, 9),                 // calling us, but not them
  ];
  assert.deepStrictEqual(texts(C.chatRows(rows, 'W9XYZ', ME)), [
    'CQ W9XYZ EN52', 'W9XYZ K3SBP FN20', 'K3SBP W9XYZ -09 GA CASEY TNX FER CALL',
    'W9XYZ K3SBP R-11 RIG HERE FLEX 8600', 'FB. IC-7300 AND A VERTICAL HERE',
  ]);
  assert.ok(C.FREQ_MATCH_HZ >= 5);
  assert.deepStrictEqual(C.chatRows(rows, '', ME), []);
});

test('nothing joins by frequency until the station has been named', () => {
  const rows = [rx('FB. NICE SIGS', 1640, 1), rx('CQ W9XYZ EN52', 1640, 2), rx('TNX AGN', 1640, 3)];
  assert.deepStrictEqual(texts(C.chatRows(rows, 'W9XYZ', ME)), ['CQ W9XYZ EN52', 'TNX AGN']);
});

test('a third station calling them is not part of our chat (N4FFF 2026-10-19)', () => {
  const rows = [
    rx('CQ W9XYZ EN52', 1640, 1),
    tx('W9XYZ K3SBP FN20', 2),
    rx('W9XYZ N4QRS EM73', 1900, 3), // someone else came back to them
    rx('N4QRS W9XYZ -05', 1640, 4),  // them answering the other station
    rx('K3SBP W9XYZ -09', 1641, 5),
    rx('NICE SIGS', 1905, 6),        // no calls, on the THIRD station's frequency
    rx('TNX AGN', 1640, 7),          // no calls, on theirs
  ];
  assert.deepStrictEqual(texts(C.chatRows(rows, 'W9XYZ', ME)), [
    'CQ W9XYZ EN52', 'W9XYZ K3SBP FN20', 'N4QRS W9XYZ -05', 'K3SBP W9XYZ -09', 'TNX AGN',
  ]);
});

test('their call FIRST with no readable sender is a line TO them: not theirs, and it never moves the chat\'s frequency (desktop addition)', () => {
  const rows = [
    rx('CQ W9XYZ EN52', 1640, 1),
    tx('W9XYZ K3SBP FN20', 2),
    rx('W9XYZ PSE AGN', 1900, 3),     // someone unnamed asking them, elsewhere
    rx('OK HERE IS MY INFO', 1905, 4), // freeform on THAT station's frequency
    rx('TNX 73 DE W9XYZ', 1641, 5),   // theirs: named later, no TO FROM pair
    rx('GL ES 73', 1640, 6),          // freeform on theirs
  ];
  assert.deepStrictEqual(texts(C.chatRows(rows, 'W9XYZ', ME)), [
    'CQ W9XYZ EN52', 'W9XYZ K3SBP FN20', 'TNX 73 DE W9XYZ', 'GL ES 73',
  ]);
});

test('mentions match whole calls, hash brackets off', () => {
  assert.ok(C.mentions('K9NW RR73; KI5QQG <P4/WE9V> -04', 'P4/WE9V'));
  assert.ok(!C.mentions('W9XYZA HI', 'W9XYZ'));
  assert.ok(!C.mentions('anything', ''));
});

test('a line calling us names its sender; others do not', () => {
  assert.strictEqual(C.directedSender('K3SBP W9XYZ -09 GA', ME), 'W9XYZ');
  assert.strictEqual(C.directedSender('k3sbp k2def fn31', ME), 'K2DEF');
  assert.strictEqual(C.directedSender('CQ W9XYZ EN52', ME), '');
  assert.strictEqual(C.directedSender('W9XYZ K3SBP 73', ME), '');
  assert.strictEqual(C.directedSender('K3SBP', ME), '');
  assert.strictEqual(C.directedSender('K3SBP 599 001', ME), '');
});

test('outgoing chat lines carry THEIR MY unless already addressed', () => {
  assert.strictEqual(C.chatOutgoing('HA YES  73 DANA', 'W9XYZ', ME), 'W9XYZ K3SBP HA YES 73 DANA');
  assert.strictEqual(C.chatOutgoing('W9XYZ K3SBP RRR', 'W9XYZ', ME), 'W9XYZ K3SBP RRR', 'a macro already has it');
  assert.strictEqual(C.chatOutgoing('w9xyz de k3sbp', 'W9XYZ', ME), 'w9xyz de k3sbp');
  assert.strictEqual(C.chatOutgoing('CQ K3SBP FN20', 'W9XYZ', ME), 'CQ K3SBP FN20');
  assert.strictEqual(C.chatOutgoing('', 'W9XYZ', ME), '');
  assert.strictEqual(C.chatOutgoing('HI', 'W9XYZ', ''), 'W9XYZ HI');
});

test('bubbles keep the whole line, the call pair split out to grey (N4FFF)', () => {
  assert.deepStrictEqual(C.bubbleParts('W9XYZ K3SBP HA YES 73 DANA', 'W9XYZ', ME), { pair: 'W9XYZ K3SBP', body: 'HA YES 73 DANA' });
  assert.deepStrictEqual(C.bubbleParts('K3SBP W9XYZ -09 GA CASEY', 'W9XYZ', ME), { pair: 'K3SBP W9XYZ', body: '-09 GA CASEY' });
  assert.deepStrictEqual(C.bubbleParts('W9XYZ K3SBP', 'W9XYZ', ME), { pair: '', body: 'W9XYZ K3SBP' }, 'nothing after: plain');
  assert.deepStrictEqual(C.bubbleParts('CQ W9XYZ EN52', 'W9XYZ', ME), { pair: '', body: 'CQ W9XYZ EN52' });
  assert.deepStrictEqual(C.bubbleParts('K3SBP <W9XYZ> RRR', 'W9XYZ', ME), { pair: 'K3SBP <W9XYZ>', body: 'RRR' });
});

test('the composer prefix is exactly what the outgoing line adds', () => {
  assert.strictEqual(C.chatPrefix('HA YES', 'W9XYZ', ME), 'W9XYZ K3SBP');
  assert.strictEqual(C.chatPrefix('', 'W9XYZ', ME), 'W9XYZ K3SBP', 'shown before typing');
  assert.strictEqual(C.chatPrefix('W9XYZ DE K3SBP', 'W9XYZ', ME), '');
  assert.strictEqual(C.chatPrefix('CQ K3SBP FN20', 'W9XYZ', ME), '');
  assert.strictEqual(C.chatPrefix('HI', 'W9XYZ', ''), 'W9XYZ');
});

test('unread counts received lines after the last view; last heard is the newest received', () => {
  const rows = [rx('A', 1, 100), tx('B', 200), rx('C', 1, 300), rx('D', 1, 400)];
  assert.strictEqual(C.chatUnread(rows, 250), 2);
  assert.strictEqual(C.chatUnread(rows, 400), 0);
  assert.strictEqual(C.chatLastHeard(rows), 400);
  assert.strictEqual(C.chatLastHeard([tx('B', 200)]), null);
});

console.log('\nopen / close state');

test('picking a station opens its chat and switches; a station calling us opens one without switching', () => {
  const st = new C.ChatState();
  st.open('W9XYZ', { activate: true, now: 10 });
  assert.strictEqual(st.active, 'W9XYZ');
  const opened = st.noteRow(rx('K3SBP K2DEF FN31', 1700, 20), ME, 20);
  assert.strictEqual(opened, 'K2DEF');
  assert.strictEqual(st.active, 'W9XYZ', 'still on the first chat');
  assert.strictEqual(st.noteRow(rx('K3SBP K2DEF -05', 1700, 30), ME, 30), '', 'already open');
  assert.strictEqual(st.noteRow(rx('CQ N4QRS EM73', 1200, 40), ME, 40), '', 'a CQ is not a call to us');
  assert.strictEqual(st.noteRow(tx('K2DEF K3SBP -09', 50), ME, 50), '', 'our own line never opens one');
});

test('a chat closed mid-line stays closed for that line, and reopens on the next', () => {
  const st = new C.ChatState();
  const growing = rx('K3SBP K2DEF FN', 1700, 20, false);
  st.noteRow(growing, ME, 20);
  assert.ok(st.get('K2DEF'));
  st.close('K2DEF', growing.key);
  assert.ok(!st.get('K2DEF'));
  growing.text = 'K3SBP K2DEF FN31'; growing.complete = true; // the same row, still arriving
  assert.strictEqual(st.noteRow(growing, ME, 25), '', 'the line it was closed on');
  assert.strictEqual(st.noteRow(rx('K3SBP K2DEF -05', 1700, 40), ME, 40), 'K2DEF', 'a new line reopens it');
});

test('unread is from the last view; leaving reads; logged chats close together', () => {
  const st = new C.ChatState();
  st.open('W9XYZ', { activate: true, now: 100 });
  st.open('K2DEF', { now: 100 });
  const rows = [rx('K3SBP K2DEF FN31', 1700, 150), rx('K3SBP K2DEF -05', 1700, 160)];
  assert.strictEqual(C.chatUnread(C.chatRows(rows, 'K2DEF', ME), st.get('K2DEF').lastViewedMs), 2);
  st.activate('K2DEF', 200);
  assert.strictEqual(C.chatUnread(C.chatRows(rows, 'K2DEF', ME), st.get('K2DEF').lastViewedMs), 0);
  st.activate('', 210);
  assert.strictEqual(st.active, '');
  assert.ok(st.markLogged('K2DEF') && !st.markLogged('NOPE'));
  assert.deepStrictEqual(st.closeLogged(), ['K2DEF']);
  assert.deepStrictEqual(st.chats.map(c => c.call), ['W9XYZ']);
});

console.log('\nthe JTCAT window');
const fs = require('fs');
const path = require('path');
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');

test('the pane has the tabs, the chat view, the prefix, the count and Quick; the module is loaded', () => {
  const html = R('renderer/jtcat-popout.html');
  for (const id of ['jp-jtty-tabs', 'jp-jtty-chat', 'jp-jtty-prefix', 'jp-jtty-count', 'jp-jtty-quick']) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(/<script src="\.\.\/lib\/jtty-chats\.js"><\/script>/.test(html));
  assert.strictEqual((html.match(/jp-jtty-quickwrap/g) || []).length >= 2, true, 'the fields and macro rows sit behind Quick in a chat');
});

test('every line, ours included, goes into the row model the chats are a view over', () => {
  const js = R('renderer/jtcat-popout.js');
  assert.ok(/jttyModelUpsert\(\{ key: 'rx-' \+ jttyEpoch \+ '-' \+ u\.id, kind: 'rx'/.test(js));
  assert.ok(/jttyModelUpsert\(\{ key: 'tx-' \+ \(\+\+jttyTxSeq\), kind: 'tx', text: String\(data\.message\)/.test(js));
  assert.ok(/jttyModelUpsert\(\{ key: 'mk-' \+ jttyEpoch/.test(js));
  assert.ok(/jttyChatState\.noteRow\(m, jttyMyCall\)/.test(js), 'a station calling us opens a chat');
  assert.ok(/row\.addEventListener\('dblclick'[\s\S]{0,200}jttyOpenChat\(call, true\)/.test(js), 'double-click opens a chat');
});

test('the composer sends what it shows: the THEIR MY line, validated and counted with the prefix', () => {
  const js = R('renderer/jtcat-popout.js');
  const send = js.slice(js.indexOf('function jttySend() {'), js.indexOf('function jttySend() {') + 900);
  assert.ok(/var text = jttyOutgoingText\(\);/.test(send) && /window\.api\.jtcatJttySend\(text, profile\)/.test(send));
  const out = js.slice(js.indexOf('function jttyOutgoingText() {'), js.indexOf('function jttyOutgoingText() {') + 400);
  assert.ok(/JttyChats\.chatOutgoing\(text, chat\.call, jttyMyCall\)/.test(out));
  const prev = js.slice(js.indexOf('function jttyPreview() {'), js.indexOf('function jttyPreview() {') + 900);
  assert.ok(/var text = jttyOutgoingText\(\);/.test(prev), 'the frame count and the refusal are for the line on air');
  assert.ok(/jttyCountEl\.textContent = chat \? n \+ '\/80' : ''/.test(js));
});

test('a CQ goes out on the clearest spot (never with Hold on, never with nothing measured)', () => {
  const js = R('renderer/jtcat-popout.js');
  const fn = js.slice(js.indexOf('function jttyCqOnClearSpot(text) {'), js.indexOf('function jttySend() {'));
  assert.ok(/if \(!\/\^CQ\\b\/i\.test\(String\(text\)\.trim\(\)\) \|\| holdTxFreq\) return;/.test(fn));
  assert.ok(/if \(!jttyOcc \|\| jttyOccMs < 5000\) return;/.test(fn));
  assert.ok(/JttyMacros\.clearestSpot\(jttyOcc, jttyOccHzPerBin, \{ prefer: jpTxFreqHz \}\)/.test(fn), 'the Clear spot button\'s measurement');
  assert.ok(/jttyCqOnClearSpot\(text\);\n\s+window\.api\.jtcatJttySend\(text, profile\);/.test(js), 'moved before the transmission starts');
});

test('a saved JTTY QSO reaches the window from the one event every log path passes through', () => {
  const main = R('main.js');
  const at = main.indexOf('win.webContents.send("qso-logged"');
  assert.ok(/jtcatPopoutWin\.webContents\.send\('jtcat-jtty-logged', \{ callsign/.test(main.slice(at, at + 900)));
  assert.ok(/onJtcatJttyLogged/.test(R('preload-jtcat-popout.js')));
  const js = R('renderer/jtcat-popout.js');
  assert.ok(/if \(jttyChatPendingClose === call\) \{ jttyChatPendingClose = ''; jttyCloseChat\(call\); return; \}/.test(js), 'Log and close');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
