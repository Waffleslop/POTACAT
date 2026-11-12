#!/usr/bin/env node
'use strict';
// Winlink diagnostics (#295; docs/ardop-macos-plan.md layer L5): the modem's
// own events in the session log, the audio's health per session, the modem
// logs in Report a Bug, and the one-session recording.
// Run: node test/winlink-diag-test.js
const assert = require('assert');
const net = require('net');
const path = require('path');
const { readSrc } = require('./_src');
const D = require('../lib/winlink-diag');
const { ModemAudioServer } = require('../lib/modem-audio-server');

let pass = 0, fail = 0;
const pending = [];
function test(name, fn) {
  const run = async () => {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
  };
  pending.push([name, run]);
}

const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));

console.log('Winlink diagnostics (#295)');

// Real ardopcf 1.0.4.1.3 lines (K3SBP to KY4RY, 2026-11-11, and a loopback run).
test('ardopcf debug lines become plain events', () => {
  const c = D.classifyArdopDebugLine;
  assert.deepStrictEqual(c('22:20:26.273 I [SendARQConnectRequest] MYCALL=K3SBP  TARGET=KY4RY bytPendingSessionID=ad'), { kind: 'call', text: 'calling KY4RY' });
  assert.strictEqual(c('12:27:09.285 I Sending Frame Type ConReq2000M').text, 'sent ConReq2000M');
  const r = c('22:20:55.202 I [DecodeFrame] Frame: ConAck2000 Decode PASS,  Quality= 94,  RS fixed 0 (of 0 max).');
  assert.strictEqual(r.kind, 'rx'); assert.strictEqual(r.quality, 94);
  assert.strictEqual(r.text, 'heard ConAck2000 (quality 94)');
  assert.strictEqual(c('22:21:02.509 D poor frame type decode').kind, 'rx-fail');
  assert.strictEqual(c('22:20:59.857 D  Command Trace TO Host CONNECTED KY4RY 2000').text, 'CONNECTED to KY4RY at 2000 Hz');
  assert.strictEqual(c('12:37:01.000 I BUSY TRUE').text, 'the channel reads busy');
  assert.strictEqual(c('12:37:09.000 I BUSY FALSE').text, 'the channel reads clear');
  assert.strictEqual(c('22:21:00.844 D [Acquire2ToneLeaderSymbolFraming] intIatMinError= -1'), null, 'routine debug lines are not session-log lines');
});

test('Dire Wolf frame lines become plain events', () => {
  assert.strictEqual(D.classifyDirewolfLine('[0L] K3SBP>W9OU-10:(SABM cmd, p=1)').kind, 'tx');
  assert.strictEqual(D.classifyDirewolfLine('[0.4] W9OU-10>K3SBP:(UA res, f=1)').kind, 'rx');
  assert.strictEqual(D.classifyDirewolfLine('Dire Wolf version 1.7'), null);
});

test('the session log gets one line per run of the same event, never a flood', () => {
  const log = new D.ModemEventLog({ perSec: 4 });
  const out = [];
  let t = 1000000;
  out.push(...log.feed({ text: 'calling KY4RY' }, t));
  for (let i = 0; i < 9; i++) out.push(...log.feed({ text: 'sent ConReq2000M' }, t += 3700));
  out.push(...log.feed({ text: 'heard ConAck2000 (quality 94)' }, t += 1000));
  out.push(...log.flush(t));
  assert.deepStrictEqual(out, ['calling KY4RY', 'sent ConReq2000M', 'sent ConReq2000M (x9)', 'heard ConAck2000 (quality 94)']);
  const burst = new D.ModemEventLog({ perSec: 4 });
  const b = [];
  for (let i = 0; i < 10; i++) b.push(...burst.feed({ text: 'event ' + i }, 5000000));
  b.push(...burst.flush(5001000));
  assert.strictEqual(b.filter((l) => /^event/.test(l)).length, 4, 'at most perSec lines a second');
  assert.ok(b.some((l) => /6 more modem lines not shown/.test(l)), 'the rest are counted, not lost silently');
});

test('Report a Bug takes ardopcf\'s last run, without its routine debug lines, capped', () => {
  const text = [
    '10:00:00.000 I ardopcf Version 1.0.4.1.3 (https://www.github.com/pflarue/ardop)',
    '10:00:01.000 I Sending Frame Type ConReq500M',
    '11:00:00.000 I ardopcf Version 1.0.4.1.3 (https://www.github.com/pflarue/ardop)',
    '11:00:01.000 D [Acquire2ToneLeaderSymbolFraming] intIatMinError= 0',
    '11:00:02.000 I Sending Frame Type ConReq2000M',
    '11:00:03.000 D  Command Trace TO Host CONNECTED KY4RY 2000',
  ].join('\n');
  const r = D.lastArdopRun(text);
  assert.deepStrictEqual(r.lines.map((l) => l.slice(0, 12)), ['11:00:00.000', '11:00:02.000', '11:00:03.000'], 'last run only; debug kept only when it is an event');
  const many = Array.from({ length: 500 }, (_, i) => '11:00:00.000 I line ' + i).join('\n');
  const capped = D.lastArdopRun(many, { maxLines: 150, maxChars: 12000 });
  assert.strictEqual(capped.lines.length, 150);
  assert.strictEqual(capped.omitted, 350);
  assert.ok(capped.lines[149].endsWith('line 499'), 'the newest lines are kept');
});

test('raw memory in a modem log never reaches a report: a line with non-text bytes is dropped whole and counted', () => {
  // ardopcf's files carry runs of raw memory (K3SBP 2026-11-11: 440 binary lines a file).
  const text = [
    '11:00:00.000 I ardopcf Version 1.0.4.1.3 (https://www.github.com/pflarue/ardop)',
    '11:00:01.000 I Sending Frame Type ConReq2000M',
    '\u0000\u0000G\u0002-\u0000\u0000\u0000secret?\u0000Invalid parameter passed to C runtime function.',
    'abc\u0007def',
    'text then a byte that was not text �',
    '11:00:02.000 I [DecodeFrame] Frame: END Decode PASS,  Quality= 90,  RS fixed 0 (of 0 max).',
    '    Avg Frame Type decode distance= 0.9\tover 33 decodes',
  ].join('\n');
  const r = D.lastArdopRun(text, { keepDebug: true });
  assert.strictEqual(r.binary, 3);
  assert.ok(r.lines.every((l) => !/[\u0000-\u0008\u000a-\u001f\u007f-\u009f�]/.test(l)), 'no control or non-text byte survives');
  assert.ok(!r.lines.some((l) => l.includes('secret?')), 'the readable part of a binary line goes too');
  assert.strictEqual(r.lines.length, 4, 'every plain line, tabs included, is kept');
  const dw = D.capTail(['[0L] K3SBP>KY4RY:', 'x\u0000y']);
  assert.deepStrictEqual(dw.lines, ['[0L] K3SBP>KY4RY:']);
  assert.strictEqual(dw.binary, 1);
});

test('the audio meter counts only holes where the audio ran out', () => {
  const m = new D.AudioFlowMeter({ rate: 12000, warnMs: 50, idleMs: 1000 });
  let t = 0;
  // ardopcf writes 100 ms of audio at a time, 100 ms apart: bursty, never empty.
  for (let i = 0; i < 20; i++) m.note(1200, t += 100);
  assert.strictEqual(m.maxGapMs, 0, 'bursty writes are not holes');
  m.note(1200, t += 180); // 80 ms after the last block's sound ended
  assert.strictEqual(Math.round(m.maxGapMs), 80);
  assert.strictEqual(m.gapsOverWarn, 1);
  m.note(1200, t += 5000); // the modem stopped transmitting: rest, not a dropout
  assert.strictEqual(Math.round(m.maxGapMs), 80);
  const s = m.snapshot(12000);
  assert.strictEqual(s.blocks, 22); assert.strictEqual(s.seconds, 2);
  assert.ok(/radio to modem 2 s, largest gap 80 ms \(1 gap over 50 ms\)/.test(D.audioSummaryText({ rx: s, tx: null })));
});

test('the recording is a real 16-bit mono WAV, capped at its length, from odd-offset buffers too', () => {
  const r = new D.PcmRecorder({ rate: 12000, seconds: 1 });
  const odd = Buffer.alloc(24001);
  for (let i = 0; i < 12000; i++) odd.writeInt16LE(i % 2 ? 1000 : -1000, 1 + i * 2);
  r.push(odd.subarray(1)); // byteOffset 1
  assert.ok(r.full);
  assert.strictEqual(r.push(new Int16Array(100)), true, 'nothing past the cap');
  const w = r.toWav();
  assert.strictEqual(w.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(w.readUInt32LE(24), 12000, 'sample rate');
  assert.strictEqual(w.readUInt16LE(22), 1, 'mono');
  assert.strictEqual(w.readUInt16LE(34), 16, '16-bit');
  assert.strictEqual(w.readUInt32LE(40), 24000, 'one second of data');
  assert.strictEqual(w.readInt16LE(44), -1000);
  assert.strictEqual(w.readInt16LE(46), 1000);
});

test('the modem audio server measures both directions and feeds the recorder tap', async () => {
  const srv = new ModemAudioServer({ makeResampler: () => ({ process: (x) => x }), txOutRate: 12000 });
  const port = await srv.listen(0);
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r) => srv.once('modem-connected', r));
  const tapped = { rx: 0, tx: 0 };
  srv.tap = { rx: (b) => { tapped.rx += b.length / 2; }, tx: (b) => { tapped.tx += b.length / 2; } };
  srv.feedRx(new Float32Array(1200), 12000);
  srv.feedRx(new Float32Array(1200), 12000);
  const txDone = new Promise((r) => srv.once('tx', r));
  sock.write(Buffer.alloc(2400));
  await txDone;
  assert.strictEqual(srv.rxMeter.blocks, 2); assert.strictEqual(tapped.rx, 2400);
  assert.strictEqual(srv.txMeter.blocks, 1); assert.strictEqual(tapped.tx, 1200);
  srv.resetMeters();
  assert.strictEqual(srv.rxMeter.blocks, 0);
  sock.destroy(); await srv.close();
});

test('wired: the tail and the audio facts run for each ARDOP or packet session', () => {
  assert.ok(/if \(mode === 'ardop' \|\| mode === 'packet'\) winlinkAudioDiagStart\(\);\s*if \(mode === 'ardop'\) startArdopTail\(\);/.test(main));
  assert.ok(/if \(s\.mode === 'ardop'\) stopArdopTail\(\);\s*winlinkAudioDiagEnd\(\);\s*if \(s\.mode === 'ardop'\) killArdop\(\);/.test(main), 'flushed before the modem is stopped');
  assert.ok(/winlinkLog\('ardop: ' \+ o\)/.test(main));
  assert.ok(/playback "\$\{modemBridge\.playbackLabel/.test(main) && /modemBridge\.playbackSampleRate = s\.playbackSampleRate/.test(main));
  assert.ok(/playbackSampleRate: playCtx\.sampleRate/.test(readSrc(path.join(root, 'renderer', 'modem-audio-bridge.js'))));
  assert.ok(/direwolfRingPush\(line\);/.test(main), 'Dire Wolf\'s lines are kept for the report');
});

test('wired: the recording is one session only, and Report a Bug carries the modem logs', () => {
  assert.ok(/settings\.winlinkRecordModemAudio = false; \/\/ one session only/.test(main));
  assert.ok(/winlinkModem: \(\(\) => \{ try \{ const m = winlinkModemReport\(\);/.test(main) && /lines: clean\(x\.lines\)/.test(main), 'masked and redacted like the session log');
  const app = readSrc(path.join(root, 'renderer', 'app.js'));
  assert.ok(/### ARDOP modem log \(/.test(app) && /### Packet modem \(Dire Wolf\), last lines/.test(app) && /Modem recordings to attach:/.test(app));
  const html = readSrc(path.join(root, 'renderer', 'index.html'));
  assert.ok(/<input type="checkbox" id="set-winlink-record-audio"> Record what the modem hears on the next radio session<\/label>/.test(html));
  assert.ok(/winlinkRecordModemAudio: setWinlinkRecordAudio \? setWinlinkRecordAudio\.checked : false/.test(app));
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/winlink-diag-test.js'"));
});

(async () => {
  for (const [, run] of pending) await run();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
