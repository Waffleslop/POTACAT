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
  // Voice said outright: the same hold and drop.
  assert.strictEqual(G.timing(true, 0, true), 'hold');
  assert.strictEqual(G.timing(true, 3000, true), 'drop');
});

test('voice TX holds and drops; FT8, CW, a tune play at once; unknown is voice (Casey, 2026-11-25)', () => {
  // Non-voice: no microphone on the air, the sound plays during the transmission.
  assert.strictEqual(G.timing(true, 0, false), 'play', 'FT8 / CW / tune: plays at once');
  assert.strictEqual(G.timing(true, 13000, false), 'play', 'a whole FT8 over later: still plays, never dropped');
  // Unknown (main said nothing about voice): held, the safe side.
  assert.strictEqual(G.timing(true, 0, undefined), 'hold');
  assert.strictEqual(G.timing(true, 0, null), 'hold');
  assert.strictEqual(G.timing(true, 0, 0), 'hold', 'only false itself lets a sound through');
});

test('voiceTx(): what is keying, and the mode, say whether a microphone is on the air', () => {
  // Voice: a voice key-down (PTT, macro, the phone, FreeDV), in a voice mode.
  for (const mode of ['USB', 'LSB', 'AM', 'FM', 'PKTUSB', '']) {
    assert.strictEqual(G.voiceTx({ mode, pttKind: 'voice' }), true, 'voice PTT in ' + (mode || 'no mode'));
  }
  // Unknown: the radio keyed by hand, a footswitch, TX POTACAT did not start: voice.
  assert.strictEqual(G.voiceTx({ mode: 'USB' }), true);
  assert.strictEqual(G.voiceTx({}), true);
  assert.strictEqual(G.voiceTx(null), true);
  assert.strictEqual(G.voiceTx({ mode: 'USB', pttKind: 'something-new' }), true, 'a kind this build does not know is voice');
  // Data mode alone is not proof: an Icom flips to USB-D for a voice PTT, and FreeDV runs in DIGU.
  assert.strictEqual(G.voiceTx({ mode: 'PKTUSB' }), true);
  assert.strictEqual(G.voiceTx({ mode: 'DIGU', pttKind: 'voice' }), true);
  // Not voice: JTCAT (every mode), CW text, a tune, a Winlink/Mercury modem.
  assert.strictEqual(G.voiceTx({ mode: 'USB', digital: true }), false, 'JTCAT keyed in USB');
  assert.strictEqual(G.voiceTx({ mode: 'USB', cw: true }), false);
  assert.strictEqual(G.voiceTx({ mode: 'USB', tune: true }), false);
  assert.strictEqual(G.voiceTx({ mode: 'PKTUSB', modem: true }), false);
  for (const k of ['ft8', 'ft4', 'ft2', 'js8', 'psk', 'jtty', 'wspr', 'sstv', 'winlink', 'tune', 'aprs2m', 'aprs30m']) {
    assert.strictEqual(G.voiceTx({ mode: 'USB', pttKind: k }), false, k);
  }
  // CW: no microphone on the air, whatever keyed it (a paddle, a hand key, a PTT).
  for (const mode of ['CW', 'CWR', 'CW-R', 'cw']) assert.strictEqual(G.voiceTx({ mode }), false, mode);
  assert.strictEqual(G.voiceTx({ mode: 'CW', pttKind: 'voice' }), false);
  // A voice key-down outranks a flag from another path: the safe side.
  assert.strictEqual(G.voiceTx({ mode: 'USB', pttKind: 'voice', digital: true }), true);
  // Every non-voice kind lib/tx-limit.js knows is not voice (one list of what keys the radio).
  const kinds = Object.keys(require('../lib/tx-limit').TX_LIMITS_MS).concat('wspr');
  for (const k of kinds) if (k !== 'voice') assert.strictEqual(G.voiceTx({ pttKind: k }), false, 'tx-limit kind ' + k);
});

test('JTCAT Run: the coin for a QSO logged as our RR73 goes out plays now, with the banner', () => {
  // main's answer during the RR73: transmitting, JTCAT keyed it (txKind ft8), rig in DATA-U.
  const voice = G.voiceTx({ mode: 'PKTUSB', pttKind: 'ft8', digital: true });
  assert.strictEqual(voice, false);
  const base = { chosenId: '', devices: [defaultIs(SPEAKERS), SPEAKERS, CODEC], txDevices: ['cdc1'] };
  const d = G.decide({ ...base, txActive: true, txVoice: voice, heldMs: 0 });
  assert.strictEqual(d.action, 'play');
  assert.strictEqual(d.sinkId, '', 'the speakers (the default)');
  // And still never on the radio's sound card, which is carrying the FT8 audio.
  const onCodec = G.decide({ chosenId: 'cdc1', devices: [defaultIs(CODEC), SPEAKERS, CODEC], txDevices: ['cdc1'], txActive: true, txVoice: false, heldMs: 0 });
  assert.strictEqual(onCodec.action, 'play');
  assert.strictEqual(onCodec.sinkId, 'spk1', 'moved off the radio');
  const onlyCodec = G.decide({ chosenId: '', devices: [defaultIs(CODEC), CODEC], txDevices: ['cdc1'], txActive: true, txVoice: false });
  assert.strictEqual(onlyCodec.action, 'silent', 'no other output: nothing plays, transmitting or not');
});

test('decide(): one answer for "may this sound play now, and where"', () => {
  const base = { chosenId: '', devices: [defaultIs(CODEC), SPEAKERS, CODEC], txDevices: ['cdc1'] };
  assert.deepStrictEqual(G.decide({ ...base, txActive: true, heldMs: 0 }), { action: 'hold' });
  assert.deepStrictEqual(G.decide({ ...base, txActive: true, heldMs: 3100 }), { action: 'drop', reason: 'transmitting' });
  const play = G.decide({ ...base, txActive: false, heldMs: 0 });
  assert.deepStrictEqual({ action: play.action, sinkId: play.sinkId, why: play.why }, { action: 'play', sinkId: 'spk1', why: 'moved' });
  const silent = G.decide({ chosenId: '', devices: [defaultIs(CODEC), CODEC], txDevices: ['cdc1'], txActive: false });
  assert.deepStrictEqual({ action: silent.action, reason: silent.reason }, { action: 'silent', reason: 'no-other-output' });
  // Transmitting voice wins over everything: nothing is even routed.
  assert.deepStrictEqual(G.decide({ chosenId: '', devices: [defaultIs(CODEC), CODEC], txDevices: ['cdc1'], txActive: true, heldMs: 10 }), { action: 'hold' });
  assert.deepStrictEqual(G.decide({ ...base, txActive: true, txVoice: true, heldMs: 0 }), { action: 'hold' });
  assert.deepStrictEqual(G.decide({ ...base, txActive: true, txVoice: true, heldMs: 3100 }), { action: 'drop', reason: 'transmitting' });
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

test('a held sound waits for the unkey and is dropped by the guard\'s own limit; a playing sound is cut when voice TX starts', () => {
  assert.ok(/d\.action === 'hold'/.test(sounds) && /SoundGuard\.HOLD_POLL_MS/.test(sounds));
  assert.ok(/d\.action === 'drop'/.test(sounds));
  assert.ok(/txActive: st\.tx, txVoice: st\.voice/.test(sounds), 'the guard is told whether the TX is voice');
  assert.ok(/voice: !\(st && st\.voice === false\)/.test(sounds), 'only main\'s explicit false is "not voice"');
  assert.ok(/catch \{ return \{ tx: true, voice: true, txDevices: \[\] \}; \}/.test(sounds), 'main unreachable: transmitting voice');
  assert.ok(/function cutAll\(/.test(sounds));
  assert.ok(/const voiceOn = \(st\) => !!\(st && st\.tx && st\.voice\);/.test(sounds));
  assert.ok(/window\.api\.onRemoteTxState\(\(on\) => \{ if \(on && live\.size\) txState\(\)\.then\(\(st\) => \{ if \(voiceOn\(st\)\) cutAll\(\); \}\); \}\)/.test(sounds), 'the TX state push cuts a voice TX');
  assert.ok(/if \(voiceOn\(await txState\(\)\)\) cutAll\(\)/.test(sounds), 'and the watch while a sound plays catches every other voice TX');
  assert.ok(!/if \(tx\) cutAll\(\)/.test(sounds), 'FT8, CW or a tune no longer cuts a sound');
});

test('main answers with every kind of transmission it knows: PTT, CW, JTCAT, FreeDV and tune', () => {
  const i = main.indexOf('function soundTxActive()');
  assert.ok(i > 0);
  const body = main.slice(i, main.indexOf('\n}\n', i));
  for (const part of ['_isEffectivelyTransmitting()', 'rigPresetTransmitting()', 'jtcatAnyTxActive()', '_jtcatTuneTxActive', '_atuSweeping', '_atuTuneEpisode']) {
    assert.ok(body.includes(part), part);
  }
  assert.ok(/ipcMain\.handle\('sound-tx-state', \(\) => soundTxState\(\)\);/.test(main));
  const si = main.indexOf('function soundTxState()');
  const st = main.slice(si, main.indexOf('\n}\n', si));
  assert.ok(/return \{ tx, voice: tx \? soundTxVoice\(\) : false, txDevices: soundTxDevices\(\) \};/.test(st));
  assert.ok(/soundTxState: \(\) => ipcRenderer\.invoke\('sound-tx-state'\)/.test(preload));
  // Reading the state is all it does: nothing in the handler keys or sets the radio.
  assert.ok(!/handleRemotePtt|sendCat|tuneRadio|setMode|write\(/.test(body));
});

test('main says whether the TX is voice from what is keying and the mode (SoundGuard.voiceTx)', () => {
  const i = main.indexOf('function soundTxVoice()');
  assert.ok(i > 0);
  const body = main.slice(i, main.indexOf('\n}\n', i));
  assert.ok(/SoundGuard\.voiceTx\(\{/.test(body));
  assert.ok(/require\('\.\/lib\/sound-guard'\)/.test(main));
  for (const part of ['mode: _currentMode', '_txLimit.armed', "kind === 'voice' || _remoteTxState", 'digital: jtcatAnyTxActive()', '_cwTxLockoutUntilMs',
    '_jtcatTuneTxActive', '_atuSweeping', '_atuTuneEpisode', '_externalAtuActive', 'mercuryTxActive', "radioOwner === 'winlink'"]) {
    assert.ok(body.includes(part), part);
  }
  assert.ok(!/handleRemotePtt|sendCat|tuneRadio|setMode|write\(|\.arm\(|disarm\(/.test(body), 'read only');
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

test('the Sounds pane says the rule plainly: never while you talk on the air, never through the radio', () => {
  const lines = [...html.matchAll(/<span class="help-text sounds-help">([^<]*)<\/span>/g)].map((x) => x[1]);
  const t = lines.find((l) => /unkey/.test(l));
  assert.ok(t, 'the help line under Sound output');
  assert.ok(!lines.some((l) => /No sound plays while you transmit\./.test(l)), 'the old blanket rule is gone');
  assert.ok(/talk on the air \(SSB, AM, FM, FreeDV\)/.test(t), 'voice is named');
  assert.ok(/FT8, CW/.test(t) && /play at once/.test(t), 'data modes and CW play at once');
  assert.ok(/never plays through the radio's sound card/.test(t), 'the where rule');
  assert.ok(!/No sound plays while you transmit\./.test(t), 'the old blanket rule is gone');
});

test('nothing in the feature transmits or changes the radio', () => {
  for (const [name, src] of [['renderer/sounds.js', sounds], ['lib/sound-guard.js', readSrc(path.join(root, 'lib', 'sound-guard.js'))], ['lib/qso-sounds.js', readSrc(path.join(root, 'lib', 'qso-sounds.js'))]]) {
    assert.ok(!/\b(ptt|tune|setFrequency|setMode|rigControl|catCommand|sendCw)\s*\(/i.test(src), name + ' calls no radio control');
  }
  assert.ok(!/window\.api\.(?!soundTxState|onRemoteTxState|getSettings|saveSettings|jtcatLog)\w+/.test(sounds), 'sounds.js uses only the TX state, the settings and the log');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
