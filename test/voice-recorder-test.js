#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Voice macro recorder (ride1226 2026-10-31: cut-off recordings, no audio,
// a button that did nothing). lib/voice-recorder.js against a fake mic and a
// fake MediaRecorder; app.js wiring by source.
// Run: node test/voice-recorder-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createVoiceRecorder, bytesToBase64, describeMicError } = require('../lib/voice-recorder');

let passed = 0, failed = 0;
let chain = Promise.resolve();
function test(name, fn) {
  // One at a time: the fake recorder is shared.
  chain = chain.then(fn).then(
    () => { passed++; console.log('  ok  ' + name); },
    (e) => { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); });
}

class FakeRecorder {
  constructor(stream, opts) { this.stream = stream; this.mimeType = (opts && opts.mimeType) || 'audio/webm'; FakeRecorder.last = this; }
  start(slice) { this.slice = slice; this.state = 'recording'; }
  push(n) { this.ondataavailable({ data: { size: n } }); }
  stop() { this.state = 'inactive'; setImmediate(() => this.onstop()); }
}
class FakeBlob { constructor(parts, o) { this.parts = parts; this.type = o.type; } }
function fakeStream() { const t = { stopped: false, stop() { this.stopped = true; } }; return { track: t, getTracks: () => [t] }; }
function harness(over = {}) {
  const states = [];
  let stream = null, gumResolve, gumReject;
  const timers = [];
  const r = createVoiceRecorder(Object.assign({
    getUserMedia: () => new Promise((res, rej) => { gumResolve = (s) => { stream = s; res(s); }; gumReject = rej; }),
    MediaRecorder: FakeRecorder, Blob: FakeBlob, maxMs: 30000,
    onState: (s, info) => states.push([s, info]),
    onDone: () => {},
    setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
  }, over));
  return { r, states, timers, gum: () => ({ resolve: gumResolve, reject: gumReject }), stream: () => stream };
}
const tick = () => new Promise((r) => setImmediate(r));

test('base64 of a long take does not throw (the old apply() over every byte did)', () => {
  const bytes = new Uint8Array(600000).map((_, i) => i & 0xff);
  const b64 = bytesToBase64(bytes);
  assert.strictEqual(Buffer.from(b64, 'base64').length, 600000);
  assert.ok(Buffer.from(b64, 'base64').equals(Buffer.from(bytes)));
  assert.throws(() => String.fromCharCode.apply(null, new Uint8Array(600000)), RangeError, 'the old way really fails at this size');
});

test('record, stop, saved; audio is delivered every 250 ms', async () => {
  const h = harness({ onDone: (blob) => { h.saved = blob; } });
  const p = h.r.start({ mimeType: 'audio/webm' });
  assert.strictEqual(h.r.state, 'requesting');
  h.gum().resolve(fakeStream());
  await p;
  assert.strictEqual(h.r.state, 'recording');
  assert.strictEqual(FakeRecorder.last.slice, 250);
  FakeRecorder.last.push(100); FakeRecorder.last.push(50);
  h.r.stop();
  await tick(); await tick();
  assert.ok(h.saved && h.saved.parts.length === 2, 'both slices saved');
  assert.deepStrictEqual(h.states.map((s) => s[0]), ['requesting', 'recording', 'saving', 'idle']);
  assert.ok(h.stream().track.stopped, 'the mic is released');
});

test('Stop while the mic is still opening cancels; no second take starts', async () => {
  const h = harness();
  const p = h.r.start({});
  assert.strictEqual(await h.r.start({}), false, 'a second start while opening is refused');
  h.r.stop();
  assert.strictEqual(h.r.state, 'idle');
  const s = fakeStream();
  h.gum().resolve(s);
  await p;
  assert.strictEqual(h.r.state, 'idle', 'the late mic does not start recording');
  assert.ok(s.track.stopped, 'and is released');
});

test('a mic error names the device and the reason', async () => {
  const h = harness();
  const p = h.r.start({ deviceLabel: 'USB Audio CODEC' });
  h.gum().reject(Object.assign(new Error('x'), { name: 'NotReadableError' }));
  await p;
  const last = h.states[h.states.length - 1];
  assert.strictEqual(last[0], 'error');
  assert.ok(/"USB Audio CODEC" is in use by another program/.test(last[1].message), last[1].message);
  assert.ok(/privacy settings/.test(describeMicError({ name: 'NotAllowedError' })));
});

test('the 30 s limit stops the take and keeps what was recorded', async () => {
  const h = harness({ onDone: (blob) => { h.saved = blob; } });
  const p = h.r.start({});
  h.gum().resolve(fakeStream());
  await p;
  FakeRecorder.last.push(10);
  const t = h.timers.find((x) => x.ms === 30000);
  assert.ok(t, 'max timer armed');
  t.fn();
  await tick(); await tick();
  assert.ok(h.saved, 'saved at the limit');
});

test('a take with no audio says so instead of saving silence', async () => {
  const h = harness({ onDone: () => { throw new Error('should not save'); } });
  const p = h.r.start({});
  h.gum().resolve(fakeStream());
  await p;
  h.r.stop();
  await tick();
  assert.strictEqual(h.states[h.states.length - 1][0], 'error');
});

test('app.js uses the module; a Rec press during a take stops it and never starts another', () => {
  const app = readSrc(path.join(__dirname, '..', 'renderer', 'app.js'));
  assert.ok(app.includes('window.VoiceRecorder.createVoiceRecorder('));
  assert.ok(!/String\.fromCharCode\.apply\(null, new Uint8Array\(reader\.result\)\)/.test(app), 'the old base64 is gone');
  const fn = app.slice(app.indexOf('async function startVoiceRecording('), app.indexOf('async function startVoiceRecording(') + 400);
  assert.ok(/voiceRecorder\.state === 'requesting' \|\| voiceRecorder\.state === 'recording'\) \{ voiceRecorder\.stop\(\); return; \}/.test(fn));
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'index.html'));
  assert.ok(html.indexOf('../lib/voice-recorder.js') > 0 && html.indexOf('../lib/voice-recorder.js') < html.indexOf('src="app.js"'), 'loaded before app.js');
});

test('ECHOCAT Web sends long voice macros to the shack (sliced base64, no whole-buffer apply)', () => {
  const web = readSrc(path.join(__dirname, '..', 'renderer', 'remote.js'));
  assert.ok(!/btoa\(String\.fromCharCode\.apply\(null, new Uint8Array\(/.test(web), 'no whole-buffer conversion left');
  assert.strictEqual((web.match(/voiceMacroB64\(/g) || []).length, 3, 'defined once, used at both sync sites');
});

chain.then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
