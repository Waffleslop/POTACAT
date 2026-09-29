#!/usr/bin/env node
'use strict';
// KM0JPR (IC-7300 over its USB CODEC, ECHOCAT iOS), 2026-09-27: "I'm still
// getting weak TX to the radio via Echocat on iPhone" — ALC and power well
// below the stock mic. On a USB CODEC rig the bridge played the phone's mic
// through a bare <audio> element: unity gain, TX drive above 100% clamped,
// and the TX EQ + compressor (whose own comment names the IC-7300) and the
// first-syllable guard existed only on the Flex dax_tx path. The route is now
// a WebAudio graph into the radio's input: guard -> drive -> EQ -> TX gate.
// These run the bridge's own functions against a recording AudioContext.
// Run: node test/echocat-usb-tx-graph-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote-audio.html'), 'utf8').replace(/\r\n/g, '\n');
const eqSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'tx-eq-chain.js'), 'utf8');

function slice(from, to) {
  const a = html.indexOf(from), b = html.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `cannot find ${from}`);
  return html.slice(a, b);
}

// A recording WebAudio stand-in: nodes remember what they connect to.
function makeEnv({ sinkFails = false } = {}) {
  const made = [];
  class Param { constructor(v) { this.value = v; this.targets = []; } setTargetAtTime(v) { this.value = v; this.targets.push(v); } cancelScheduledValues() {} }
  class Node {
    constructor(kind) { this.kind = kind; this.out = []; made.push(this); }
    connect(n) { this.out.push(n); return n; }
    disconnect() { this.out = []; }
  }
  class Ctx {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = new Node('destination'); this.sinkId = ''; this.closed = false; Ctx.last = this; }
    async setSinkId(id) { if (sinkFails) throw new Error('NotFoundError'); this.sinkId = id; }
    createMediaStreamSource() { return new Node('source'); }
    createDelay() { const n = new Node('delay'); n.delayTime = new Param(0); return n; }
    createGain() { const n = new Node('gain'); n.gain = new Param(1); return n; }
    createBiquadFilter() { const n = new Node('biquad'); n.frequency = new Param(0); n.gain = new Param(0); n.Q = new Param(0); return n; }
    createDynamicsCompressor() { const n = new Node('compressor'); for (const k of ['threshold', 'knee', 'ratio', 'attack', 'release']) n[k] = new Param(0); return n; }
    async resume() {}
    async close() { this.closed = true; }
  }
  const audioEl = { muted: false, volume: 1, srcObject: null, async setSinkId() {} };
  const notes = [];
  const window = { api: { sendAudioStatus: (m) => notes.push(m), onTxDriveUpdate() {}, onTxEqUpdate() {} } };
  const sandbox = new Function('window', 'AudioContext', 'audioEl', `
    ${eqSrc}
    const TxEqChain = window.TxEqChain;
    let kiwiTxMuted = false;
    ${slice('let _txSinkRoute = false;', '// --- TX EQ + Compressor ---')}
    const _txEqChain = TxEqChain.create();
    let _txEqState = { enabled: false, preset: 'ragchew' };
    ${slice('let _txDrivePct = 100;', 'window.api.onTxDriveUpdate(')}
    ${slice('async function startSinkTxGraph(', 'function stopDaxTxTap() {')}
    return {
      start: startSinkTxGraph, stop: stopSinkTxGraph,
      setDrive(p) { _txDrivePct = p; _applyTxDrive(); },
      setTx(on) { kiwiTxMuted = on; const t = 0; if (_sinkTxGate) _sinkTxGate.gain.setTargetAtTime(on ? 1 : 0, t, 0.005); },
      state: () => ({ drive: _txDriveGain, gate: _sinkTxGate, delay: _sinkTxDelay, legacy: _txSinkLegacy, ctx: _sinkTxCtx }),
    };
  `);
  const bridge = sandbox(window, Ctx, audioEl);
  return { bridge, audioEl, notes, made, Ctx };
}

// Follow first-connection edges from a node to the destination.
function pathFrom(node) {
  const kinds = [];
  let n = node;
  for (let i = 0; n && i < 20; i++) { kinds.push(n.kind); n = n.out[0]; }
  return kinds;
}

console.log('ECHOCAT USB CODEC TX graph');

(async () => {
  await test('the mic goes to the radio\'s own output device through the graph, element muted', async () => {
    const { bridge, audioEl, Ctx } = makeEnv();
    await bridge.start({}, 'usb-codec-id', { enabled: false }, 120);
    assert.strictEqual(Ctx.last.sinkId, 'usb-codec-id');
    assert.strictEqual(audioEl.muted, true, 'the element must not play the mic too');
    const st = bridge.state();
    assert.strictEqual(st.legacy, false);
    assert.deepStrictEqual(pathFrom(st.delay), ['delay', 'gain', 'gain', 'destination'], 'guard -> drive -> gate -> radio');
  });

  await test('TX drive above 100% is applied, not clamped (KM0JPR)', async () => {
    const { bridge, notes } = makeEnv();
    await bridge.start({}, 'usb-codec-id', { enabled: false }, 0);
    bridge.setDrive(180);
    assert.strictEqual(bridge.state().drive.gain.value, 1.8);
    assert.ok(!notes.some((n) => n && /clamped/.test(n.note || '')), 'no clamp note on the graph route');
  });

  await test('the TX EQ + compressor sits between drive and gate when enabled', async () => {
    const { bridge } = makeEnv();
    await bridge.start({}, 'usb-codec-id', { enabled: true, preset: 'ragchew' }, 0);
    const p = pathFrom(bridge.state().drive);
    assert.ok(p.includes('compressor'), `path ${p.join(' -> ')}`);
    assert.strictEqual(p[p.length - 2], 'gain', 'the gate is the last node');
    assert.strictEqual(p[p.length - 1], 'destination');
  });

  await test('the gate is closed on receive and opens with TX', async () => {
    const { bridge } = makeEnv();
    await bridge.start({}, 'usb-codec-id', { enabled: false }, 0);
    assert.strictEqual(bridge.state().gate.gain.value, 0, 'no mic into the radio on receive (OH7DSQ)');
    bridge.setTx(true);
    assert.strictEqual(bridge.state().gate.gain.value, 1);
    bridge.setTx(false);
    assert.strictEqual(bridge.state().gate.gain.value, 0);
  });

  await test('a device the graph cannot open throws (the caller falls back and says so)', async () => {
    const { bridge } = makeEnv({ sinkFails: true });
    await assert.rejects(() => bridge.start({}, 'gone-id', { enabled: false }, 0));
    bridge.stop();
    assert.strictEqual(bridge.state().ctx, null);
  });

  await test('the caller falls back to the element route and reports it (source guard)', () => {
    const at = html.indexOf('_txSinkRoute = true;');
    const branch = html.slice(at, html.indexOf('// PC-side TX peak meter', at));
    assert.ok(/await startSinkTxGraph\(event\.streams\[0\], config\.outputDeviceId, config\.txEq, config\.txGuardMs\)/.test(branch));
    assert.ok(/TX audio graph unavailable/.test(branch), 'the fallback is reported');
    assert.ok(/if \(!graphOk\) \{\s*_txSinkLegacy = true;/.test(branch));
  });

  await test('teardown closes the graph and live EQ updates reach it (source guard)', () => {
    const stop = html.slice(html.indexOf('window.api.onStopAudio('), html.indexOf('window.api.onStopAudio(') + 600);
    assert.ok(/stopSinkTxGraph\(\);/.test(stop));
    const eq = html.slice(html.indexOf('window.api.onTxEqUpdate('), html.indexOf('window.api.onTxEqUpdate(') + 900);
    assert.ok(/_sinkTxCtx && _txDriveGain && _sinkTxGate/.test(eq));
  });

  console.log(`\nECHOCAT USB CODEC TX graph: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
