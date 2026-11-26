#!/usr/bin/env node
'use strict';
// A radio saved in the first run's "which radio" step has the same settings
// shape as one saved in the Settings rig editor (a shorter first run, part 2).
//
//   1. The record: saveRigEditor builds a new radio with lib/rig-record.js
//      newRigRecord, the same function the first run uses, and passes it every
//      value the function reads.
//   2. The connection target: the editor's own buildCatTargetFromForm() (run
//      here from renderer/app.js, with its form fields at the values the Add
//      Rig form holds) gives the same target as catTargetFor() for every
//      connection the first run sets up.
//   3. End to end: the first run's IC-7300, FT-710, FLEX-6600, G90, X6100 and
//      Pebble HF equal the record the Settings editor saves for the same radio
//      with the same answers, key for key and value for value, apart from the
//      new id.
// Run: node test/rig-record-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const RR = require('../lib/rig-record');
const Q = require('../lib/rig-quick-setup');
const { getModelList } = require('../lib/rig-models');

const R = (f) => readSrc(path.join(__dirname, '..', f));
const app = R('renderer/app.js');
const html = R('renderer/index.html');
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n    ' + (e && e.stack || e)); }
}
function fnSource(name) {
  const a = app.indexOf('function ' + name + '(');
  assert.ok(a >= 0, name + ' found');
  const b = app.indexOf('\n}\n', a);
  return app.slice(a, b + 2);
}

console.log('One saved-radio shape: Settings editor and first run');

// --- 1. the record ----------------------------------------------------------
const save = fnSource('saveRigEditor');
const call = /const newRig = window\.RigRecord\.newRigRecord\(\{([\s\S]*?)\n    \}\);/.exec(save);
t('saveRigEditor builds a new radio with RigRecord.newRigRecord', () => {
  assert.ok(call, 'the call is there');
  assert.ok(/currentRigs\.push\(newRig\);/.test(save));
  assert.ok(!/const newRig = \{/.test(save), 'no second copy of the record literal');
});
t('and passes it every value the record reads, nothing it does not', () => {
  const lib = R('lib/rig-record.js');
  const body = lib.slice(lib.indexOf('function newRigRecord('), lib.indexOf('function pttField('));
  const reads = new Set([...body.matchAll(/\bv\.(\w+)/g)].map((m) => m[1]));
  const passed = new Set([...call[1].matchAll(/^\s+(\w+)(?::|,)/gm)].map((m) => m[1]));
  assert.deepStrictEqual([...passed].sort(), [...reads].sort());
});
t('optional keys are stored only when set, as before', () => {
  const r = RR.newRigRecord({ id: 'a', voiceAsData: false, audioJack: 'data', allowPowerOffNoWake: undefined, ampDriveLimitW: 0, txLeftOnly: false, packetMode: '', cwSideband: '', sdrScope: undefined, bands: undefined });
  for (const k of ['voiceAsData', 'audioJack', 'voiceDataSwitch', 'allowPowerOffNoWake', 'ampDriveLimitW', 'txAudioInput', 'txChannel', 'icomUsbDataModOff', 'lanVoiceInSsb', 'packetMode', 'cwSideband', 'sdrScope', 'bands']) {
    assert.ok(!(k in r), k + ' absent');
  }
  const s = RR.newRigRecord({ voiceAsData: true, audioJack: 'mic', voiceDataSwitch: false, allowPowerOffNoWake: false, ampDriveLimitW: 5, txAudioInput: 'rear', txLeftOnly: true, icomUsbDataModOff: true, lanVoiceInSsb: true, packetMode: 'fm', cwSideband: 'usb', sdrScope: { enabled: false }, bands: ['20m'] });
  assert.deepStrictEqual([s.voiceAsData, s.audioJack, s.voiceDataSwitch, s.allowPowerOffNoWake, s.ampDriveLimitW, s.txAudioInput, s.txChannel, s.icomUsbDataModOff, s.lanVoiceInSsb, s.packetMode, s.cwSideband, s.bands],
    [true, 'mic', false, false, 5, 'rear', 'left', true, true, 'fm', 'usb', ['20m']]);
});
t('the Add Rig defaults are the form\'s own', () => {
  assert.ok(/<input type="range" id="rig-rx-level" min="-20" max="20" step="1" value="0"/.test(html), 'receive level 0 dB');
  assert.ok(/if \(setCwKeyLine\) setCwKeyLine\.value = 'auto';/.test(app), 'keying line auto');
  assert.ok(/if \(setRadioNr\) setRadioNr\.value = '1';/.test(app), 'radio 1');
  assert.ok(/setRigFullPowerField\(null\);/.test(app), 'full power from the model');
  assert.ok(/id="set-external-atu-watts"[^>]*value="10"/.test(html) && /id="set-external-atu-seconds"[^>]*value="4"/.test(html), 'external ATU 10 W, 4 s');
  assert.ok(/buildFlexBandAntennaMap\(\{\}\);/.test(app), 'empty Flex antenna map');
  assert.deepStrictEqual(RR.NEW_RIG_DEFAULTS.rxLevelDb, 0);
  assert.deepStrictEqual(RR.NEW_RIG_DEFAULTS.cwKeyLine, 'auto');
  assert.deepStrictEqual(RR.NEW_RIG_DEFAULTS.radioNr, 1);
  assert.deepStrictEqual(RR.NEW_RIG_DEFAULTS.fullPowerW, null);
  assert.deepStrictEqual([RR.NEW_RIG_DEFAULTS.externalAtuWatts, RR.NEW_RIG_DEFAULTS.externalAtuSeconds], [10, 4]);
});

// --- 2. the connection target, from the editor's own code -------------------
// The form as the Add Rig form leaves it (renderer/index.html), plus the
// operator's port: run the real buildCatTargetFromForm against it.
function editorTarget(radioType, form) {
  const f = Object.assign({
    'set-serialcat-baud': '9600', 'set-serialcat-handshake': 'auto', 'set-serialcat-ptt': 'cat', 'set-serialcat-dtr-off': false,
    'set-icom-baud': '115200', 'set-icom-ptt': 'cat', 'set-icom-civ-pace': 'auto', 'set-icom-model': '0x94', 'set-icom-model-text': 'IC-7300',
    'set-flex-slice': '0', 'set-flrig-host': '127.0.0.1', 'set-flrig-port': '12345', 'set-flrig-ptt': 'cat',
    'set-rig-model': '', 'set-rig-baud': '9600', 'set-rigctld-port': '4532', 'set-rig-dtr-off': false, 'set-rig-ptt-port': '', 'set-rig-ptt-type': 'RTS',
    'set-nocat-ptt': 'none', port: '',
  }, form || {});
  const el = (id) => ({
    value: f[id], checked: !!f[id],
    get options() { return [{ text: f[id + '-text'] }]; }, selectedIndex: 0,
  });
  const scope = {
    document: { getElementById: (id) => (id in f ? el(id) : null) },
    getSelectedRadioType: () => radioType,
    getEffectiveSerialcatPort: () => f.port,
    getEffectiveIcomPort: () => f.port,
    getEffectivePort: () => f.port,
    setSerialcatBaud: el('set-serialcat-baud'), setSerialcatDtrOff: el('set-serialcat-dtr-off'),
    setFlexSlice: el('set-flex-slice'), setFlrigHost: el('set-flrig-host'), setFlrigPort: el('set-flrig-port'),
    setRigModel: el('set-rig-model'), setRigBaud: el('set-rig-baud'), setRigDtrOff: el('set-rig-dtr-off'), setRigctldPort: el('set-rigctld-port'),
    setRigPttPortManual: el('set-rig-ptt-port-manual'), setRigPttPort: el('set-rig-ptt-port'), setRigPttType: el('set-rig-ptt-type'),
    readTciRigTarget: () => null, rigTciFields: {}, yaesuLanTargetFromForm: () => null,
  };
  const src = fnSource('pttChoiceField') + fnSource('civPaceChoice') + fnSource('buildCatTargetFromForm') + 'return buildCatTargetFromForm();';
  return new Function(...Object.keys(scope), src)(...Object.values(scope));
}
t('the Add Rig form defaults the harness uses are the HTML\'s', () => {
  assert.ok(/<option value="9600" selected>9600<\/option>/.test(html), 'serial CAT 9600');
  assert.ok(/<option value="115200" selected>115200<\/option>/.test(html), 'Icom 115200');
  assert.ok(/<option value="auto" selected>Auto \(by radio model\)<\/option>/.test(html), 'RTS line Auto');
  assert.ok(/id="set-flrig-host" placeholder="127\.0\.0\.1" value="127\.0\.0\.1"/.test(html) && /id="set-flrig-port" min="1" max="65535" value="12345"/.test(html), 'flrig 127.0.0.1:12345');
  assert.ok(/id="set-rigctld-port" min="1024" max="65535" value="4532"/.test(html), 'rigctld 4532');
  assert.ok(/<option value="0">A<\/option>/.test(html), 'Flex slice A first');
});
const cases = [
  ['serialcat', { port: 'COM5' }, { path: 'COM5' }],
  ['serialcat', { port: 'COM5', 'set-serialcat-baud': '38400' }, { path: 'COM5', baudRate: 38400 }],
  ['icom', { port: 'COM3', 'set-icom-model': '0xA4', 'set-icom-model-text': 'IC-705' }, { path: 'COM3', civAddress: 0xA4, civModel: 'IC-705' }],
  ['hamlib', { port: 'COM7', 'set-rig-model': '3088', 'set-rig-baud': '19200' }, { serialPort: 'COM7', rigId: 3088, baudRate: 19200 }],
  ['flex', {}, { slice: 0 }],
  ['flrig', {}, {}],
  ['nocat', {}, {}],
];
for (const [type, form, values] of cases) {
  t('catTargetFor(' + type + ') = the editor\'s buildCatTargetFromForm ' + JSON.stringify(values), () => {
    const ed = editorTarget(type, form);
    const ours = RR.catTargetFor(type, values);
    assert.deepStrictEqual(ours, ed);
    assert.deepStrictEqual(Object.keys(ours), Object.keys(ed), 'same keys, same order');
  });
}

// --- 3. end to end -----------------------------------------------------------
// What the Settings editor saves for a new radio when the operator picks the
// model and the port and changes nothing else: the Add form's values
// (above), the connection the model selects, the audio source the editor
// offers first for it (rebuildAudioSourceOptions), the model as the name.
const groups = getModelList();
const RigFamily = require('../lib/rig-family');
const RMC = require('../lib/rig-model-connection');
function settingsRecord(model, form, extra) {
  const group = groups.find((g) => g.models.includes(model));
  const conn = RMC.connectionForModel({ model, group, current: 'flex' }); // a new rig opens on FlexRadio
  const type = conn.type;
  if (conn.hamlib) Object.assign(form, { 'set-rig-model': String(conn.hamlib.rigId), 'set-rig-baud': String(conn.hamlib.baudRate) });
  return RR.newRigRecord({
    ...RR.NEW_RIG_DEFAULTS,
    id: 'rig_1', name: model, model,
    catTarget: editorTarget(type, form),
    audioSource: RigFamily.defaultAudioSourceFor(RigFamily.familyFromRadioType(type)),
    flexBandAntennaMap: {}, setupDone: [],
    ...(extra || {}),
  });
}
const e2e = [
  ['IC-7300', { port: 'COM3', 'set-icom-model': '0x94', 'set-icom-model-text': 'IC-7300' }, { port: 'COM3' }],
  ['IC-705', { port: 'COM4', 'set-icom-model': '0xA4', 'set-icom-model-text': 'IC-705' }, { port: 'COM4' }],
  ['FT-710', { port: 'COM5' }, { port: 'COM5' }],
  ['FT-991/991A', { port: 'COM6', 'set-serialcat-baud': '38400' }, { port: 'COM6', baudRate: 38400 }],
  ['FLEX-6600/6600M', {}, { flexHost: '192.168.1.50' }, { flexApiHost: '192.168.1.50' }],
  ['G90', { port: 'COM8' }, { port: 'COM8' }],
  ['X6100', {}, {}],
  ['Pebble HF', {}, {}],
];
for (const [model, form, answers, extra] of e2e) {
  t('first run ' + model + ' = what Settings saves for it', () => {
    const plan = Q.planForModel(groups, model);
    const ours = Q.buildRig(plan, { ...answers, id: 'rig_1' });
    const theirs = settingsRecord(model, { ...form }, extra);
    assert.deepStrictEqual(ours, theirs);
    assert.deepStrictEqual(Object.keys(ours), Object.keys(theirs), 'same keys, same order');
  });
}
t('the editor would save an empty sdrScope form too; the first run leaves it out (main reads absent as off)', () => {
  const main = R('main.js');
  assert.ok(/return SdrScope\.normalizeSdrSettings\(rig && rig\.sdrScope\);/.test(main));
  const SdrScope = require('../lib/sdr-scope');
  assert.strictEqual(SdrScope.normalizeSdrSettings(undefined).enabled, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
