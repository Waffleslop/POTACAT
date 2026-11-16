// SPDX-License-Identifier: Apache-2.0
'use strict';
// TCI rig link (lib/tci-rig.js, lib/tci-target.js) against a fake Zeus and a
// fake Thetis (test/fixtures/fake-tci-server.js). Based on PR #632 by w5lee.
// Run: node test/tci-rig-test.js

const assert = require('node:assert/strict');
const test = require('node:test');
const { startFakeTciServer } = require('./fixtures/fake-tci-server');
const TciRig = require('../lib/tci-rig');
const TciTarget = require('../lib/tci-target');

const KEYS = /(?:^|;)\s*(?:trx|tune)\s*:\s*\d+\s*,\s*(?:true|1)\b/i;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await wait(5);
  }
}

function open(server, extra = {}) {
  const seen = { link: [], dial: [], mode: [], smeter: [], filter: [], squelch: [], agc: [], nb: [], nr: [], rfGain: [], tx: [], drive: [] };
  const on = {};
  for (const k of Object.keys(seen)) on[k] = (...a) => seen[k].push(a.length > 1 ? a : a[0]);
  const rig = TciRig.connectTciRig({ host: '127.0.0.1', port: server.port, server: server.dialect, autoStart: true, on, log: () => {}, ...extra });
  return { rig, seen };
}

test('parseCommands splits names and fields', () => {
  assert.deepEqual(TciRig.parseCommands('vfo:0,0,14074000;ready; trx:0,true ;'), [
    { name: 'vfo', fields: ['0', '0', '14074000'] }, { name: 'ready', fields: [] }, { name: 'trx', fields: ['0', 'true'] },
  ]);
});

test('modes: spots map to a demodulator, DIGU only when data mode is on', () => {
  assert.equal(TciRig.toTciMode('FT8', 14074000, true), 'DIGU');
  assert.equal(TciRig.toTciMode('FT8', 14074000, false), 'USB');
  assert.equal(TciRig.toTciMode('SSB', 7200000, true), 'LSB');
  assert.equal(TciRig.toTciMode('SSB', 14200000, true), 'USB');
  assert.equal(TciRig.toTciMode('SSB', 5357000, true), 'USB', '60 m is USB');
  assert.equal(TciRig.toTciMode('CW', 7030000, true), 'CWU');
  assert.equal(TciRig.toTciMode('BOGUS', 7030000, true), '');
  assert.equal(TciRig.fromTciMode('CWL'), 'CW');
  assert.equal(TciRig.fromTciMode('DIGU'), 'DIGU');
});

test('the keying guard matches key-down forms only', () => {
  for (const s of ['trx:0,true;', 'trx:1,true,tci;', 'tune:0,true;', 'vfo:0,0,7074000;trx:0,1;']) assert.ok(TciRig.KEYING.test(s), s);
  for (const s of ['trx:0;', 'trx:0,false;', 'tune:0,false;', 'tune_drive:0,10;', 'vfo:0,0,7074000;']) assert.ok(!TciRig.KEYING.test(s), s);
});

test('targets: validation, defaults and addresses', () => {
  assert.equal(TciTarget.validate(TciTarget.normalize({ server: 'zeus', host: ' 127.0.0.1 ' })), null);
  assert.equal(TciTarget.normalize({ server: 'zeus' }).port, 40001);
  assert.equal(TciTarget.normalize({ server: 'thetis' }).port, 50001);
  assert.match(TciTarget.validate({ type: 'tci', server: 'expert', host: 'x', port: 1 }), /Zeus or Thetis/);
  assert.match(TciTarget.validate({ type: 'tci', server: 'zeus', host: 'bad host!', port: 1 }), /hostname/);
  assert.match(TciTarget.validate({ type: 'tci', server: 'zeus', host: 'pi.local', port: 70000 }), /port/);
  assert.equal(TciTarget.validate({ type: 'tci', server: 'thetis', host: '::1', port: 50001 }), null);
  assert.equal(TciTarget.address('::1', 50001), 'ws://[::1]:50001');
  assert.equal(TciTarget.describe({ server: 'thetis', host: '10.0.0.5', port: 50001 }), 'Thetis TCI at 10.0.0.5:50001');
});

test('probe waits for ready and sends nothing', async () => {
  const server = await startFakeTciServer();
  try {
    await TciRig.probeTci('127.0.0.1', server.port);
    await wait(30);
    assert.deepEqual(server.frames, []);
  } finally { await server.close(); }
  await assert.rejects(TciRig.probeTci('127.0.0.1', server.port), /ECONNREFUSED|closed/);
});

test('Zeus: connects on ready, reads only, follows dial and mode, never keys', async () => {
  const server = await startFakeTciServer({ dialect: 'zeus' });
  const { rig, seen } = open(server);
  try {
    await until(() => rig.connected && seen.agc.length && seen.drive.length);
    assert.deepEqual(seen.link, [true]);
    assert.equal(rig.receiveDialHz, 14074000);
    assert.equal(seen.mode.at(-1)[0], 'USB');
    assert.equal(seen.drive.at(-1), 50);
    assert.equal(seen.rfGain.at(-1), 100, 'attenuator 0 dB reads as full RF gain');
    for (const f of server.frames) assert.ok(!KEYS.test(f), 'keyed: ' + f);
    // Tune: VFO and DIGU for FT8.
    assert.equal(rig.tune(7074000, 'FT8', { dataMode: true }), '');
    await until(() => rig.receiveDialHz === 7074000 && rig.tciMode === 'DIGU');
    assert.match(server.frames.at(-1), /^vfo:0,0,7074000;modulation:0,DIGU;$/);
    // S-meter on Zeus's WDSP channel 2.
    server.send('rx_smeter:0,2,-73.5;rx_smeter:0,4,-20;rx_smeter:1,0,-10;');
    await until(() => seen.smeter.length);
    await wait(20);
    assert.deepEqual(seen.smeter, [-73.5]);
  } finally { rig.close(); await server.close(); }
});

test('controls: filter, squelch, AGC, NB, NR and RF gain reach the server', async () => {
  const server = await startFakeTciServer({ dialect: 'zeus' });
  const { rig, seen } = open(server);
  try {
    await until(() => rig.connected && rig.filterBand && rig.squelchAvailable);
    assert.ok(rig.setFilterBand(200, 2700));
    assert.ok(rig.setSquelch(30));
    assert.ok(rig.setAgcMode('slow'));
    assert.ok(!rig.setAgcMode('long'), 'only the four modes every client offers');
    assert.ok(rig.setNoiseBlanker(true));
    assert.ok(rig.setNoiseReduction(true));
    assert.ok(rig.setRfGain(50));
    await until(() => server.state.att === 16 && server.state.nr === true);
    assert.deepEqual(server.state.filter, [200, 2700]);
    assert.equal(server.state.sqlEnable, true);
    assert.equal(server.state.sqlLevel, 30);
    assert.equal(server.state.agc, 'slow');
    assert.equal(server.state.nb, true);
    await until(() => seen.agc.at(-1) === 'slow');
  } finally { rig.close(); await server.close(); }
});

test('Thetis: dBm squelch, step attenuator and 0..90 drive', async () => {
  const server = await startFakeTciServer({ dialect: 'thetis' });
  const { rig, seen } = open(server);
  try {
    await until(() => rig.connected && seen.drive.length && rig.rfGainAvailable && rig.squelchAvailable);
    assert.ok(rig.isThetis);
    assert.equal(seen.drive.at(-1), 50, 'Thetis drive 45 of 90 reads as 50 %');
    assert.ok(server.frames[0].includes('rx_step_att_ex:0;'));
    assert.ok(!server.frames[0].includes('attenuator:0;'));
    assert.ok(rig.setSquelch(50));
    assert.ok(rig.setRfGain(0));
    await until(() => server.state.att === 31);
    assert.equal(server.state.sqlLevel, -70);
  } finally { rig.close(); await server.close(); }
});

test('nothing is sent while the radio transmits from its own controls', async () => {
  const server = await startFakeTciServer({ dialect: 'zeus' });
  const { rig, seen } = open(server);
  try {
    await until(() => rig.connected && rig.filterBand);
    server.send('trx:0,true;');
    await until(() => rig.transmitting);
    assert.deepEqual(seen.tx, [false, true]);
    const before = server.frames.length;
    assert.match(rig.tune(7074000, 'FT8'), /receive/);
    assert.equal(rig.setFilterBand(200, 2700), false);
    assert.equal(rig.setAgcMode('slow'), false);
    await wait(30);
    assert.equal(server.frames.length, before);
    server.send('trx:0,false;');
    await until(() => !rig.transmitting);
    assert.equal(rig.tune(7074000, 'FT8'), '');
  } finally { rig.close(); await server.close(); }
});

test('a stopped receiver is started only with autoStart', async () => {
  for (const autoStart of [true, false]) {
    const server = await startFakeTciServer({ running: false });
    const { rig } = open(server, { autoStart });
    try {
      await until(() => rig.connected);
      await wait(40);
      assert.equal(server.frames.some((f) => /(^|;)start;/.test(f)), autoStart, `autoStart ${autoStart}`);
    } finally { rig.close(); await server.close(); }
  }
});

test('a dropped link reports down and refuses control', async () => {
  const server = await startFakeTciServer();
  const { rig, seen } = open(server);
  await until(() => rig.connected);
  server.terminateClients();
  await until(() => seen.link.includes(false));
  assert.equal(rig.connected, false);
  assert.match(rig.tune(7074000, 'FT8'), /not connected/);
  await server.close();
});
