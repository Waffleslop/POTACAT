'use strict';
// #357 (NA4DQ, 2026-11-11): a picture sent from ECHOCAT.
//   (a) POTACAT closed with "detached ArrayBuffer": the encoder emptied the
//       array the SSTV window's preview read 1.5 s later.
//   (b) the crash was a dialog box that held the whole app at the shack.
//   (c) the picture keyed on the old Winlink frequency before the SSTV window
//       had tuned the radio, and was refused.
// (d), the mail window sending the radio back mid-SSTV, is in
// winlink-data-hold-test.js with the rest of the Winlink return.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SstvEngine } = require('../lib/sstv-engine');
const S = require('../lib/sstv-send');
const SstvStartBand = require('../lib/sstv-start-band');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const MAIN = R('main.js');
function slice(src, start, end) {
  const i = src.indexOf(start);
  assert.ok(i >= 0, 'not found: ' + start);
  const j = end ? src.indexOf(end, i + start.length) : -1;
  return src.slice(i, j > 0 ? j : i + 6000);
}

// An engine whose worker is a postMessage that really transfers (detaches)
// what it is handed, as worker_threads does.
function engineWithFakeWorker() {
  const eng = new SstvEngine();
  const sent = [];
  eng._running = true;
  eng._workerReady = true;
  eng._worker = { postMessage(msg, transfer) { sent.push(structuredClone(msg, { transfer: transfer || [] })); } };
  return { eng, sent };
}

console.log('(a) the picture is copied before it is encoded');
test('the transfer really empties the array it is given (what crashed POTACAT)', () => {
  const a = new Uint8ClampedArray(16).fill(7);
  structuredClone(a, { transfer: [a.buffer] });
  assert.strictEqual(a.length, 0);
  assert.throws(() => Array.from(a.values()), /detached/i);
});
test('encode leaves the caller\'s picture whole: the SSTV window can still show it afterwards', () => {
  const { eng, sent } = engineWithFakeWorker();
  const rgba = new Uint8ClampedArray(320 * 256 * 4).fill(200);
  eng.encode(rgba, 320, 256, 'martin1');
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].imageData.length, rgba.length, 'the worker got the whole picture');
  assert.strictEqual(rgba.length, 320 * 256 * 4, 'the caller\'s array is not detached');
  assert.strictEqual(Array.from(rgba).length, rgba.length, 'pushTxImage\'s Array.from works');
});
test('a picture held while the worker starts is copied when it goes, too', () => {
  const eng = new SstvEngine();
  eng._running = true;
  const rgba = new Uint8ClampedArray(64).fill(1);
  eng.encode(rgba, 4, 4, 'martin1');
  const sent = [];
  eng._worker = { postMessage(msg, transfer) { if (msg.type === 'encode') sent.push(structuredClone(msg, { transfer: transfer || [] })); } };
  eng._onWorkerMessage({ type: 'ready' });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(rgba.length, 64);
});
test('a plain array still encodes', () => {
  const { eng, sent } = engineWithFakeWorker();
  eng.encode([1, 2, 3, 4], 1, 1, 'martin1');
  assert.deepStrictEqual(Array.from(sent[0].imageData), [1, 2, 3, 4]);
});
test('ownCopy: its own buffer; an emptied picture is an error, not a silent blank', () => {
  const a = new Uint8ClampedArray([1, 2, 3, 4]);
  const c = S.ownCopy(a);
  assert.notStrictEqual(c.buffer, a.buffer);
  c[0] = 9;
  assert.strictEqual(a[0], 1);
  const gone = new Uint8ClampedArray(4);
  structuredClone(gone, { transfer: [gone.buffer] });
  assert.throws(() => S.ownCopy(gone), /empty/);
  assert.throws(() => S.ownCopy(null), /empty/);
});
test('the engine copies every time (lib/sstv-engine.js)', () => {
  const src = R('lib/sstv-engine.js');
  const enc = slice(src, '  encode(imageData, width, height, mode) {', '\n  }\n');
  assert.ok(/const data = new Uint8ClampedArray\(imageData\);/.test(enc), 'always a copy');
  assert.ok(!/imageData instanceof Uint8ClampedArray \? imageData/.test(enc), 'the caller\'s array is never the one transferred');
});

console.log('(b) a failure is a status line, never a dialog box');
test('guard turns a throw into onError and returns undefined; a good call passes through', () => {
  let got = null;
  const g = S.guard((x) => { if (x) throw new Error('boom'); return 5; }, (e) => { got = e.message; });
  assert.strictEqual(g(false), 5);
  assert.strictEqual(g(true), undefined);
  assert.strictEqual(got, 'boom');
  const g2 = S.guard(() => { throw new Error('x'); }, () => { throw new Error('the report threw'); });
  assert.doesNotThrow(() => g2(), 'a report that throws is swallowed too');
});
test('failText: one short line, the reason in plain words', () => {
  assert.strictEqual(S.failText(new Error('Cannot perform %TypedArray%.prototype.values on a detached ArrayBuffer')),
    'Picture not sent: Cannot perform %TypedArray%.prototype.values on a detached ArrayBuffer.');
  assert.strictEqual(S.failText(new Error('line one.\n    at foo (main.js:1)')), 'Picture not sent: line one.');
  assert.ok(S.failText(new Error('x'.repeat(400))).length < 180);
});
test('notSentStatus: back to receive (or Auto-SSTV) with the reason', () => {
  assert.deepStrictEqual(S.notSentStatus({ error: 'Picture not sent: why.' }), { state: 'rx', error: 'Picture not sent: why.' });
  assert.deepStrictEqual(S.notSentStatus({ autoActive: true, error: 'e' }), { state: 'auto-rx', error: 'e' });
  assert.deepStrictEqual(S.notSentStatus({}), { state: 'rx' });
});
test('main: sstvSendFailed says it in the log, the SSTV window and on every ECHOCAT client', () => {
  const f = slice(MAIN, 'function sstvSendFailed(text, { log } = {}) {', '\n}\n');
  assert.ok(/sendCatLog\('\[SSTV\] ' \+ \(log \|\| text\)\)/.test(f));
  assert.ok(/sstvPopoutWin\.webContents\.send\('tune-blocked', text\)/.test(f), 'the SSTV window\'s status line');
  assert.ok(/broadcastSstvTxStatus\(SstvSend\.notSentStatus\(\{ autoActive: autoSstvActive, error: text \}\)\)/.test(f), 'the phone');
  assert.ok(!/dialog\./.test(f));
});
test('main: the phone-picture handler fails only through sstvSendFailed, and guards the preview', () => {
  const h = slice(MAIN, "remoteServer.on('sstv-photo', ({ image, mode, guest, freqKhz }) => {", "remoteServer.on('sstv-stop'");
  assert.ok(!/console\.error\(/.test(h), 'no failure that only reaches a console nobody sees');
  assert.ok(/sstvSendFailed\('Picture not sent: SSTV could not start on this computer\.'\)/.test(h));
  assert.ok(/sstvSendFailed\('Picture not sent: the picture could not be read\.'\)/.test(h));
  assert.ok(/\} catch \(err\) \{\n      sstvSendFailed\(SstvSend\.failText\(err\)/.test(h), 'the catch is a status line');
  assert.ok(/const pushTxImage = SstvSend\.guard\(\(\) => \{/.test(h), 'the 1.5 s preview timer cannot throw out of its timeout');
  assert.ok(/sstvEngine\.encode\(SstvSend\.ownCopy\(rgba\), size\.width, size\.height, mode\)/.test(h), 'the encoder gets its own copy');
});
test('main: the encode-complete handler and its audio timer are guarded, and release PTT on a throw', () => {
  assert.ok(/sstvEngine\.on\('encode-complete', SstvSend\.guard\(\(data\) => \{/.test(MAIN));
  assert.ok(/\}, sstvSendThrew\)\);/.test(MAIN));
  assert.ok(/setTimeout\(SstvSend\.guard\(fn, sstvSendThrew\), wait\)/.test(MAIN));
  const t = slice(MAIN, 'const sstvSendThrew = (err) => {', '\n    };');
  assert.ok(t.indexOf('handleRemotePtt(false)') >= 0 && t.indexOf('handleRemotePtt(false)') < t.indexOf('sstvSendFailed('), 'PTT released first');
});
test('main: a refused key-down tells the phone why, not a bare "rx"', () => {
  const b = slice(MAIN, "lanOwner: useYaesuLanTx ? 'sstv' : undefined }) === false) {", 'return;');
  assert.ok(/_ownTxRefused\.why/.test(b) && /sstvSendFailed\('Picture not sent: ' \+/.test(b));
  assert.ok(/_ownTxRefused = \{ why, at: now \}/.test(MAIN), 'every refusal is recorded, logged or not');
});

console.log('(c) the radio is tuned to the SSTV frequency first');
const B20 = ['160m', '80m', '40m', '30m', '20m', '17m', '15m', '12m', '10m', '6m'];
test('NA4DQ: radio left on the Winlink gateway (14.105 DIGU) -> 14.230 USB before the picture', () => {
  assert.deepStrictEqual(S.sendChannel({ radioHz: 14105000, bands: B20 }), { act: 'tune', freqKhz: 14230, mode: 'USB' });
});
test('the phone named its channel: tune there', () => {
  assert.deepStrictEqual(S.sendChannel({ radioHz: 14105000, requestedKhz: 14230, bands: B20 }), { act: 'tune', freqKhz: 14230, mode: 'USB' });
  assert.deepStrictEqual(S.sendChannel({ radioHz: 18104600, requestedKhz: 7171, bands: B20 }), { act: 'tune', freqKhz: 7171, mode: 'LSB' });
  assert.deepStrictEqual(S.sendChannel({ radioHz: 18104600, requestedKhz: '14233', bands: B20 }), { act: 'tune', freqKhz: 14233, mode: 'USB' }, 'a string from an older client');
});
test('already on SSTV (on or near the channel, 14.240 when 14.230 is busy): not moved', () => {
  assert.strictEqual(S.sendChannel({ radioHz: 14230000 }).act, 'stay');
  assert.strictEqual(S.sendChannel({ radioHz: 14240000 }).act, 'stay');
  assert.strictEqual(S.sendChannel({ radioHz: 14233000, requestedKhz: 14230 }).act, 'stay');
  assert.strictEqual(S.sendChannel({ radioHz: 3845000 }).act, 'stay');
  assert.strictEqual(S.sendChannel({ radioHz: 3730000 }).act, 'stay', 'the European 80 m channel too');
});
test('elsewhere on an SSTV band: that band\'s channel, in its sideband', () => {
  assert.deepStrictEqual(S.sendChannel({ radioHz: 7074000 }), { act: 'tune', freqKhz: 7171, mode: 'LSB' });
  assert.deepStrictEqual(S.sendChannel({ radioHz: 18104600 }), { act: 'tune', freqKhz: 18161, mode: 'USB' });
  assert.deepStrictEqual(S.sendChannel({ radioHz: 28074000 }), { act: 'tune', freqKhz: 28680, mode: 'USB' });
  assert.deepStrictEqual(S.sendChannel({ radioHz: 3573000 }), { act: 'tune', freqKhz: 3845, mode: 'LSB' });
});
test('a band with no SSTV channel (30 m) or an unknown dial: Idle Mode\'s day/night channel', () => {
  assert.deepStrictEqual(S.sendChannel({ radioHz: 10136000, daytime: true }), { act: 'tune', freqKhz: 14230, mode: 'USB' });
  assert.deepStrictEqual(S.sendChannel({ radioHz: 10136000, daytime: false }), { act: 'tune', freqKhz: 7171, mode: 'LSB' });
  assert.deepStrictEqual(S.sendChannel({ radioHz: 0 }), { act: 'tune', freqKhz: 14230, mode: 'USB' });
});
test('never a band the radio is not set up for (#292)', () => {
  const vhf = ['2m', '70cm'];
  const r = S.sendChannel({ radioHz: 146520000, bands: vhf });
  assert.strictEqual(r.act, 'stay');
  assert.strictEqual(r.why, SstvStartBand.NO_BAND_NOTE);
  const q = S.sendChannel({ radioHz: 146520000, requestedKhz: 14230, bands: vhf });
  assert.strictEqual(q.act, 'stay');
  assert.ok(/not set up for 20m/.test(q.why));
  assert.deepStrictEqual(S.sendChannel({ radioHz: 7074000, bands: ['20m'] }), { act: 'tune', freqKhz: 14230, mode: 'USB' }, '40 m not set up: 20 m');
});
test('split on: the dial is not where it transmits, so it is not tuned', () => {
  const r = S.sendChannel({ radioHz: 14105000, split: true });
  assert.strictEqual(r.act, 'stay');
  assert.ok(/split/.test(r.why));
});
test('the channels match the SSTV window\'s list', () => {
  const pop = R('renderer/sstv-popout.js');
  for (const list of Object.values(S.CHANNELS_KHZ)) for (const k of list) assert.ok(new RegExp(`value="${k}"`).test(pop), k + ' kHz is in the window\'s list');
});
test('main: plan, open the window on that frequency, tune, then encode', () => {
  const h = slice(MAIN, "remoteServer.on('sstv-photo', ({ image, mode, guest, freqKhz }) => {", "remoteServer.on('sstv-stop'");
  assert.ok(/const plan = guest \? \{ act: 'stay' \} : SstvSend\.sendChannel\(\{/.test(h), 'a guest\'s picture never moves the radio');
  assert.ok(/radioHz: _currentFreqHz, requestedKhz: freqKhz, bands: activeRigBands\(\)/.test(h));
  const tune = h.indexOf("tuneRadio(plan.freqKhz, plan.mode, undefined, { origin: 'SSTV picture from ECHOCAT' })");
  const open = h.indexOf('openSstvPopout(hereKhz > 0 ? {');
  const enc = h.indexOf('sstvEngine.encode(');
  assert.ok(open > 0 && tune > open && enc > tune, 'the window (it releases JTCAT), then the tune, then the encode');
  assert.ok(/openedBy: 'app', freqKhz: hereKhz, mode: plan\.mode \|\| ''/.test(h), 'the window opens where the radio is going, not on its own selection');
  // The guest gate still asks the pass on the effective TX frequency (guest-pass-tx-gate-test).
  assert.ok(/interceptCatCommand\(\{ type: 'sstv_tx', freqHz: effectiveTxFreqHz\(\), split: _currentSplit \}\)/.test(h));
});

console.log('the wire (docs/echocat-protocol.md, lib/echocat-protocol.js)');
test('sstv-photo carries freqKhz; sstv-tx-status carries error; the hello says sstv-send-tune', () => {
  const P = require('../lib/echocat-protocol');
  const schema = P.MESSAGES || P.SCHEMA || P.messages;
  if (schema) {
    assert.ok(schema['sstv-photo'].fields.freqKhz, 'sstv-photo.freqKhz');
    assert.ok(schema['sstv-tx-status'].fields.error, 'sstv-tx-status.error');
  } else {
    const src = R('lib/echocat-protocol.js');
    assert.ok(/'sstv-photo': \{[^\n]*freqKhz: f\.optNumber/.test(src));
    assert.ok(/'sstv-tx-status': \{[^\n]*error: f\.optString/.test(src));
  }
  const rs = R('lib/remote-server.js');
  assert.ok(/'sstv-send-tune',/.test(rs), 'capability advertised');
  assert.ok(/freqKhz: Number\(msg\.freqKhz\) > 0 \? Number\(msg\.freqKhz\) : undefined,/.test(rs), 'passed through to main');
  const doc = R('docs/echocat-protocol.md');
  assert.ok(/sstv-send-tune/.test(doc) && /`error`/.test(doc));
});
test('ECHOCAT Web sends its channel and shows why a picture was not sent', () => {
  const web = R('renderer/remote.js');
  assert.ok(/if \(sendKhz > 0\) photoMsg\.freqKhz = sendKhz;/.test(web));
  assert.ok(/if \(msg\.error\) \{ sstvPhoneStatus\.textContent = String\(msg\.error\);/.test(web));
});
test('the handoff to the ECHOCAT app is written', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'docs', 'handoffs', 'DESKTOP_TO_ECHOCAT_HANDOFF_2026-11-13_SSTV_STATUS.md')));
});

console.log(`\nSSTV picture from ECHOCAT (#357): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
