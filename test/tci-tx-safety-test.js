// SPDX-License-Identifier: Apache-2.0
'use strict';
// TCI transmit safety (lib/tci-tx.js through lib/tci-rig.js) against a fake
// Zeus and a fake Thetis. Each rule in lib/tci-tx.js's header is a case here.
// Based on PR #632 by w5lee.
// Run: node test/tci-tx-safety-test.js

const assert = require('node:assert/strict');
const test = require('node:test');
const { startFakeTciServer } = require('./fixtures/fake-tci-server');
const TciRig = require('../lib/tci-rig');
const TciTx = require('../lib/tci-tx');

const KEYS = /(?:^|;)\s*trx:0,true/;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting'); await wait(5); }
}

async function setup(serverOpts = {}, rigOpts = {}) {
  const server = await startFakeTciServer(serverOpts);
  const meters = [];
  const rig = TciRig.connectTciRig({
    host: '127.0.0.1', port: server.port, server: server.dialect, log: () => {},
    on: { txMeter: (k, v) => meters.push([k, v]) }, ...rigOpts,
  });
  await until(() => rig.connected && rig.tciMode);
  return { server, rig, meters };
}
async function toDigu(rig, server) {
  assert.equal(rig.tune(14074000, 'FT8'), '');
  await until(() => rig.tciMode === 'DIGU' && server.state.modulation === 'DIGU');
}
function burst(seconds = 0.2) {
  const s = new Float32Array(Math.round(12000 * seconds));
  for (let i = 0; i < s.length; i++) s[i] = 0.5 * Math.sin(i / 3);
  return s;
}
const done = () => { let r; const p = new Promise((res) => { r = res; }); return { p, cb: (reason, peak) => r({ reason, peak }) }; };

test('1. no key-down on connect, and none before startTx', async () => {
  const { server, rig } = await setup();
  try {
    await wait(60);
    for (const f of server.frames) assert.ok(!KEYS.test(f), 'keyed on connect: ' + f);
    assert.equal(server.state.trx, false);
  } finally { rig.close(); await server.close(); }
});

test('a digital over plays on TX_CHRONO, completes and is released', async () => {
  const { server, rig, meters } = await setup();
  try {
    await toDigu(rig, server);
    const d = done();
    const samples = burst(0.2);
    assert.equal(rig.startTx(samples, d.cb), '');
    await until(() => server.state.trx === true);
    server.send('tx_power:4.8;tx_swr:1.3;');
    const r = await d.p;
    assert.equal(r.reason, 'complete');
    await until(() => server.state.trx === false);
    const sent = server.txAudio.filter((a) => a.type === 2).reduce((n, a) => n + a.samples.length, 0);
    assert.ok(sent >= samples.length, `sent ${sent} of ${samples.length} samples`);
    assert.ok(meters.some(([k]) => k === 'swr'));
    assert.equal(rig.txActive, false);
  } finally { rig.close(); await server.close(); }
});

test('2a. a dropped socket mid-over is released from a second session', async () => {
  const { server, rig } = await setup({ moxSticks: true });
  try {
    await toDigu(rig, server);
    const d = done();
    assert.equal(rig.startTx(burst(5), d.cb), '');
    await until(() => server.state.trx === true && server.txAudio.length > 0);
    server.terminateClients();
    const r = await d.p;
    assert.match(r.reason, /dropped/);
    const t0 = Date.now();
    await until(() => server.state.trx === false, 1500);
    assert.ok(Date.now() - t0 < 1500, 'released within 1.5 s');
  } finally { rig.close(); await server.close(); }
});

test('2b. a server that stops asking for audio is released within 800 ms', async () => {
  const { server, rig } = await setup();
  try {
    await toDigu(rig, server);
    const d = done();
    assert.equal(rig.startTx(burst(5), d.cb), '');
    await until(() => server.txAudio.length > 2);
    server.stopChrono();
    const t0 = Date.now();
    const r = await d.p;
    assert.match(r.reason, /TX_CHRONO/);
    assert.ok(Date.now() - t0 < TciTx.STALL_MS + 300, 'stall released in time');
    await until(() => server.state.trx === false);
  } finally { rig.close(); await server.close(); }
});

test('2c. a server that keys and never asks is released', async () => {
  const { server, rig } = await setup({ chrono: false });
  try {
    await toDigu(rig, server);
    const d = done();
    assert.equal(rig.startTx(burst(2), d.cb), '');
    const r = await d.p;
    assert.match(r.reason, /TX_CHRONO/);
    await until(() => server.state.trx === false);
  } finally { rig.close(); await server.close(); }
});

test('2d. a release the radio never confirms goes again from a second session', async () => {
  const { server, rig } = await setup({ ackRelease: false });
  try {
    await toDigu(rig, server);
    const d = done();
    assert.equal(rig.startTx(burst(5), d.cb), '');
    await until(() => server.txAudio.length > 0);
    rig.stopTx('operator halt');
    await d.p;
    // The fake drops trx on the release but never answers it: the recovery
    // session must still be opened (a second client connects and sends RX).
    await until(() => server.frames.filter((f) => f === TciTx.RELEASE).length >= 2, 2000);
  } finally { rig.close(); await server.close(); }
});

test('3. every over is bounded: the deadline ends a buffer the server keeps asking for', async () => {
  const { server, rig } = await setup({ chronoSamples: 1 }); // asks for 1 sample at a time: never finishes in time
  try {
    await toDigu(rig, server);
    const d = done();
    const t0 = Date.now();
    assert.equal(rig.startTx(burst(0.1), d.cb), '');
    const r = await d.p;
    assert.match(r.reason, /deadline/);
    assert.ok(Date.now() - t0 < 100 + 800 + 400);
    await until(() => server.state.trx === false);
  } finally { rig.close(); await server.close(); }
});

test('3b. voice: no phone audio for 800 ms releases PTT; audio keeps it up', async () => {
  const { server, rig } = await setup();
  try {
    assert.equal(rig.tune(14250000, 'USB'), '');
    await until(() => rig.tciMode === 'USB');
    const d = done();
    assert.equal(rig.startVoiceTx(60000, d.cb), '');
    const feed = setInterval(() => rig.pushVoiceAudio(new Float32Array(240).fill(0.1)), 20);
    await wait(1000);
    assert.equal(rig.voiceTxActive, true, 'fed audio keeps PTT up');
    clearInterval(feed);
    const r = await d.p;
    assert.match(r.reason, /microphone/);
    await until(() => server.state.trx === false);
  } finally { rig.close(); await server.close(); }
});

test('4. the drive cap: clamps setDrive and refuses a key-down until the drive is set', async () => {
  let cap = 40;
  const { server, rig } = await setup({}, { driveCapPct: () => cap });
  try {
    await toDigu(rig, server);
    assert.match(rig.startTx(burst(), () => {}), /Set TX drive/, 'drive unknown (Zeus reports 50 until written)');
    assert.ok(rig.setDrive(100));
    await until(() => server.state.drive === 40);
    assert.equal(rig.drivePct, 40);
    assert.equal(rig.txRefusal('digital'), '');
    cap = 20; // the operator lowered the limit
    assert.match(rig.txRefusal('digital'), /above the amplifier limit of 20%/);
    assert.equal(server.state.trx, false);
  } finally { rig.close(); await server.close(); }
});

test('4b. Thetis drive 0..90: the cap is in percent of full drive', async () => {
  const { server, rig } = await setup({ dialect: 'thetis' }, { driveCapPct: () => 50 });
  try {
    assert.ok(rig.setDrive(80));
    await until(() => server.state.drive === 45);
  } finally { rig.close(); await server.close(); }
});

test('5. digital needs DIGU; a band pick on Zeus sends DIGU even with data mode off', async () => {
  const { server, rig } = await setup();
  try {
    assert.equal(server.state.modulation, 'USB');
    assert.match(rig.startTx(burst(), () => {}), /DIGU/);
    assert.equal(rig.tune(7074000, 'FT8', { dataMode: false }), '');
    await until(() => rig.tciMode === 'DIGU');
    assert.equal(rig.txRefusal('digital'), '');
    assert.match(rig.txRefusal('voice'), /USB or LSB/);
  } finally { rig.close(); await server.close(); }
});

test('5b. split or a TX dial off the RX dial refuses', async () => {
  const { server, rig } = await setup();
  try {
    await toDigu(rig, server);
    server.send('split_enable:0,true;');
    await until(() => /split/.test(rig.txRefusal('digital')));
    server.send('split_enable:0,false;vfo:0,1,14080000;');
    await until(() => /split/.test(rig.txRefusal('digital')));
    server.send('vfo:0,1,14074000;');
    await until(() => rig.txRefusal('digital') === '');
  } finally { rig.close(); await server.close(); }
});

test('6. Thetis never keys', async () => {
  const { server, rig } = await setup({ dialect: 'thetis' });
  try {
    assert.equal(rig.tune(14074000, 'FT8'), '');
    await until(() => rig.tciMode === 'DIGU');
    assert.equal(rig.startTx(burst(), () => {}), TciTx.THETIS_TX_REFUSAL);
    assert.equal(rig.startVoiceTx(1000, () => {}), TciTx.THETIS_TX_REFUSAL);
    await wait(40);
    for (const f of server.frames) assert.ok(!KEYS.test(f), 'Thetis keyed: ' + f);
  } finally { rig.close(); await server.close(); }
});

test('nothing else can key: the control path refuses keying frames', async () => {
  const { server, rig } = await setup();
  try {
    await toDigu(rig, server);
    const before = server.frames.length;
    // A second over while one runs, and controls while keyed, are refused.
    assert.equal(rig.startTx(burst(1), () => {}), '');
    await until(() => server.state.trx === true);
    assert.match(rig.startTx(burst(), () => {}), /receive/);
    assert.equal(rig.setDrive(10), false);
    assert.match(rig.tune(7074000, 'FT8'), /receive/);
    rig.stopTx();
    await until(() => server.state.trx === false);
    assert.equal(server.frames.slice(before).filter((f) => KEYS.test(f)).length, 1, 'exactly one key-down');
  } finally { rig.close(); await server.close(); }
});
