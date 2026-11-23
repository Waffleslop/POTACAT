// SSTV waits for the frequency to be quiet before it transmits (#326).
// Every rule is in lib/sstv-quiet-wait.js (the Winlink busy detector and the
// automatic retry's channel watch, reused); main.js holds the picture and
// ticks. Nothing here transmits: the "send" is a callback that records.
// Run: node test/sstv-quiet-wait-test.js
'use strict';
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const Q = require('../lib/sstv-quiet-wait');
const Spectrum = require('../lib/winlink-spectrum');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const root = path.join(__dirname, '..');
const src = (p) => readSrc(path.join(root, p));
const main = src('main.js');
function fnBody(s, name) {
  const i = s.indexOf('function ' + name + '(');
  assert.ok(i >= 0, name + ' exists');
  let depth = 0;
  for (let k = s.indexOf(') {', i) + 2; k < s.length; k++) {
    if (s[k] === '{') depth++;
    else if (s[k] === '}' && --depth === 0) return s.slice(i, k + 1);
  }
  throw new Error(name + ': unbalanced');
}
function handler(s, ev) {
  const i = s.indexOf(ev);
  assert.ok(i >= 0, ev + ' is handled');
  return s.slice(i, i + 1500);
}

// Synthetic receive audio, 48 kHz, 100 ms chunks: band noise, plus an SSTV
// tone (1900 Hz, in the 1100-2300 Hz band) when someone is sending.
const RATE = 48000, CHUNK = 4800;
let seed = 12345;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; }
let phase = 0;
function chunk(tone) {
  const a = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) {
    a[i] = rnd() * 0.02;
    if (tone) { a[i] += 0.3 * Math.sin(phase); phase += 2 * Math.PI * 1900 / RATE; }
  }
  return a;
}
/** Feed `ms` of audio from `t`, returning the new t. */
function feed(listener, t, ms, tone) {
  for (let end = t + ms; t < end; t += 100) listener.push(chunk(tone), RATE, t);
  return t;
}
function recorder() {
  const r = { sent: [], gaveUp: [], cancelled: [], statuses: [] };
  r.gate = new Q.SendGate({
    onSend: (p, why) => r.sent.push({ p, why }),
    onGiveUp: (p, text) => r.gaveUp.push({ p, text }),
    onCancel: (p, reason) => r.cancelled.push({ p, reason }),
    onStatus: (s) => r.statuses.push(s),
  });
  return r;
}
/** Tick the gate once a second while feeding audio, until `ms` has passed or it stops waiting. */
function run(r, listener, t, ms, tone) {
  for (let end = t + ms; t < end && r.gate.waiting(); ) {
    t = feed(listener, t, 1000, typeof tone === 'function' ? tone(t) : tone);
    r.gate.tick(t, listener);
  }
  return t;
}

console.log('sstv: wait for the frequency to be quiet before sending (#326)');

// ---- the reused detector ----
test('the listener is the Winlink busy detector and channel watch, on the SSTV band 1100-2300 Hz', () => {
  const lib = src('lib/sstv-quiet-wait.js');
  assert.ok(/require\('\.\/winlink-spectrum'\)/.test(lib) && /Spectrum\.BusyDetector\(/.test(lib) && /Spectrum\.SpectrumAccumulator\(/.test(lib), 'BusyDetector + SpectrumAccumulator reused');
  assert.ok(/require\('\.\/winlink-auto-retry'\)/.test(lib) && /Retry\.ChannelWatch\(/.test(lib), 'ChannelWatch reused');
  assert.strictEqual(Q.BAND_LO_HZ, 1100);
  assert.strictEqual(Q.BAND_HI_HZ, 2300);
  const l = new Q.QuietListener({ hz: 14230000, now: 0 });
  assert.strictEqual(l.detector.loBin, Math.floor(1100 / Spectrum.SPAN_HZ * Spectrum.MAGS));
  assert.strictEqual(l.detector.hiBin, Math.ceil(2300 / Spectrum.SPAN_HZ * Spectrum.MAGS));
  assert.strictEqual(Q.QUIET_S, 5);
  assert.strictEqual(Q.MAX_WAIT_S, 240);
});

// ---- busy waits, quiet sends ----
test('busy waits: a picture on the frequency holds ours; it goes 5 s after the frequency reads quiet', () => {
  const l = new Q.QuietListener({ hz: 14230000, now: 0 });
  let t = feed(l, 0, 6000, true); // someone is sending
  const r = recorder();
  assert.strictEqual(r.gate.hold('pic', { enabled: true, now: t, listener: l }), 'waiting');
  assert.strictEqual(r.sent.length, 0, 'nothing sent while busy');
  const startedAt = t;
  t = run(r, l, t, 30000, true); // still sending for 30 s
  assert.strictEqual(r.sent.length, 0, 'still held after 30 s of busy');
  assert.ok(r.statuses.length && r.statuses[r.statuses.length - 1].heard === 'busy', 'the line says someone is on the frequency');
  const quietFrom = t;
  t = run(r, l, t, 30000, false); // they stop
  assert.strictEqual(r.sent.length, 1, 'sent once it cleared');
  assert.strictEqual(r.sent[0].p, 'pic');
  assert.strictEqual(r.sent[0].why, 'quiet');
  const after = t - quietFrom;
  // 4 s detector hold + 5 s quiet, ticked once a second
  assert.ok(after >= (Spectrum.BUSY_HOLD_MS + Q.QUIET_S * 1000) && after <= 12000, 'sent ' + after + ' ms after the signal stopped');
  assert.ok(t - startedAt > 30000);
});

test('quiet sends: a frequency already quiet for 5 s sends at once', () => {
  const l = new Q.QuietListener({ hz: 14230000, now: 0 });
  const t = feed(l, 0, 7000, false);
  const r = recorder();
  assert.strictEqual(r.gate.hold('pic', { enabled: true, now: t, listener: l }), 'sent');
  assert.deepStrictEqual(r.sent.map((s) => s.why), ['quiet']);
  assert.strictEqual(r.statuses.length, 0, 'no waiting line shown');
});

test('quiet but not for long enough yet: waits the rest of the 5 s, and says how long it has been quiet', () => {
  const l = new Q.QuietListener({ hz: 14230000, now: 0 });
  let t = feed(l, 0, 2000, false);
  const r = recorder();
  assert.strictEqual(r.gate.hold('pic', { enabled: true, now: t, listener: l }), 'waiting');
  assert.strictEqual(r.statuses[0].heard, 'quiet');
  t = run(r, l, t, 10000, false);
  assert.strictEqual(r.sent.length, 1);
  assert.ok(t <= 6000, 'sent by ' + t);
});

test('a frequency that comes back busy restarts the quiet count', () => {
  const l = new Q.QuietListener({ hz: 14230000, now: 0 });
  let t = feed(l, 0, 3000, true);
  const r = recorder();
  r.gate.hold('pic', { enabled: true, now: t, listener: l });
  t = run(r, l, t, 6000, false);   // a gap shorter than hold + quiet
  assert.strictEqual(r.sent.length, 0, 'not sent in the gap');
  t = run(r, l, t, 5000, true);    // the next station starts
  assert.strictEqual(r.sent.length, 0, 'not sent while the next one sends');
  run(r, l, t, 20000, false);
  assert.strictEqual(r.sent.length, 1);
});

// ---- Send now ----
test('Send now overrides: the held picture goes at once, busy or not', () => {
  const l = new Q.QuietListener({ hz: 14230000, now: 0 });
  let t = feed(l, 0, 5000, true);
  const r = recorder();
  r.gate.hold('pic', { enabled: true, now: t, listener: l });
  t = feed(l, t, 2000, true);
  assert.strictEqual(r.gate.sendNow(t, l), true);
  assert.deepStrictEqual(r.sent.map((s) => s.why), ['now']);
  assert.strictEqual(r.gate.waiting(), false);
  assert.strictEqual(r.gate.sendNow(t, l), false, 'nothing held: Send now does nothing');
  assert.strictEqual(r.sent.length, 1, 'never a second picture');
});

// ---- Cancel ----
test('Cancel stops: nothing is sent, ever, after a cancel', () => {
  const l = new Q.QuietListener({ hz: 14230000, now: 0 });
  let t = feed(l, 0, 5000, true);
  const r = recorder();
  r.gate.hold('pic', { enabled: true, now: t, listener: l });
  assert.strictEqual(r.gate.cancel('cancel'), true);
  assert.deepStrictEqual(r.cancelled.map((c) => c.reason), ['cancel']);
  t = feed(l, t, 20000, false);
  r.gate.tick(t, l);
  assert.strictEqual(r.sent.length, 0, 'the frequency clearing later sends nothing');
  assert.strictEqual(r.gate.cancel('cancel'), false);
});

test('a second picture while one waits replaces it; only the newest is ever sent', () => {
  const l = new Q.QuietListener({ hz: 14230000, now: 0 });
  let t = feed(l, 0, 5000, true);
  const r = recorder();
  r.gate.hold('first', { enabled: true, now: t, listener: l });
  r.gate.hold('second', { enabled: true, now: t, listener: l });
  assert.deepStrictEqual(r.cancelled.map((c) => [c.p, c.reason]), [['first', 'replaced']]);
  run(r, l, t, 30000, false);
  assert.deepStrictEqual(r.sent.map((s) => s.p), ['second']);
});

// ---- max wait ----
test('the max wait gives up after 4 minutes of busy, says so, and sends nothing', () => {
  const l = new Q.QuietListener({ hz: 14230000, now: 0 });
  let t = feed(l, 0, 2000, true);
  const r = recorder();
  r.gate.hold('pic', { enabled: true, now: t, listener: l });
  t = run(r, l, t, 300000, true);
  assert.strictEqual(r.sent.length, 0);
  assert.strictEqual(r.gaveUp.length, 1);
  assert.strictEqual(r.gaveUp[0].text, 'Picture not sent: the frequency stayed busy for 4 minutes.');
  assert.ok(t - 2000 >= Q.MAX_WAIT_S * 1000 && t - 2000 <= Q.MAX_WAIT_S * 1000 + 1000);
});

test('no receive audio: it cannot hear, keeps waiting and says why, never sends on a guess', () => {
  const r = recorder();
  const l = new Q.QuietListener({ hz: 14230000, now: 0 });
  r.gate.hold('pic', { enabled: true, now: 0, listener: l });
  for (let t = 1000; t <= 10000; t += 1000) r.gate.tick(t, l);
  assert.strictEqual(r.sent.length, 0);
  assert.strictEqual(r.statuses[r.statuses.length - 1].heard, 'no-audio');
  assert.ok(/No receive audio is reaching POTACAT/.test(Q.waitDetail(r.statuses[r.statuses.length - 1])));
  r.gate.tick(Q.MAX_WAIT_S * 1000, l);
  assert.strictEqual(r.sent.length, 0);
  assert.ok(/no receive audio reached POTACAT for 4 minutes/.test(r.gaveUp[0].text));
  // with no listener at all, the same
  const r2 = recorder();
  r2.gate.hold('pic', { enabled: true, now: 0, listener: null });
  r2.gate.tick(5000, null);
  assert.strictEqual(r2.statuses[r2.statuses.length - 1].heard, 'no-audio');
  assert.strictEqual(r2.sent.length, 0);
});

// ---- off by default ----
test('off by default changes nothing: the picture goes straight through, no listening, no status', () => {
  assert.strictEqual(Q.shouldWait({}), false);
  assert.strictEqual(Q.shouldWait(), false);
  assert.strictEqual(Q.shouldWait({ enabled: undefined, requested: undefined }), false);
  assert.strictEqual(Q.shouldWait({ enabled: 'true' }), false, 'only a real true turns it on');
  const r = recorder();
  // busy frequency, no listener: it would wait if it were on
  assert.strictEqual(r.gate.hold('pic', { now: 0, listener: null }), 'sent');
  assert.deepStrictEqual(r.sent.map((s) => s.why), ['off']);
  assert.strictEqual(r.statuses.length, 0);
  assert.strictEqual(r.gate.waiting(), false);
  // main reads the setting as === true, and no default turns it on
  assert.ok(/enabled: settings\.sstvWaitQuiet === true/.test(main), 'main: settings.sstvWaitQuiet === true');
  assert.ok(!/sstvWaitQuiet\s*:\s*true/.test(main), 'no default of true in main');
  assert.ok(/sstvWaitQuiet === true/.test(src('renderer/sstv-popout.js')), 'the window shows it off unless saved on');
  // and main only listens while it can matter
  const feedFn = fnBody(main, 'sstvQuietFeed');
  assert.ok(/settings\.sstvWaitQuiet !== true/.test(feedFn) && /_sstvQuietGate\.waiting\(\)/.test(feedFn), 'no listening while off and nothing waits');
});

// ---- the phone path ----
test('the phone path is gated too: a client may ask for the wait, never skip the shack\'s setting', () => {
  assert.strictEqual(Q.shouldWait({ enabled: false, requested: true }), true);
  assert.strictEqual(Q.shouldWait({ enabled: true, requested: false }), true, 'a Guest Pass phone cannot turn the owner\'s courtesy off');
  const r = recorder();
  r.gate.hold('phone-pic', { enabled: false, requested: true, now: 0, listener: null });
  assert.strictEqual(r.gate.waiting(), true);
  // remote-server passes waitQuiet as a boolean
  const rs = src('lib/remote-server.js');
  const photo = handler(rs, "case 'sstv-photo':");
  assert.ok(/waitQuiet: msg\.waitQuiet === true/.test(photo), 'remote-server: waitQuiet === true');
  assert.ok(/case 'sstv-send-now':[\s\S]{0,200}this\.emit\('sstv-send-now'\)/.test(rs), 'remote-server: sstv-send-now');
  assert.ok(/'sstv-wait-quiet'/.test(rs), 'capability sstv-wait-quiet advertised');
  // main: the phone's picture is marked and goes through the same encode-complete gate
  const mainPhoto = handler(main, "remoteServer.on('sstv-photo'");
  assert.ok(/waitQuiet/.test(mainPhoto.slice(0, 120)), 'main reads waitQuiet');
  assert.ok(/_sstvNextPicture = \{ requested: waitQuiet === true/.test(main), 'main marks the next picture');
  assert.ok(/remoteServer\.on\('sstv-send-now', \(\) => sstvQuietSendNow\('ECHOCAT'\)\)/.test(main), 'phone Send now');
  assert.ok(/function sstvHaltTxNow\(\) \{[\s\S]{0,200}sstvQuietCancel\('halt'\)/.test(main), 'phone HALT cancels the wait');
  // the protocol: registry and doc
  const proto = src('lib/echocat-protocol.js');
  assert.ok(/'sstv-photo': \{[^\n]*waitQuiet: f\.optBoolean/.test(proto), 'registry: sstv-photo waitQuiet');
  assert.ok(/'sstv-send-now': \{ dir: Dir\.C2S, feature: 'sstv' \}/.test(proto), 'registry: sstv-send-now');
  assert.ok(/'sstv-tx-status': \{[^\n]*waitedSec: f\.optNumber[^\n]*maxWaitSec: f\.optNumber[^\n]*quietSec: f\.optNumber[^\n]*heard: f\.optString/.test(proto), 'registry: waiting fields');
  const doc = src('docs/echocat-protocol.md');
  assert.ok(/`waitQuiet`/.test(doc) && /`sstv-send-now`/.test(doc) && /`waiting`/.test(doc) && /sstv-wait-quiet/.test(doc), 'protocol doc');
});

// ---- wiring ----
test('wiring: every picture (window and phone) goes through the gate at encode-complete, before PTT', () => {
  assert.ok(/require\('\.\/lib\/sstv-quiet-wait'\)/.test(main));
  assert.ok(/const sstvKeyAndSend = SstvSend\.guard\(\(data\) => \{/.test(main), 'the key-and-send body is its own function');
  assert.ok(/sstvEngine\.on\('encode-complete', \(data\) => sstvHoldPicture\(data, sstvKeyAndSend\)\);/.test(main), 'encode-complete holds the picture');
  assert.strictEqual((main.match(/sstvKeyAndSend\(/g) || []).length, 0, 'never called directly (only through the gate)');
  const hold = fnBody(main, 'sstvHoldPicture');
  assert.ok(/enabled: settings\.sstvWaitQuiet === true/.test(hold) && /requested: !!\(want && want\.requested\)/.test(hold));
  const gate = fnBody(main, 'sstvQuietGateGet');
  assert.ok(/onSend:/.test(gate) && /onGiveUp:[\s\S]*sstvSendFailed\(/.test(gate) && /onCancel:/.test(gate) && /onStatus:/.test(gate));
  assert.ok(/broadcastSstvTxStatus\(s\)/.test(gate) || /broadcastSstvTxStatus\(status\)/.test(gate), 'waiting reaches ECHOCAT through sstv-tx-status');
});

test('wiring: the receive audio is tapped before the engine hands it to its worker; not while we transmit', () => {
  const eng = src('lib/sstv-engine.js');
  assert.ok(/setAudioTap\(fn\)/.test(eng));
  const feedA = eng.slice(eng.indexOf('feedAudio(samples) {'), eng.indexOf('feedAudio(samples) {') + 2000);
  assert.ok(feedA.indexOf('this._audioTap') >= 0 && feedA.indexOf('this._audioTap') < feedA.indexOf('postMessage'), 'tap before the transfer');
  assert.ok(/sstvEngine\.setAudioTap\(sstvQuietFeed\)/.test(main));
  const feedFn = fnBody(main, 'sstvQuietFeed');
  assert.ok(/_remoteTxState \|\| \(cat && cat\._transmitting\)/.test(feedFn), 'our own transmission is not the band');
  assert.ok(/SstvQuietWait\.dialMoved\(/.test(feedFn), 'the dial moved: listen again');
});

test('wiring: Cancel, HALT, window close and SSTV stop end the wait; Send now from the window', () => {
  assert.ok(/ipcMain\.on\('sstv-wait-cancel', \(\) => sstvQuietCancel\('cancel'\)\)/.test(main));
  assert.ok(/ipcMain\.on\('sstv-wait-send-now', \(\) => sstvQuietSendNow\('the SSTV window'\)\)/.test(main));
  assert.ok(/ipcMain\.on\('sstv-tx-complete', \(\) => \{\s*sstvQuietCancel\('halt'\);/.test(main), 'HALT TX in the window');
  assert.ok(/ipcMain\.on\('sstv-stop', \(\) => \{\s*sstvQuietCancel\('stop'\);/.test(main), 'SSTV stopped');
  assert.ok(/function stopSstv\(\) \{\s*sstvQuietCancel\('closed'\);/.test(main), 'window closed / SSTV stopped');
  const pre = src('preload-sstv-popout.js');
  assert.ok(/sstvWaitCancel: \(\) => ipcRenderer\.send\('sstv-wait-cancel'\)/.test(pre));
  assert.ok(/sstvWaitSendNow: \(\) => ipcRenderer\.send\('sstv-wait-send-now'\)/.test(pre));
});

test('wiring: the SSTV window shows the wait with Send now and Cancel, and the setting', () => {
  const html = src('renderer/sstv-popout.html');
  const js = src('renderer/sstv-popout.js');
  assert.ok(/id="quiet-wait"[^>]*hidden/.test(html), 'the waiting bar, hidden until a wait');
  assert.ok(/id="quiet-send-now"[^>]*>Send now</.test(html) && /id="quiet-cancel"[^>]*>Cancel</.test(html));
  assert.ok(/<input type="checkbox" id="wait-quiet"> Wait for the frequency to be quiet before sending/.test(html));
  assert.ok(/<script src="\.\.\/lib\/sstv-quiet-wait\.js"><\/script>/.test(html));
  assert.ok(/data\.state === 'waiting'/.test(js) && /SstvQuietWait\.WAIT_TITLE/.test(js) && /SstvQuietWait\.waitDetail\(/.test(js));
  assert.ok(/saveSettings\(\{ sstvWaitQuiet: /.test(js));
  assert.ok(/window\.api\.sstvWaitSendNow\(\)/.test(js) && /window\.api\.sstvWaitCancel\(\)/.test(js));
});

test('wiring: ECHOCAT Web shows the wait with Send now and Cancel', () => {
  const rh = src('renderer/remote.html');
  const rj = src('renderer/remote.js');
  assert.ok(/<!-- sstv-quiet-wait-js -->/.test(rh));
  assert.ok(/\['sstv-quiet-wait-js', 'sstv-quiet-wait\.js'\]/.test(src('lib/remote-server.js')));
  assert.ok(/id="sstv-phone-wait-bar"/.test(rh) && /id="sstv-phone-send-now"[^>]*>Send now</.test(rh) && /id="sstv-phone-wait-cancel"[^>]*>Cancel</.test(rh));
  assert.ok(/msg\.state === 'waiting'/.test(rj));
  assert.ok(/type: 'sstv-send-now'/.test(rj) && /type: 'sstv-halt-tx'/.test(rj));
});

test('words', () => {
  assert.strictEqual(Q.WAIT_TITLE, 'Waiting for the frequency to clear...');
  assert.strictEqual(Q.SEND_NOW, 'Send now');
  assert.strictEqual(Q.CANCEL, 'Cancel');
  assert.strictEqual(Q.waitDetail({ heard: 'busy', waitedSec: 12, maxWaitSec: 240 }), 'Someone is on the frequency. Waited 0:12 of 4:00.');
  assert.strictEqual(Q.waitDetail({ heard: 'quiet', quietSec: 3, waitedSec: 70, maxWaitSec: 240 }), 'Quiet for 3 of 5 s. Waited 1:10 of 4:00.');
  assert.strictEqual(Q.dialMoved(14230000, 14230300), false);
  assert.strictEqual(Q.dialMoved(14230000, 7171000), true);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
