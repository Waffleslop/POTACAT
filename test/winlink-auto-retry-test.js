// One automatic retry after a dropped Winlink link (#425; Casey 2026-11-12:
// "Yes automatically retry after a dropped link").
// Every rule is in lib/winlink-auto-retry.js; every sentence in
// lib/winlink-outcome.js; main.js only runs the countdown and logs.
// Run: node test/winlink-auto-retry-test.js
'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const path = require('path');
const R = require('../lib/winlink-auto-retry');
const O = require('../lib/winlink-outcome');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js')).replace(/\r\n/g, '\n');
const popout = readSrc(path.join(root, 'renderer', 'winlink-popout.js'));
const popoutHtml = readSrc(path.join(root, 'renderer', 'winlink-popout.html'));
function fnBody(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  let depth = 0;
  for (let k = src.indexOf(') {', i) + 2; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error(name + ': unbalanced');
}
// A session that connected and dropped, as describeOutcome words it.
const dropOutcome = (extra = {}) => O.describeOutcome({ state: 'error', mode: 'ardop', gateway: 'KY4RY', dialed: true, connected: true, queued: 2, outbox: 2, ...extra });
const base = { mode: 'ardop', gateway: 'KY4RY', dialKhz: 7103, origin: 'mail window', enabled: true };

console.log('winlink: one automatic retry after a dropped link (#425)');

test('only after "dropped": the link had connected and ended before the exchange finished', () => {
  assert.strictEqual(dropOutcome().kind, 'dropped');
  assert.deepStrictEqual(R.shouldRetry({ ...base, outcome: dropOutcome() }), { retry: true, why: '' });
  const never = {
    'no answer': O.describeOutcome({ state: 'error', mode: 'ardop', gateway: 'KY4RY', dialed: true, hint: 'no-answer' }),
    'not connected': O.describeOutcome({ state: 'error', mode: 'ardop', gateway: 'KY4RY', dialed: true }),
    'the operator\'s Abort': O.describeOutcome({ state: 'error', mode: 'ardop', gateway: 'KY4RY', dialed: true, connected: true, cause: { kind: 'operator' } }),
    'stopped by POTACAT (stall)': O.describeOutcome({ state: 'error', mode: 'ardop', gateway: 'KY4RY', dialed: true, connected: true, cause: { kind: 'stall' } }),
    'a refused password': O.describeOutcome({ state: 'error', mode: 'ardop', gateway: 'KY4RY', dialed: true, connected: true, hint: 'login-failed' }),
    'a PTT refusal': O.describeOutcome({ state: 'error', mode: 'ardop', gateway: 'KY4RY', dialed: true, connected: true, cause: { kind: 'ptt-refused', detail: 'no PTT' } }),
    'a rig refusal before connect': O.describeOutcome({ state: 'error', mode: 'ardop', gateway: 'KY4RY', dialed: true, hint: 'rig-refused' }),
    'the SWR guard': O.describeOutcome({ state: 'error', mode: 'ardop', gateway: 'KY4RY', dialed: true, connected: true, cause: { kind: 'swr', detail: '3.1:1' } }),
    'the TX failsafe': O.describeOutcome({ state: 'error', mode: 'ardop', gateway: 'KY4RY', dialed: true, connected: true, cause: { kind: 'tx-failsafe' } }),
    'POTACAT closing': O.describeOutcome({ state: 'error', mode: 'ardop', gateway: 'KY4RY', dialed: true, connected: true, cause: { kind: 'closing' } }),
    'Winlink turned off': O.describeOutcome({ state: 'error', mode: 'ardop', gateway: 'KY4RY', dialed: true, connected: true, cause: { kind: 'turned-off' } }),
    'the modem closing its audio': O.describeOutcome({ state: 'error', mode: 'ardop', gateway: 'KY4RY', dialed: true, connected: true, modemAudioClosed: true }),
    'a session that could not start': O.describeOutcome({ state: 'error', mode: 'ardop', gateway: 'KY4RY', setupText: 'ardopcf is not answering' }),
    'a finished session': O.describeOutcome({ state: 'done', mode: 'ardop', gateway: 'KY4RY', sent: 1 }),
  };
  for (const [name, outcome] of Object.entries(never)) assert.strictEqual(R.shouldRetry({ ...base, outcome }).retry, false, name + ' (' + outcome.kind + ')');
});

test('once per session the operator started; never internet; never a Guest Pass; never with the setting off or Winlink stopping', () => {
  const d = dropOutcome();
  assert.deepStrictEqual(R.shouldRetry({ ...base, outcome: d, autoRetry: true }), { retry: false, why: 'this session was already the automatic retry (one per session)' });
  assert.strictEqual(R.shouldRetry({ ...base, mode: 'telnet', outcome: { kind: 'dropped' } }).retry, false);
  assert.strictEqual(R.shouldRetry({ ...base, origin: 'guest-pass', outcome: d }).retry, false);
  assert.strictEqual(R.shouldRetry({ ...base, origin: 'ECHOCAT Guest Pass', outcome: d }).retry, false);
  assert.strictEqual(R.shouldRetry({ ...base, origin: 'ECHOCAT device', outcome: d }).retry, true, 'the owner\'s phone or ECHOCAT Web: yes');
  assert.strictEqual(R.shouldRetry({ ...base, enabled: false, outcome: d }).retry, false);
  assert.strictEqual(R.shouldRetry({ ...base, enabled: undefined, outcome: d }).retry, true, 'on by default');
  assert.strictEqual(R.shouldRetry({ ...base, closing: true, outcome: d }).retry, false);
  assert.strictEqual(R.shouldRetry({ ...base, gateway: '', outcome: d }).retry, false);
  assert.strictEqual(R.shouldRetry({ ...base, dialKhz: 0, outcome: d }).retry, false);
  for (const mode of ['ardop', 'packet', 'vara', 'varafm', 'mercury']) assert.strictEqual(R.shouldRetry({ ...base, mode, outcome: d }).retry, true, mode);
});

test('the countdown: 20 s; the channel is listened to for the last 10 s; clear means go', () => {
  assert.strictEqual(R.COUNTDOWN_S, 20); assert.strictEqual(R.CLEAR_S, 10); assert.strictEqual(R.BUSY_WAIT_S, 60);
  const ok = { ok: true, why: '' };
  const t0 = 1e6, ends = t0 + 20000;
  assert.deepStrictEqual(R.step({ now: t0, endsAt: ends, radio: ok, channel: 'listening' }), { act: 'wait', state: 'counting', inS: 20 });
  assert.deepStrictEqual(R.step({ now: t0 + 12500, endsAt: ends, radio: ok, channel: 'listening' }), { act: 'wait', state: 'counting', inS: 8 });
  const w = new R.ChannelWatch();
  w.start(ends - 10000);
  for (let t = ends - 10000; t <= ends; t += 85) w.frame(false, t);
  assert.strictEqual(w.verdict(ends - 1, ends), 'listening', 'never before the countdown ends');
  assert.strictEqual(w.verdict(ends, ends), 'clear');
  assert.deepStrictEqual(R.step({ now: ends, endsAt: ends, radio: ok, channel: w.verdict(ends, ends) }), { act: 'start', state: 'starting' });
});

test('listening starts early enough that a clear channel reads clear exactly when the countdown reaches zero', () => {
  assert.ok(R.LISTEN_FROM_S > R.CLEAR_S && R.LISTEN_FROM_S < R.COUNTDOWN_S);
  const ends = 9e6, w = new R.ChannelWatch();
  w.start(ends - R.LISTEN_FROM_S * 1000);
  for (let t = ends - R.LISTEN_FROM_S * 1000 + 300; t <= ends; t += 85) w.frame(false, t); // the first frame comes a little after the start
  assert.strictEqual(w.verdict(ends, ends), 'clear', 'no "waiting for the channel" second on a clear channel (seen in the loopback before this)');
});

test('a busy channel: wait up to 60 s more for 10 s of clear, then give up and say so', () => {
  const ok = { ok: true, why: '' };
  const ends = 5e6;
  const w = new R.ChannelWatch();
  w.start(ends - 10000);
  let t = ends - 10000;
  for (; t < ends + 15000; t += 85) w.frame(true, t);                 // busy through the end and 15 s past it
  assert.strictEqual(w.verdict(t, ends), 'busy-wait');
  const st = R.step({ now: t, endsAt: ends, radio: ok, channel: 'busy-wait' });
  assert.strictEqual(st.act, 'wait'); assert.strictEqual(st.state, 'waiting-clear'); assert.strictEqual(st.waitedS, 15);
  for (; t < ends + 24000; t += 85) w.frame(false, t);                 // clear for 9 s: not yet
  assert.strictEqual(w.verdict(t, ends), 'busy-wait');
  for (; t < ends + 25100; t += 85) w.frame(false, t);                 // 10 s of clear
  assert.strictEqual(w.verdict(t, ends), 'clear');
  // Held busy the whole time: given up at 60 s.
  const h = new R.ChannelWatch();
  h.start(ends - 10000);
  let u = ends - 10000;
  for (; u <= ends + 60000; u += 85) h.frame(true, u);
  assert.strictEqual(h.verdict(u, ends), 'gave-up');
  assert.deepStrictEqual(R.step({ now: u, endsAt: ends, radio: ok, channel: 'gave-up' }), { act: 'skip', state: 'skipped', why: 'busy' });
  assert.strictEqual(O.retryText({ state: 'skipped', gateway: 'KY4RY', why: 'busy' }), 'Not retried: the channel stayed busy.');
  // A busy flicker resets the 10 s.
  const f = new R.ChannelWatch();
  f.start(0);
  for (let v = 0; v < 9000; v += 85) f.frame(false, v);
  f.frame(true, 9000);
  for (let v = 9085; v < 15000; v += 85) f.frame(false, v);
  assert.strictEqual(f.verdict(15000, 10000), 'busy-wait', 'clear since 9.1 s, not for 10 s');
});

test('no radio audio at all: the channel cannot be checked, so the retry is not made', () => {
  const w = new R.ChannelWatch();
  w.start(0);
  assert.strictEqual(w.verdict(R.NO_AUDIO_S * 1000 + 1, 10000), 'no-audio');
  const st = R.step({ now: 10000, endsAt: 10000, radio: { ok: true }, channel: 'no-audio' });
  assert.strictEqual(st.act, 'skip');
  assert.strictEqual(O.retryText({ state: 'skipped', why: st.why }), 'Not retried: no radio audio reached POTACAT, so the channel could not be checked.');
});

test('the radio must be free: nothing transmitting, the radio still Winlink\'s, the SWR guard clear, no session running', () => {
  assert.deepStrictEqual(R.radioReady({ radioOwner: 'none' }), { ok: true, why: '' });
  assert.deepStrictEqual(R.radioReady({ radioOwner: 'winlink' }), { ok: true, why: '' });
  assert.deepStrictEqual(R.radioReady({ transmitting: true }), { ok: false, why: 'something was transmitting' });
  assert.deepStrictEqual(R.radioReady({ radioOwner: 'jtcat' }), { ok: false, why: 'the radio is in use by jtcat' });
  assert.deepStrictEqual(R.radioReady({ swrTripped: true }), { ok: false, why: 'the SWR guard has tripped' });
  assert.deepStrictEqual(R.radioReady({ sessionActive: true }), { ok: false, why: 'another session is running' });
  // During the countdown a radio that is no longer free ends it at once; at the end it is checked again.
  const bad = { ok: false, why: 'the SWR guard has tripped' };
  assert.deepStrictEqual(R.step({ now: 0, endsAt: 20000, radio: bad, channel: 'listening' }), { act: 'skip', state: 'skipped', why: 'the SWR guard has tripped' });
  assert.deepStrictEqual(R.step({ now: 20000, endsAt: 20000, radio: bad, channel: 'clear' }), { act: 'skip', state: 'skipped', why: 'the SWR guard has tripped' });
  assert.deepStrictEqual(R.step({ now: 0, endsAt: 20000, tryNow: true, radio: bad, channel: 'listening' }).act, 'skip', 'Try now does not override the radio checks');
});

test('Try now starts at once without waiting for the channel (the operator\'s decision); Cancel and operator actions cancel it', () => {
  assert.deepStrictEqual(R.step({ now: 0, endsAt: 20000, tryNow: true, radio: { ok: true }, channel: 'listening' }), { act: 'start', state: 'starting' });
  assert.deepStrictEqual(R.step({ now: 30000, endsAt: 20000, tryNow: true, radio: { ok: true }, channel: 'busy-wait' }), { act: 'start', state: 'starting' });
  assert.strictEqual(R.cancelReason('cancel'), 'you cancelled it');
  for (const a of ['connect', 'gateway-pick', 'mode', 'dial', 'winlink-off', 'setting-off']) assert.ok(R.cancelReason(a), a);
  assert.strictEqual(R.cancelReason('nothing'), '');
});

test('the dial: a CAT radio tuned away cancels it; a radio with no CAT cannot be checked, so the countdown says where it must be', () => {
  assert.strictEqual(R.dialMoved({ nowHz: 7103000, dialKhz: 7103 }), false);
  assert.strictEqual(R.dialMoved({ nowHz: 7103080, dialKhz: 7103 }), false);
  assert.strictEqual(R.dialMoved({ nowHz: 7074000, dialKhz: 7103 }), true);
  assert.strictEqual(R.dialMoved({ noCat: true, nowHz: 7074000, dialKhz: 7103 }), false);
  assert.strictEqual(R.dialMoved({ nowHz: 0, dialKhz: 7103 }), false, 'no reading is not a move');
  assert.strictEqual(O.retryText({ state: 'counting', gateway: 'KY4RY', inS: 20 }), 'Trying KY4RY again in 20 s.');
  assert.strictEqual(O.retryText({ state: 'counting', gateway: 'KY4RY', inS: 14, noCat: true, dialKhz: 7103.5 }), 'Trying KY4RY again in 14 s. The radio must still be on 7.103.50 MHz.');
});

test('the sentences every surface shows, in one place', () => {
  assert.strictEqual(O.retryText({ state: 'starting', gateway: 'KY4RY' }), 'Trying KY4RY again now (automatic retry).');
  assert.strictEqual(O.retryText({ state: 'waiting-clear', gateway: 'KY4RY', waitedS: 12, maxWaitS: 60 }), 'Waiting for the channel to clear before trying KY4RY again (12 s of 60 s).');
  assert.strictEqual(O.retryText({ state: 'cancelled', why: 'you cancelled it' }), 'Not retried: you cancelled it.');
  assert.strictEqual(O.retryText({ state: 'skipped', why: 'the radio is in use by jtcat' }), 'Not retried: the radio is in use by jtcat.');
  // The retry dropped too: said so, and POTACAT does not try a third time.
  const again = dropOutcome({ autoRetry: true });
  assert.strictEqual(again.title, 'The link to KY4RY dropped again.');
  assert.strictEqual(again.next, 'POTACAT already tried once more by itself. Try another gateway or another band, or try again later.');
  assert.strictEqual(again.retry, true, 'the manual Try again is still offered');
  assert.strictEqual(R.shouldRetry({ ...base, outcome: again, autoRetry: true }).retry, false);
  // The summary line says it was the retry.
  const line = O.summaryLine({ mode: 'ardop', gateway: 'KY4RY', dialKhz: 7103, connected: true, autoRetry: true, outcome: again });
  assert.ok(/^session summary: the link dropped after it connected \(this was the automatic retry after a dropped link\); gateway KY4RY/.test(line), line);
  assert.ok(!/automatic retry/.test(O.summaryLine({ mode: 'ardop', gateway: 'KY4RY', outcome: dropOutcome() })));
  for (const t of [O.retryText({ state: 'counting', gateway: 'KY4RY', inS: 3 }), again.text]) assert.ok(!/[\u{1F300}-\u{1FAFF}!]/u.test(t), 'no emoji, no exclamation: ' + t);
});

test('wired: decided once per ended session, before the radio is put back; a pending retry keeps the radio on the gateway', () => {
  const end = fnBody(main, 'winlinkEndSession');
  const decide = end.indexOf('const retryWill = wasActive && state === \'error\' ? winlinkRetryDecide(s, outcome) : false;');
  assert.ok(decide > 0 && decide < end.indexOf('WinlinkReturn.atSessionEnd('), 'decided before the return');
  assert.ok(/windowOpen: winlinkMailWindowOpen\(\) \|\| retryWill/.test(end), 'kept like an open mail window while it waits');
  assert.ok(/_winlinkRetry\.holdsReturn = true;/.test(end), 'and goes back if the retry is not made');
  const dec = fnBody(main, 'winlinkRetryDecide');
  assert.ok(/WinlinkAutoRetry\.shouldRetry\(\{ outcome, mode: s\.mode, gateway: s\.gateway, dialKhz: s\.dialKhz, origin: s\.origin, autoRetry: s\.autoRetry, enabled: settings\.winlinkAutoRetry !== false \}\)/.test(dec));
  assert.ok(/automatic retry scheduled: /.test(dec) && /automatic retry skipped: \$\{d\.why\}/.test(dec), 'scheduled and skipped are logged');
  assert.ok(/url: s\.url \|\| ''/.test(dec), 'the same url');
});

test('wired: the retry is the same gateway, dial, mode and url, marked as the retry; one log line each for started, cancelled, skipped', () => {
  const start = fnBody(main, 'winlinkRetryStart');
  assert.ok(/winlinkStartSession\(\{ mode: r\.mode, gateway: r\.gateway, dialKhz: r\.dialKhz, url: r\.url, origin: 'automatic retry', autoRetry: true \}\)/.test(start));
  assert.ok(/automatic retry started: /.test(start));
  assert.ok(/automatic retry cancelled: /.test(fnBody(main, 'winlinkRetryEnd')) && /automatic retry skipped: /.test(fnBody(main, 'winlinkRetryEnd')));
  const ss = main.slice(main.indexOf('async function winlinkStartSession('), main.indexOf('async function winlinkEnterFmDataBeforeDial('));
  assert.ok(/origin: String\(origin \|\| 'operator'\), autoRetry: !!autoRetry,/.test(ss), 'the session records both');
  assert.ok(/autoRetry: !!s\.autoRetry, origin: s\.origin \|\| ''/.test(fnBody(main, 'winlinkOutcomeFacts')), 'the outcome and the summary line know it');
});

test('wired: the checks at the end of the countdown use the real state', () => {
  const tick = fnBody(main, 'winlinkRetryTick');
  assert.ok(/WinlinkAutoRetry\.radioReady\(\{ transmitting: winlinkAnyTx\(\), radioOwner, swrTripped: _swrTripped, sessionActive: winlinkSessionActive\(\) \}\)/.test(tick));
  assert.ok(/WinlinkAutoRetry\.dialMoved\(\{ noCat: r\.noCat, nowHz: _currentFreqHz, dialKhz: r\.dialKhz \}\)/.test(tick));
  assert.ok(/r\.watch\.start\(now\)/.test(tick) && /r\.endsAt - WinlinkAutoRetry\.LISTEN_FROM_S \* 1000/.test(tick));
  assert.ok(/_remoteTxState \|\| \(cat && cat\._transmitting\) \|\| winlinkTxActive \|\| mercuryTxActive/.test(fnBody(main, 'winlinkAnyTx')));
  assert.ok(/settings\.catTarget && settings\.catTarget\.type === 'none'/.test(fnBody(main, 'winlinkNoCat')));
  // The channel check is the same busy detector the waterfall uses, on the radio audio main has.
  const feed = fnBody(main, 'winlinkRetryFeed');
  assert.ok(/new WinlinkSpectrum\.BusyDetector\(band\.lo, band\.hi\)/.test(feed) && /WinlinkSpectrum\.markerBand\(r\.mode, winlinkModemBw\(\)\)/.test(feed));
  assert.ok(/if \(_winlinkRetry\) winlinkRetryFeed\(pcm, sampleRate\);/.test(fnBody(main, 'winlinkFeedRx')));
  assert.ok(/winlinkSessionActive\(\) \|\| _winlinkRetry\);/.test(fnBody(main, 'modemBridgeWanted')), 'a sound-device radio keeps sending audio while it waits');
});

test('wired: Cancel, Try now and every operator action that changes the mode or gateway', () => {
  assert.ok(/ipcMain\.handle\('winlink-cmd-retry', \(_e, op\) => winlinkRetryCommand\(String\(op \|\| ''\)\)\);/.test(main));
  const connect = main.slice(main.indexOf("ipcMain.handle('winlink-cmd-connect'"), main.indexOf("ipcMain.on('winlink-cmd-abort'"));
  assert.ok(connect.indexOf("winlinkRetryCancel('connect');") > 0 && connect.indexOf("winlinkRetryCancel('connect');") < connect.indexOf('return winlinkStartSession('));
  assert.ok(/ipcMain\.handle\('winlink-cmd-qsy', \(_e, o = \{\}\) => \{ winlinkRetryCancel\('gateway-pick'\); return winlinkPreviewQsy\(o\); \}\);/.test(main));
  const remote = fnBody(main, 'winlinkHandleRemote');
  assert.ok(/case 'winlink-connect':[\s\S]{0,120}winlinkRetryCancel\('connect'\);/.test(remote));
  assert.ok(/case 'winlink-qsy':\n\s*winlinkRetryCancel\('gateway-pick'\);/.test(remote));
  assert.ok(/case 'winlink-retry':[\s\S]{0,120}winlinkRetryCommand\(String\(req\.op \|\| ''\)\)/.test(remote));
  assert.ok(/if \(_winlinkRetry && mode !== _winlinkRetry\.mode\) winlinkRetryCancel\('mode'\);/.test(fnBody(main, 'winlinkSetMode')));
  assert.ok(/^function disconnectWinlink\(\{ quit \} = \{\}\) \{\n {2}winlinkRetryCancel\('winlink-off'\);/.test(fnBody(main, 'disconnectWinlink')), 'first, before the session it may end (whose cause, turned-off or closing, is never retried)');
  assert.ok(/if \(settings\.winlinkAutoRetry === false\) winlinkRetryCancel\('setting-off'\);/.test(main));
  assert.ok(/!winlinkSessionActive\(\) && !_winlinkRetry && settings\.winlinkPassword/.test(fnBody(main, 'winlinkArmAutoCheck')), 'the internet auto-check waits');
});

test('surfaces: the Mail window card shows the countdown with Try now and Cancel; the wire carries it to every device', () => {
  assert.ok(/id="wl-done-retrynow" hidden>Try now</.test(popoutHtml) && /id="wl-done-retrycancel" hidden>Cancel</.test(popoutHtml) && /id="wl-done-auto"/.test(popoutHtml));
  assert.ok(/window\.api\.retry\('now'\)/.test(popout) && /window\.api\.retry\('cancel'\)/.test(popout));
  assert.ok(/auto\.textContent = bad\.retryText \|\| '';/.test(popout), 'the words are the shack\'s');
  assert.ok(/\$\('wl-done-retry'\)\.hidden = waiting;/.test(popout), 'no Try again while the retry waits');
  const proto = readSrc(path.join(root, 'lib', 'echocat-protocol.js'));
  assert.ok(/'winlink-retry': \{ dir: Dir\.C2S, feature: 'winlink', fields: \{ op: f\.string, reqId: f\.optString \} \}/.test(proto));
  assert.ok(/retryState \('counting' \| 'waiting-clear'/.test(proto) && /retryInS/.test(proto) && /retryText/.test(proto));
  const rs = readSrc(path.join(root, 'lib', 'remote-server.js'));
  const i = rs.indexOf("case 'winlink-retry':");
  assert.ok(i > 0 && i < rs.indexOf("if (ws._passSession) { this._sendTo(ws, { type: 'winlink-refused', reason: 'guest-pass', reqId }); break; }", i), 'a Guest Pass is refused before main hears it');
  assert.ok(/\.\.\.winlinkRetryFields\(now\.outcome\)/.test(fnBody(main, 'winlinkSettleOutcome')), 'the Outbox sentence a moment later keeps the countdown');
});

test('Settings > Station > Winlink: on by default, beside the other Winlink options', () => {
  const html = readSrc(path.join(root, 'renderer', 'index.html'));
  const app = readSrc(path.join(root, 'renderer', 'app.js'));
  const box = html.indexOf('<input type="checkbox" id="set-winlink-auto-retry" checked> Try again once by itself when a link drops</label>');
  assert.ok(box > html.indexOf('id="set-winlink-prediction"') && box < html.indexOf('id="set-winlink-cap"'));
  assert.ok(/setWinlinkAutoRetry\.checked = s\.winlinkAutoRetry !== false;/.test(app));
  assert.ok(/winlinkAutoRetry: setWinlinkAutoRetry \? setWinlinkAutoRetry\.checked : true,/.test(app));
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/winlink-auto-retry-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
