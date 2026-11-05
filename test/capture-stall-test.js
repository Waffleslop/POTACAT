#!/usr/bin/env node
'use strict';
// kc8zp_ryan 2026-11-03: after the rig sat idle, FT8 in ECHOCAT Web stopped
// decoding while its progress bar kept moving; opening FT8 on the phone fixed
// it. Capture restarted only on the track's 'ended' event, and an OS that
// mutes the track, suspends the AudioContext or stops delivering fires none.
// Run: node test/capture-stall-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const CS = require('../lib/capture-stall');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const NOISE = [0.001, -0.002, 0.0005];
const ZEROS = [0, 0, 0];
const RUN = { ctxState: 'running', trackMuted: false };

// Feed real audio every 100 ms from `from` to `to`.
function feed(w, from, to, buf) { for (let t = from; t <= to; t += 100) w.noteSamples(buf || NOISE, t); }

console.log('Capture-stall watchdog');
test('healthy audio: never acts', () => {
  const w = new CS.CaptureStallWatch(0);
  for (let t = 0; t <= 600000; t += 5000) { feed(w, t, t + 4900); assert.strictEqual(w.tick(t + 5000, RUN).action, 'none'); }
});
test('the grace period after a start: nothing is judged', () => {
  const w = new CS.CaptureStallWatch(0);
  assert.strictEqual(w.tick(CS.GRACE_MS - 1, RUN).action, 'none');
});
test('no buffers for 20 s: restart, and the reason says so', () => {
  const w = new CS.CaptureStallWatch(0);
  feed(w, 0, 30000);
  assert.strictEqual(w.tick(30000 + CS.STALL_MS - 1000, RUN).action, 'none');
  const d = w.tick(30000 + CS.STALL_MS + 100, RUN);
  assert.strictEqual(d.action, 'restart');
  assert.ok(/no audio arrived/.test(d.reason), d.reason);
});
test('an FT8 transmission (13 s of no buffers) is not a stall', () => {
  const w = new CS.CaptureStallWatch(0);
  feed(w, 0, 30000);
  assert.strictEqual(w.tick(30000 + 13000, RUN).action, 'none');
});
test('a track muted by the OS for 20 s: restart', () => {
  const w = new CS.CaptureStallWatch(0);
  feed(w, 0, 20000);
  const muted = { ctxState: 'running', trackMuted: true };
  w.tick(20000, muted);
  feed(w, 20000, 45000); // a muted track may still deliver (zeros or not)
  assert.strictEqual(w.tick(39000, muted).action, 'none');
  const d = w.tick(41000, muted);
  assert.strictEqual(d.action, 'restart');
  assert.ok(/muted/.test(d.reason), d.reason);
});
test('a suspended AudioContext: resume first, rebuild if it stays suspended', () => {
  const w = new CS.CaptureStallWatch(0);
  feed(w, 0, 20000);
  const sus = { ctxState: 'suspended', trackMuted: false };
  assert.strictEqual(w.tick(20000, sus).action, 'resume');
  assert.strictEqual(w.tick(22000, sus).action, 'none'); // asked 2 s ago
  assert.strictEqual(w.tick(25000, sus).action, 'resume');
  const d = w.tick(20000 + CS.SUSPEND_MS, sus);
  assert.strictEqual(d.action, 'restart');
  assert.ok(/suspended/.test(d.reason), d.reason);
});
test('a resume that works: no rebuild', () => {
  const w = new CS.CaptureStallWatch(0);
  feed(w, 0, 20000);
  assert.strictEqual(w.tick(20000, { ctxState: 'suspended' }).action, 'resume');
  feed(w, 20000, 40000);
  assert.strictEqual(w.tick(40000, RUN).action, 'none');
});
test('exact digital silence for 60 s: restart; real noise never', () => {
  const w = new CS.CaptureStallWatch(0);
  feed(w, 0, 20000);
  feed(w, 20000, 20000 + CS.ZERO_MS + 1000, ZEROS);
  const d = w.tick(20000 + CS.ZERO_MS + 1000, RUN);
  assert.strictEqual(d.action, 'restart');
  assert.ok(/silence/.test(d.reason), d.reason);
  assert.strictEqual(CS.hasSignal(Float32Array.from([0, 0, 1e-9])), true);
  assert.strictEqual(CS.hasSignal(new Float32Array(4096)), false);
});
test('rebuilds back off: 30 s, then 60 s, capped at 5 min; real audio resets it', () => {
  const w = new CS.CaptureStallWatch(0);
  let t = 100000;
  assert.strictEqual(w.tick(t, RUN).action, 'restart'); // no audio since 0
  w.started(t);
  // Still dead: the next is not before 30 s, the one after not before 60 s.
  assert.strictEqual(w.tick(t + CS.BACKOFF_MS - 1000, RUN).action, 'none');
  assert.strictEqual(w.tick(t + CS.BACKOFF_MS, RUN).action, 'restart');
  const t2 = t + CS.BACKOFF_MS; w.started(t2);
  assert.strictEqual(w.tick(t2 + 2 * CS.BACKOFF_MS - 1000, RUN).action, 'none');
  assert.strictEqual(w.tick(t2 + 2 * CS.BACKOFF_MS, RUN).action, 'restart');
  w.restarts = 20;
  assert.strictEqual(w.backoffMs(), CS.MAX_BACKOFF_MS);
  // A rebuild that brings audio back for a minute resets the count.
  const t3 = 2e6; w.started(t3); feed(w, t3, t3 + CS.HEALTHY_MS);
  assert.strictEqual(w.restarts, 0);
});
test("an ended track is left to the renderer's own 'ended' restart", () => {
  const w = new CS.CaptureStallWatch(0);
  assert.strictEqual(w.tick(100000, { ctxState: 'running', trackEnded: true }).action, 'none');
});

test('wiring: the main window and the JTCAT window both run it on sound-card capture', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
  const app = read('renderer/app.js'), pop = read('renderer/jtcat-popout.js');
  assert.ok(/<script src="\.\.\/lib\/capture-stall\.js"><\/script>/.test(read('renderer/index.html')), 'index.html loads it');
  assert.ok(/<script src="\.\.\/lib\/capture-stall\.js"><\/script>/.test(read('renderer/jtcat-popout.html')), 'jtcat-popout.html loads it');
  // Every buffer is counted, on the worklet and the ScriptProcessor paths.
  assert.strictEqual((app.match(/_jtcatStallWatch\.noteSamples\(/g) || []).length, 2);
  assert.strictEqual((pop.match(/_popoutStallWatch\.noteSamples\(/g) || []).length, 2);
  assert.ok(/jtcatArmStallWatch\(audioTrack\)/.test(app));
  assert.ok(/popoutArmStallWatch\(/.test(pop));
  // The timer stops with the capture, so a stopped capture is never rebuilt.
  assert.ok(/function stopJtcatAudio\(\) \{\n  if \(_jtcatStallTimer\) \{ clearInterval\(_jtcatStallTimer\)/.test(app));
  assert.ok(/function stopPopoutAudio\(\) \{\n    if \(_popoutStallTimer\) \{ clearInterval\(_popoutStallTimer\)/.test(pop));
  // Not on the feeds main supplies.
  assert.ok(/!\(s\.audioSource === 'smartsdr' \|\| s\.audioSource === 'icom-network' \|\| s\.audioSource === 'yaesu-lan'\)/.test(app));
  assert.ok(/audioSource !== 'smartsdr' && audioSource !== 'icom-network' && audioSource !== 'yaesu-lan'/.test(pop));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
