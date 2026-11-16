// SPDX-License-Identifier: Apache-2.0
'use strict';
// TCI receive audio (lib/tci-rig.js): RX1 as 12 kHz mono float32 into
// JTCAT, the VFO window's monitor and ECHOCAT. Based on PR #632 by w5lee.
// Run: node test/tci-audio-test.js

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { readSrc } = require('./_src');
const { startFakeTciServer, rxAudioFrame } = require('./fixtures/fake-tci-server');
const TciRig = require('../lib/tci-rig');
const RigFamily = require('../lib/rig-family');

const ROOT = path.join(__dirname, '..');
const MAIN = readSrc(path.join(ROOT, 'main.js'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting'); await wait(5); }
}
function open(server, audio) {
  const got = [];
  const rig = TciRig.connectTciRig({ host: '127.0.0.1', port: server.port, server: server.dialect, audio, on: { audio: (pcm) => got.push(pcm) }, log: () => {} });
  return { rig, got };
}

test('decodeRxFrame keeps RX1 audio only, clamped', () => {
  assert.deepEqual([...TciRig.decodeRxFrame(rxAudioFrame([0.5, -2, NaN]))], [0.5, -1, 0]);
  assert.ok(TciRig.decodeRxFrame(rxAudioFrame([0.1], { channels: 0 })), 'Zeus leaves channels 0');
  const full = rxAudioFrame([0.1, 0.2]);
  assert.equal(TciRig.decodeRxFrame(full.subarray(0, full.length - 1)), null, 'truncated');
  assert.equal(TciRig.decodeRxFrame(rxAudioFrame([0.1], { type: 3 })), null, 'TX pacing is not audio');
  assert.equal(TciRig.decodeRxFrame(rxAudioFrame([0.1], { type: 0 })), null, 'IQ is not audio');
  assert.equal(TciRig.decodeRxFrame(rxAudioFrame([0.1], { receiver: 1 })), null, 'RX2');
  assert.equal(TciRig.decodeRxFrame(rxAudioFrame([0.1], { rate: 48000 })), null, 'not the asked rate');
  assert.equal(TciRig.decodeRxFrame(rxAudioFrame([0.1], { channels: 2 })), null, 'stereo');
  assert.equal(TciRig.decodeRxFrame(rxAudioFrame([0.1], { format: 2 })), null, 'not float32');
  assert.equal(TciRig.decodeRxFrame(rxAudioFrame([])), null, 'empty');
});

test('audio is asked for after ready, only when wanted', async () => {
  for (const audio of [true, false]) {
    const server = await startFakeTciServer();
    const { rig, got } = open(server, audio);
    try {
      await until(() => rig.connected);
      await wait(30);
      const asked = server.frames.some((f) => f.includes('audio_start:0;'));
      assert.equal(asked, audio);
      if (audio) assert.ok(server.frames.join('').includes('audio_samplerate:12000;audio_stream_channels:1;audio_stream_sample_type:float32;audio_start:0;'));
      server.send(rxAudioFrame([0.25, 0.5]));
      await wait(40);
      assert.equal(got.length, audio ? 1 : 0);
      if (audio) assert.deepEqual([...got[0]], [0.25, 0.5]);
    } finally { rig.close(); await server.close(); }
  }
});

test('no audio reaches the decoder while the radio transmits', async () => {
  const server = await startFakeTciServer();
  const { rig, got } = open(server, true);
  try {
    await until(() => rig.connected);
    server.send('trx:0,true;');
    await until(() => rig.transmitting);
    server.send(rxAudioFrame([0.9]));
    await wait(40);
    assert.equal(got.length, 0);
    server.send('trx:0,false;');
    await until(() => !rig.transmitting);
    server.send(rxAudioFrame([0.1]));
    await until(() => got.length === 1);
  } finally { rig.close(); await server.close(); }
});

test('setAudio starts and stops the stream', async () => {
  const server = await startFakeTciServer();
  const { rig, got } = open(server, false);
  try {
    await until(() => rig.connected);
    rig.setAudio(true);
    await until(() => server.frames.some((f) => f.includes('audio_start:0;')));
    server.send(rxAudioFrame([0.1]));
    await until(() => got.length === 1);
    rig.setAudio(false);
    await until(() => server.frames.some((f) => f === 'audio_stop:0;'));
    server.send(rxAudioFrame([0.1]));
    await wait(40);
    assert.equal(got.length, 1);
  } finally { rig.close(); await server.close(); }
});

test('a TCI rig offers TCI audio first, and only TCI rigs do', () => {
  assert.equal(RigFamily.defaultAudioSourceFor('tci'), 'tci');
  assert.ok(RigFamily.audioSourceValidFor('tci', 'dax'));
  for (const fam of ['flex', 'icom', 'serial', 'hamlib', 'rigctld', 'flrig', 'generic', 'none', 'yaesu-lan', 'icom-network']) {
    assert.ok(!RigFamily.audioSourceValidFor(fam, 'tci'), fam);
  }
});

test('main.js routes TCI audio to JTCAT, the VFO monitor and ECHOCAT', () => {
  const at = MAIN.indexOf('function tciRigAudio(pcm) {');
  const body = MAIN.slice(at, MAIN.indexOf('\n}\n', at));
  for (const want of ["'smartsdr-audio-frame'", "'jtcat-vita49-audio'", "jtcatManager.feedAudio('default', pcm)", 'rxSpecRing.push(pcm', 'if (jtcatRxFromWebSdr()) return;']) {
    assert.ok(body.includes(want), want);
  }
  assert.match(MAIN, /audio: settings\.audioSource === 'tci', \/\/ the rig's audio source/);
  assert.match(MAIN, /if \(settings\.audioSource === 'tci' && tciRigTarget\(\)\) return;/, 'the window capture does not double-feed');
  assert.match(MAIN, /if \(tciRig && tciRigTarget\(\)\) tciRig\.setAudio\(settings\.audioSource === 'tci'\);/);
  const pop = readSrc(path.join(ROOT, 'renderer', 'jtcat-popout.js'));
  assert.match(pop, /audioSource === 'websdr' \|\| audioSource === 'tci'\)\s*\? \{ sourceRate: 12000 \}/);
  const app = readSrc(path.join(ROOT, 'renderer', 'app.js'));
  assert.match(app, /var jtcatFromTci = !jtcatFromSdr && s\.audioSource === 'tci'/);
  const vfo = readSrc(path.join(ROOT, 'renderer', 'vfo-popout.html'));
  assert.match(vfo, /s\.audioSource === 'yaesu-lan' \|\| s\.audioSource === 'tci'\) \{/);
});
