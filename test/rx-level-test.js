#!/usr/bin/env node
'use strict';
// Shack-side RECEIVE level (WB3EGD, TS-480 + RigBlaster Advantage, 2026-10-28):
// the RigBlaster takes receive audio from the TS-480's rear ACC2 jack, a
// fixed-level line out that ignores the AF knob, so the phone sat at -47 dBFS
// and nothing on the radio could raise it. The bridge had a TX drive and no
// receive twin. These run the bridge's own receive-level functions against a
// recording WebAudio stand-in, and hold every surface to the one wiring shape
// TX drive uses (choke point, rig switch, connect hydration, Guest Pass).
// Also covers the Flex Direct stand-in capture (W5ORC, 2026-10-27: a PC with
// no recording device made getUserMedia throw and the bridge never started).
// Run: node test/rx-level-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const html = read('renderer/remote-audio.html');

function slice(src, from, to) {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `cannot find ${from} .. ${to}`);
  return src.slice(a, b);
}

function makeEnv() {
  class Param { constructor(v) { this.value = v; } }
  class Node {
    constructor(kind) { this.kind = kind; this.out = []; this.disconnected = false; }
    connect(n) { this.out.push(n); return n; }
    disconnect() { this.disconnected = true; this.out = []; }
  }
  const ctxs = [];
  class Ctx {
    constructor() { this.state = 'running'; this.closed = false; ctxs.push(this); }
    createMediaStreamSource(stream) { const n = new Node('source'); n.stream = stream; return n; }
    createGain() { const n = new Node('gain'); n.gain = new Param(1); return n; }
    createMediaStreamDestination() {
      const n = new Node('destination');
      const track = { kind: 'audio', label: 'MediaStreamAudioDestinationNode', enabled: true, stopped: false, stop() { this.stopped = true; } };
      n.stream = { getTracks: () => [track], getAudioTracks: () => [track] };
      return n;
    }
    createConstantSource() { const n = new Node('constant'); n.offset = new Param(1); n.started = false; n.start = () => { n.started = true; }; return n; }
    async resume() { this.state = 'running'; }
    async close() { this.closed = true; }
  }
  const window = { api: { _cb: null, onRxLevelUpdate(cb) { this._cb = cb; } } };
  const sandbox = new Function('window', 'AudioContext', `
    let kiwiTxMuted = false;
    let smartGain = null;
    ${slice(html, 'let _rxLevelDb = 0;', 'let _txDrivePct = 100;')}
    return {
      linear: () => _rxLevelLinear(),
      setDb: (v) => { _rxLevelDb = v; _applyRxLevel(); },
      fire: (v) => window.api._cb(v),
      wrap: (raw) => wrapRxLevel(raw),
      teardown: () => tearDownRxLevelGraph(),
      standIn: () => silentStandInStream(),
      teardownStandIn: () => tearDownStandIn(),
      setSmart: (g, muted) => { smartGain = g; kiwiTxMuted = muted; _applyRxLevel(); },
      state: () => ({ ctx: _rxCtx, source: _rxSource, gain: _rxGain, dest: _rxDest, raw: _rxRawStream, standInUsed: _standInUsed, standInCtx: _standInCtx }),
    };
  `);
  const api = sandbox(window, Ctx);
  return { api, ctxs, Ctx };
}

function rawStream() {
  const track = { kind: 'audio', label: 'USB Audio CODEC', enabled: true, stopped: false, stop() { this.stopped = true; } };
  return { getTracks: () => [track], getAudioTracks: () => [track], track };
}

(async () => {
  console.log('receive level — bridge functions');

  await test('dB to linear: 0 = unity, +20 = 10x, -20 = 0.1x, clamped at both ends', () => {
    const { api } = makeEnv();
    api.setDb(0); assert.strictEqual(api.linear(), 1);
    api.setDb(20); assert.ok(Math.abs(api.linear() - 10) < 1e-9);
    api.setDb(-20); assert.ok(Math.abs(api.linear() - 0.1) < 1e-9);
    api.setDb(6); assert.ok(Math.abs(api.linear() - 1.9953) < 1e-3);
    api.setDb(40); assert.ok(Math.abs(api.linear() - 10) < 1e-9, 'clamped high');
    api.setDb(-99); assert.ok(Math.abs(api.linear() - 0.1) < 1e-9, 'clamped low');
    api.setDb('junk'); assert.strictEqual(api.linear(), 1, 'junk = unity');
  });

  await test('wrapRxLevel: source -> gain -> destination, gain at the level, raw kept for stop', () => {
    const { api } = makeEnv();
    api.setDb(12);
    const raw = rawStream();
    const out = api.wrap(raw);
    const s = api.state();
    assert.strictEqual(s.source.stream, raw);
    assert.strictEqual(s.source.out[0], s.gain);
    assert.strictEqual(s.gain.out[0], s.dest);
    assert.ok(Math.abs(s.gain.gain.value - Math.pow(10, 12 / 20)) < 1e-9);
    assert.strictEqual(out, s.dest.stream, 'the levelled stream is what the bridge keeps');
    assert.strictEqual(s.raw, raw);
    assert.strictEqual(raw.track.stopped, false);
  });

  await test('a live update moves the gain node and the SmartSDR gain, TX-mute still wins', () => {
    const { api } = makeEnv();
    api.wrap(rawStream());
    const smart = { gain: { value: 1 } };
    api.setSmart(smart, false);
    api.fire(-6);
    const s = api.state();
    const g = Math.pow(10, -6 / 20);
    assert.ok(Math.abs(s.gain.gain.value - g) < 1e-9);
    assert.ok(Math.abs(smart.gain.value - g) < 1e-9, 'direct routes carry the level on smartGain');
    api.setSmart(smart, true);
    assert.strictEqual(smart.gain.value, 0, 'muted during TX whatever the level');
  });

  await test('teardown stops the raw capture, disconnects the graph and closes the context', () => {
    const { api, ctxs } = makeEnv();
    const raw = rawStream();
    api.wrap(raw);
    api.teardown();
    const s = api.state();
    assert.strictEqual(raw.track.stopped, true, 'the device is released');
    assert.strictEqual(s.ctx, null); assert.strictEqual(s.gain, null); assert.strictEqual(s.raw, null);
    assert.strictEqual(ctxs[0].closed, true);
  });

  await test('the silent stand-in is a real stream from a constant source, and is remembered', () => {
    const { api, ctxs } = makeEnv();
    const st = api.standIn();
    assert.ok(st.getAudioTracks().length === 1);
    assert.strictEqual(api.state().standInUsed, true);
    const ctx = ctxs[ctxs.length - 1];
    assert.strictEqual(ctx.closed, false);
    api.teardownStandIn();
    assert.strictEqual(api.state().standInUsed, false);
    assert.strictEqual(ctx.closed, true);
  });

  console.log('receive level — wiring (source guards)');

  await test('bridge: stand-in before the system default on the direct routes, level wrapped on the capture routes', () => {
    const start = slice(html, 'window.api.onStartAudio(async (config) => {', 'pc.ontrack = async (event) => {');
    assert.ok(/\} else if \(config\.daxTxDirect\) \{[\s\S]*silentStandInStream\(\);[\s\S]*\} else \{\n\s+localStream = await navigator\.mediaDevices\.getUserMedia\(\{ audio: baseAudio \}\);/.test(start),
      'daxTxDirect with no input gets the stand-in, never the default recording device');
    assert.ok(/if \(!config\.daxTxDirect\) localStream = wrapRxLevel\(localStream\);/.test(start));
    assert.ok(/if \(config\.rxLevelDb != null\) _rxLevelDb = Number\(config\.rxLevelDb\) \|\| 0;/.test(start), 'seeded from the bridge config');
    assert.ok(/tearDownRxLevelGraph\(\);\n\s+tearDownStandIn\(\);/.test(start), 'previous session torn down');
    const stop = slice(html, 'window.api.onStopAudio(() => {', 'stopDaxTxTap();');
    assert.ok(/tearDownRxLevelGraph\(\);[\s\S]*tearDownStandIn\(\);/.test(stop));
    const smartSites = html.match(/smartGain\.gain\.value = kiwiTxMuted \? 0 : _rxLevelLinear\(\)/g) || [];
    assert.strictEqual(smartSites.length, 2, 'both SmartSDR gain writes carry the receive level');
    assert.ok(!/smartGain\.gain\.value = kiwiTxMuted \? 0 : 1\b/.test(html), 'no SmartSDR gain write still hard-codes unity');
  });

  await test('preload exposes onRxLevelUpdate on the rx-level-update channel', () => {
    assert.ok(/onRxLevelUpdate: \(cb\) => ipcRenderer\.on\('rx-level-update'/.test(read('preload-remote-audio.js')));
  });

  await test('protocol: set-rx-level (C2S) and rx-level-state (S2C) are registered', () => {
    const p = read('lib/echocat-protocol.js');
    assert.ok(/'set-rx-level': \{ dir: Dir\.C2S/.test(p));
    assert.ok(/'rx-level-state': \{ dir: Dir\.S2C/.test(p));
  });

  await test('remote-server: capability, Guest Pass refusal, broadcast', () => {
    const s = read('lib/remote-server.js');
    assert.ok(/'tx-drive', 'rx-level', 'tune-step'/.test(s), 'hello capability');
    assert.ok(/case 'set-rx-level':\n\s+if \(this\._guestLocked\(ws\)\) \{\n\s+this\.emit\('rx-level-refused'\);/.test(s));
    assert.ok(/broadcastRxLevelState\(value\) \{[\s\S]*?type: 'rx-level-state', value: v/.test(s));
  });

  await test('main: one choke point, forwarded to a remote shack, rig switch, connect hydration, client set + refusal, rig editor save', () => {
    const m = read('main.js');
    const h = slice(m, "ipcMain.on('rx-level-set', (_e, value) => {", "ipcMain.on('tx-eq-set'");
    assert.ok(/Math\.max\(-20, Math\.min\(20, Math\.round\(Number\(value\)\)\)\)/.test(h), 'clamped to -20..+20 dB');
    assert.ok(/if \(isRemoteMode\(\)\) \{[\s\S]*type: 'set-rx-level', value: v[\s\S]*return;\n\s+\}/.test(h), 'a laptop driving a shack sends it there');
    assert.ok(/settings\.rxLevelDb = v;[\s\S]*activeRig\.rxLevelDb = v;/.test(h), 'persisted globally and per rig');
    assert.ok(/remoteAudioWin\.webContents\.send\('rx-level-update', v\)/.test(h), 'pushed to the bridge');
    assert.ok(/remoteServer\.broadcastRxLevelState\(v\)/.test(h), 'echoed to devices');
    assert.ok(/ipcMain\.emit\('rx-level-set', null, rig\.rxLevelDb != null \? rig\.rxLevelDb : 0\);/.test(m), 'rides the rig switch');
    assert.ok(/broadcastTxDriveState\(currentTxDrive\(\)\); \} catch \{ \/\* ignore \*\/ \}\n\s+try \{ remoteServer\.broadcastRxLevelState\(currentRxLevel\(\)\); \}/.test(m), 'hydrated at connect beside TX drive');
    assert.ok(/remoteServer\.on\('set-rx-level', \(\{ value \}\) => \{\n\s+ipcMain\.emit\('rx-level-set', null, value\);/.test(m));
    assert.ok(/remoteServer\.on\('rx-level-refused'/.test(m));
    assert.ok(/case 'rx-level-state': \{[\s\S]*?'rx-level-update', v/.test(m), 'the shack\'s echo reaches this desktop\'s windows');
    assert.ok(/rxLevelDb: currentRxLevel\(\),/.test(m), 'in the bridge config');
    assert.ok(/if \(has\('rigs'\) && !isRemoteMode\(\)\) \{[\s\S]*?ipcMain\.emit\('rx-level-set', null, lvl\);/.test(m), 'a rig editor save applies it');
    assert.ok(/function currentRxLevel\(\) \{[\s\S]*?Math\.max\(-20, Math\.min\(20, Math\.round\(v\)\)\) : 0;/.test(m));
  });

  await test('rig editor: the field is restored on edit, reset on add, saved on both paths', () => {
    const a = read('renderer/app.js');
    assert.ok(/setRigRxLevelField\(rig\.rxLevelDb\);/.test(a));
    assert.ok(/setRigRxLevelField\(0\);/.test(a));
    assert.ok(/rig\.rxLevelDb = rigRxLevelDb;/.test(a));
    assert.ok(/rxLevelDb: rigRxLevelDb,/.test(a));
    assert.ok(/id="rig-rx-level" min="-20" max="20"/.test(read('renderer/index.html')));
  });

  await test('ECHOCAT Web: the row is revealed by rx-level-state and sends set-rx-level on release', () => {
    const r = read('renderer/remote.js');
    assert.ok(/case 'rx-level-state': \{[\s\S]*?classList\.remove\('hidden'\)/.test(r));
    assert.ok(/type: 'set-rx-level', value: parseInt\(rcRxLevel\.value, 10\) \|\| 0/.test(r));
    assert.ok(/id="rc-rx-level" class="so-slider" min="-20" max="20"/.test(read('renderer/remote.html')));
  });

  await test('Add SDR opens the directory picker for the empty slot (AA5MP)', () => {
    const a = read('renderer/app.js');
    const h = slice(a, "const btn = document.getElementById('kiwi-add-row-btn');", '})();');
    assert.ok(/\.kiwi-browse-btn\[data-slot="' \+ slot \+ '"\]/.test(h) && /browse\.click\(\)/.test(h));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
