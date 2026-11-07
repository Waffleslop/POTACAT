#!/usr/bin/env node
'use strict';
// #133: FT8 started from ECHOCAT (web or app) on a sound-card rig showed
// "No decodes" while the shack was decoding, until Restart audio; then the
// listen audio dropped in and out (Linux Mint, FT-991A).
//
//  - The main window's restart-jtcat-audio handler only restarted a capture
//    the DESKTOP view started, so Restart audio, the engine's silent-capture
//    recovery and a device change made from the phone did nothing to a
//    capture a remote started.
//  - startJtcatAudio() was async with nothing serialising it: two calls close
//    together (a second jtcat-start, a stall restart) could leave two live
//    captures both feeding the engine, and a stop during a pending start
//    could leave a capture running.
//  - The audio window's rx-spectrum capture had the same race: an "off" that
//    landed while the "on" was still opening the device stopped nothing.
//
// Run: node test/jtcat-capture-gate-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const Gate = require('../lib/jtcat-capture-gate');

const root = path.join(__dirname, '..');
const app = readSrc(path.join(root, 'renderer', 'app.js'));
const preload = readSrc(path.join(root, 'preload.js'));
const main = readSrc(path.join(root, 'main.js'));
const audioHtml = readSrc(path.join(root, 'renderer', 'remote-audio.html'));
const indexHtml = readSrc(path.join(root, 'renderer', 'index.html'));

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  pending.push(async () => {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
  });
}

// --- Fakes: a sound device, an engine, and a build shaped like startJtcatAudio's.
function makeRig() {
  const rig = { open: new Set(), fed: [], opened: 0, maxConcurrentBuilds: 0, building: 0, logs: [] };
  rig.current = null; // the "globals" the renderer keeps
  rig.teardown = () => {
    if (rig.current) { rig.open.delete(rig.current); rig.current = null; }
  };
  // Every await in the real build is a tick here; each is followed by a stale check.
  rig.build = async (ctx) => {
    rig.building++;
    rig.maxConcurrentBuilds = Math.max(rig.maxConcurrentBuilds, rig.building);
    try {
      await tick(3); // the 300 ms settle
      if (ctx.stale()) return false;
      const cap = { id: ++rig.opened, gen: ctx.gen };
      rig.current = cap; // getUserMedia resolved, written to the globals
      rig.open.add(cap);
      await tick(2); // resume() / addModule()
      if (ctx.stale()) return false;
      cap.feeding = true;
      return true;
    } finally { rig.building--; }
  };
  rig.feedOnce = () => { for (const c of rig.open) if (c.feeding) rig.fed.push(c.id); };
  return rig;
}
function tick(n) { let p = Promise.resolve(); for (let i = 0; i < (n || 1); i++) p = p.then(() => new Promise((r) => setImmediate(r))); return p; }
function serializerFor(rig) {
  return Gate.createCaptureSerializer({ teardown: rig.teardown, build: rig.build, log: (m) => rig.logs.push(m) });
}

console.log('#133 JTCAT capture gate');

// --- The restart gate (Restart audio, engine silent, bridge teardown).
test('restart gate: the desktop view started the capture -> restart', () => {
  assert.strictEqual(Gate.shouldRestartCapture({ desktopRunning: true, remoteActive: false, popoutOpen: false }), true);
});
test('restart gate: a REMOTE started the capture -> restart (was ignored)', () => {
  assert.strictEqual(Gate.shouldRestartCapture({ desktopRunning: false, remoteActive: true, popoutOpen: false }), true);
});
test('restart gate: both -> restart', () => {
  assert.strictEqual(Gate.shouldRestartCapture({ desktopRunning: true, remoteActive: true, popoutOpen: false }), true);
});
test('restart gate: the popout owns the capture -> main window leaves it alone', () => {
  assert.strictEqual(Gate.shouldRestartCapture({ desktopRunning: true, remoteActive: true, popoutOpen: true }), false);
});
test('restart gate: nothing running -> nothing to restart', () => {
  assert.strictEqual(Gate.shouldRestartCapture({ desktopRunning: false, remoteActive: false, popoutOpen: false }), false);
});
test('restart gate: says why it ignored a request', () => {
  assert.ok(/popout/i.test(Gate.restartDecision({ desktopRunning: false, remoteActive: true, popoutOpen: true }).why));
  assert.ok(/no capture/i.test(Gate.restartDecision({ desktopRunning: false, remoteActive: false, popoutOpen: false }).why));
  assert.strictEqual(Gate.restartDecision({ desktopRunning: false, remoteActive: true, popoutOpen: false }).restart, true);
});

// --- The serializer, with fakes.
test('control: the old unserialised start (stop, await, open) leaves two captures feeding one engine', async () => {
  const rig = makeRig();
  const oldStart = async () => { rig.teardown(); await rig.build({ gen: 0, reason: 'old', stale: () => false }); };
  const a = oldStart();
  await tick(1); // B's stop runs while A is still in its settle delay
  const b = oldStart();
  await Promise.all([a, b]);
  rig.feedOnce();
  assert.strictEqual(rig.fed.length, 2, 'the race this fixes did not reproduce');
});
test('one start: one capture, feeding', async () => {
  const rig = makeRig(); const s = serializerFor(rig);
  assert.strictEqual(await s.start('desktop'), true);
  assert.strictEqual(rig.open.size, 1);
  rig.feedOnce(); assert.deepStrictEqual(rig.fed, [1]);
});
test('two starts back to back (a second jtcat-start): exactly one capture feeds the engine', async () => {
  const rig = makeRig(); const s = serializerFor(rig);
  const a = s.start('remote jtcat-start');
  await tick(4); // A is mid-build (device open, worklet not up yet)
  const b = s.start('remote jtcat-start');
  await Promise.all([a, b]);
  assert.strictEqual(rig.open.size, 1, 'live captures: ' + rig.open.size);
  rig.feedOnce();
  assert.strictEqual(rig.fed.length, 1, 'engine fed by ' + rig.fed.length + ' captures');
  assert.strictEqual(rig.maxConcurrentBuilds, 1, 'builds overlapped');
});
test('a second start lands during the first start settle delay: still exactly one capture', async () => {
  const rig = makeRig(); const s = serializerFor(rig);
  const a = s.start('one'); await tick(1); const b = s.start('two');
  await Promise.all([a, b]);
  rig.feedOnce();
  assert.strictEqual(rig.open.size, 1);
  assert.strictEqual(rig.fed.length, 1);
});
test('three starts at once: the newest wins, the skipped ones open nothing', async () => {
  const rig = makeRig(); const s = serializerFor(rig);
  const r = await Promise.all([s.start('a'), s.start('b'), s.start('c')]);
  assert.deepStrictEqual(r, [false, false, true]);
  assert.strictEqual(rig.opened, 1);
  assert.strictEqual(rig.open.size, 1);
});
test('a stop while a start is pending: nothing left running', async () => {
  const rig = makeRig(); const s = serializerFor(rig);
  const a = s.start('remote jtcat-start');
  await tick(4); // device already open inside the build
  s.stop('jtcat-stop-for-remote');
  await a;
  assert.strictEqual(rig.open.size, 0, 'capture left running after stop');
  assert.strictEqual(rig.current, null);
});
test('a stop before a queued start begins: the start never opens the device', async () => {
  const rig = makeRig(); const s = serializerFor(rig);
  const a = s.start('x'); s.stop('y');
  assert.strictEqual(await a, false);
  assert.strictEqual(rig.opened, 0);
});
test('a superseded build logs why it let go', async () => {
  const rig = makeRig(); const s = serializerFor(rig);
  const a = s.start('first');
  await tick(4);
  const b = s.start('second');
  await Promise.all([a, b]);
  assert.ok(rig.logs.some((m) => /superseded/.test(m) && /first/.test(m)), rig.logs.join(' | '));
  assert.ok(rig.logs.some((m) => /starting/.test(m) && /second/.test(m)), rig.logs.join(' | '));
});
test('a build that throws is logged and leaves the queue usable', async () => {
  const rig = makeRig();
  let first = true;
  const s = Gate.createCaptureSerializer({
    teardown: rig.teardown,
    build: async (ctx) => { if (first) { first = false; throw new Error('NotReadableError'); } return rig.build(ctx); },
    log: (m) => rig.logs.push(m),
  });
  assert.strictEqual(await s.start('one'), false);
  assert.strictEqual(await s.start('two'), true);
  assert.ok(rig.logs.some((m) => /NotReadableError/.test(m)));
});
test('describeTrack names the device and what the OS actually gave', () => {
  const t = { label: 'USB Audio CODEC Mono', getSettings: () => ({ sampleRate: 48000, channelCount: 1, deviceId: 'abcdef1234567890' }) };
  const d = Gate.describeTrack(t);
  assert.ok(/USB Audio CODEC/.test(d) && /48000 Hz/.test(d) && /1 ch/.test(d), d);
  assert.strictEqual(Gate.describeTrack(null), '(no track)');
});

// --- Wiring (source text).
test('index.html loads the gate before app.js', () => {
  const g = indexHtml.indexOf('../lib/jtcat-capture-gate.js');
  assert.ok(g > 0 && g < indexHtml.indexOf('<script src="app.js"></script>'));
});
test('app.js: the restart handler decides with the gate (no desktop-only rule left)', () => {
  assert.ok(!/jtcatRunning && !jtcatRemoteActive && !jtcatPopoutOpen/.test(app), 'old desktop-only gate still present');
  const i = app.indexOf('window.api.onRestartJtcatAudio(');
  assert.ok(i > 0);
  const body = app.slice(i, i + 900);
  assert.ok(/JtcatCaptureGate\.restartDecision\(/.test(body), body);
  assert.ok(/remoteActive:\s*jtcatRemoteActive/.test(body));
});
test('app.js: startJtcatAudio goes through the serializer; stopJtcatAudio cancels a pending start', () => {
  assert.ok(/JtcatCaptureGate\.createCaptureSerializer\(/.test(app));
  const s = app.indexOf('function startJtcatAudio(');
  assert.ok(/_jtcatCapture\.start\(/.test(app.slice(s, s + 400)), 'startJtcatAudio is not the serializer');
  const st = app.indexOf('function stopJtcatAudio(');
  assert.ok(/_jtcatCapture\.stop\(/.test(app.slice(st, st + 400)), 'stopJtcatAudio does not cancel');
});
test('app.js: the build checks stale() after every await', () => {
  const s = app.indexOf('async function _buildJtcatCapture(');
  const e = app.indexOf('\n}\n', s);
  assert.ok(s > 0 && e > s);
  const body = app.slice(s, e);
  const lines = body.split('\n');
  const missing = [];
  lines.forEach((ln, i) => {
    if (!/\bawait\b/.test(ln) || /^\s*\/\//.test(ln)) return;
    const next = lines.slice(i, i + 4).join('\n');
    if (!/ctx\.stale\(\)/.test(next)) missing.push(ln.trim());
  });
  assert.deepStrictEqual(missing, [], 'awaits with no stale check: ' + missing.join(' || '));
});
test('app.js: the remote start names its reason', () => {
  const i = app.indexOf('window.api.onJtcatStartForRemote(');
  assert.ok(/startJtcatAudio\('[^']*remote[^']*'\)/.test(app.slice(i, i + 500)));
});
test('preload passes the restart reason through', () => {
  assert.ok(/onRestartJtcatAudio:\s*\(cb\)\s*=>\s*ipcRenderer\.on\('restart-jtcat-audio',\s*\(_e,\s*why\)\s*=>\s*cb\(why\)\)/.test(preload));
});
test('main.js: bridge teardown and engine-silent say why they restart the capture', () => {
  assert.ok(/send\('restart-jtcat-audio', 'echocat-bridge-teardown'\)/.test(main));
  assert.ok(/send\('restart-jtcat-audio', 'engine-silent'\)/.test(main));
});
test('main.js: a remote FT8 start logs what else is capturing the radio', () => {
  const i = main.indexOf("remoteServer.on('jtcat-start', ({ mode }) => {");
  const body = main.slice(i, i + 2600);
  assert.ok(/FT8 started from ECHOCAT/.test(body) && /_rxSpecBridgeOn/.test(body), 'no capture log on remote start');
});
test('remote-audio.html: a superseded rx-spectrum "on" stops the device it opened', () => {
  const i = audioHtml.indexOf('window.api.onRxSpectrumWant(');
  const body = audioHtml.slice(i, i + 1600);
  assert.ok(/const my = \+\+rxSpecGen;/.test(body), 'no generation token');
  assert.ok(/if \(my !== rxSpecGen\)[^\n]*getTracks\(\)\.forEach/.test(body), 'superseded stream not stopped');
});

(async () => {
  for (const t of pending) await t();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
