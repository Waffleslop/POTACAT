'use strict';
// #905: a FreeDV stop that arrives while the receive capture is still opening
// wins. The open used to finish after the stop and keep the capture, which then
// held the radio's input device. Runs the real startFreedvForMode / stopFreedv
// from renderer/app.js against a fake getUserMedia whose open we hold.
// Run: node test/freedv-stop-during-open-test.js
const assert = require('assert');
const path = require('path');
const vm = require('vm');
const { readSrc } = require('./_src');
const G = require('../lib/capture-open-guard');

let passed = 0;
const tests = [];
function t(name, fn) { tests.push([name, fn]); }

const app = readSrc(path.join(__dirname, '..', 'renderer', 'app.js'));
const from = app.indexOf('let freedvActive = false;');
const to = app.indexOf('// Sync indicator in status bar');
assert.ok(from > 0 && to > from, 'FreeDV section found in renderer/app.js');
const section = app.slice(from, to);

function fakeStream() {
  const track = { stopped: false, stop() { this.stopped = true; } };
  return { track, getTracks() { return [track]; } };
}

function harness() {
  const opens = [];      // pending getUserMedia calls: { resolve, stream }
  const contexts = [];
  const calls = { freedvStop: 0 };
  let settingsResolve = null;
  let holdSettings = false;
  class FakeAudioContext {
    constructor() { this.sampleRate = 48000; this.closed = false; this.destination = {}; contexts.push(this);
      this.audioWorklet = { addModule: () => Promise.resolve() }; }
    createMediaStreamSource() { return { connect() {} }; }
    close() { this.closed = true; return Promise.resolve(); }
  }
  class FakeWorkletNode { constructor() { this.port = {}; } connect() {} disconnect() {} }
  const window = {
    CaptureOpenGuard: G,
    api: {
      platform: 'win32',
      getSettings: () => holdSettings
        ? new Promise((r) => { settingsResolve = () => r({ enableFreedv: true }); })
        : Promise.resolve({ enableFreedv: true }),
      freedvStop() { calls.freedvStop++; },
      freedvSetTx() {},
      freedvRxAudio() {},
      jtcatLog() {},
    },
  };
  const ctx = vm.createContext({
    window,
    navigator: { mediaDevices: { getUserMedia: () => new Promise((resolve) => {
      const stream = fakeStream(); opens.push({ resolve: () => resolve(stream), stream }); }) } },
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeWorkletNode,
    document: { getElementById: () => null },
    console: { log() {}, error() {} },
    Date,
  });
  vm.runInContext(section + '\nthis.__fd = { startFreedvForMode, stopFreedv, stream: () => freedvAudioStream, active: () => freedvActive };', ctx);
  return {
    fd: ctx.__fd, opens, contexts, calls,
    holdSettings() { holdSettings = true; },
    releaseSettings() { settingsResolve(); },
  };
}
const tick = () => new Promise((r) => setImmediate(r));

t('guard: cancel and a newer begin make an open stale', () => {
  const g = G.createOpenGuard();
  const a = g.begin();
  assert.strictEqual(g.isCurrent(a), true);
  g.cancel();
  assert.strictEqual(g.isCurrent(a), false);
  const b = g.begin();
  const c = g.begin();
  assert.strictEqual(g.isCurrent(b), false);
  assert.strictEqual(g.isCurrent(c), true);
  const s = fakeStream();
  G.releaseStream(s); G.releaseStream(null);
  assert.strictEqual(s.track.stopped, true);
});

t('a normal start keeps the capture, and stop releases it', async () => {
  const h = harness();
  const p = h.fd.startFreedvForMode('FREEDV');
  await tick();
  assert.strictEqual(h.opens.length, 1, 'getUserMedia called');
  h.opens[0].resolve();
  await p;
  assert.strictEqual(h.fd.stream(), h.opens[0].stream, 'capture kept');
  assert.strictEqual(h.opens[0].stream.track.stopped, false);
  h.fd.stopFreedv();
  assert.strictEqual(h.opens[0].stream.track.stopped, true);
  assert.strictEqual(h.fd.stream(), null);
});

t('a stop while getUserMedia is opening wins: tracks stopped, capture not kept', async () => {
  const h = harness();
  const p = h.fd.startFreedvForMode('FREEDV');
  await tick();
  assert.strictEqual(h.opens.length, 1);
  h.fd.stopFreedv();
  h.opens[0].resolve();
  await p;
  assert.strictEqual(h.opens[0].stream.track.stopped, true, 'the late stream is stopped');
  assert.strictEqual(h.fd.stream(), null, 'no capture kept after the stop');
  assert.strictEqual(h.contexts.length, 0, 'no AudioContext built for a stopped open');
});

t('a stop while the settings are read wins: nothing opens, FreeDV not left active', async () => {
  const h = harness();
  h.holdSettings();
  const p = h.fd.startFreedvForMode('FREEDV');
  await tick();
  h.fd.stopFreedv();
  h.releaseSettings();
  await p;
  await tick();
  assert.strictEqual(h.opens.length, 0, 'getUserMedia not called after the stop');
  assert.strictEqual(h.fd.active(), false);
});

t('stop then start while the first open is pending: only the second capture is kept', async () => {
  const h = harness();
  const p1 = h.fd.startFreedvForMode('FREEDV');
  await tick();
  h.fd.stopFreedv();
  const p2 = h.fd.startFreedvForMode('FREEDV');
  await tick();
  assert.strictEqual(h.opens.length, 2);
  h.opens[1].resolve();
  await p2;
  h.opens[0].resolve();
  await p1;
  assert.strictEqual(h.opens[0].stream.track.stopped, true, 'first (stale) stream stopped');
  assert.strictEqual(h.opens[1].stream.track.stopped, false, 'second stream still running');
  assert.strictEqual(h.fd.stream(), h.opens[1].stream);
  assert.strictEqual(h.contexts.filter((c) => !c.closed).length, 1, 'one live AudioContext');
});

t('the page loads lib/capture-open-guard.js', () => {
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'index.html'));
  assert.ok(/<script src="\.\.\/lib\/capture-open-guard\.js"><\/script>/.test(html));
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok', name); }
    catch (e) { console.error('  FAIL', name, '\n', e && e.message); process.exitCode = 1; }
  }
  console.log(`freedv-stop-during-open: ${passed}/${tests.length} passed`);
})();
