'use strict';
// FDV1: decoded FreeDV speech reaches the phone on the ECHOCAT audio track,
// freedv-status carries state, modes, sync, SNR and a plain reason, and the
// protocol drift is fixed (agreed with ECHOCAT 2026-11-16).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildFreedvStatus, shouldSendStatus, REASONS, THROTTLE_MS } = require('../lib/freedv-status');
const { createLeveller, rmsOf, TARGET_RMS, MAX_GAIN } = require('../lib/freedv-speech-level');
const proto = require('../lib/echocat-protocol');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ok', name); }
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const both = { classic: true, rade: true };

// --- freedv-status ---
t('off in settings: state off, the disabled sentence', () => {
  const st = buildFreedvStatus({ enabled: false, decoders: both });
  assert.strictEqual(st.state, 'off');
  assert.strictEqual(st.reasonCode, 'disabled');
  assert.strictEqual(st.reason, REASONS.disabled);
  assert.strictEqual(st.tx, false);
});
t('no decoder in this build: unavailable, no-decoder, no modes', () => {
  const st = buildFreedvStatus({ enabled: true, decoders: { classic: false, rade: false } });
  assert.strictEqual(st.state, 'unavailable');
  assert.strictEqual(st.reasonCode, 'no-decoder');
  assert.deepStrictEqual(st.modes, []);
  assert.strictEqual(st.rx, false);
});
t('only the classic decoder: RADE is not offered, and running RADE says so', () => {
  const st = buildFreedvStatus({ enabled: true, decoders: { classic: true, rade: false } });
  assert.ok(!st.modes.includes('RADEV1'));
  assert.ok(st.modes.includes('700D'));
  const r = buildFreedvStatus({ enabled: true, decoders: { classic: true, rade: false }, running: true, mode: 'RADEV1' });
  assert.strictEqual(r.state, 'unavailable');
  assert.strictEqual(r.reason, REASONS['no-rade']);
});
t('running: sync and SNR as a float in dB, tx false, callsign null', () => {
  const st = buildFreedvStatus({ enabled: true, decoders: both, running: true, mode: 'RADEV1', sync: 1, snr: 4.27 });
  assert.strictEqual(st.state, 'running');
  assert.strictEqual(st.sync, true);
  assert.strictEqual(st.snr, 4.3);
  assert.strictEqual(st.tx, false);
  assert.strictEqual(st.callsign, null);
  assert.ok(st.modes.includes('RADEV1'));
});
t('an engine error is said as unavailable with its message', () => {
  const st = buildFreedvStatus({ enabled: true, decoders: both, running: true, mode: '700D', error: 'boom' });
  assert.strictEqual(st.state, 'unavailable');
  assert.strictEqual(st.reason, 'boom');
});
t('throttle: state changes send now; sync/SNR at most every 250 ms; small SNR moves wait', () => {
  const a = buildFreedvStatus({ enabled: true, decoders: both, running: true, mode: '700D', sync: 0, snr: 2 });
  const b = { ...a, sync: true };
  assert.strictEqual(shouldSendStatus(null, a, 0, 0), true);
  assert.strictEqual(shouldSendStatus(a, b, 1000, 900), 'later');
  assert.strictEqual(shouldSendStatus(a, b, 1000 + THROTTLE_MS, 1000), true);
  assert.strictEqual(shouldSendStatus(a, { ...a, snr: 2.5 }, 5000, 0), false);
  assert.strictEqual(shouldSendStatus(a, { ...a, snr: 3.1 }, 5000, 0), true);
  assert.strictEqual(shouldSendStatus(a, { ...a, state: 'off' }, 1000, 999), true);
});

// --- speech level ---
const tone = (amp, n = 640) => Int16Array.from({ length: n }, (_, i) => Math.round(amp * 32767 * Math.sin(i / 3)));
t('quiet speech is brought up to about the SSB receive level', () => {
  const lv = createLeveller();
  let out;
  for (let i = 0; i < 40; i++) out = lv.process(tone(0.03));
  assert.ok(Math.abs(rmsOf(out) - TARGET_RMS) < 0.02, `rms ${rmsOf(out)}`);
});
t('loud speech is brought down, never clipped past full scale', () => {
  const lv = createLeveller();
  let out;
  for (let i = 0; i < 40; i++) out = lv.process(tone(0.9));
  assert.ok(Math.abs(rmsOf(out) - TARGET_RMS) < 0.03);
  assert.ok(out.every((v) => v <= 1 && v >= -1));
});
t('silence does not pump the noise floor up', () => {
  const lv = createLeveller();
  for (let i = 0; i < 20; i++) lv.process(tone(0.3));
  const before = lv.level;
  const out = lv.process(tone(0.0005));
  assert.strictEqual(lv.level, before);
  assert.ok(rmsOf(out) < 0.0005 * MAX_GAIN);
});

// --- wiring ---
const main = read('main.js');
t('one place builds the FreeDV engine', () => {
  assert.strictEqual((main.match(/new FreedvEngine\(\)/g) || []).length, 1);
  assert.ok(/function startFreedvEngine\(codecMode, why\)/.test(main));
  assert.ok(/function stopFreedvEngine\(why\)/.test(main));
});
t('decoded speech goes to this window and to the ECHOCAT audio window', () => {
  const start = main.slice(main.indexOf('function startFreedvEngine('), main.indexOf('function stopFreedvEngine('));
  assert.ok(start.includes("win.webContents.send('freedv-rx-speech', data)"));
  assert.ok(start.includes("remoteAudioWin.webContents.send('freedv-speech', { samples: data.samples, rate: data.rate || 8000 })"));
  assert.ok(start.includes("type: 'freedv-sync'"), 'freedv-sync kept for ECHOCAT Web');
  assert.ok(start.includes('_freedvAudioMuted = true'));
});
t('every stop unmutes ECHOCAT and says so in freedv-status', () => {
  const stop = main.slice(main.indexOf('function stopFreedvEngine('), main.indexOf('function freedvCodecFor('));
  assert.ok(stop.includes('_freedvAudioMuted = false'));
  assert.ok(stop.includes('pushFreedvStatus(true)'));
  assert.ok(/ipcMain\.on\('freedv-stop', \(\) => \{\n    stopFreedvEngine\(/.test(main));
  assert.ok(main.includes("stopFreedvEngine('tuned to a non-FreeDV mode')"));
});
t('ECHOCAT freedv-start starts FreeDV here; freedv-remote-start is gone', () => {
  assert.ok(main.includes("startFreedvEngine(freedvCodecFor(mode), 'from ECHOCAT')"));
  assert.ok(!main.includes('freedv-remote-start'));
  assert.ok(!main.includes('freedv-remote-stop'));
});
t('freedv-set-tx on is refused (FreeDV cannot transmit yet), with ptt-refused kind freedv', () => {
  const at = main.indexOf("remoteServer.on('freedv-set-tx'");
  const block = main.slice(at, at + 900);
  const refuse = block.indexOf('FreedvPtt.FREEDV_PTT_REFUSAL');
  assert.ok(refuse > 0);
  assert.ok(block.indexOf("type: 'ptt-refused', kind: 'freedv'") > refuse);
  assert.ok(block.indexOf('return;') > refuse);
  assert.ok(block.indexOf('gatedSetTransmit(true)') < 0 || block.indexOf('gatedSetTransmit(true)') > block.indexOf('return;'));
});
t('freedv-status after every auth-ok and on the settings toggle', () => {
  assert.ok(main.includes("remoteServer.sendToClient({ type: 'freedv-enabled', enabled: !!settings.enableFreedv });\n    pushFreedvStatus(true);"));
  assert.ok(main.includes("pushFreedvStatus(true); // ECHOCAT's FreeDV strip says on or off"));
});

const rs = read('lib/remote-server.js');
t('server reads freedv-set-tx as on or enabled; hello advertises freedv-remote-rx', () => {
  assert.ok(rs.includes("enabled: !!(msg.enabled ?? msg.on)"));
  assert.ok(rs.includes("'freedv-remote-rx',"));
});

const ra = read('renderer/remote-audio.html');
const pre = read('preload-remote-audio.js');
t('the audio window puts decoded speech on the sender and restores the radio after', () => {
  assert.ok(ra.includes('<script src="../lib/freedv-speech-level.js"></script>'));
  assert.ok(pre.includes("onFreedvSpeech: (cb) => ipcRenderer.on('freedv-speech'"));
  const on = ra.slice(ra.indexOf('window.api.onFreedvSpeech('));
  assert.ok(on.includes('audioSender.replaceTrack(track)'));
  assert.ok(on.includes('freedvLeveller.process(samples)'));
  const mute = ra.slice(ra.indexOf('window.api.onFreedvMute('), ra.indexOf('// --- Decoded FreeDV speech to the phone'));
  assert.ok(mute.includes('if (!muted) restoreFromFreedvTrack();'));
  assert.ok(ra.includes('if (freedvGain) freedvGain.gain.value = kiwiTxMuted ? 0 : g;'), 'RX Level applies');
  assert.ok(ra.includes('tearDownFreedvGraph();\n  tearDownLocalMixGraph();'), 'torn down on stop');
});
t('silence in FreeDV is not an audio-health fault', () => {
  const hm = ra.slice(ra.indexOf('function startHealthMonitor('), ra.indexOf('function stopHealthMonitor('));
  assert.ok(/if \(freedvMuted\) \{\n      _healthSilentCount = 0;\n      return;\n    \}/.test(hm));
});

t('protocol table: freedv-sync and freedv-status declared, set-tx on/enabled, squelch enabled/threshold', () => {
  const M = proto.MESSAGES;
  assert.strictEqual(M['freedv-sync'].dir, proto.Dir.S2C);
  assert.strictEqual(M['freedv-status'].dir, proto.Dir.S2C);
  for (const k of ['state', 'mode', 'modes', 'rx', 'tx', 'sync', 'snr', 'reason', 'reasonCode', 'callsign', 'callsignAt']) {
    assert.ok(M['freedv-status'].fields[k], `freedv-status.${k}`);
  }
  assert.ok(M['freedv-set-tx'].fields.on && M['freedv-set-tx'].fields.enabled);
  assert.ok(M['freedv-set-squelch'].fields.enabled && M['freedv-set-squelch'].fields.threshold);
  assert.ok(!M['freedv-set-squelch'].fields.level);
});

console.log(`freedv-echocat-test: ${passed} passed`);
