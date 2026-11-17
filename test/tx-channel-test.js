#!/usr/bin/env node
'use strict';
// Transmit on: left only or both channels, per rig (#654). The rule, the Web
// Audio wiring against a stand-in context, and the glue in every surface.
// Run: node test/tx-channel-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require('../lib/tx-channel');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// A stand-in AudioContext: records every connect as [from, to, output, input].
function fakeCtx({ maxChannelCount = 2, channelCount = 2 } = {}) {
  const links = [];
  const node = (name) => ({ name, connect(to, o, i) { links.push([name, to.name, o, i]); } });
  const ctx = {
    links,
    destination: { name: 'dest', maxChannelCount, channelCount },
    createChannelMerger(n) { const m = node('merger'); m.inputs = n; return m; },
    gain: node('gain'),
  };
  return ctx;
}

test('absent, unknown and both mean both; only left means left', () => {
  assert.strictEqual(T.normalize(undefined), 'both');
  assert.strictEqual(T.normalize(''), 'both');
  assert.strictEqual(T.normalize('right'), 'both');
  assert.strictEqual(T.normalize('both'), 'both');
  assert.strictEqual(T.normalize('left'), 'left');
  assert.strictEqual(T.normalize('LEFT'), 'left');
});

test('per rig, and the active rig from settings', () => {
  assert.strictEqual(T.ofRig(null), 'both');
  assert.strictEqual(T.ofRig({}), 'both');
  assert.strictEqual(T.ofRig({ txChannel: 'left' }), 'left');
  const s = { activeRigId: 'b', rigs: [{ id: 'a', txChannel: 'left' }, { id: 'b' }] };
  assert.strictEqual(T.ofSettings(s), 'both');
  assert.strictEqual(T.ofSettings({ ...s, activeRigId: 'a' }), 'left');
  assert.strictEqual(T.ofSettings({}), 'both');
  assert.strictEqual(T.ofSettings({ rigs: [{ id: 'a', txChannel: 'left' }], activeRigId: 'zz' }), 'both');
});

test('both: a plain connect to the output, no merger (unchanged behaviour)', () => {
  const ctx = fakeCtx();
  const out = T.connect(ctx, ctx.gain, 'both');
  assert.strictEqual(out, ctx.gain);
  assert.deepStrictEqual(ctx.links, [['gain', 'dest', undefined, undefined]]);
});

test('left: the node feeds input 0 (left) of a 2-input merger; the right input stays empty', () => {
  const ctx = fakeCtx();
  const out = T.connect(ctx, ctx.gain, 'left');
  assert.strictEqual(out.name, 'merger');
  assert.strictEqual(out.inputs, 2);
  assert.deepStrictEqual(ctx.links, [['gain', 'merger', 0, 0], ['merger', 'dest', undefined, undefined]]);
});

test('left on a one-channel output: plain connect (no right channel, no half-level down-mix)', () => {
  const ctx = fakeCtx({ maxChannelCount: 1, channelCount: 1 });
  T.connect(ctx, ctx.gain, 'left');
  assert.deepStrictEqual(ctx.links, [['gain', 'dest', undefined, undefined]]);
});

test('left raises a destination left at one channel to two', () => {
  const ctx = fakeCtx({ maxChannelCount: 2, channelCount: 1 });
  T.connect(ctx, ctx.gain, 'left');
  assert.strictEqual(ctx.destination.channelCount, 2);
});

// --- the glue: every sound-card transmit path to the rig uses the one rule ---
test('the modem bridge page loads the module before its script and routes playback through it', () => {
  const html = read('renderer/modem-audio-bridge.html');
  const a = html.indexOf('../lib/tx-channel.js'), b = html.indexOf('src="modem-audio-bridge.js"');
  assert.ok(a > 0 && a < b, 'tx-channel.js loads before modem-audio-bridge.js');
  const js = read('renderer/modem-audio-bridge.js');
  assert.ok(/TxChannel\.connect\(playCtx, playGain, c\.txChannel\)/.test(js));
});

test('main sends the active rig\'s choice with the bridge devices', () => {
  const main = read('main.js');
  const m = main.match(/function modemBridgeDevices\(\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'modemBridgeDevices found');
  assert.ok(/txChannel: TxChannel\.ofRig\(rig\)/.test(m[0]));
});

test('JTCAT FT8 transmit and Tune use the rule; the rig editor saves it (absent = both)', () => {
  const app = read('renderer/app.js');
  assert.ok(/TxChannel\.connect\(jtcatTxAudioCtx, txGain, window\.TxChannel\.ofSettings\(s\)\)/.test(app));
  assert.ok(/TxChannel\.connect\(jtcatTxAudioCtx, jtcatTuneGain, window\.TxChannel\.ofSettings\(s\)\)/.test(app));
  assert.ok(/if \(rigTxLeftOnly\) rig\.txChannel = 'left'; else delete rig\.txChannel;/.test(app));
  const html = read('renderer/index.html');
  assert.ok(/<select id="set-tx-channel"/.test(html));
  assert.ok(/<option value="both">Both channels \(left and right\)<\/option>/.test(html));
  assert.ok(/<option value="left">Left channel only<\/option>/.test(html));
  assert.ok(html.indexOf('../lib/tx-channel.js') > 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
