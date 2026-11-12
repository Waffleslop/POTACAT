#!/usr/bin/env node
'use strict';
// How a Winlink session ended, in the words every surface shows (#425).
//
// AE5JE, ARDOP on 40 m: sessions connected, moved data for up to three
// minutes, dropped, and the status bar read
//   Failed connect: HTTP 500 — Session failure {"NumReceived":0}
// The rule this file guards: an ending is worded in ONE place
// (lib/winlink-outcome.js) from what POTACAT saw; Pat's reply never reaches a
// status; a link that had connected never reads "Failed connect"; and every
// session leaves one summary line in the log that a Report a Bug carries.
// Fake Pat, real sockets, real WinlinkClient; main.js's own functions run in a
// sandbox for the summary line.
// Run: node test/winlink-outcome-test.js
const assert = require('assert');
const http = require('http');
const path = require('path');
const vm = require('vm');
const { readSrc } = require('./_src');
const O = require('../lib/winlink-outcome');
const D = require('../lib/winlink-diag');
const H = require('../lib/winlink-history');
const { WinlinkClient, PatHttpError } = require('../lib/winlink-client');
const { WinlinkState } = require('../lib/winlink-state');
const WinlinkModes = require('../lib/winlink-modes');

let pass = 0, fail = 0;
const pending = [];
function test(name, fn) {
  pending.push(async () => {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
  });
}

const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));

function fnBody(src, name) {
  let i = src.indexOf(`async function ${name}(`);
  if (i < 0) i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} exists`);
  let depth = 0;
  const j = src.indexOf(') {', i) + 2;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error(`${name}: unbalanced`);
}

/** A fake Pat: `handler(req, res)` answers. */
function fakePat(handler) {
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => handler(req, res)); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  })));
}

// Pat v1.0.0 api/api.go ConnectHandler: http.Error(w, "Session failure", 500)
// and then, in the same body, the Inbox count as JSON.
const PAT_BODIES = [
  'Session failure\n{"NumReceived":0}\n',
  'Session failure\n{"NumReceived":2}\n',
  'Session failure\n',
];
// What reached the status bar before this change, word for word.
const OLD_STATUS = 'connect: HTTP 500 — Session failure\n{"NumReceived":0}';

// Nothing of Pat's, of HTTP or of JSON, in any status on any surface.
const FORBIDDEN = [/HTTP\s*\d{3}/i, /Failed connect/i, /Session failure/i, /NumReceived/i, /[{}]/, /^\s*connect\s*:/i, /\bundefined\b/, /\bnull\b/, /\bNaN\b/, /\[object/, /\n/];
function assertPlain(text, what) {
  assert.ok(typeof text === 'string' && text.trim().length > 10, `${what}: a sentence, got ${JSON.stringify(text)}`);
  for (const re of FORBIDDEN) assert.ok(!re.test(text), `${what}: ${re} in ${JSON.stringify(text)}`);
  assert.ok(/[.!?…]$/.test(text), `${what}: ends as a sentence: ${JSON.stringify(text)}`);
  assert.ok(!/\p{Extended_Pictographic}/u.test(text), `${what}: no emoji`);
}

console.log('Winlink: how a session ended (#425)');

const base = { state: 'error', mode: 'ardop', gateway: 'ky4ry', dialed: true };
const NEXT = 'Try again, or try another gateway or another band.';

// ── the three cases the report could not tell apart ─────────────────────────

test('never connected: the gateway did not answer, the mail is still in the Outbox, try another gateway or band', () => {
  const o = O.describeOutcome({ ...base, connected: false, hint: 'no-answer', hintText: 'KY4RY did not answer — try another gateway or band', queued: 2, outbox: 2 });
  assert.strictEqual(o.text, `KY4RY did not answer. 2 messages are still in your Outbox. ${NEXT}`);
  assert.strictEqual(o.kind, 'no-answer'); assert.strictEqual(o.word, 'No answer'); assert.strictEqual(o.errorKind, 'no-answer');
  assert.strictEqual(o.retry, true);
  const u = O.describeOutcome({ ...base, connected: false, queued: 1, outbox: 1 });
  assert.strictEqual(u.text, `The call to KY4RY did not connect. 1 message is still in your Outbox. ${NEXT}`);
  assert.strictEqual(u.kind, 'not-connected'); assert.strictEqual(u.word, 'Not connected');
});

test('connected, then the link dropped: says so, with what moved and what is still in the Outbox', () => {
  const o = O.describeOutcome({ ...base, connected: true, queued: 3, outbox: 2, received: 0 });
  assert.strictEqual(o.text, `The link to KY4RY dropped before the mail exchange finished. So far: 1 sent, 0 received. 2 messages are still in your Outbox and will go on the next try. ${NEXT}`);
  assert.strictEqual(o.kind, 'dropped'); assert.strictEqual(o.word, 'Link dropped'); assert.strictEqual(o.errorKind, 'dropped');
  assert.strictEqual(o.title, 'The link to KY4RY dropped before the mail exchange finished.');
  assert.strictEqual(o.next, NEXT);
  assert.strictEqual(o.retry, true);
  assert.ok(!/fail/i.test(o.word + o.text), 'a session that connected never reads "Failed"');
});

test('the exchange finished: the sentence every surface already showed', () => {
  const o = O.describeOutcome({ state: 'done', mode: 'ardop', gateway: 'KY4RY', sent: 1, received: 0, connected: true, dialed: true });
  assert.strictEqual(o.text, 'Sent 1 message via KY4RY (ARDOP); no new mail.');
  assert.strictEqual(o.word, 'Finished'); assert.strictEqual(o.ok, true); assert.strictEqual(o.errorKind, '');
  assert.strictEqual(O.describeOutcome({ state: 'done', mode: 'telnet', sent: 0, received: 2 }).text, 'Checked mail over the internet — nothing to send; 2 new messages in your Inbox.');
  // a cause noted on the way (a refused key-down that was retried) never spoils a session that finished
  assert.strictEqual(O.describeOutcome({ state: 'done', mode: 'vara', gateway: 'W1AW', sent: 2, received: 1, cause: { kind: 'swr' } }).text, 'Sent 2 messages via W1AW (VARA HF); 1 new message in your Inbox.');
});

// ── only what POTACAT can read back is claimed ──────────────────────────────

test('what moved is claimed only from what was read back: the Outbox before and after, and Pat\'s Inbox count', () => {
  // The Outbox not read yet (the first push, or Pat gone): no word about it, and no sent count.
  const first = O.describeOutcome({ ...base, connected: true, queued: 2, outbox: null, received: 0 });
  assert.strictEqual(first.text, `The link to KY4RY dropped before the mail exchange finished. So far: 0 received. ${NEXT}`);
  // Nothing known at all: nothing claimed.
  const none = O.describeOutcome({ ...base, connected: true });
  assert.strictEqual(none.text, `The link to KY4RY dropped before the mail exchange finished. ${NEXT}`);
  // Everything queued went: said, because the Outbox was read and is empty.
  const all = O.describeOutcome({ ...base, connected: true, queued: 2, outbox: 0, received: 1 });
  assert.strictEqual(all.detail, 'So far: 2 sent, 1 received. Your Outbox is empty: everything you wrote was sent.');
  // Nothing was queued: an empty Outbox is not news.
  assert.strictEqual(O.describeOutcome({ ...base, connected: true, queued: 0, outbox: 0, received: 0 }).detail, 'So far: 0 sent, 0 received.');
  // A message written during the session never makes "sent" negative.
  assert.strictEqual(O.movedFacts({ queued: 1, outbox: 3 }).sent, 0);
  assert.deepStrictEqual(O.movedFacts({}), { sent: null, received: null, outbox: null, queued: null });
  // "Nothing was lost" is never said: POTACAT cannot know what the gateway still holds.
  for (const o of [first, none, all]) assert.ok(!/nothing was lost/i.test(o.text));
});

test('Pat\'s reply body gives the Inbox count for a session that did not finish', () => {
  assert.strictEqual(O.receivedFromPatBody(PAT_BODIES[0]), 0);
  assert.strictEqual(O.receivedFromPatBody(PAT_BODIES[1]), 2);
  assert.strictEqual(O.receivedFromPatBody(PAT_BODIES[2]), null);
  assert.strictEqual(O.receivedFromPatBody(''), null);
});

// ── a cause POTACAT knows is named ──────────────────────────────────────────

test('a cause known from POTACAT\'s side is named, in the same words its log line uses', () => {
  const c = (kind, detail, extra = {}) => O.describeOutcome({ ...base, connected: true, queued: 1, outbox: 1, received: 0, cause: { kind, detail }, ...extra });
  const moved = 'So far: 0 sent, 0 received. 1 message is still in your Outbox and will go on the next try.';
  assert.strictEqual(c('stall').text, `POTACAT stopped the session: nothing moved for 3 minutes. ${moved} ${NEXT}`);
  assert.strictEqual(c('cap', '', { capMin: 30 }).text, `POTACAT stopped the session at its 30-minute limit. ${moved} Press Send / Receive again to carry on.`);
  assert.strictEqual(c('operator').text, `You stopped the session. ${moved}`);
  assert.strictEqual(c('swr', 'SWR 3.4:1').text, `POTACAT stopped transmitting: the SWR guard tripped (SWR 3.4:1). ${moved} Check the antenna and its match, then try again.`);
  assert.strictEqual(c('ptt-refused', '149.090.00 MHz is outside the bands this radio transmits on').text, `The radio did not transmit: 149.090.00 MHz is outside the bands this radio transmits on. ${moved} Put that right, then try again.`);
  assert.strictEqual(c('tx-failsafe').text, `POTACAT stopped the session: the transmitter stayed keyed for 30 seconds, so POTACAT unkeyed it. ${moved} Check that the radio has gone back to receive, then try again.`);
  assert.strictEqual(c('audio-device', 'USB Audio CODEC was unplugged').title, 'The radio\'s sound device stopped: USB Audio CODEC was unplugged.');
  assert.strictEqual(c('audio-stopped').title, 'POTACAT\'s modem audio stopped, so the session could not go on.');
  assert.strictEqual(c('modem-stopped').title, 'The modem (ardopcf) stopped during the session.');
  assert.strictEqual(c('modem-stopped', '', { mode: 'packet' }).title, 'The modem (Dire Wolf) stopped during the session.');
  assert.strictEqual(c('pat-stopped').title, 'The Winlink mail program (Pat) stopped during the session.');
  assert.strictEqual(c('pat-lost').title, 'POTACAT lost touch with the Winlink mail program (Pat) during the session.');
  assert.strictEqual(c('closing').title, 'The session ended because POTACAT was closing.');
  assert.strictEqual(c('stopped', 'another reason').title, 'POTACAT stopped the session: another reason.');
  for (const k of ['stall', 'cap', 'operator', 'swr', 'ptt-refused', 'tx-failsafe', 'audio-device', 'audio-stopped', 'modem-stopped', 'preempted', 'internal', 'closing', 'turned-off', 'stopped']) {
    assert.strictEqual(c(k).word, 'Stopped', k);
    assert.strictEqual(c(k).errorKind, 'stopped', k);
  }
  // the watchdog is the only stop where the same gateway again is the obvious next step
  assert.strictEqual(c('stall').retry, true);
  assert.strictEqual(c('operator').retry, false);
  // main.js names every kind it passes, and each has its sentence
  const used = [...main.matchAll(/winlinkAbortSession\([^\n]*?, \{ kind: '([a-z-]+)'/g)].map((m) => m[1])
    .concat([...main.matchAll(/winlinkNoteCause\((?:quit \? )?'([a-z-]+)'(?: : '([a-z-]+)')?/g)].flatMap((m) => [m[1], m[2]].filter(Boolean)));
  assert.ok(used.length >= 14, `found ${used.length} cause kinds in main.js`);
  for (const k of used) assert.ok(O.CAUSE_KINDS.includes(k), `main.js passes cause '${k}', which has no sentence`);
  for (const k of ['stall', 'cap', 'operator', 'swr', 'ptt-refused', 'tx-failsafe', 'audio-device', 'audio-stopped', 'modem-stopped', 'pat-stopped', 'pat-lost', 'closing', 'turned-off', 'internal', 'preempted']) assert.ok(used.includes(k), `main.js names the cause '${k}'`);
});

test('the modem closing its audio connection, cut transmit audio and the modem\'s own ending are said when they are known', () => {
  const closed = O.describeOutcome({ ...base, connected: true, modemAudioClosed: true });
  assert.strictEqual(closed.title, 'The modem (ardopcf) closed its audio connection to POTACAT, and the link to KY4RY ended before the mail exchange finished.');
  assert.strictEqual(closed.kind, 'modem-audio-closed'); assert.strictEqual(closed.word, 'Link dropped');
  const cut = O.describeOutcome({ ...base, connected: true, txCutMs: 240 });
  assert.ok(cut.text.includes('POTACAT\'s transmit audio was interrupted for 240 ms during the session, which can break a link.'), cut.text);
  const to = O.describeOutcome({ ...base, connected: true, modemEnd: { by: 'timeout' } });
  assert.strictEqual(to.title, 'The link to KY4RY dropped before the mail exchange finished: nothing got through for 90 seconds, so the modem ended the link.');
  const gw = O.describeOutcome({ ...base, connected: true, modemEnd: { by: 'gateway' } });
  assert.strictEqual(gw.title, 'The link to KY4RY dropped before the mail exchange finished: KY4RY ended the link.');
  // Pat hanging up after the link was already lost is consequence, not cause: not said.
  assert.strictEqual(O.describeOutcome({ ...base, connected: true, modemEnd: { by: 'host' } }).title, 'The link to KY4RY dropped before the mail exchange finished.');
  // no blame on the operator where the cause is not known
  for (const o of [closed, cut, to, gw]) assert.ok(!/\byou(r)? (did|should|must|forgot|failed)\b/i.test(o.text), o.text);
  assert.strictEqual(O.PAT_ARDOP_ARQ_TIMEOUT_S, 90, 'wl2k-go transport/ardop DefaultARQTimeout');
});

test('a refused password, a modem that is not answering and a session that could not start keep their own sentence', () => {
  const pw = O.describeOutcome({ ...base, connected: true, hint: 'login-failed', hintText: 'Winlink refused the password for K3SBP — check it in Settings > Station > Winlink (a password made before 2018 must be typed in CAPITALS)' });
  assert.strictEqual(pw.kind, 'login-failed'); assert.strictEqual(pw.errorKind, 'login-failed', 'the phone offers Fix password on this kind');
  assert.ok(/^Winlink refused the password for K3SBP/.test(pw.text), 'not a dropped link');
  const down = O.describeOutcome({ ...base, connected: false, hint: 'transport-down', hintText: 'ardopcf is not answering — see the [Winlink] ardop lines above' });
  assert.strictEqual(down.title, 'ardopcf is not answering — see the [Winlink] ardop lines above.');
  assert.strictEqual(down.errorKind, 'transport-down');
  // before any call: POTACAT's own reason, and the vara-* kind the phone knows
  const setup = O.describeOutcome({ state: 'error', mode: 'vara', gateway: 'W1AW', dialed: false, hint: 'vara-not-running', setupText: 'VARA HF is not running on the shack PC — start it there (with its PTT set to VOX), or turn on "Start VARA for me" in Settings > Station > Winlink' });
  assert.strictEqual(setup.kind, 'setup'); assert.strictEqual(setup.errorKind, 'vara-not-running');
  assert.ok(/^VARA HF is not running on the shack PC/.test(setup.text));
  assert.ok(!/dropped|did not answer/.test(setup.text));
  // a link that came up and then timed out is a drop, not "did not answer"
  assert.strictEqual(O.describeOutcome({ ...base, connected: true, hint: 'no-answer', hintText: 'KY4RY did not answer' }).kind, 'dropped');
});

test('internet sessions say internet, not gateway or band', () => {
  const never = O.describeOutcome({ state: 'error', mode: 'telnet', dialed: true, connected: false });
  assert.strictEqual(never.text, 'Could not reach Winlink over the internet. Check this computer\'s internet connection, then try again.');
  const drop = O.describeOutcome({ state: 'error', mode: 'telnet', dialed: true, connected: true, queued: 1, outbox: 1, received: 0 });
  assert.strictEqual(drop.text, 'The internet connection to Winlink closed before the mail exchange finished. So far: 0 sent, 0 received. 1 message is still in your Outbox and will go on the next try. Check this computer\'s internet connection, then try again.');
  assert.strictEqual(never.retry, false);
});

// ── the guard: nothing of Pat's in any status ───────────────────────────────

test('GUARD: Pat\'s real replies through the real client; no outcome on any path says HTTP 500, Failed connect or JSON', async () => {
  const raws = [OLD_STATUS];
  for (const body of PAT_BODIES) {
    const pat = await fakePat((req, res) => { res.statusCode = 500; res.end(body); });
    const c = new WinlinkClient({ port: pat.port });
    let err;
    try { await c.connect('ardop:///KY4RY?bw=2000MAX&freq=7100.5'); } catch (e) { err = e; }
    await pat.close();
    assert.ok(err instanceof PatHttpError && err.status === 500, 'Pat\'s 500');
    assert.ok(/HTTP 500/.test(err.message), 'the raw reply is what it was (it goes to the log)');
    raws.push(err.message, String(err.body), `Failed ${err.message}`, `Stopped: ${err.message}`);
  }
  raws.push('connect: lost the connection to Pat before it answered (ECONNRESET)', '{"error":"x"}', 'HTTP 502 Bad Gateway');
  const modes = ['telnet', 'ardop', 'packet', 'vara', 'varafm', 'mercury'];
  const hints = ['', 'login-failed', 'no-answer', 'transport-down', 'rig-refused', 'busy', 'stopped', 'vara-not-answering'];
  const causes = [null, ...O.CAUSE_KINDS.map((k) => ({ kind: k })), { kind: 'not-a-kind' }];
  const counts = [{}, { queued: 2, outbox: 2, received: 0 }, { queued: 2, outbox: 0, received: 3 }, { queued: null, outbox: null, received: null }];
  let n = 0;
  for (const raw of raws) for (const mode of modes) for (const connected of [false, true]) for (const dialed of [false, true]) for (const hint of hints) for (const cause of causes) for (const cnt of counts) {
    const o = O.describeOutcome({
      state: 'error', mode, gateway: 'W1AW-10', dialed, connected, hint, hintText: raw, setupText: raw,
      cause: cause ? { ...cause, detail: raw } : null, ...cnt,
      modemEnd: n % 3 === 0 ? { by: 'timeout', text: raw } : null, modemAudioClosed: n % 5 === 0, txCutMs: n % 7 === 0 ? 120 : 0, capMin: 30,
    });
    n++;
    const what = `${mode} connected=${connected} dialed=${dialed} hint=${hint} cause=${cause && cause.kind}`;
    assertPlain(o.text, what);
    assertPlain(o.title, what + ' (title)');
    assert.ok(o.word && !/[{}]|HTTP/.test(o.word), what);
    assert.ok(o.text.startsWith(o.title), what);
    assert.ok(o.text.length <= 620, `${what}: ${o.text.length} characters`);
    // A session that had connected never reads "Failed connect", in the label or the sentence.
    if (connected) assert.ok(!/^Failed\W+connect\b/i.test(`${o.word} ${o.text}`) && !/did not (connect|answer)/i.test(o.title), `${what}: ${o.word} ${o.text}`);
    // The label a link that dropped gets is never "Failed".
    if (connected && dialed && !cause && hint !== 'login-failed') assert.notStrictEqual(o.word, 'Failed', what);
  }
  assert.ok(n > 10000, `${n} combinations`);
  // the done sentence too
  for (const mode of modes) assertPlain(O.describeOutcome({ state: 'done', mode, gateway: 'W1AW-10', sent: 1, received: 1 }).text, `done ${mode}`);
});

test('plainReason takes Pat\'s reply out of a reason and keeps the meaning of POTACAT\'s own', () => {
  assert.strictEqual(O.plainReason(OLD_STATUS), '');
  assert.strictEqual(O.plainReason('Stopped: nothing moved for 3 minutes'), 'nothing moved for 3 minutes');
  assert.strictEqual(O.plainReason('14.074.00 MHz is on the SDR; the radio is on 7.103.50 MHz'), '14.074.00 MHz is on the SDR; the radio is on 7.103.50 MHz');
  assert.ok(O.plainReason('x'.repeat(900)).length <= 260);
});

// ── the history's Last result ───────────────────────────────────────────────

test('the gateway history uses the same words, and never Pat\'s error text', () => {
  assert.strictEqual(H.resultText({ connected: true, error: 'EOF' }), 'Link dropped before the mail exchange finished');
  assert.strictEqual(H.resultText({ exchanged: true, sent: 1, received: 2 }), 'Mail exchanged (1 sent, 2 received)');
  assert.strictEqual(H.resultText({ error: 'Connect timeout' }), 'Did not answer');
  assert.strictEqual(H.resultText({ error: 'some new Go error: {"a":1} HTTP 500' }), 'Did not connect');
  const ev = [
    '{"log_time":"2026-11-12T01:00:00Z","what":"connect","operation":"connect ardop:///KY4RY?bw=2000MAX&freq=7100.5","success":true}',
    '{"log_time":"2026-11-12T01:03:00Z","what":"exchange","targetcall":"KY4RY","success":false,"error":"EOF"}',
  ].join('\n');
  assert.strictEqual(H.parseEvents(ev)[0].result, 'Link dropped before the mail exchange finished');
});

// ── which side ended an ARDOP link (ardopcf 1.0.4.1.3's own lines) ───────────

// The shapes are ardopcf's source strings (ARDOPC.c, ARQ.c, HostInterface.c,
// TCPHostInterface.c) in its log format; the last block is K3SBP's real
// 2026-11-11 session to KY4RY, which Pat ended after a finished exchange.
const TIMEOUT_LINES = [
  '01:00:26.273 I [SendARQConnectRequest] MYCALL=AE5JE  TARGET=KY4RY bytPendingSessionID=ad',
  '01:00:29.857 D  Command Trace TO Host CONNECTED KY4RY 2000',
  '01:00:31.278 D  Command Trace TO Host NEWSTATE ISS ',
  '01:02:59.242 D  Command Trace TO Host NEWSTATE IRS ',
  '01:04:29.300 D [ARDOPprotocol.GetNexARQFrame] Timeout setting SendTimeout timer to start.',
  '01:04:30.301 D ARDOPprotocol.tmrSendTimeout]  ARQ Timeout from ProtocolState: IRS Going to DISC state',
  '01:04:30.302 D  Command Trace TO Host DISCONNECTED',
  '01:04:30.302 D  Command Trace TO Host STATUS ARQ Timeout from Protocol State:  IRS',
  '01:04:32.100 D  Command Trace TO Host NEWSTATE DISC ',
  '01:04:32.150 D [Command Trace FROM host: DISCONNECT]',
];
const GATEWAY_LINES = [
  '01:00:29.857 D  Command Trace TO Host CONNECTED KY4RY 500',
  '01:00:31.278 D  Command Trace TO Host NEWSTATE ISS ',
  '01:03:01.000 I [ARDOPprotocol.ProcessRcvdARQFrame]  DISC frame received Send END...go to DISC state',
  '01:03:01.001 D  Command Trace TO Host DISCONNECTED',
  '01:03:01.002 I [STATUS: ARQ CONNECTION ENDED WITH KY4RY]',
];
const CLEAN_LINES = [
  '22:20:59.857 D  Command Trace TO Host CONNECTED KY4RY 2000',
  '22:23:14.100 D  Command Trace TO Host NEWSTATE IDLE ',
  '22:23:14.100 D [Command Trace FROM host: DISCONNECT]',
  '22:23:16.883 D  Command Trace TO Host STATUS INITIATING ARQ DISCONNECT',
  '22:23:18.567 I [ARDOPprotocol.ProcessRcvdARQFrame]  END received ... going to DISC state',
  '22:23:18.569 D  Command Trace TO Host DISCONNECTED',
  '22:23:26.058 D  Command Trace TO Host NEWSTATE DISC ',
];
function story(lines) {
  const s = new D.ArdopLinkStory();
  for (const l of lines) s.note(D.classifyArdopDebugLine(l));
  return s.snapshot();
}

test('the modem\'s own lines say its last state and which side ended the link', () => {
  const t = story(TIMEOUT_LINES);
  assert.strictEqual(t.end.by, 'timeout'); assert.strictEqual(t.end.state, 'IRS');
  assert.strictEqual(t.stateText, 'IRS, then DISCONNECTED');
  assert.ok(t.connected);
  assert.strictEqual(story(GATEWAY_LINES).end.by, 'gateway');
  assert.strictEqual(story(GATEWAY_LINES).stateText, 'ISS, then DISCONNECTED');
  assert.strictEqual(story(CLEAN_LINES).end.by, 'host', 'Pat asked: the END that answers it is not a second ending');
  // the first ending is the cause; Pat's DISCONNECT after a timeout is consequence
  assert.strictEqual(story([...TIMEOUT_LINES, ...GATEWAY_LINES.slice(2)]).end.by, 'timeout');
  // a new call starts a new story
  assert.strictEqual(story([...TIMEOUT_LINES, TIMEOUT_LINES[0]]).end, null);
  // the state changes on every over: followed, kept for a report, never a session-log line of its own
  assert.strictEqual(D.classifyArdopDebugLine(TIMEOUT_LINES[2]).quiet, true);
  assert.strictEqual(D.classifyArdopDebugLine(TIMEOUT_LINES[7]).quiet, true);
  assert.ok(!D.classifyArdopDebugLine(TIMEOUT_LINES[5]).quiet, 'the timeout is said in the session log');
  assert.ok(/if \(ev && _winlinkLinkStory\) _winlinkLinkStory\.note\(ev\);[^\n]*\n\s*if \(ev && !ev\.quiet\) for \(const o of t\.log\.feed\(ev, now\)\) winlinkLog\('ardop: ' \+ o\);/.test(main), 'wired in the tail');
  assert.strictEqual(O.endedByText({ modemEnd: t.end, mode: 'ardop' }).startsWith('this station\'s modem, on its ARQ timeout'), true);
  assert.ok(/^the gateway/.test(O.endedByText({ modemEnd: story(GATEWAY_LINES).end, mode: 'ardop' })));
  assert.strictEqual(O.endedByText({ mode: 'vara' }), 'not reported by this modem');
  assert.strictEqual(O.endedByText({ mode: 'ardop' }), 'the modem did not say');
  assert.ok(/^POTACAT \(stall\)/.test(O.endedByText({ cause: { kind: 'stall' }, modemEnd: t.end, mode: 'ardop' })), 'POTACAT\'s own stop is named first');
});

// ── B1: the one summary line ────────────────────────────────────────────────

test('the summary line carries the gateway, dial, mode, duration, what moved, the modem\'s last state, who ended it and Pat\'s reply', () => {
  const t = story(TIMEOUT_LINES);
  const facts = { ...base, dialKhz: 7100.5, connected: true, queued: 2, outbox: 2, received: 0, modemEnd: t.end };
  const line = O.summaryLine({
    ...facts, outcome: O.describeOutcome(facts), ranMs: 251000, connectedMs: 181000,
    inProgress: 'sending one at 43% of 12345 bytes when it ended',
    modemState: t.stateText, endedBy: O.endedByText({ modemEnd: t.end, mode: 'ardop' }),
    audio: 'radio to modem 240 s, largest gap 12 ms; modem to radio 95 s, largest gap 0 ms (modem side 12000 samples/s)',
    patLine: '2026/11/12 01:04:32 Exchange failed: EOF', raw: OLD_STATUS,
  });
  assert.strictEqual(line,
    'session summary: the link dropped after it connected; gateway KY4RY; dial 7100.5 kHz; mode ARDOP; ran 4 min 11 s (connected for 3 min 01 s); '
    + 'moved: 0 sent, 0 received, 2 in the Outbox, sending one at 43% of 12345 bytes when it ended; last modem state: IRS, then DISCONNECTED; '
    + 'ended by: this station\'s modem, on its ARQ timeout (ARQ timeout in state IRS: nothing got through for the modem\'s time limit, so it ended the link); '
    + 'audio: radio to modem 240 s, largest gap 12 ms; modem to radio 95 s, largest gap 0 ms (modem side 12000 samples/s); '
    + 'Pat\'s last line: 2026/11/12 01:04:32 Exchange failed: EOF; Pat\'s reply: connect: HTTP 500 — Session failure {"NumReceived":0}');
  assert.ok(!/\n/.test(line), 'ONE line');
  // never connected, nothing known
  const nc = { ...base, dialKhz: 3585, connected: false, hint: 'no-answer' };
  assert.strictEqual(O.summaryLine({ ...nc, outcome: O.describeOutcome(nc), ranMs: 42000 }),
    'session summary: never connected (no answer); gateway KY4RY; dial 3585.0 kHz; mode ARDOP; ran 42 s (never connected); moved: sent not known, received not known, Outbox not read; last modem state: not reported; ended by: not reported');
  // a POTACAT stop after the link came up says both
  const st = { ...base, connected: true, cause: { kind: 'stall' } };
  assert.ok(O.summaryLine({ ...st, outcome: O.describeOutcome(st) }).startsWith('session summary: stopped by POTACAT (stall), after the link had connected; gateway KY4RY;'));
});

/**
 * main.js's own functions for the end of a session, run as they are against a
 * fake Pat: the Outbox is read back from Pat, the summary line is logged, the
 * status gains its Outbox sentence, and the line is kept for Report a Bug.
 */
async function runSettle({ patBody, outboxAfter, queued, connected = true, modemLines = TIMEOUT_LINES, patGone = false }) {
  const mail = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ MID: 'M' + i, Subject: 's', To: [{ Addr: 'x@winlink.org' }] })));
  let outbox = queued;
  const pat = await fakePat((req, res) => {
    if (req.url.startsWith('/api/connect')) { outbox = outboxAfter; res.statusCode = 500; res.end(patBody); return; }
    if (req.url.startsWith('/api/mailbox/out')) { res.end(mail(outbox)); return; }
    res.end('[]');
  });
  const logs = [];
  const pushes = [];
  const state = new WinlinkState();
  state.applyMailbox('out', JSON.parse(mail(queued)).map((m) => ({ mid: m.MID })));
  const ctx = vm.createContext({
    WinlinkOutcome: O, WinlinkDiag: D, WinlinkModes, winlinkState: state,
    patClient: new WinlinkClient({ port: pat.port }),
    winlinkLog: (m) => logs.push(m),
    winlinkSessionPush: () => pushes.push(state.session),
    winlinkSessionActive: () => ['starting', 'connecting', 'connected', 'disconnecting'].includes(state.session.state),
    console, Date, Math, Promise, String, Number,
  });
  const decl = (name) => { const m = new RegExp(`^(?:let|const) ${name} = [^;]+;`, 'm').exec(main); assert.ok(m, `${name} is declared in main.js`); return m[0]; };
  const src = ['_winlinkCause', '_winlinkDialed', '_winlinkConnectedAt', '_winlinkQueuedAtStart', '_winlinkModemAudioClosed', '_winlinkTxCutMs',
    '_winlinkPatLastLine', '_winlinkPatReply', '_winlinkReceived', '_winlinkLinkStory', '_winlinkAudioSummary', '_winlinkSummaries',
    '_winlinkSessionError', '_winlinkSessionErrorKind', '_winlinkPatConnected', '_winlinkSessionSeq'].map(decl).join('\n')
    + '\n' + ['winlinkOutcomeReset', 'winlinkNoteCause', 'winlinkOutboxCount', 'winlinkOutcomeFacts', 'winlinkOutcomeView', 'winlinkSettleOutcome'].map((f) => fnBody(main, f)).join('\n')
    + `\nglobalThis.api = {
      reset: winlinkOutcomeReset, settle: winlinkSettleOutcome, facts: winlinkOutcomeFacts, view: winlinkOutcomeView, note: winlinkNoteCause,
      set: (o) => { if ('connected' in o) _winlinkPatConnected = o.connected; if ('dialed' in o) _winlinkDialed = o.dialed; if ('connectedAt' in o) _winlinkConnectedAt = o.connectedAt;
        if ('reply' in o) _winlinkPatReply = o.reply; if ('received' in o) _winlinkReceived = o.received; if ('patLine' in o) _winlinkPatLastLine = o.patLine; if ('audio' in o) _winlinkAudioSummary = o.audio; if ('seq' in o) _winlinkSessionSeq = o.seq; },
      story: () => _winlinkLinkStory, queued: () => _winlinkQueuedAtStart, summaries: () => WinlinkOutcome.summaryLines(_winlinkSummaries),
    };`;
  vm.runInContext(src, ctx, { filename: 'main.js (the session-end functions)' });
  const api = ctx.api;

  // The session, as winlinkStartSession sets it up.
  const t0 = Date.now() - 251000;
  state.setSession({ state: 'starting', mode: 'ardop', gateway: 'KY4RY', dialKhz: 7100.5, capSec: 1800 });
  state.setSession({ startedAt: t0 });
  api.reset('ardop');
  api.set({ seq: 1 });
  await new Promise((r) => setTimeout(r, 60)); // the Outbox count at the start, read from Pat
  assert.strictEqual(api.queued(), queued, 'the Outbox as the session started');
  state.setSession({ state: 'connecting' });
  api.set({ dialed: true });
  // Pat's real client call, which ends the way AE5JE's did.
  let err;
  const client = new WinlinkClient({ port: pat.port });
  try { await client.connect('ardop:///KY4RY?bw=2000MAX&freq=7100.5'); } catch (e) { err = e; }
  assert.ok(err instanceof PatHttpError);
  if (connected) { api.set({ connected: true, connectedAt: Date.now() - 181000 }); for (const l of modemLines) api.story().note(D.classifyArdopDebugLine(l)); }
  api.set({ reply: err.message, received: O.receivedFromPatBody(err.body), patLine: connected ? '2026/11/12 01:04:32 Exchange failed: EOF' : '2026/11/12 01:01:00 Unable to establish connection to remote: Connect timeout', audio: 'audio this session: radio to modem 240 s, largest gap 12 ms; modem to radio 95 s, largest gap 0 ms (modem side 12000 samples/s)' });
  // winlinkEndSession: the first status (the Outbox not read yet), then the settle.
  const s = state.session;
  const first = O.describeOutcome(api.facts('error', s, err.message, 0, null));
  state.setSession({ state: 'error', text: first.text, error: first.text, errorKind: first.errorKind, outcome: api.view(first) });
  if (patGone) { ctx.patClient = null; }
  await api.settle('error', s, err.message, 0, Date.now());
  await pat.close();
  return { logs, pushes, first, session: state.session, summaries: api.summaries() };
}

test('B1 (main.js\'s own code, fake Pat): a mid-session drop writes ONE summary line and the status gains what is still in the Outbox', async () => {
  const r = await runSettle({ patBody: PAT_BODIES[0], queued: 2, outboxAfter: 2 });
  const lines = r.logs.filter((l) => /^session summary:/.test(l));
  assert.strictEqual(lines.length, 1, 'one line: ' + JSON.stringify(r.logs));
  const line = lines[0];
  assert.ok(/^session summary: the link dropped after it connected; gateway KY4RY; dial 7100\.5 kHz; mode ARDOP; ran 4 min 1[01] s \(connected for 3 min 0[01] s\); moved: 0 sent, 0 received, 2 in the Outbox; last modem state: IRS, then DISCONNECTED; ended by: this station's modem, on its ARQ timeout \(/.test(line), line);
  assert.ok(line.includes('audio: radio to modem 240 s, largest gap 12 ms'), line);
  assert.ok(line.includes('Pat\'s last line: 2026/11/12 01:04:32 Exchange failed: EOF'), line);
  assert.ok(line.endsWith('Pat\'s reply: connect: HTTP 500 — Session failure {"NumReceived":0}'), 'Pat\'s raw reply is in the log: ' + line);
  // the status: first without the Outbox, then with it, never with Pat's reply
  assert.strictEqual(r.first.text, `The link to KY4RY dropped before the mail exchange finished: nothing got through for 90 seconds, so the modem ended the link. So far: 0 received. ${NEXT}`);
  assert.strictEqual(r.session.error, `The link to KY4RY dropped before the mail exchange finished: nothing got through for 90 seconds, so the modem ended the link. So far: 0 sent, 0 received. 2 messages are still in your Outbox and will go on the next try. ${NEXT}`);
  assert.strictEqual(r.session.text, r.session.error);
  assert.strictEqual(r.session.outcome.word, 'Link dropped');
  assert.strictEqual(r.session.outcome.retry, true);
  assert.strictEqual(r.pushes.length, 1, 'pushed to every surface once more');
  assertPlain(r.session.error, 'the settled status');
  // kept for Report a Bug, stamped
  assert.strictEqual(r.summaries.length, 1);
  assert.ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ session summary: the link dropped/.test(r.summaries[0]), r.summaries[0]);
});

test('B1: one message went and one arrived before the drop, and a session that never connected', async () => {
  const moved = await runSettle({ patBody: PAT_BODIES[1], queued: 3, outboxAfter: 2, modemLines: GATEWAY_LINES });
  assert.ok(moved.logs.some((l) => /moved: 1 sent, 2 received, 2 in the Outbox; last modem state: ISS, then DISCONNECTED; ended by: the gateway \(heard DISC from the far station: it ended the link\)/.test(l)), JSON.stringify(moved.logs));
  assert.strictEqual(moved.session.error, `The link to KY4RY dropped before the mail exchange finished: KY4RY ended the link. So far: 1 sent, 2 received. 2 messages are still in your Outbox and will go on the next try. ${NEXT}`);
  const never = await runSettle({ patBody: PAT_BODIES[0], queued: 1, outboxAfter: 1, connected: false });
  assert.ok(never.logs.some((l) => /^session summary: never connected; gateway KY4RY; dial 7100\.5 kHz; mode ARDOP; ran 4 min 1[01] s \(never connected\); moved: 0 sent, 0 received, 1 in the Outbox; last modem state: not reported; ended by: the modem did not say; .*Pat's last line: .*Unable to establish connection to remote: Connect timeout; Pat's reply: connect: HTTP 500/.test(l)), JSON.stringify(never.logs));
  assert.strictEqual(never.session.error, `The call to KY4RY did not connect. 1 message is still in your Outbox. ${NEXT}`);
  // Pat gone: the line is still written, and nothing is claimed about the Outbox
  const gone = await runSettle({ patBody: PAT_BODIES[0], queued: 2, outboxAfter: 2, patGone: true });
  assert.ok(gone.logs.some((l) => /moved: sent not known, 0 received, Outbox not read/.test(l)), JSON.stringify(gone.logs));
  assert.ok(!/Outbox/.test(gone.session.error), gone.session.error);
});

test('wired: winlinkEndSession words the ending from the facts, logs Pat\'s reply, and writes the summary for every session that ran', () => {
  const end = fnBody(main, 'winlinkEndSession');
  assert.ok(/const raw = String\(text \|\| ''\);\s*const outcome = WinlinkOutcome\.describeOutcome\(winlinkOutcomeFacts\(state, s, raw, received, null\)\);\s*text = outcome\.text;/.test(end), 'the status is the outcome\'s, whatever text was passed in');
  assert.ok(/winlinkState\.setSession\(\{ state, text, error: state === 'error' \? text : '', errorKind: state === 'error' \? outcome\.errorKind : '', outcome: winlinkOutcomeView\(outcome\)/.test(end));
  assert.ok(/settings\.winlinkLastSession = \{ at: endedAt, ok: state === 'done', text: String\(outcome\.title/.test(end), 'Last check: the first sentence');
  assert.ok(/if \(state === 'error' && raw && raw !== text\) winlinkLog\(`the reason as it was reported: \$\{raw\.replace/.test(end), 'Pat\'s reply stays in the log (and so in the Verbose Log)');
  assert.ok(/winlinkSettleOutcome\(state, s, raw, received, endedAt\)/.test(end), 'the summary line');
  assert.ok(end.indexOf('stopArdopTail();') < end.indexOf('WinlinkOutcome.describeOutcome('), 'after the modem\'s last lines were read');
  assert.ok(end.indexOf('winlinkAudioDiagEnd();') < end.indexOf('WinlinkOutcome.describeOutcome('), 'after the audio was summed up');
  assert.ok(!/Session failed'\) : ''/.test(end), 'no generic "Session failed" status');
  // the start: reset, and the phase flag set just before Pat is asked to call
  const start = fnBody(main, 'winlinkStartSession');
  assert.ok(/winlinkOutcomeReset\(mode\);/.test(start));
  assert.ok(/_winlinkDialed = true; dialed = true;\s*const received = await patClient\.connect\(url\);/.test(start));
  // Pat's reply is kept for the log and gives the Inbox count; it never becomes the reason on a stopped attempt
  assert.ok(/_winlinkPatReply = dialed \? String\(\(e && e\.message\) \|\| e\) : '';/.test(start));
  assert.ok(/WinlinkOutcome\.receivedFromPatBody\(e\.body\)/.test(start));
  assert.ok(/if \(ls && !ls\.ok && !dialed && !String\(ls\.text \|\| ''\)\.includes\(why\)\) \{/.test(start), 'a stopped attempt\'s late Pat reply is not appended to the status');
  // every POTACAT stop names its cause
  assert.ok(/function winlinkAbortSession\(why, cause\) \{[\s\S]*?winlinkNoteCause\(\(cause && cause\.kind\) \|\| 'stopped', cause && cause\.kind \? cause\.detail : why\);/.test(main));
  assert.ok(/winlinkAbortSession\('nothing moved for 3 minutes', \{ kind: 'stall' \}\)/.test(main));
  assert.ok(/winlinkAbortSession\('the transmitter stayed keyed for 30 s', \{ kind: 'tx-failsafe' \}\)/.test(main));
  assert.ok(/_winlinkModemAudioClosed = true; winlinkLog\('modem audio: the modem closed its audio connection'\);/.test(main));
  assert.ok(/_winlinkTxCutMs = Math\.max\(_winlinkTxCutMs, Number\(c\.totalMs\) \|\| 0\);/.test(main));
  assert.ok(/winlinkLog\('refused Pat\\'s PTT — the SWR guard has tripped'\); winlinkNoteCause\('swr', ''\);/.test(main));
});

test('wired: no surface words an ending itself', () => {
  const pop = readSrc(path.join(root, 'renderer', 'winlink-popout.js'));
  assert.ok(/el\.textContent = \(ended && ss\.outcome && ss\.outcome\.word\) \|\| STATE_WORDS\[st\] \|\| st;/.test(pop), 'the mail window\'s label is the shack\'s word');
  assert.ok(/var text = ss\.error && st === 'error' \? ss\.error : \(ss\.text \|\| ''\);/.test(pop), 'the sentence is session.error as sent');
  assert.ok(/\$\('wl-done-title'\)\.textContent = bad\.title;\s*\$\('wl-done-sub'\)\.textContent = \[bad\.detail, bad\.next\]\.filter\(Boolean\)\.join\(' '\);/.test(pop), 'the card shows the same sentence in its parts');
  assert.ok(/window\.api\.connect\(\{ mode: ss\.mode, gateway: ss\.gateway, dialKhz: ss\.dialKhz, url: ss\.url \|\| '' \}\)/.test(pop), 'Try again is the operator\'s own Connect to the same gateway');
  const html = readSrc(path.join(root, 'renderer', 'winlink-popout.html'));
  assert.ok(/\.wl-session\.final \.wl-text \{[^}]*white-space: normal;/.test(html), 'a finished session\'s sentence wraps instead of being cut');
  assert.ok(/<button class="wl-btn primary" id="wl-done-retry" hidden>Try again<\/button>/.test(html));
  // theme-ready: the red of an ending is the theme's own (a fixed #e94560 was 3.4:1 on the light themes)
  assert.ok(/\.wl-state\.error \{ color: var\(--accent-red-text, var\(--accent-red, #e94560\)\); \}/.test(html));
  assert.ok(/\$\('wl-text'\)\.style\.color = st === 'error' \? 'var\(--accent-red-text, var\(--accent-red, #e94560\)\)'/.test(pop));
  // while the card is up with the whole sentence, the bar keeps to its first part
  assert.ok(/\$\('wl-text'\)\.textContent = cardUp && ss\.outcome && ss\.outcome\.title \? ss\.outcome\.title : text;/.test(pop));
  const web = readSrc(path.join(root, 'renderer', 'remote.js'));
  assert.ok(/disconnecting: 'Stopping', done: '', error: '' \};/.test(web), 'ECHOCAT Web puts nothing in front of the shack\'s sentence');
  assert.ok(!/error: 'Failed: '/.test(web));
  assert.ok(/var t = ss\.state === 'error' \? \(ss\.error \|\| 'The session did not finish\.'\) : \(ss\.text \|\| ''\);/.test(web));
  // the wire: the session object carries the sentence and its parts to the phone
  const proto = readSrc(path.join(root, 'lib', 'echocat-protocol.js'));
  assert.ok(/session\.outcome = \{ kind, word, title, detail, next,\n\s*\/\/ retry \}/.test(proto) && /'winlink-session': \{ dir: Dir\.S2C, feature: 'winlink', fields: \{ session: f\.object \} \}/.test(proto));
  assert.ok(Object.prototype.hasOwnProperty.call(new WinlinkState().session, 'outcome'), 'a new session starts with no outcome');
  const st = new WinlinkState();
  st.setSession({ state: 'error', outcome: { word: 'Link dropped' } });
  st.setSession({ state: 'starting' });
  assert.strictEqual(st.session.outcome, null, 'cleared when the next session starts');
});

// ── B2: what Report a Bug carries ───────────────────────────────────────────

/** A connected ARDOP session at the density of K3SBP's 2026-11-11 one: 73 kept lines and 150 debug lines a minute. */
function ardopSession({ startSec, minutes, ending }) {
  const ts = (s) => `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s) % 60).padStart(2, '0')}.${String(Math.round((s % 1) * 1000)).padStart(3, '0')}`;
  const out = [`${ts(startSec)} I ardopcf Version 1.0.4.1.3 (POTACAT)`, `${ts(startSec + 1)} I [SendARQConnectRequest] MYCALL=AE5JE  TARGET=KY4RY bytPendingSessionID=ad`,
    `${ts(startSec + 5)} D  Command Trace TO Host CONNECTED KY4RY 2000`];
  const end = startSec + 5 + minutes * 60;
  let i = 0;
  for (let t = startSec + 6; t < end; t += 60 / 73, i++) {
    const k = i % 8;
    out.push(k === 0 ? `${ts(t)} I Sending Frame Type 16QAM.2000.100.E`
      : k === 1 ? `${ts(t)} I [DecodeFrame] Frame: DataACK Decode PASS,  Quality= 88,  RS fixed 0 (of 0 max).`
        : k === 2 ? `${ts(t)} D  Command Trace TO Host NEWSTATE ${i % 16 < 8 ? 'ISS' : 'IRS'} `
          : k === 3 ? `${ts(t)} I [DecodeFrame] Frame: 16QAM.2000.100.O Decode FAIL,  Quality= 41,  RS fixed 0 (of 64 max).`
            : k === 4 ? `${ts(t)} D poor frame type decode`
              : `${ts(t)} I Sending Frame Type DataACK`);
    out.push(`${ts(t + 0.1)} D [Main.KeyPTT] PTT-TRUE`, `${ts(t + 0.2)} D UpdateBusyDetector: avg energy 123`); // debug noise the report drops
  }
  if (ending === 'timeout') out.push(`${ts(end)} D ARDOPprotocol.tmrSendTimeout]  ARQ Timeout from ProtocolState: IRS Going to DISC state`, `${ts(end)} D  Command Trace TO Host DISCONNECTED`, `${ts(end)} D  Command Trace TO Host STATUS ARQ Timeout from Protocol State:  IRS`);
  else out.push(`${ts(end)} D [Command Trace FROM host: DISCONNECT]`, `${ts(end + 2)} I [ARDOPprotocol.ProcessRcvdARQFrame]  END received ... going to DISC state`, `${ts(end + 2)} D  Command Trace TO Host DISCONNECTED`);
  return out;
}
const firstTime = (lines) => { const m = /^(\d\d):(\d\d):(\d\d)/.exec(lines.find((l) => /^\d\d:\d\d:\d\d/.test(l)) || ''); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null; };

test('B2: the report\'s ARDOP tail covers the minutes before a drop on Windows (CRLF), at a real session\'s line rate', () => {
  // A 4-minute session that dropped on the modem's timeout, in a Windows log file.
  const drop = ardopSession({ startSec: 3600, minutes: 4, ending: 'timeout' });
  const text = drop.join('\r\n') + '\r\n';
  const r = D.ardopReportTail(text);
  assert.strictEqual(r.omitted, 0, 'nothing the report keeps was left out');
  assert.ok(r.lines.some((l) => /TO Host CONNECTED KY4RY 2000/.test(l)), 'the connect is in it');
  assert.ok(r.lines.some((l) => /ARQ Timeout from ProtocolState: IRS/.test(l)), 'the line that says which side ended it');
  assert.ok(r.lines.some((l) => /TO Host DISCONNECTED/.test(l)));
  assert.ok(r.lines.some((l) => /TO Host NEWSTATE/.test(l)), 'the modem\'s states are kept');
  assert.ok(!r.lines.some((l) => /KeyPTT|UpdateBusyDetector/.test(l)), 'debug noise is not');
  assert.ok(!r.lines.some((l) => /\r/.test(l)), 'CRLF split cleanly');
  assert.strictEqual(firstTime(r.lines), 3600, 'all 4 minutes: from the first line of the run');
  assert.strictEqual(r.key.length, 0, 'nothing had to be cut');
  // The old cap (150 lines, the last run only) did not reach back 3 minutes.
  const old = D.lastArdopRun(text, { maxLines: 150, maxChars: 12000 });
  assert.ok(3600 + 245 - firstTime(old.lines) < 180, `the old tail reached back ${3600 + 245 - firstTime(old.lines)} s`);
  // The caps hold about 7 minutes of a link at that rate.
  const long = D.ardopReportTail(ardopSession({ startSec: 3600, minutes: 12, ending: 'timeout' }).join('\r\n'));
  assert.ok(long.lines.length <= D.ARDOP_REPORT.maxLines && long.lines.join('\n').length <= D.ARDOP_REPORT.maxChars);
  const covered = 3600 + 5 + 12 * 60 - firstTime(long.lines);
  assert.ok(covered >= 6 * 60, `a 12-minute session: the last ${covered} s are in the report`);
  assert.ok(long.key.some((l) => /TO Host CONNECTED KY4RY 2000/.test(l)) && long.key.some((l) => /ardopcf Version/.test(l)), 'and how the link began is kept from the part that was cut');
});

test('B2: a retry before the report does not push the session that dropped out of it', () => {
  // ardopcf is started per session: the drop, then two more tries, then Report a Bug.
  const drop = ardopSession({ startSec: 3600, minutes: 3, ending: 'timeout' });
  const retry = ardopSession({ startSec: 3900, minutes: 2, ending: 'clean' });
  const text = [...drop, ...retry].join('\r\n');
  const old = D.lastArdopRun(text, { maxLines: 150, maxChars: 12000 });
  assert.ok(!old.lines.some((l) => /ARQ Timeout/.test(l)), 'before: the report held only the retry');
  const r = D.ardopReportTail(text);
  assert.strictEqual(r.runs, 2);
  assert.ok(r.lines.some((l) => /ARQ Timeout from ProtocolState: IRS/.test(l)) || r.key.some((l) => /ARQ Timeout from ProtocolState: IRS/.test(l)), 'now: the drop is there');
  assert.ok(r.lines.filter((l) => /ardopcf Version/.test(l)).length + r.key.filter((l) => /ardopcf Version/.test(l)).length === 2, 'both runs are marked');
  // four runs: the oldest is left out, the last three are in
  const four = D.ardopReportTail([...ardopSession({ startSec: 100, minutes: 1, ending: 'clean' }), ...drop, ...retry, ...ardopSession({ startSec: 4200, minutes: 1, ending: 'clean' })].join('\n'));
  assert.strictEqual(four.runs, 3);
  // raw memory in the file is still dropped whole, and counted
  const dirty = D.ardopReportTail([...drop.slice(0, 5), '01:00:07.000 I Invalid parameter \u0000\u0001\u0002 passed', ...drop.slice(5)].join('\n'));
  assert.strictEqual(dirty.binary, 1);
  assert.ok(!dirty.lines.some((l) => /\u0000/.test(l)));
});

test('B2 wired: the modem\'s lines, the audio counters and the summary lines reach Report a Bug on every platform', () => {
  const rep = fnBody(main, 'winlinkModemReport');
  assert.ok(/sessions: WinlinkOutcome\.summaryLines\(_winlinkSummaries\)/.test(rep), 'the last sessions\' summary lines');
  assert.ok(/WinlinkOutcome\.keepSummary\(_winlinkSummaries, \{ at: endedAt, radio: WinlinkModes\.isRadioMode\(s\.mode\), line \}\);/.test(fnBody(main, 'winlinkSettleOutcome')));
  // Everything about the session is taken before Pat is asked for the Outbox: a Try again cannot mix two sessions.
  const settle = fnBody(main, 'winlinkSettleOutcome');
  assert.ok(settle.indexOf('winlinkOutcomeFacts(state, s, raw, received, null)') < settle.indexOf('await winlinkOutboxCount()'), 'facts first, then the await');
  assert.strictEqual((settle.match(/\bawait\b/g) || []).length, 1);
  assert.ok(!/_winlink(Cause|PatReply|PatLastLine|LinkStory|AudioSummary|ConnectedAt)\b/.test(settle.slice(settle.indexOf('await winlinkOutboxCount()'))), 'no session variable is read after the await');
  assert.ok(/WinlinkDiag\.ardopReportTail\(fs\.readFileSync\(dbg, 'utf8'\)\)/.test(rep), 'the wider ARDOP tail');
  assert.ok(/sessions: clean\(m\.sessions \|\| \[\]\)/.test(main) && /key: clean\(x\.key\)/.test(main), 'masked and redacted like the session log');
  const app = readSrc(path.join(root, 'renderer', 'app.js'));
  assert.ok(/### Winlink sessions \(latest last\)/.test(app) && /wm\.sessions\.join\('\\n'\)/.test(app));
  assert.ok(/\(how each link began and ended, from the lines left out\)/.test(app));
  // The session log's own lines: the modem's events, each audio cut as it happens, and the session's audio sentence.
  assert.ok(/winlinkLog\('ardop: ' \+ o\)/.test(main));
  assert.ok(/winlinkLog\(`modem audio: \$\{c\.ms\} ms of transmit audio cut — the sound card stopped taking it \(\$\{c\.totalMs\} ms this session\)`\)/.test(main));
  assert.ok(/_winlinkAudioSummary = WinlinkDiag\.audioSummaryText\(\{ rx: winlinkAudio\.rxMeter\.snapshot\(rate\), tx: winlinkAudio\.txMeter\.snapshot\(rate\), rxDropped: winlinkAudio\.stats\.rxDropped, rate \}\);\s*winlinkLog\(_winlinkAudioSummary\);/.test(main));
  // None of it is behind a platform check: Windows gets what the Mac gets.
  for (const f of ['startArdopTail', 'stopArdopTail', 'winlinkAudioDiagStart', 'winlinkAudioDiagEnd', 'winlinkModemReport', 'startWinlinkAudio', 'winlinkSettleOutcome', 'newestModemLog']) {
    assert.ok(!/process\.platform|darwin|win32/.test(fnBody(main, f)), `${f} is the same on every platform`);
  }
  for (const f of ['modem-audio-lane.js', 'modem-audio-lane-client.js', 'modem-audio-server.js', 'winlink-diag.js']) {
    assert.ok(!/process\.platform|darwin|win32/.test(readSrc(path.join(root, 'lib', f))), `lib/${f} has no platform branch`);
  }
  // ardopcf is told where to write its log on every platform.
  assert.ok(/if \(logDir\) args\.push\('--logdir', logDir\);/.test(readSrc(path.join(root, 'lib', 'ardop-process.js'))));
});

test('B2: the internet auto-check never pushes a radio session\'s summary out of the report', () => {
  const list = [];
  O.keepSummary(list, { at: Date.UTC(2026, 10, 12, 1, 4, 30), radio: true, line: 'session summary: the link dropped after it connected; gateway KY4RY' });
  for (let i = 0; i < 40; i++) O.keepSummary(list, { at: Date.UTC(2026, 10, 12, 2, 0, 0) + i * 1800000, radio: false, line: 'session summary: mail exchanged; mode internet #' + i });
  assert.strictEqual(list.length, 3, 'one radio, the last two internet');
  const lines = O.summaryLines(list);
  assert.strictEqual(lines[0], '2026-11-12T01:04:30Z session summary: the link dropped after it connected; gateway KY4RY');
  assert.ok(/#38$/.test(lines[1]) && /#39$/.test(lines[2]));
  for (let i = 0; i < 12; i++) O.keepSummary(list, { at: Date.UTC(2026, 10, 13) + i, radio: true, line: 'radio #' + i });
  assert.strictEqual(list.filter((e) => e.radio).length, 8, 'the last 8 radio sessions');
  assert.ok(!list.some((e) => /KY4RY/.test(e.line)) && list.some((e) => e.line === 'radio #11') && list.some((e) => e.line === 'radio #4'));
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/winlink-outcome-test.js'"));
});

(async () => {
  for (const run of pending) await run();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
