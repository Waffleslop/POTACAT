#!/usr/bin/env node
'use strict';
// The transmit guard (#1041): no POTACAT sound reaches the transmitter.
// lib/sound-guard.js decides where a sound may play (never the radio's sound
// card) and when (never while transmitting; held up to 3 s, then dropped).
// The second half pins that renderer/sounds.js asks it before every play and
// that every sound in the main window goes through that one door.
// Run: node test/sound-guard-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const G = require('../lib/sound-guard');

const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// What Windows lists: a role entry for the default, then each device.
const out = (deviceId, label, groupId) => ({ kind: 'audiooutput', deviceId, label, groupId });
const SPEAKERS = out('spk1', 'Speakers (Realtek(R) Audio)', 'g-realtek');
const HEADSET = out('hs1', 'Headphones (Arctis 7)', 'g-arctis');
const CODEC = out('cdc1', 'Speakers (USB Audio CODEC )', 'g-codec');
const SIGNALINK = out('sl1', 'Speakers (SignaLink USB)', 'g-sl'); // a radio interface with no tell-tale name
const defaultIs = (d) => out('default', 'Default - ' + d.label, d.groupId);
const commsIs = (d) => out('communications', 'Communications - ' + d.label, d.groupId);
const MIC = { kind: 'audioinput', deviceId: 'mic1', label: 'Microphone (USB Audio CODEC )', groupId: 'g-codec' };

console.log('Transmit guard: where');

test('Automatic, default is the speakers: plays on the system default', () => {
  const r = G.resolveOutput({ chosenId: '', devices: [defaultIs(SPEAKERS), SPEAKERS, CODEC, MIC], txDevices: ['cdc1'] });
  assert.deepStrictEqual({ ok: r.ok, sinkId: r.sinkId, why: r.why }, { ok: true, sinkId: '', why: 'default' });
});

test('default = codec: Automatic moves the sound to another output', () => {
  const r = G.resolveOutput({ chosenId: '', devices: [defaultIs(CODEC), SPEAKERS, CODEC], txDevices: ['cdc1'] });
  assert.deepStrictEqual({ ok: r.ok, sinkId: r.sinkId, why: r.why }, { ok: true, sinkId: 'spk1', why: 'moved' });
});

test('default = the TX device by hardware group, whatever its name (compared by groupId, not deviceId)', () => {
  const r = G.resolveOutput({ chosenId: '', devices: [defaultIs(SIGNALINK), SIGNALINK, HEADSET], txDevices: ['sl1'] });
  assert.strictEqual(r.sinkId, 'hs1');
  assert.strictEqual(r.why, 'moved');
});

test('default = the TX device by name when the list gives no groups', () => {
  const noGroup = (d) => ({ ...d, groupId: '' });
  const r = G.resolveOutput({ chosenId: '', devices: [noGroup(defaultIs(SIGNALINK)), noGroup(SIGNALINK), noGroup(HEADSET)], txDevices: ['sl1'] });
  assert.strictEqual(r.sinkId, 'hs1');
});

test('the TX device named only by its saved label (its id is gone from the list) still counts', () => {
  const r = G.resolveOutput({ chosenId: '', devices: [defaultIs(SIGNALINK), SIGNALINK, HEADSET], txDevices: [{ deviceId: 'old-id', label: 'Speakers (SignaLink USB)' }] });
  assert.strictEqual(r.sinkId, 'hs1');
});

test('no TX device set in POTACAT: a "USB Audio CODEC" default is still the radio\'s sound card', () => {
  const r = G.resolveOutput({ chosenId: '', devices: [defaultIs(CODEC), CODEC, SPEAKERS], txDevices: [] });
  assert.strictEqual(r.sinkId, 'spk1');
  assert.strictEqual(r.why, 'moved');
});

test('chosen device = codec: Automatic decides instead (never the radio)', () => {
  const r = G.resolveOutput({ chosenId: 'cdc1', devices: [defaultIs(SPEAKERS), SPEAKERS, CODEC], txDevices: ['cdc1'] });
  assert.deepStrictEqual({ ok: r.ok, sinkId: r.sinkId, why: r.why }, { ok: true, sinkId: '', why: 'moved' });
  // The operator made their sound output the TX device afterwards: the same.
  const r2 = G.resolveOutput({ chosenId: 'hs1', devices: [defaultIs(SPEAKERS), SPEAKERS, HEADSET], txDevices: ['hs1'] });
  assert.deepStrictEqual({ sinkId: r2.sinkId, why: r2.why }, { sinkId: '', why: 'moved' });
});

test('a chosen output that is not the radio\'s is used, and found again by name when its id changed', () => {
  const devices = [defaultIs(SPEAKERS), SPEAKERS, HEADSET, CODEC];
  const r = G.resolveOutput({ chosenId: 'hs1', devices, txDevices: ['cdc1'] });
  assert.deepStrictEqual({ sinkId: r.sinkId, why: r.why }, { sinkId: 'hs1', why: 'chosen' });
  const r2 = G.resolveOutput({ chosenId: 'hs-old', chosenLabel: 'Headphones (Arctis 7)', devices, txDevices: ['cdc1'] });
  assert.strictEqual(r2.sinkId, 'hs1');
});

test('a chosen output that is unplugged: Automatic', () => {
  const r = G.resolveOutput({ chosenId: 'hs1', chosenLabel: 'Headphones (Arctis 7)', devices: [defaultIs(SPEAKERS), SPEAKERS, CODEC], txDevices: ['cdc1'] });
  assert.deepStrictEqual({ sinkId: r.sinkId, why: r.why }, { sinkId: '', why: 'default' });
});

test('no other device: silent, with the line the Sounds pane shows', () => {
  const r = G.resolveOutput({ chosenId: '', devices: [defaultIs(CODEC), commsIs(CODEC), CODEC, MIC], txDevices: ['cdc1'] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-other-output');
  assert.strictEqual(r.text, G.NO_OUTPUT_TEXT);
  assert.ok(/never plays a sound into the radio/.test(r.text));
  // Chosen = the codec and nothing else: silent too.
  assert.strictEqual(G.resolveOutput({ chosenId: 'cdc1', devices: [defaultIs(CODEC), CODEC], txDevices: [] }).ok, false);
});

test('a default that names no hardware (Linux "Default") with a radio sound card in the list: a named output, or silence', () => {
  const bare = out('default', 'Default', '');
  const r = G.resolveOutput({ chosenId: '', devices: [bare, CODEC, SPEAKERS], txDevices: ['cdc1'] });
  assert.strictEqual(r.sinkId, 'spk1');
  assert.strictEqual(G.resolveOutput({ chosenId: '', devices: [bare, CODEC], txDevices: ['cdc1'] }).ok, false);
  // No radio sound card anywhere: the default is fine.
  assert.strictEqual(G.resolveOutput({ chosenId: '', devices: [bare, SPEAKERS], txDevices: [] }).sinkId, '');
});

test('the list for "Sound output" leaves out the radio\'s sound card and the role entries', () => {
  const list = G.listOutputs([defaultIs(SPEAKERS), commsIs(HEADSET), SPEAKERS, HEADSET, CODEC, SIGNALINK, MIC], ['sl1']);
  assert.deepStrictEqual(list.map((d) => d.deviceId), ['spk1', 'hs1']);
});

test('what became of the chosen output: listed, the radio\'s now, or not connected (kept as the choice)', () => {
  const devices = [defaultIs(SPEAKERS), SPEAKERS, HEADSET, CODEC];
  assert.strictEqual(G.chosenState({ chosenId: '', devices, txDevices: ['cdc1'] }), '');
  assert.strictEqual(G.chosenState({ chosenId: 'hs1', devices, txDevices: ['cdc1'] }), 'listed');
  assert.strictEqual(G.chosenState({ chosenId: 'hs-old', chosenLabel: 'Headphones (Arctis 7)', devices, txDevices: ['cdc1'] }), 'listed');
  assert.strictEqual(G.chosenState({ chosenId: 'cdc1', devices, txDevices: ['cdc1'] }), 'radio');
  assert.strictEqual(G.chosenState({ chosenId: 'hs1', devices, txDevices: ['hs1'] }), 'radio');
  assert.strictEqual(G.chosenState({ chosenId: 'gone', chosenLabel: 'Speakers (Dock)', devices, txDevices: ['cdc1'] }), 'missing');
  // Not connected: Automatic plays meanwhile, and never on the radio.
  const r = G.resolveOutput({ chosenId: 'gone', chosenLabel: 'Speakers (Dock)', devices: [defaultIs(CODEC), CODEC, SPEAKERS], txDevices: ['cdc1'] });
  assert.strictEqual(r.sinkId, 'spk1');
});

console.log('Transmit guard: when');

test('TX active: the sound is held, and dropped once it has waited 3 s', () => {
  assert.strictEqual(G.HOLD_MAX_MS, 3000);
  assert.strictEqual(G.timing(false, 0), 'play');
  assert.strictEqual(G.timing(true, 0), 'hold');
  assert.strictEqual(G.timing(true, 2999), 'hold');
  assert.strictEqual(G.timing(true, 3000), 'drop');
  assert.strictEqual(G.timing(false, 2500), 'play', 'unkeyed inside 3 s: it plays');
});

test('decide(): one answer for "may this sound play now, and where"', () => {
  const base = { chosenId: '', devices: [defaultIs(CODEC), SPEAKERS, CODEC], txDevices: ['cdc1'] };
  assert.deepStrictEqual(G.decide({ ...base, txActive: true, heldMs: 0 }), { action: 'hold' });
  assert.deepStrictEqual(G.decide({ ...base, txActive: true, heldMs: 3100 }), { action: 'drop', reason: 'transmitting' });
  const play = G.decide({ ...base, txActive: false, heldMs: 0 });
  assert.deepStrictEqual({ action: play.action, sinkId: play.sinkId, why: play.why }, { action: 'play', sinkId: 'spk1', why: 'moved' });
  const silent = G.decide({ chosenId: '', devices: [defaultIs(CODEC), CODEC], txDevices: ['cdc1'], txActive: false });
  assert.deepStrictEqual({ action: silent.action, reason: silent.reason }, { action: 'silent', reason: 'no-other-output' });
  // Transmitting wins over everything: nothing is even routed.
  assert.deepStrictEqual(G.decide({ chosenId: '', devices: [defaultIs(CODEC), CODEC], txDevices: ['cdc1'], txActive: true, heldMs: 10 }), { action: 'hold' });
});

console.log('Transmit guard: the glue');

const sounds = readSrc(path.join(root, 'renderer', 'sounds.js'));
const app = readSrc(path.join(root, 'renderer', 'app.js'));
const main = readSrc(path.join(root, 'main.js'));
const preload = readSrc(path.join(root, 'preload.js'));
const html = readSrc(path.join(root, 'renderer', 'index.html'));

test('renderer/sounds.js asks the guard before every play, with the live device list, the TX devices and the TX state', () => {
  assert.ok(/SoundGuard\.decide\(\{/.test(sounds));
  assert.ok(/navigator\.mediaDevices\.enumerateDevices\(\)/.test(sounds));
  assert.ok(/addEventListener\('devicechange', \(\) => \{ deviceList = null; \}\)/.test(sounds), 'the list is read again when a device comes or goes');
  assert.ok(/window\.api\.soundTxState\(\)/.test(sounds));
  const play = sounds.slice(sounds.indexOf('async function start('), sounds.indexOf('// --- end of start'));
  assert.ok(play.indexOf('SoundGuard.decide(') >= 0 && play.indexOf('SoundGuard.decide(') < play.indexOf('await draw(ctx, out)'), 'the decision comes before the source starts');
  assert.ok(/setSinkId\(/.test(sounds), 'the sound context is given its output');
  assert.ok(!/audioCtx\b/.test(sounds), 'its own context, never the shared default-output one');
});

test('a held sound waits for the unkey and is dropped by the guard\'s own limit; a playing sound is cut when TX starts', () => {
  assert.ok(/d\.action === 'hold'/.test(sounds) && /SoundGuard\.HOLD_POLL_MS/.test(sounds));
  assert.ok(/d\.action === 'drop'/.test(sounds));
  assert.ok(/function cutAll\(/.test(sounds));
  assert.ok(/window\.api\.onRemoteTxState\(\(on\) => \{ if \(on\) cutAll\(\); \}\)/.test(sounds), 'the TX state push cuts at once');
  assert.ok(/if \(tx\) cutAll\(\)/.test(sounds), 'and the watch while a sound plays catches every other kind of TX');
});

test('main answers with every kind of transmission it knows: PTT, CW, JTCAT, FreeDV and tune', () => {
  const i = main.indexOf('function soundTxActive()');
  assert.ok(i > 0);
  const body = main.slice(i, main.indexOf('\n}\n', i));
  for (const part of ['_isEffectivelyTransmitting()', 'rigPresetTransmitting()', 'jtcatAnyTxActive()', '_jtcatTuneTxActive', '_atuSweeping', '_atuTuneEpisode']) {
    assert.ok(body.includes(part), part);
  }
  assert.ok(/ipcMain\.handle\('sound-tx-state', \(\) => \(\{ tx: soundTxActive\(\), txDevices: soundTxDevices\(\) \}\)\)/.test(main));
  assert.ok(/soundTxState: \(\) => ipcRenderer\.invoke\('sound-tx-state'\)/.test(preload));
  // Reading the state is all it does: nothing in the handler keys or sets the radio.
  assert.ok(!/handleRemotePtt|sendCat|tuneRadio|setMode|write\(/.test(body));
});

test('every sound the main window makes for a contact goes through PotacatSounds (no way round the guard)', () => {
  const chime = app.slice(app.indexOf('function playQsoChime('), app.indexOf('// --- Tune confirmation click ---'));
  assert.ok(!/audioCtx\.destination/.test(chime), 'the QSO chime no longer plays on the default output');
  assert.ok(!/new AudioContext\(/.test(chime));
  assert.ok(/PotacatSounds\.playChime\(/.test(chime));
  assert.ok(/PotacatSounds\.playFile\(/.test(chime));
  assert.ok(/PotacatSounds\.preview\(QsoSounds\.previewSound\(key\), using\)/.test(app), 'the Play and Hear buttons take the same road');
  assert.ok(html.indexOf('<script src="../lib/sound-guard.js"></script>') < html.indexOf('<script src="sounds.js"></script>'));
  assert.ok(html.indexOf('<script src="sounds.js"></script>') < html.indexOf('<script src="app.js"></script>'));
});

test('nothing in the feature transmits or changes the radio', () => {
  for (const [name, src] of [['renderer/sounds.js', sounds], ['lib/sound-guard.js', readSrc(path.join(root, 'lib', 'sound-guard.js'))], ['lib/qso-sounds.js', readSrc(path.join(root, 'lib', 'qso-sounds.js'))]]) {
    assert.ok(!/\b(ptt|tune|setFrequency|setMode|rigControl|catCommand|sendCw)\s*\(/i.test(src), name + ' calls no radio control');
  }
  assert.ok(!/window\.api\.(?!soundTxState|onRemoteTxState|getSettings|saveSettings|jtcatLog)\w+/.test(sounds), 'sounds.js uses only the TX state, the settings and the log');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
