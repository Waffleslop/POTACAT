#!/usr/bin/env node
'use strict';
/**
 * The route choice on a Flex (lib/flex-route.js): through POTACAT or through
 * FlexRadio SmartLink. The four states, the refusals and their sentences, the
 * desk question, the 60 s no-GUI-client reclaim, the reclaim retry window,
 * persistence across a restart, and which ECHOCAT messages need the radio.
 *
 * Run: node test/flex-route-test.js
 */
const assert = require('assert');
const FR = require('../lib/flex-route');
const { MESSAGES } = require('../lib/echocat-protocol');
const { readSrc } = require('./_src');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
function clock(t0 = 1_000_000) {
  let t = t0;
  const now = () => t;
  now.add = (ms) => { t += ms; };
  return now;
}
const OK = { state: 'pc', flexDirect: true, guestPass: false, transmitting: false, winlink: false, deskInUse: false };

console.log('decideRelease');

test('a free radio with nobody at the desk is released at once', () => {
  assert.deepStrictEqual(FR.decideRelease(OK), { action: 'release' });
});
test('someone at the desk is asked first', () => {
  assert.deepStrictEqual(FR.decideRelease({ ...OK, deskInUse: true }), { action: 'ask' });
});
test('transmitting, Winlink and a Guest Pass are refused with their own sentence', () => {
  assert.deepStrictEqual(FR.decideRelease({ ...OK, transmitting: true }), { action: 'refuse', error: FR.TEXT.transmitting });
  assert.deepStrictEqual(FR.decideRelease({ ...OK, winlink: true }), { action: 'refuse', error: FR.TEXT.winlink });
  assert.deepStrictEqual(FR.decideRelease({ ...OK, guestPass: true }), { action: 'refuse', error: 'A guest has the radio.' });
});
test('a refusal wins over asking the desk (the desk is never bothered for nothing)', () => {
  assert.strictEqual(FR.decideRelease({ ...OK, transmitting: true, deskInUse: true }).action, 'refuse');
  assert.strictEqual(FR.decideRelease({ ...OK, winlink: true, deskInUse: true }).action, 'refuse');
});
test('a guest is named before their transmission', () => {
  assert.strictEqual(FR.decideRelease({ ...OK, guestPass: true, transmitting: true }).error, FR.TEXT.guest);
});
test('no Flex Direct: nothing to hand over', () => {
  assert.deepStrictEqual(FR.decideRelease({ ...OK, flexDirect: false }), { action: 'refuse', error: FR.TEXT.notFlexDirect });
});
test('already released is done; mid-change is busy', () => {
  assert.deepStrictEqual(FR.decideRelease({ ...OK, state: 'released', flexDirect: false }), { action: 'done' });
  for (const state of ['releasing', 'reclaiming']) {
    assert.deepStrictEqual(FR.decideRelease({ ...OK, state }), { action: 'refuse', error: FR.TEXT.busy });
  }
});

console.log('deskInUse');

test('used in the last 2 minutes with the window visible', () => {
  assert.strictEqual(FR.deskInUse({ systemIdleSec: 0, windowVisible: true }), true);
  assert.strictEqual(FR.deskInUse({ systemIdleSec: 119, windowVisible: true }), true);
  assert.strictEqual(FR.deskInUse({ systemIdleSec: 120, windowVisible: true }), false);
});
test('a hidden or minimised window, headless, or no idle reading: nobody to ask', () => {
  assert.strictEqual(FR.deskInUse({ systemIdleSec: 3, windowVisible: false }), false);
  assert.strictEqual(FR.deskInUse({ systemIdleSec: 3, windowVisible: true, headless: true }), false);
  assert.strictEqual(FR.deskInUse({ systemIdleSec: null, windowVisible: true }), false);
  assert.strictEqual(FR.deskInUse({ systemIdleSec: NaN, windowVisible: true }), false);
  assert.strictEqual(FR.deskInUse(), false);
});
test('the desk timeout is 30 s', () => assert.strictEqual(FR.DESK_ASK_TIMEOUT_MS, 30000));

console.log('FlexRoute states');

test('pc -> releasing -> released -> reclaiming -> pc', () => {
  const now = clock();
  const r = new FR.FlexRoute({ now });
  assert.strictEqual(r.state, 'pc');
  assert.strictEqual(r.held, false);
  now.add(10);
  assert.ok(r.beginRelease('Casey iPhone'));
  assert.strictEqual(r.state, 'releasing');
  assert.strictEqual(r.held, true);
  assert.deepStrictEqual(r.snapshot(), { state: 'releasing', since: 1_000_010, holder: 'Casey iPhone' });
  now.add(10);
  assert.ok(r.finishRelease(true));
  assert.strictEqual(r.state, 'released');
  assert.strictEqual(r.held, true);
  assert.strictEqual(r.since, 1_000_020);
  assert.ok(r.beginReclaim());
  assert.strictEqual(r.state, 'reclaiming');
  assert.strictEqual(r.held, false, 'reclaiming lets connectSmartSdr through');
  assert.ok(r.finishReclaim(true));
  assert.strictEqual(r.state, 'pc');
  assert.deepStrictEqual(Object.keys(r.snapshot()).sort(), ['since', 'state'], 'no holder once POTACAT has it');
});
test('a failed release goes back to pc; a failed reclaim back to released', () => {
  const r = new FR.FlexRoute({ now: clock() });
  r.beginRelease('x'); r.finishRelease(false);
  assert.strictEqual(r.state, 'pc');
  r.beginRelease('x'); r.finishRelease(true); r.beginReclaim(); r.finishReclaim(false);
  assert.strictEqual(r.state, 'released');
});
test('transitions out of order are refused and change nothing', () => {
  const r = new FR.FlexRoute({ now: clock() });
  assert.strictEqual(r.finishRelease(true), false);
  assert.strictEqual(r.beginReclaim(), false);
  assert.strictEqual(r.finishReclaim(true), false);
  assert.strictEqual(r.state, 'pc');
  r.beginRelease('x');
  assert.strictEqual(r.beginRelease('y'), false);
  assert.strictEqual(r.beginReclaim(), false);
  assert.strictEqual(r.holder, 'x');
});
test('every state is one of the four on the wire', () => {
  assert.deepStrictEqual(FR.STATES, ['pc', 'releasing', 'released', 'reclaiming']);
  assert.deepStrictEqual(MESSAGES['flex-route'].fields.state.values, FR.STATES);
});

console.log('persistence');

test('released survives a restart; pc and releasing are not saved', () => {
  const now = clock();
  const r = new FR.FlexRoute({ now });
  assert.strictEqual(r.toSaved(), null);
  r.beginRelease('Pixel');
  assert.strictEqual(r.toSaved(), null, 'a release that never finished is not a release');
  r.finishRelease(true);
  const saved = r.toSaved();
  assert.deepStrictEqual(saved, { state: 'released', since: 1_000_000, holder: 'Pixel' });
  const again = new FR.FlexRoute({ now: clock(5_000_000), saved: JSON.parse(JSON.stringify(saved)) });
  assert.strictEqual(again.state, 'released');
  assert.strictEqual(again.since, 1_000_000);
  assert.strictEqual(again.holder, 'Pixel');
});
test('a reclaim in progress is still released on disk (a crash comes back released)', () => {
  const r = new FR.FlexRoute({ now: clock() });
  r.beginRelease('x'); r.finishRelease(true); r.beginReclaim();
  assert.strictEqual(r.toSaved().state, 'released');
});
test('junk in settings is pc', () => {
  for (const saved of [null, {}, { state: 'reclaiming' }, { state: 'pc' }, 'released']) {
    assert.strictEqual(new FR.FlexRoute({ now: clock(), saved }).state, 'pc');
  }
});

console.log('the 60 s no-GUI-client rule');

test('60 s in a row with no GUI client: due; 59.999 s is not', () => {
  const now = clock();
  const r = new FR.FlexRoute({ now });
  r.beginRelease('x'); r.finishRelease(true);
  assert.strictEqual(r.autoReclaimDue(), false, 'nothing seen yet: never due');
  r.noteGuiClients(0);
  now.add(59_999);
  r.noteGuiClients(0); // the 5 s tick repeats it; the clock keeps its start
  assert.strictEqual(r.autoReclaimDue(), false);
  now.add(1);
  assert.strictEqual(r.autoReclaimDue(), true);
});
test('a GUI client appearing restarts the clock', () => {
  const now = clock();
  const r = new FR.FlexRoute({ now });
  r.beginRelease('x'); r.finishRelease(true);
  r.noteGuiClients(0); now.add(50_000);
  r.noteGuiClients(1); now.add(20_000);
  assert.strictEqual(r.autoReclaimDue(), false);
  r.noteGuiClients(0); now.add(59_000);
  assert.strictEqual(r.autoReclaimDue(), false);
  now.add(1_000);
  assert.strictEqual(r.autoReclaimDue(), true);
});
test('losing the watch stops the clock (nothing known is not "no client")', () => {
  const now = clock();
  const r = new FR.FlexRoute({ now });
  r.beginRelease('x'); r.finishRelease(true);
  r.noteGuiClients(0); now.add(45_000);
  r.noteWatchLost(); now.add(30_000);
  assert.strictEqual(r.autoReclaimDue(), false);
  assert.strictEqual(r.noGuiForMs(), null);
});
test('the clock only runs while released', () => {
  const now = clock();
  const r = new FR.FlexRoute({ now });
  r.noteGuiClients(0); now.add(120_000);
  assert.strictEqual(r.autoReclaimDue(), false);
  r.beginRelease('x'); r.finishRelease(true); r.noteGuiClients(0); now.add(60_000);
  r.beginReclaim();
  assert.strictEqual(r.autoReclaimDue(), false, 'not twice');
  r.finishReclaim(false);
  assert.strictEqual(r.noGuiForMs(), null, 'a failed reclaim starts a fresh 60 s');
});

console.log('reclaim retries');

test('F3000001 is retried every 2 s for 20 s, then named', () => {
  const startedAt = 0;
  assert.deepStrictEqual(FR.reclaimNext({ startedAt, now: 0, status: FR.RADIO_FULL }), { action: 'retry', delayMs: 2000 });
  assert.deepStrictEqual(FR.reclaimNext({ startedAt, now: 18_000, status: 0xF3000001 }), { action: 'retry', delayMs: 2000 });
  assert.deepStrictEqual(FR.reclaimNext({ startedAt, now: 18_001, status: 0xF3000001 }), { action: 'fail', error: 'The radio is still held by another client.' });
});
test('no answer at all ends as unreachable', () => {
  assert.deepStrictEqual(FR.reclaimNext({ startedAt: 0, now: 25_000, status: null }), { action: 'fail', error: FR.TEXT.unreachable });
});
test('a negative int32 status (as parseInt of a reply can give) still reads as F3000001', () => {
  assert.strictEqual(FR.reclaimNext({ startedAt: 0, now: 30_000, status: 0xF3000001 | 0 }).error, FR.TEXT.stillHeld);
  assert.strictEqual(FR.statusHex(0xF3000001 | 0), 'F3000001');
  assert.strictEqual(FR.statusHex(null), 'none');
});

console.log('ECHOCAT messages that need the radio');

test('tuning, keying and rig control are refused while released', () => {
  for (const t of ['tune', 'ptt', 'set-mode', 'rig-control', 'set-txpower', 'cw-text', 'paddle', 'jtcat-call-cq', 'sstv-photo', 'scan-control', 'rig-reconnect']) {
    assert.strictEqual(FR.isRigCommand({ type: t }), true, t);
  }
});
test('spots, logging, stopping and the route messages themselves are not', () => {
  for (const t of ['log-qso', 'set-sources', 'hide-spot', 'ping', 'estop', 'jtcat-halt-tx', 'sstv-halt-tx', 'cw-stop', 'jtcat-stop',
    'flex-release', 'flex-reclaim', 'lookup-call', 'get-all-qsos', 'winlink-list', 'winlink-compose']) {
    assert.strictEqual(FR.isRigCommand({ type: t }), false, t);
  }
  assert.strictEqual(FR.isRigCommand(null), false);
});
test('every listed type is a real ECHOCAT message (registry or demux case)', () => {
  const demux = readSrc(path.join(__dirname, '..', 'lib', 'remote-server.js'));
  for (const t of FR.RIG_TYPES) {
    assert.ok(MESSAGES[t] || demux.includes(`case '${t}'`), `${t} is not an ECHOCAT message`);
  }
});

console.log('the words');

test('one sentence each, no emoji, never a bare "SmartLink"', () => {
  for (const [k, v] of Object.entries(FR.TEXT)) {
    assert.ok(typeof v === 'string' && v.length > 5, k);
    assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(v), `${k} has an emoji`);
    assert.ok(!/(^|[^o]\s)SmartLink/.test(v.replace(/FlexRadio SmartLink/g, '')), `${k}: say "FlexRadio SmartLink"`);
    assert.ok(!/\bphone\b/i.test(v), `${k}: "mobile device", not "phone"`);
  }
});
test('the sentences Casey and the ECHOCAT session agreed on, word for word', () => {
  assert.strictEqual(FR.TEXT.guest, 'A guest has the radio.');
  assert.strictEqual(FR.TEXT.deskSaidNo, 'The person at the computer did not agree.');
  assert.strictEqual(FR.TEXT.stillHeld, 'The radio is still held by another client.');
  assert.strictEqual(FR.TEXT.rigRefused, 'The radio is on FlexRadio SmartLink with your mobile device.');
  assert.strictEqual(FR.TEXT.banner, 'The radio is with ECHOCAT through FlexRadio SmartLink.');
  assert.strictEqual(FR.TEXT.takeBackWarn, 'Your mobile device will lose the radio.');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
