// SPDX-License-Identifier: Apache-2.0
'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WebSocketServer } = require('ws');
const { AUDIO_RATE, connectTciJtcatRx, decodeRxFrame, probeTci } = require('../lib/tci-jtcat-rx');
const { createZeusFt8Rx } = require('../lib/zeus-ft8-rx');
const { cycleZeusEngineNr } = require('../lib/zeus-engine-port');

test('FT8 DSP recall restores the exact prior settings after a controller restart', { timeout: 3000 }, async () => {
  const initial = {
    status: 'Connected',
    agc: { mode: 'Long', fixedGainDb: 24 },
    nr: { nrMode: 'Nnr', nbMode: 'Nb2', anfEnabled: true, snbEnabled: true, nbpNotchesEnabled: true },
    squelch: { enabled: true, level: 40 },
    autoAgcEnabled: true,
    rxLevelerEnabled: true,
  };
  const state = structuredClone(initial);
  const setters = {
    '/api/auto-agc': ['autoAgcEnabled', 'enabled'],
    '/api/rx/agc': ['agc', 'agc'],
    '/api/rx/nr': ['nr', 'nr'],
    '/api/rx/squelch': ['squelch', 'squelch'],
    '/api/rx/leveler': ['rxLevelerEnabled', 'enabled'],
  };
  const server = http.createServer(async (request, response) => {
    if (request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const [key, field] = setters[request.url];
      state[key] = JSON.parse(body)[field];
    }
    response.end(JSON.stringify(state));
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-tci-test-'));
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const port = server.address().port;
    await createZeusFt8Rx(port, profile)(true, () => true);
    assert.equal(state.agc.mode, 'Fixed');
    assert.equal(state.nr.nrMode, 'Off');
    assert.equal(state.nr.nbMode, 'Off');
    assert.equal(state.nr.anfEnabled, false);
    await createZeusFt8Rx(port, profile)(false, () => true);
    assert.deepEqual(state, initial);
    assert.deepEqual(fs.readdirSync(profile), []);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('setup verifies TCI readiness without sending a command', { timeout: 3000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const port = server.address().port;
  const connection = once(server, 'connection');
  const probe = probeTci(port);
  try {
    const [peer] = await connection;
    const messages = [];
    peer.on('message', frame => messages.push(frame.toString()));
    const closed = once(peer, 'close');
    peer.send('protocol:Zeus,1.9;ready;');
    await probe;
    await closed;
    assert.deepEqual(messages, []);
  } finally {
    for (const peer of server.clients) peer.terminate();
    await new Promise(resolve => server.close(resolve));
  }
  await assert.rejects(probeTci(port), /ECONNREFUSED/);
});

function rxFrame(values) {
  const frame = Buffer.alloc(64 + values.length * 4);
  frame.writeUInt32LE(AUDIO_RATE, 4);
  frame.writeUInt32LE(3, 8); // Float32
  frame.writeUInt32LE(values.length, 20);
  frame.writeUInt32LE(1, 24); // RX audio
  values.forEach((value, index) => frame.writeFloatLE(value, 64 + index * 4));
  return frame;
}

test('accepts only complete RX1 audio frames and sanitizes PCM', () => {
  const frame = rxFrame([0.5, -2, NaN]);
  assert.deepEqual([...decodeRxFrame(frame)], [0.5, -1, 0]);
  assert.equal(decodeRxFrame(frame.subarray(0, frame.length - 1)), null);
  frame.writeUInt32LE(3, 24); // TX_CHRONO, never decoder audio
  assert.equal(decodeRxFrame(frame), null);
});

test('waits for ready, subscribes without keying, and delivers RX1 audio', { timeout: 3000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const dial = [];
  const modes = [];
  const meters = [];
  const txMeters = [];
  const txStates = [];
  const dspChanges = [];
  let receive;
  let receivePeak;
  const peaks = [];
  const audio = new Promise((resolve) => { receive = resolve; });
  const client = connectTciJtcatRx(server.address().port, {
    onAudio: receive,
    onRxPeak(level) { peaks.push(level); receivePeak?.(level); },
    onDial: (hz) => dial.push(hz),
    onMode: (mode) => modes.push(mode),
    onSmeter: (dbm) => meters.push(dbm),
    onTxMeter: (name, value) => txMeters.push([name, value]),
    onTxState: (state) => txStates.push(state),
    async setFt8Rx(enter, isReceiving) {
      assert.equal(isReceiving(), true);
      dspChanges.push(enter);
    },
    log() {},
  });
  try {
    const [peer] = await once(server, 'connection');
    const subscription = once(peer, 'message');
    assert.equal(client.connected, false);
    assert.match(await client.tune(14074000, 'FT8', true), /not connected/);
    peer.send('vfo:0,0,14074000;vfo:0,1,14075000;ready;');
    const [commands] = await subscription;
    assert.equal(client.connected, true);
    assert.equal(commands.toString(),
      'audio_samplerate:12000;audio_stream_channels:1;audio_stream_sample_type:float32;audio_start:0;trx:0;');
    // Use the next audio frame as a barrier after the text updates.
    peer.send('trx:0,true;modulation:0,DIGU;modulation:1,LSB;rx_smeter:0,2,-73.5;rx_smeter:0,4,-55;rx_smeter:1,0,-52;tx_power:6.8;tx_swr:1.2;tx_alc:3;tx_power:-1;tx_swr:0;tx_alc:105;');
    peer.send(rxFrame(Array(3000).fill(1)));
    assert.equal((await audio).length, 3000);
    assert.deepEqual(peaks, []);
    assert.deepEqual(dial, [14074000]);
    assert.deepEqual(modes, ['DIGU']);
    assert.deepEqual(meters, [-73.5]);
    assert.deepEqual(txMeters, [['tx_power', 6.8], ['tx_swr', 1.2], ['tx_alc', 3]]);
    assert.equal(client.transmitting, true);
    assert.match(await client.tune(14074000, 'FT8', true), /return to receive/);
    peer.send('trx:0,false;vfo:0,0,14074001;');
    // Wait until the client has handled the receive status before tuning.
    while (dial.length < 2) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(client.transmitting, false);
    assert.deepEqual(txStates, [true, false]);
    const cleanPeak = new Promise(resolve => { receivePeak = resolve; });
    peer.send(rxFrame(Array(1500).fill(0.25)));
    peer.send(rxFrame(Array(1500).fill(-0.5)));
    assert.deepEqual(await cleanPeak, { peakDb: 20 * Math.log10(0.5), nearClip: false });
    const fullScale = new Promise(resolve => { receivePeak = resolve; });
    peer.send(rxFrame(Array(3000).fill(-1)));
    assert.deepEqual(await fullScale, { peakDb: 0, nearClip: true });
    assert.match(await client.tune(14074000, 'INVALID', true), /unsupported/i);
    const tune = once(peer, 'message');
    assert.equal(await client.tune(14074000, 'FT8', true), '');
    assert.equal((await tune)[0].toString(), 'vfo:0,0,14074000;modulation:0,DIGU;');
    const voice = once(peer, 'message');
    assert.equal(await client.tune(14074000, 'SSB', true), '');
    assert.equal((await voice)[0].toString(), 'vfo:0,0,14074000;modulation:0,USB;');
    const lowerSideband = once(peer, 'message');
    assert.equal(await client.tune(7100000, 'SSB', true), '');
    assert.equal((await lowerSideband)[0].toString(), 'vfo:0,0,7100000;modulation:0,LSB;');
    assert.deepEqual(dspChanges, [true, false, false]);
  } finally {
    client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

function txChrono(count) {
  const frame = Buffer.alloc(64);
  frame.writeUInt32LE(AUDIO_RATE, 4);
  frame.writeUInt32LE(3, 8); // Float32
  frame.writeUInt32LE(count, 20);
  frame.writeUInt32LE(3, 24); // TX_CHRONO
  frame.writeUInt32LE(1, 28); // mono
  return frame;
}

async function withMockTxServer(run, { samples = Float32Array.of(0.25, -0.25), voice = false, thetis = false, emulateExpertSdr = false, onDigitalTxAudio } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let finish;
  let measuredWatts;
  const completed = new Promise(resolve => {
    finish = (reason, watts) => {
      measuredWatts = watts;
      resolve(reason);
    };
  });
  let afterDial;
  const client = connectTciJtcatRx(server.address().port, {
    server: emulateExpertSdr ? 'thetis' : undefined,
    onDigitalTxAudio,
    onAudio() {}, onDial(hz) { afterDial?.(hz); }, onMode() {}, onSmeter() {}, onTxMeter() {}, log() {},
  });
  try {
    const [peer] = await once(server, 'connection');
    const subscription = once(peer, 'message');
    const mode = voice ? 'USB' : 'DIGU';
    const vfoB = thetis ? 7100000 : 14074000;
    const protocol = emulateExpertSdr ? 'ExpertSDR3' : 'Thetis';
    const txState = thetis ? `protocol:${protocol},2.0;tx_frequency:14074000;split_enable:0,true;` : '';
    peer.send(`${txState}vfo:0,0,14074000;vfo:0,1,${vfoB};modulation:0,${mode};trx:0,false;ready;`);
    await subscription;
    if (thetis) {
      assert.match(client.startTx(samples, 14074000, finish), /split off/);
      const dial = new Promise(resolve => { afterDial = resolve; });
      peer.send('split_enable:0,false;vfo:0,0,14074000;');
      await dial;
    }
    const key = once(peer, 'message');
    const reason = voice
      ? client.startVoiceTx((mode, dial) => mode === 'USB' && dial === 14074000, 5000, finish)
      : client.startTx(samples, 14074000, finish);
    assert.equal(reason, '');
    assert.equal((await key)[0].toString(), 'trx:0,true,tci;');
    await run({ client, peer, server, completed, readMeasuredWatts: () => measuredWatts });
  } finally {
    client.close();
    for (const peer of server.clients) peer.terminate();
    await new Promise(resolve => server.close(resolve));
  }
}

test('keys for TCI audio, responds to TX_CHRONO, and releases after the tail', { timeout: 3000 }, async () => {
  const txFrames = [];
  await withMockTxServer(async ({ peer, completed, readMeasuredWatts }) => {
    const next = once(peer, 'message');
    peer.send('tx_power:99;');
    peer.send('trx:0,true;');
    peer.send(txChrono(3));
    const [audio, binary] = await next;
    assert.equal(binary, true);
    assert.equal(audio.readUInt32LE(24), 2);
    assert.equal(audio.readUInt32LE(20), 3);
    assert.deepEqual([audio.readFloatLE(64), audio.readFloatLE(68), audio.readFloatLE(72)], [0.25, -0.25, 0]);
    assert.equal(txFrames.length, 1);
    assert.deepEqual(txFrames[0], audio.subarray(64));
    peer.send('tx_power:4.4;');
    peer.send('tx_power:3.2;');
    const release = once(peer, 'message');
    assert.equal(await completed, 'complete');
    assert.equal(readMeasuredWatts(), 4.4);
    assert.equal((await release)[0].toString(), 'trx:0,false;');
    peer.send('trx:0,false;');
  }, { onDigitalTxAudio: (payload) => txFrames.push(payload) });
});

test('a lost TX socket opens a recovery connection and releases PTT', { timeout: 3000 }, async () => {
  await withMockTxServer(async ({ peer, server, completed }) => {
    const rescue = once(server, 'connection');
    peer.terminate();
    assert.equal(await completed, 'TCI socket disconnected');
    const [recoveryPeer] = await rescue;
    const [release] = await once(recoveryPeer, 'message');
    assert.equal(release.toString(), 'trx:0,false;');
    recoveryPeer.send('trx:0,false;');
  });
});

for (const emulateExpertSdr of [false, true]) {
  const serverName = emulateExpertSdr ? 'Thetis in ExpertSDR3 emulation' : 'Thetis';
  test(`${serverName} uses reported TX frequency rather than the unrelated VFO B`, { timeout: 3000 }, async () => {
    await withMockTxServer(async ({ client, peer, completed }) => {
      const release = once(peer, 'message');
      client.stopTx();
      assert.equal(await completed, 'cancelled');
      assert.equal((await release)[0].toString(), 'trx:0,false;');
    }, { thetis: true, emulateExpertSdr });
  });
}

test('accepts a longer digital waveform and releases PTT when stopped', { timeout: 3000 }, async () => {
  const samples = new Float32Array(30 * AUDIO_RATE).fill(0.25);
  await withMockTxServer(async ({ client, peer, completed }) => {
    const next = once(peer, 'message');
    peer.send('trx:0,true;');
    peer.send(txChrono(2));
    const [audio] = await next;
    assert.equal(audio.readFloatLE(64), 0.25);
    const release = once(peer, 'message');
    client.stopTx();
    assert.equal(await completed, 'cancelled');
    assert.equal((await release)[0].toString(), 'trx:0,false;');
    peer.send('trx:0,false;');
  }, { samples });
});

test('streams phone mic audio on demand and releases voice PTT independently', { timeout: 3000 }, async () => {
  await withMockTxServer(async ({ client, peer, completed }) => {
    assert.equal(client.voiceTxActive, true);
    assert.match(client.startTx(Float32Array.of(0.25), 14074000, () => {}), /receiving/);
    client.pushVoiceAudio(Float32Array.of(0.25, -0.5));
    const next = once(peer, 'message');
    peer.send('trx:0,true;');
    peer.send(txChrono(3));
    const [audio] = await next;
    assert.deepEqual([audio.readFloatLE(64), audio.readFloatLE(68), audio.readFloatLE(72)], [0.25, -0.5, 0]);
    const release = once(peer, 'message');
    client.stopVoiceTx();
    assert.equal(await completed, 'cancelled');
    assert.equal(client.voiceTxActive, false);
    assert.equal((await release)[0].toString(), 'trx:0,false;');
    peer.send('trx:0,false;');
  }, { voice: true });
});

test('voice PTT drops when phone audio stops even if Zeus continues requesting PCM', { timeout: 3000 }, async () => {
  await withMockTxServer(async ({ client, peer, completed }) => {
    client.pushVoiceAudio(Float32Array.of(0.25));
    peer.send('trx:0,true;');
    const released = new Promise(resolve => {
      peer.on('message', (data, binary) => { if (!binary) resolve(data.toString()); });
    });
    const pace = setInterval(() => peer.send(txChrono(128)), 40);
    try {
      assert.equal(await completed, 'phone microphone audio stopped');
      assert.equal(await released, 'trx:0,false;');
      peer.send('trx:0,false;');
    } finally {
      clearInterval(pace);
    }
  }, { voice: true });
});

test('missing TX_CHRONO releases PTT before the slot deadline', { timeout: 3000 }, async () => {
  await withMockTxServer(async ({ peer, completed }) => {
    const release = once(peer, 'message');
    peer.send('trx:0,true;');
    assert.equal(await completed, 'no TX_CHRONO received');
    assert.equal((await release)[0].toString(), 'trx:0,false;');
    peer.send('trx:0,false;');
  });
});

for (const autoStart of [false, true]) {
  test(`stopped receiver auto-start is ${autoStart ? 'enabled' : 'disabled'}`, { timeout: 3000 }, async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const commands = [];
    const connected = once(server, 'connection');
    const client = connectTciJtcatRx(server.address().port, {
      autoStart, onAudio() {}, onDial() {}, onMode() {}, onSmeter() {}, onTxMeter() {}, log() {},
    });
    try {
      const [peer] = await connected;
      peer.on('message', data => commands.push(data.toString()));
      const response = once(peer, 'message');
      peer.send('stop;ready;');
      await response;
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(commands.includes('start;'), autoStart);
      peer.send('stop;ready;');
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(commands.filter(command => command === 'start;').length, autoStart ? 1 : 0);
    } finally {
      client.close();
      for (const peer of server.clients) peer.terminate();
      await new Promise(resolve => server.close(resolve));
    }
  });
}

for (const scenario of [
  { server: 'thetis', reportedDb: -60, percent: 0, halfVolumeDb: '-6.02' },
  { server: 'zeus', reportedDb: 1, percent: 11, halfVolumeDb: '13.98' },
]) {
  test(`${scenario.server} RX volume reads radio state and sends a bounded volume command`, { timeout: 3000 }, async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const connection = once(server, 'connection');
    let report;
    const volume = new Promise(resolve => { report = resolve; });
    const client = connectTciJtcatRx(server.address().port, {
      server: scenario.server, onRxVolume: value => report(value), onAudio() {}, onDial() {}, onMode() {}, onSmeter() {}, onTxMeter() {}, log() {},
    });
    try {
      const [peer] = await connection;
      const query = new Promise(resolve => peer.on('message', data => {
        if (data.toString() === 'rx_volume:0,0;') resolve();
      }));
      peer.send('ready;');
      await query;
      peer.send(`rx_volume:0,0,${scenario.reportedDb};`);
      assert.equal(Math.round((await volume) * 100), scenario.percent);
      assert.equal(client.setRxVolume(1.01), false);
      const command = once(peer, 'message');
      assert.equal(client.setRxVolume(0.5), true);
      assert.equal((await command)[0].toString(), `rx_volume:0,0,${scenario.halfVolumeDb};rx_volume:0,0;`);
      if (scenario.server === 'zeus') {
        const full = once(peer, 'message');
        assert.equal(client.setRxVolume(1), true);
        assert.equal((await full)[0].toString(), 'rx_volume:0,0,20.00;rx_volume:0,0;');
        const half = once(peer, 'message');
        assert.equal(client.setRxVolume(0.5), true);
        assert.equal((await half)[0].toString(), 'rx_volume:0,0,13.98;rx_volume:0,0;');
        const confirmed = new Promise(resolve => { report = resolve; });
        peer.send('rx_volume:0,0,14;');
        assert.equal(await confirmed, Math.pow(10, (13.98 - 20) / 20));
      }
    } finally {
      client.close();
      for (const peer of server.clients) peer.terminate();
      await new Promise(resolve => server.close(resolve));
    }
  });
}

test('TCI AGC normalizes Zeus and Thetis readbacks and sets RX1 mode', { timeout: 3000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const connection = once(server, 'connection');
  const modes = [];
  const client = connectTciJtcatRx(server.address().port, {
    onAgcMode(mode) { modes.push(mode); },
    onAudio() {}, onDial() {}, onMode() {}, onSmeter() {}, onTxMeter() {}, log() {},
  });
  try {
    const [peer] = await connection;
    const query = new Promise(resolve => peer.on('message', data => {
      if (data.toString() === 'agc_mode:0;') resolve();
    }));
    peer.send('trx:0,false;agc_mode:0,FIXED;agc_mode:1,fast;agc_mode:0,normal;ready;');
    await query;
    assert.deepEqual(modes, ['off', 'med']);
    assert.equal(client.agcMode, 'med');
    assert.equal(client.setAgcMode('invalid'), false);
    const command = once(peer, 'message');
    assert.equal(client.setAgcMode('slow'), true);
    assert.equal((await command)[0].toString(), 'agc_mode:0,slow;agc_mode:0;');
  } finally {
    client.close();
    for (const peer of server.clients) peer.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});

for (const scenario of [
  { label: 'raises quiet fixed gain in a bounded step', gain: 55, volumeDb: 0, peakDb: -40,
    expected: 'agc_gain:0,67;agc_gain:0;' },
  { label: 'balances 9% volume toward 50% without a gain spike', gain: 67, volumeDb: -20.92, peakDb: -14,
    expected: 'agc_gain:0,54;rx_volume:0,0,-6.02;agc_gain:0;rx_volume:0,0;' },
  { label: 'uses the Zeus engine fixed gain instead of TCI AGC top', server: 'zeus',
    gain: 93, engineGain: 20, volumeDb: -13, peakDb: -14,
    expected: 'agc_gain:0,-5;rx_volume:0,0,13.98;rx_volume:0,0;' },
]) {
  test(`auto RX level ${scenario.label}`, { timeout: 5000 }, async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const connection = once(server, 'connection');
    let ready;
    const linked = new Promise(resolve => { ready = resolve; });
    let gain = scenario.engineGain ?? scenario.gain;
    const initialGain = gain;
    let volumeDb = scenario.volumeDb;
    let audioTimer;
    const radio = connectTciJtcatRx(server.address().port, {
      server: scenario.server || 'thetis',
      getZeusFixedGain: async () => gain,
      onLink(connected) { if (connected) ready(); },
      onAudio() {}, onDial() {}, onMode() {}, onSmeter() {}, onTxMeter() {}, log() {},
    });
    try {
      const [peer] = await connection;
      peer.send(`vfo:0,0,7074000;modulation:0,DIGU;trx:0,false;agc_mode:0,off;agc_gain:0,${scenario.gain};rx_volume:0,0,${scenario.volumeDb};ready;`);
      await linked;
      const adjustments = [];
      const sendAudio = () => {
        const level = scenario.peakDb + gain - initialGain + volumeDb - scenario.volumeDb;
        const frame = rxFrame(Array(512).fill(Math.min(1, Math.pow(10, level / 20))));
        for (let i = 0; i < 118; i++) peer.send(frame);
      };
      peer.on('message', data => {
        const command = data.toString();
        const gainMatch = /(?:^|;)agc_gain:0,(-?\d+);/.exec(command);
        const volumeMatch = /(?:^|;)rx_volume:0,0,(-?[\d.]+);/.exec(command);
        if (!gainMatch && !volumeMatch) return;
        adjustments.push(command);
        if (gainMatch) {
          gain = Number(gainMatch[1]);
          if (!scenario.server) peer.send(`agc_gain:0,${gain};`);
        }
        if (volumeMatch) {
          volumeDb = Number(volumeMatch[1]);
          peer.send(`rx_volume:0,0,${volumeDb};`);
        }
        audioTimer = setTimeout(sendAudio, 350);
      });
      const result = radio.autoRxLevel();
      sendAudio();
      const measured = await result;
      assert.equal(measured.error, undefined);
      assert.equal(measured.adjustments, adjustments.length);
      assert.equal(adjustments[0], scenario.expected);
      assert.equal(measured.clipped, 0);
      if (scenario.peakDb === -40) {
        assert.ok(adjustments.length > 1);
        assert.equal(measured.fixedGain.to, 80);
        assert.equal(measured.limited, true);
        assert.equal(Math.round(measured.peakDb), -15);
      } else {
        assert.ok(Math.abs(measured.peakDb - (-12)) < 2);
        assert.equal(measured.volume.to, 50);
      }
    } finally {
      clearTimeout(audioTimer);
      radio.close();
      for (const peer of server.clients) peer.terminate();
      await new Promise(resolve => server.close(resolve));
    }
  });
}

test('Zeus TCI cycles NR and NB and reads back RF gain and drive', { timeout: 3000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const connection = once(server, 'connection');
  let ready;
  const linked = new Promise(resolve => { ready = resolve; });
  let reportNb;
  const levels = [];
  const driveWrites = [];
  const radio = connectTciJtcatRx(server.address().port, {
    server: 'zeus', onNoiseBlanker: enabled => reportNb?.(enabled),
    onAttenuation: percent => levels.push(percent),
    onDrive(percent, written) { levels.push(percent); driveWrites.push(written); },
    onLink(connected) { if (connected) ready(); },
    onAudio() {}, onDial() {}, onMode() {}, onSmeter() {}, onTxMeter() {}, log() {},
  });
  try {
    const [peer] = await connection;
    const subscribed = new Promise(resolve => peer.on('message', data => {
      if (data.toString() === 'rx_nb_enable:0;rx_nb2_enable:0;') resolve();
    }));
    peer.send('trx:0,false;drive:0,50;ready;');
    await linked;
    await subscribed;
    const nr = once(peer, 'message');
    assert.equal(await radio.cycleNoiseReduction(), true);
    assert.equal((await nr)[0].toString(), 'rx_nr_enable_ex:0,true,1;');
    assert.equal(radio.noiseReductionLevel, 1);
    const initialNb = new Promise(resolve => { reportNb = resolve; });
    peer.send('rx_nb2_enable:0,false;');
    assert.equal(await initialNb, false);

    for (const [command, enabled, level] of [
      ['rx_nb_enable', true, 1],
      ['rx_nb2_enable', true, 2],
      ['rx_nb2_enable', false, 0],
    ]) {
      const nb = once(peer, 'message');
      const confirmed = new Promise(resolve => { reportNb = resolve; });
      const notices = [];
      assert.equal(radio.cycleNoiseBlanker(value => notices.push(value)), true);
      assert.equal((await nb)[0].toString(), `${command}:0,${enabled};${command}:0;`);
      assert.deepEqual(notices, []);
      peer.send(`${command}:0,${enabled};`);
      assert.equal(await confirmed, enabled);
      assert.equal(radio.noiseBlankerLevel, level);
      assert.deepEqual(notices, [level]);
    }
    const attenuation = once(peer, 'message');
    assert.equal(radio.setRfGain(50), true);
    assert.equal((await attenuation)[0].toString(), 'attenuator:0,16;attenuator:0;');
    const drive = once(peer, 'message');
    assert.equal(radio.setDrive(75), true);
    assert.equal((await drive)[0].toString(), 'drive:0,75;drive:0;');
    assert.equal(radio.setDrive(101), false);
    const readback = new Promise(resolve => { reportNb = resolve; });
    peer.send('attenuator:0,31;attenuator:0,23;attenuator:0,16;attenuator:0,8;attenuator:0,0;drive:0,50;rx_nb2_enable:0,false;');
    await readback;
    assert.deepEqual(levels, [50, 0, 25, 50, 75, 100, 50]);
    assert.deepEqual(driveWrites, [false, true]);
  } finally {
    radio.close();
    for (const peer of server.clients) peer.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});


test('local Zeus engine cycles through all five NR algorithms and off', { timeout: 3000 }, async () => {
  const state = { receivers: [{ nrMode: 'Off' }], wdspNr3RnnrAvailable: true };
  const changes = [];
  const server = http.createServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/receivers/0');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const patch = JSON.parse(Buffer.concat(chunks));
    assert.deepEqual(Object.keys(patch), ['nrMode']);
    changes.push(patch.nrMode);
    state.receivers[0].nrMode = patch.nrMode;
    response.end(JSON.stringify(state));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const engine = { port: server.address().port, state };
    for (const expected of [1, 2, 3, 4, 5, 0]) {
      assert.equal(await cycleZeusEngineNr(engine, () => true), expected);
    }
    assert.deepEqual(changes, ['Anr', 'Emnr', 'Rnnr', 'Sbnr', 'Nnr', 'Off']);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('Thetis RF gain uses only the enabled RX1 step attenuator and shares drive control', { timeout: 3000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const connection = once(server, 'connection');
  let reportGain;
  let reportDrive;
  const radio = connectTciJtcatRx(server.address().port, {
    server: 'thetis',
    onAttenuation: value => reportGain?.(value),
    onDrive: value => reportDrive?.(value),
    onAudio() {}, onDial() {}, onMode() {}, onSmeter() {}, onTxMeter() {}, log() {},
  });
  try {
    const [peer] = await connection;
    const queried = new Promise(resolve => peer.on('message', data => {
      if (data.toString() === 'rx_step_att_ex:0;') resolve();
    }));
    peer.send('device:HERMESLITE;trx:0,false;ready;');
    await queried;
    assert.equal(radio.setRfGain(25), false);

    const initial = new Promise(resolve => { reportGain = resolve; });
    peer.send('rx_step_att_ex:0,0;');
    assert.equal(await initial, null);
    const enabled = new Promise(resolve => { reportGain = resolve; });
    peer.send('rx_step_att_enabled_ex:0,true;');
    assert.equal(await enabled, 100);

    const gain = once(peer, 'message');
    assert.equal(radio.setRfGain(25), true);
    assert.equal((await gain)[0].toString(), 'rx_step_att_ex:0,23;rx_step_att_ex:0;');
    const confirmed = new Promise(resolve => { reportGain = resolve; });
    peer.send('rx_step_att_ex:0,23;');
    assert.equal(await confirmed, 25);

    const drive = once(peer, 'message');
    assert.equal(radio.setDrive(50), true);
    assert.equal((await drive)[0].toString(), 'drive:0,45;drive:0;');
    const maximum = once(peer, 'message');
    assert.equal(radio.setDrive(100), true);
    assert.equal((await maximum)[0].toString(), 'drive:0,90;drive:0;');
    const confirmedDrive = new Promise(resolve => { reportDrive = resolve; });
    peer.send('drive:0,90;');
    assert.equal(await confirmedDrive, 100);
  } finally {
    radio.close();
    for (const peer of server.clients) peer.terminate();
    await new Promise(resolve => server.close(resolve));
  }
});

for (const serverName of ['zeus', 'thetis']) {
  test(`${serverName}: receives filter and squelch readback and streams IQ only on request`, { timeout: 3000 }, async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const events = new (require('node:events').EventEmitter)();
    const commands = [];
    const client = connectTciJtcatRx(server.address().port, {
      server: serverName,
      onFilter: width => events.emit('filter', width),
      onSquelch: level => events.emit('sql', level),
      onIq: (...args) => events.emit('iq', ...args),
      onAudio() {}, onDial() {}, onMode() {}, onSmeter() {}, onTxMeter() {}, log() {},
    });
    try {
      const [peer] = await once(server, 'connection');
      peer.on('message', command => { commands.push(command.toString()); events.emit('command'); });
      const filter = once(events, 'filter');
      const squelch = once(events, 'sql');
      const wireLevel = serverName === 'thetis' ? -70 : 50;
      peer.send(`trx:0,false;ready;dds:0,14050000;rx_filter_band:0,100,2700;sql_enable:0,true;sql_level:0,${wireLevel};`);
      assert.deepEqual(await filter, [2600]);
      assert.deepEqual(await squelch, [50]);
      assert.equal(client.setFilterBand(-2800, -100), true);
      assert.equal(client.setSquelch(50), true);
      assert.equal(client.setIqEnabled(true), true);
      const frame = Buffer.alloc(72);
      frame.writeUInt32LE(48000, 4);
      frame.writeUInt32LE(3, 8);
      frame.writeUInt32LE(2, 20);
      frame.writeUInt32LE(2, 28);
      frame.writeFloatLE(0.25, 64);
      frame.writeFloatLE(-0.5, 68);
      const iq = once(events, 'iq');
      peer.send(frame);
      const [payload, rate, center] = await iq;
      assert.deepEqual(payload, frame.subarray(64));
      assert.equal(rate, 48000);
      assert.equal(center, 14050000);
      assert.equal(client.setIqEnabled(false), true);
      while (!commands.includes('iq_stop:0;')) await once(events, 'command');
      assert.ok(commands.includes('dds:0;iq_start:0;'));
      assert.ok(commands.includes('rx_filter_band:0,-2800,-100;rx_filter_band:0;'));
      assert.ok(commands.includes(`sql_level:0,${wireLevel};sql_enable:0,true;sql_enable:0;sql_level:0;`));
    } finally {
      client.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
