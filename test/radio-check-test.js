#!/usr/bin/env node
'use strict';
// The first run's radio check (lib/radio-check.js): Station Setup's control
// and hearing steps, inline, with only the buttons that read or listen.
// Run: node test/radio-check-test.js
const assert = require('assert');
const RC = require('../lib/radio-check');
const SS = require('../lib/station-setup');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n    ' + (e && e.stack || e)); }
}
console.log('Radio check: two Station Setup steps, nothing transmits');

const TX_ACTIONS = ['tx-test', 'tx-test-current-power', 'tune-tone', 'voice-test', 'tx-test-confirm', 'tx-device-test', 'ptt-flow-fix'];

function payload(live, rig) {
  return SS.evaluateChecklist({
    rig: { id: 'r1', name: 'IC-7300', model: 'IC-7300', radioType: 'icom', active: true, audioSource: 'dax', inputDeviceId: '', outputDeviceId: '', ...(rig || {}) },
    modelInfo: { brand: 'Icom', maxPower: 100 },
    platform: 'win32',
    notes: [{ id: 'icom-civ-address', level: 'recommended', feature: 'CAT', title: 'Leave the CI-V address at 94h', steps: ['On the radio: MENU > SET > Connectors > CI-V > CI-V Address > 94h.'], why: 'x' }],
    live: { callsign: 'K1ABC', grid: 'FN20', ...(live || {}) },
    prefs: {},
  });
}

t('the actions it may run read or listen; none transmits', () => {
  assert.deepStrictEqual(RC.ACTIONS, ['recheck', 'rx-test', 'open-rig-editor']);
  for (const a of TX_ACTIONS) assert.ok(!RC.ACTIONS.includes(a), a);
});

t('only "POTACAT can control your radio" and "Hearing the radio", in that order', () => {
  const full = payload({ catConnected: true, freqHz: 14074000, rxTest: { result: 'ok', dbfs: -30 } }, { inputDeviceId: 'in1', outputDeviceId: 'out1' });
  assert.ok(full.steps.some((s) => s.id === 'tx-test'), 'Station Setup has the transmit steps');
  const v = RC.inlineSteps(full);
  assert.deepStrictEqual(v.steps.map((s) => s.id), ['radio-control', 'rx-audio']);
  assert.deepStrictEqual(v.steps.map((s) => s.title), ['POTACAT can control your radio', 'Hearing the radio']);
  assert.ok(v.passed && v.controlOk && v.hearingOk);
  assert.ok(/14\.074 MHz/.test(v.steps[0].detail), 'live frequency read-back');
  assert.strictEqual(RC.outcome(full), 'passed');
});

t('a radio that does not answer: Station Setup\'s instructions and the radio\'s CAT note, Check again, back to which radio', () => {
  const v = RC.inlineSteps(payload({ catConnected: false, catError: 'No response from radio' }));
  const c = v.steps[0];
  assert.strictEqual(c.state, 'needs');
  assert.ok(/No response from radio/.test(c.detail));
  assert.ok(c.instructions.some((b) => /switched on/.test((b.steps || []).join(' '))));
  assert.ok(c.instructions.some((b) => b.noteId === 'icom-civ-address'), 'the usual cause for this radio, from the rig notes');
  assert.deepStrictEqual(c.actions, [{ id: 'recheck', label: 'Check again' }, { id: 'open-rig-editor', label: 'Change the radio settings' }]);
  assert.strictEqual(RC.outcome(payload({ catConnected: false })), 'failed');
});

t('hearing the radio: no input yet, then the 3-second listen', () => {
  const none = RC.inlineSteps(payload({ catConnected: true })).steps[1];
  assert.strictEqual(none.state, 'needs');
  assert.ok(/No audio input/.test(none.detail));
  const unknown = RC.inlineSteps(payload({ catConnected: true }, { inputDeviceId: 'in1' })).steps[1];
  assert.deepStrictEqual(unknown.actions, [{ id: 'rx-test', label: 'Listen for 3 seconds' }]);
  const silent = RC.inlineSteps(payload({ catConnected: true, rxTest: { result: 'silent', dbfs: -100 } }, { inputDeviceId: 'in1' })).steps[1];
  assert.strictEqual(silent.state, 'needs');
  assert.ok(silent.actions.every((a) => RC.ACTIONS.includes(a.id)));
});

t('whatever Station Setup offers, a transmit action never reaches the inline check', () => {
  const fake = { steps: [
    { id: 'radio-control', title: 'c', state: 'needs', actions: [{ id: 'recheck', label: 'Check again' }, { id: 'tx-test', label: 'Transmit' }, { id: 'ptt-flow-fix', label: 'Fix' }] },
    { id: 'rx-audio', title: 'h', state: 'unknown', actions: [{ id: 'tune-tone', label: 'Tone' }, { id: 'rx-test', label: 'Listen' }] },
    { id: 'tx-test', title: 't', state: 'unknown', actions: [{ id: 'tx-test', label: 'Transmit' }] },
  ] };
  const v = RC.inlineSteps(fake);
  const ids = v.steps.flatMap((s) => s.actions.map((a) => a.id));
  assert.deepStrictEqual(ids, ['recheck', 'rx-test']);
  assert.deepStrictEqual(RC.inlineSteps(null), { steps: [], controlOk: false, hearingOk: false, passed: false });
});

t('Flex, Icom Network, Yaesu LAN, TCI: the sound comes over the radio\'s link, no input to choose', () => {
  for (const s of ['smartsdr', 'icom-network', 'yaesu-lan', 'tci']) assert.ok(RC.audioIsNetwork(s), s);
  assert.ok(!RC.audioIsNetwork('dax'));
  const v = RC.inlineSteps(payload({ catConnected: true }, { audioSource: 'smartsdr', radioType: 'flex' }));
  assert.strictEqual(v.steps[1].state, 'ok');
});

t('the sound input offered: the radio\'s own by name, or none', () => {
  const dev = (kind, id, label) => ({ kind, deviceId: id, label });
  const pc = [
    dev('audioinput', 'default', 'Default - Microphone (Realtek Audio)'),
    dev('audioinput', 'mic', 'Microphone Array (Realtek Audio)'),
    dev('audioinput', 'cam', 'Microphone (HD Webcam)'),
    dev('audioinput', 'codec', 'Microphone (USB Audio CODEC )'),
    dev('audiooutput', 'spk', 'Speakers (Realtek Audio)'),
    dev('audiooutput', 'codec-out', 'Speakers (USB Audio CODEC )'),
  ];
  assert.strictEqual(RC.suggestInput(pc, 'IC-7300', 'Icom'), 'codec');
  assert.strictEqual(RC.matchingOutput(pc, 'codec'), 'codec-out', 'the same sound card\'s output');
  assert.strictEqual(RC.suggestInput([dev('audioinput', 'a', 'Microphone (2- IC-7300)'), dev('audioinput', 'b', 'Microphone (USB Audio CODEC)')], 'IC-7300', 'Icom'), 'a', 'the model in the name counts most');
  assert.strictEqual(RC.suggestInput([dev('audioinput', 'a', 'Microphone (USB Audio CODEC)'), dev('audioinput', 'b', 'Microphone (2- USB Audio CODEC)')], 'FT-710', 'Yaesu'), '', 'two alike: no guess');
  assert.strictEqual(RC.suggestInput(pc.slice(0, 3), 'IC-7300', 'Icom'), '', 'only the computer\'s own: none');
  assert.strictEqual(RC.suggestInput([], 'IC-7300', 'Icom'), '');
  assert.strictEqual(RC.matchingOutput(pc, 'nope'), '', 'no such input: no output');
  assert.strictEqual(RC.matchingOutput([dev('audioinput', 'a', 'Microphone (USB Audio CODEC)'), dev('audiooutput', 'o1', 'Speakers (USB Audio CODEC)'), dev('audiooutput', 'o2', 'Speakers (2- USB Audio CODEC)')], 'a'), '', 'two outputs alike: no guess');
});

t('the chosen input is saved on the radio and the global copy; an empty output gets its twin', () => {
  const rigs = [{ id: 'r0', remoteAudioInput: 'x' }, { id: 'r1', remoteAudioInput: '', remoteAudioOutput: '' }];
  const p = RC.audioPatch(rigs, 'r1', 'codec', 'codec-out');
  assert.deepStrictEqual(p.rigs[1], { id: 'r1', remoteAudioInput: 'codec', remoteAudioOutput: 'codec-out' });
  assert.deepStrictEqual(p.rigs[0], rigs[0]);
  assert.strictEqual(rigs[1].remoteAudioInput, '', 'the list passed in is not changed');
  assert.deepStrictEqual([p.remoteAudioInput, p.remoteAudioOutput], ['codec', 'codec-out']);
  const kept = RC.audioPatch([{ id: 'r1', remoteAudioOutput: 'mine' }], 'r1', 'codec', 'codec-out');
  assert.strictEqual(kept.rigs[0].remoteAudioOutput, 'mine', 'an output already chosen stays');
  assert.strictEqual(RC.audioPatch(rigs, 'nope', 'a', 'b'), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
