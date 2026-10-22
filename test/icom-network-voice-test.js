// IC-9700 over Icom Network (KG5EIU, 2026-10-22): a desktop PTT played the
// Mac's mic on the Mac's speakers ("massive feedback"), the speaker button
// opened the mic instead of the radio's LAN audio, the phone's PTT opened
// the RS-BA1 voice stream and fed it nothing, FM voice keyed in USB-D, and
// band clicks never moved the radio (MAIN cannot take the band SUB is on).
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { CivCodec } = require('../lib/codecs/civ-codec');
const { RIG_MODELS } = require('../lib/rig-models');
const { StreamingResampler } = require('../lib/mercury-audio-bridge');

let passed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log(`  ok - ${name}`); });
}
const hex = (b) => Buffer.from(b).toString('hex');
const frame = (from, cmd, ...data) => Buffer.from([0xFE, 0xFE, 0xE0, from, cmd, ...data, 0xFD]);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function codecFor(model) {
  const sent = [];
  const logs = [];
  const c = new CivCodec(model, (buf) => sent.push(hex(buf)));
  c.on('log', (m) => logs.push(m));
  c.on('error', () => {});
  return { c, sent, logs };
}

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');

(async () => {
  console.log('civ-codec');

  await t('FM voice keys in FM-D: mode 05 with DATA1, never USB', () => {
    const { c, sent } = codecFor(RIG_MODELS['IC-9700']);
    c.setMode('DIGFM', 145500000);
    assert.ok(sent[0].startsWith('fefea2e00605'), `mode frame ${sent[0]}`);
    assert.ok(/^fefea2e01a0601/.test(sent[1]), `data frame ${sent[1]}`);
    c.setMode('DIGAM', 7200000);
    assert.ok(sent[2].startsWith('fefea2e00602'));
  });

  await t('IC-9700: a NAK on a band change swaps MAIN and SUB and sends the frequency again', async () => {
    const { c, sent, logs } = codecFor(RIG_MODELS['IC-9700']);
    c.setFrequency(432100000);
    const setFreq = sent[0];
    c.onData(frame(0xA2, 0xFA));
    assert.strictEqual(sent[1], 'fefea2e007b0fd', 'exchange MAIN/SUB');
    await wait(200);
    assert.strictEqual(sent[2], setFreq, 'the same frequency, once more');
    assert.ok(logs.some(l => /SUB receiver is on that band/.test(l)));
    c.onData(frame(0xA2, 0xFA));
    assert.strictEqual(sent.length, 3, 'one swap only — never a loop');
    assert.ok(logs.some(l => /even after swapping/.test(l)));
  });

  await t('an ACK clears the pending set; a later NAK is not a band refusal', async () => {
    const { c, sent } = codecFor(RIG_MODELS['IC-9700']);
    c.setFrequency(144174000);
    c.onData(frame(0xA2, 0xFB));
    c.onData(frame(0xA2, 0xFA));
    await wait(200);
    assert.strictEqual(sent.length, 1);
  });

  await t('a radio without MAIN/SUB bands never swaps', async () => {
    const { c, sent } = codecFor(RIG_MODELS['IC-7300']);
    c.setFrequency(14074000);
    c.onData(frame(0x94, 0xFA));
    await wait(200);
    assert.strictEqual(sent.length, 1);
  });

  console.log('mic resampling');
  await t('24 kHz mic chunks become the radio\'s 48 kHz with no gap at chunk edges', () => {
    const r = new StreamingResampler(24000, 48000);
    let n = 0;
    for (let i = 0; i < 188; i++) n += r.process(new Float32Array(128).fill(0.5)).length;
    assert.ok(Math.abs(n - 48128) < 4, `one second → ${n} samples`);
  });

  console.log('wiring (source guards)');
  const main = read('main.js');
  const vfo = read('renderer/vfo-popout.html');

  await t('the VFO window PTT streams the mic over RS-BA1 and keys in DATA mode', () => {
    const naked = main.slice(main.indexOf("ipcMain.on('naked-ptt'"), main.indexOf("ipcMain.on('naked-ptt'") + 400);
    assert.ok(/icomNetworkVoiceTx\(!!state, 'VFO window PTT'\)/.test(naked));
    assert.ok(/forceDataMode: true/.test(naked));
  });

  await t('the phone PTT uses the same helper', () => {
    assert.ok(/icomNetworkVoiceTx\(state, 'ECHOCAT phone PTT'\)/.test(main));
  });

  await t('mic chunks reach the radio: dax-tx-chunk feeds RS-BA1 before the SmartSDR gate', () => {
    const h = main.slice(main.indexOf("ipcMain.on('dax-tx-chunk'"));
    const icom = h.indexOf('pushIcomNetworkVoiceChunk(mic)');
    const flex = h.indexOf('if (!smartSdrAudio || !smartSdrAudio.txReady) return;');
    assert.ok(icom > 0 && icom < flex);
    assert.ok(!/rsba1-voice-tx-chunk/.test(main), 'the channel nothing ever sent is gone');
  });

  await t('the ECHOCAT bridge uses the direct mic tap on Icom Network', () => {
    const cfg = main.slice(main.indexOf('function _buildAudioBridgeConfig'), main.indexOf('function _buildAudioBridgeConfig') + 900);
    assert.ok(/audioSource === 'icom-network' && !!\(_icomNetworkTransport/.test(cfg));
  });

  await t('the VFO window never plays its mic on Icom Network, and its speaker plays the radio', () => {
    assert.ok(/\(s\.audioSource === 'icom-network'\);/.test(vfo), 'PTT takes the direct branch');
    assert.ok(/s\.audioSource === 'smartsdr' \|\| s\.audioSource === 'icom-network'/.test(vfo), 'monitor plays packets');
    assert.ok(/if \(pttDown\) return; \/\/ never play the radio back/.test(vfo));
  });

  await t('FM goes to FM-D on an Icom in the SSB-over-DATA switch', () => {
    assert.ok(/_icomData && curMode === 'FM'\) \? 'DIGFM'/.test(main));
  });

  console.log(`\n${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
