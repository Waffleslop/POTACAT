#!/usr/bin/env node
'use strict';
// The modem audio lane (lib/modem-audio-lane.js, #187): the modem's audio path
// off the main process. LaneCore is driven here with a stand-in worklet that
// plays in real time, so the rules are checked without Electron:
//   - nothing is sent before key-down; what came early is the frame's start (#289)
//   - the worklet is never sent more than its ring holds, so nothing is cut there
//   - a stalled worklet: the lane holds FIFO_MAX_MS, then cuts — counted and reported
//   - endOver: the worklet reports 'drained' when it has played the over out
//   - a route without the worklet (Flex / Icom), or no port yet: back to main
// Run: node test/modem-audio-lane-test.js
const assert = require('assert');
const path = require('path');
const vm = require('vm');
const { readSrc } = require('./_src');
const { LaneCore, TX_RATE } = require('../lib/modem-audio-lane');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n       ' + (e && e.stack || e)); } };
const root = path.join(__dirname, '..');

// The REAL play worklet (renderer/modem-play-worklet.js) in a stand-in scope, wired to a lane.
function rig({ rate = 48000, ringMs = 2000, prebufferMs = 250, fifoMaxMs = 10000 } = {}) {
  let Proc = null;
  class AudioWorkletProcessor { constructor() { this.port = { onmessage: null, postMessage: () => {} }; } }
  vm.runInNewContext(readSrc(path.join(root, 'renderer', 'modem-play-worklet.js')), { AudioWorkletProcessor, sampleRate: rate, registerProcessor: (_n, c) => { Proc = c; }, Float32Array, Math });
  const w = new Proc({ processorOptions: { sourceRate: TX_RATE, ringMs, prebufferMs } });
  const events = [];
  let now = 0;
  const lane = new LaneCore({ toMain: (evt, data) => events.push({ evt, data }), now: () => now, fifoMaxMs });
  // Lane <-> worklet: messages delivered at once (the stall is modeled by not running process()).
  const toWorklet = [];
  const lanePortForWorklet = { postMessage: (m) => lane.onWorklet(m), onmessage: null };
  w.onMsg({ cmd: 'lane' }, [lanePortForWorklet]);
  lane.setTxPort({ postMessage: (m) => { toWorklet.push(m); w.onMsg(m); } });
  const out = [];
  let debt = 0;
  const play = (ms) => { debt += rate * ms / 1000; for (; debt >= 128; debt -= 128) { const b = new Float32Array(128); w.process([], [[b]]); out.push(b); now += 128 * 1000 / rate; } };
  const modem = (ms, v = 0.5) => { const f = new Float32Array(Math.round(TX_RATE * ms / 1000)); f.fill(v); lane.modemTx(f); };
  const evts = (name) => events.filter((e) => e.evt === name);
  return { w, lane, play, modem, events, evts, out, toWorklet };
}

console.log('modem audio lane');

t('audio before key-down is held, then sent first at key-down; nothing reaches the worklet before', () => {
  const r = rig();
  r.modem(80);
  assert.strictEqual(r.toWorklet.filter((m) => m.pcm).length, 0, 'not keyed: nothing sent');
  r.lane.key(true, { bridge: true });
  const first = r.toWorklet.findIndex((m) => m.pcm);
  assert.ok(r.toWorklet.findIndex((m) => m.cmd === 'over-start') < first, 'the over opens before its audio');
  assert.strictEqual(r.evts('prekey-sent').length, 1);
  assert.ok(r.evts('prekey-sent')[0].data.ms >= 75);
});

t('a 200 ms stall of everything upstream leaves no hole and cuts nothing (the pre-buffer rides it out)', () => {
  const r = rig();
  r.lane.key(true, { bridge: true });
  // The modem writes 20 ms every 20 ms; at 1.0 s nothing arrives for 200 ms, then the backlog at once.
  for (let i = 0; i < 100; i++) {
    if (i >= 50 && i < 60) { r.play(20); continue; }
    if (i === 60) r.modem(200);
    r.modem(20); r.play(20);
  }
  r.lane.endOver({ leaveMs: 0 });
  r.play(600);
  const d = r.evts('drained');
  assert.strictEqual(d.length, 1, 'the bridge reports the end of the over');
  assert.strictEqual(d[0].data.over, null, `no damage reported: ${JSON.stringify(d[0].data.over)}`);
  assert.strictEqual(r.evts('tx-cut').length, 0);
});

t('the worklet is never sent more than its ring holds: a 3 s burst waits in the lane, nothing is dropped', () => {
  const r = rig({ ringMs: 2000 });
  r.lane.key(true, { bridge: true });
  r.modem(3000);
  let held = 0; for (const m of r.toWorklet) if (m.pcm) held += m.pcm.length;
  assert.ok(held <= TX_RATE * 2, `sent ${held} samples into a 2 s ring`);
  r.play(3500);
  r.lane.endOver({}); r.play(300);
  let sent = 0; for (const m of r.toWorklet) if (m.pcm) sent += m.pcm.length;
  assert.strictEqual(sent, TX_RATE * 3, 'all of it, in the end');
  assert.strictEqual(r.w.droppedTotal, 0);
  assert.strictEqual(r.evts('tx-cut').length, 0);
});

t('a worklet that stops reading: the lane keeps FIFO_MAX_MS, then cuts and says how much', () => {
  const r = rig({ fifoMaxMs: 1000, ringMs: 500 });
  r.lane.key(true, { bridge: true });
  r.modem(2500); // 0.5 s into the ring, 1 s held, the rest cut
  const cuts = r.evts('tx-cut');
  assert.ok(cuts.length >= 1, 'reported');
  const total = cuts[cuts.length - 1].data.totalMs;
  assert.ok(total >= 900 && total <= 1100, `about 1000 ms cut, got ${total}`);
  assert.strictEqual(r.lane.stats().txCutMs, total);
});

t('drained comes only after the audio has played, pre-buffer included', () => {
  const r = rig();
  r.lane.key(true, { bridge: true });
  r.modem(400);
  r.lane.endOver({});
  r.play(200);
  assert.strictEqual(r.evts('drained').length, 0, 'still playing');
  r.play(400);
  assert.strictEqual(r.evts('drained').length, 1);
});

t('packet may leave its extra tail unplayed (leaveMs)', () => {
  const r = rig({ prebufferMs: 0 });
  r.lane.key(true, { bridge: true });
  r.modem(500);
  r.lane.endOver({ leaveMs: 200 });
  r.play(320);
  assert.strictEqual(r.evts('drained').length, 1, 'drained with about 200 ms still queued');
});

t('re-keyed before the end: the over goes on, no early drained', () => {
  const r = rig({ prebufferMs: 0 });
  r.lane.key(true, { bridge: true });
  r.modem(100);
  r.lane.endOver({});
  r.lane.cancelEnd();
  r.play(300);
  assert.strictEqual(r.evts('drained').length, 0);
});

t('the Flex / Icom route, and a bridge with no port yet: leveled audio goes back to main', () => {
  const r = rig();
  r.lane.key(true, { bridge: false });
  r.modem(40);
  assert.ok(r.evts('tx-out').length >= 1);
  assert.strictEqual(r.toWorklet.filter((m) => m.pcm).length, 0);
  const lone = new LaneCore({ toMain: (e) => lone._e.push(e) }); lone._e = [];
  lone.key(true, { bridge: true }); lone.modemTx(new Float32Array(480));
  assert.ok(lone._e.includes('tx-out'));
  assert.strictEqual(lone.endOver({}), false, 'no port: main keeps its own drain timer');
});

t('key-up drops what is queued (the carrier is gone): not counted as a cut', () => {
  const r = rig();
  r.lane.key(true, { bridge: true });
  r.modem(3000);
  r.lane.key(false);
  assert.strictEqual(r.lane.stats().fifoMs, 0);
  assert.strictEqual(r.evts('tx-cut').length, 0);
});

t('every chunk from the modem is measured for the over\'s log line, and the leveler runs in the lane', () => {
  const r = rig();
  r.lane.key(true, { bridge: true, seedGain: 2 });
  r.modem(100, 0.25);
  const n = r.evts('tx-note');
  assert.ok(n.length >= 1 && Math.abs(n[0].data.peak - 0.25) < 1e-6);
  const sent = r.toWorklet.find((m) => m.pcm);
  assert.ok(sent.pcm[0] > 0.45, 'seeded gain 2 applied');
});

t('receive from the capture worklet goes straight to the modem; skipped frames are counted', () => {
  const fed = [];
  const lane = new LaneCore({ feedRx: (pcm, rate) => fed.push([pcm.length, rate]) });
  lane.onCapture({ pcm: new Float32Array(960), sampleRate: 48000, skipped: 0 });
  lane.onCapture({ pcm: new Float32Array(960), sampleRate: 48000, skipped: 128 });
  assert.deepStrictEqual(fed, [[960, 48000], [960, 48000]]);
  assert.deepStrictEqual({ frames: lane.stats().rx.frames, skipped: lane.stats().rx.skipped }, { frames: 1920, skipped: 128 });
});

t('main.js: the lane owns the modem socket and main only keys it', () => {
  const main = readSrc(path.join(root, 'main.js'));
  assert.ok(/new ModemAudioLane\(\{ modemRate, log: winlinkLog \}\)/.test(main));
  assert.ok(!/new ModemAudioServer\(/.test(main), 'no modem socket in main');
  assert.ok(/winlinkLaneKeyDown\(\); \/\/ the start of this frame/.test(main));
  assert.ok(/winlinkAudio\.endOver\(\{ leaveMs: winlinkUnkeyLeaveMs\(\) \}\)/.test(main), 'PTT off when the bridge has played the frame');
  assert.ok(/winlinkAudio\.attachBridge\(modemBridgeWin\.webContents/.test(main), 'each worklet gets its port');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
