#!/usr/bin/env node
'use strict';
// AE5JE 2026-10-26 (Bitdefender): audio devices and window positions forgot
// themselves every launch. Two fixes:
//  - lib/audio-device-heal.js: a saved device whose ID changed is followed by
//    its exact name (never to a different device);
//  - lib/settings-save-status.js: the bug report says whether settings saves
//    are reaching disk, and a failed save is logged instead of silent.
// Run: node test/ae5je-settings-audio-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('../lib/audio-device-heal');
const S = require('../lib/settings-save-status');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const dev = (kind, deviceId, label) => ({ kind, deviceId, label });
const CODEC_OUT = 'Speakers (USB Audio CODEC )';
const CODEC_IN = 'Microphone (USB Audio CODEC )';

console.log('Audio devices follow their name');
test('a present ID teaches the rig its label', () => {
  const r = H.healRigAudioDevices([{ id: 'r1', remoteAudioOutput: 'old', remoteAudioInput: 'in1' }],
    [dev('audiooutput', 'old', CODEC_OUT), dev('audioinput', 'in1', CODEC_IN)]);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.rigs[0].remoteAudioOutputLabel, CODEC_OUT);
  assert.strictEqual(r.rigs[0].remoteAudioInputLabel, CODEC_IN);
  assert.deepStrictEqual(r.notes, []);
});
test('a changed ID is followed to the device with the same name', () => {
  const rigs = [{ id: 'r1', name: 'IC-7300', remoteAudioOutput: '65333e5e', remoteAudioOutputLabel: CODEC_OUT }];
  const r = H.healRigAudioDevices(rigs, [dev('audiooutput', 'default', 'Default - Speakers'), dev('audiooutput', 'new99', CODEC_OUT)]);
  assert.strictEqual(r.rigs[0].remoteAudioOutput, 'new99');
  assert.strictEqual(rigs[0].remoteAudioOutput, '65333e5e', 'input not mutated');
  assert.ok(/IC-7300: the output "Speakers \(USB Audio CODEC \)" came back under a new device ID/.test(r.notes[0]), r.notes[0]);
});
test('never a different device, never a guess between two of the same name, never without a label', () => {
  const lone = H.healRigAudioDevices([{ id: 'r', remoteAudioOutput: 'gone', remoteAudioOutputLabel: CODEC_OUT }], [dev('audiooutput', 'x', 'Speakers (Realtek)')]);
  assert.strictEqual(lone.changed, false);
  const two = H.healRigAudioDevices([{ id: 'r', remoteAudioOutput: 'gone', remoteAudioOutputLabel: CODEC_OUT }], [dev('audiooutput', 'a', CODEC_OUT), dev('audiooutput', 'b', CODEC_OUT)]);
  assert.strictEqual(two.changed, false);
  assert.ok(/2 devices share that name/.test(two.notes[0]));
  const noLabel = H.healRigAudioDevices([{ id: 'r', remoteAudioOutput: 'gone' }], [dev('audiooutput', 'a', CODEC_OUT)]);
  assert.strictEqual(noLabel.changed, false);
});
test('an input name never matches an output of the same name', () => {
  const r = H.healRigAudioDevices([{ id: 'r', remoteAudioInput: 'gone', remoteAudioInputLabel: 'USB Audio CODEC' }], [dev('audiooutput', 'o', 'USB Audio CODEC')]);
  assert.strictEqual(r.changed, false);
});
test('role and ALSA IDs are never touched; blank labels (no permission) learn nothing', () => {
  for (const id of ['default', 'communications', 'alsa:hw:1,0']) {
    assert.strictEqual(H.healRigAudioDevices([{ id: 'r', remoteAudioOutput: id }], [dev('audiooutput', 'z', CODEC_OUT)]).changed, false, id);
  }
  assert.strictEqual(H.healRigAudioDevices([{ id: 'r', remoteAudioOutput: 'a' }], [dev('audiooutput', 'a', '')]).changed, false);
});
test('renderer: runs at launch, on device change and after a pick; keeps currentRigs in step', () => {
  const app = read('renderer', 'app.js');
  const html = read('renderer', 'index.html');
  assert.ok(/<script src="\.\.\/lib\/audio-device-heal\.js"><\/script>/.test(html));
  assert.ok(/healRigAudioDevicesNow\('launch'\)/.test(app));
  assert.ok(/addEventListener\('devicechange'/.test(app));
  assert.ok((app.match(/healRigAudioDevicesNow\('audio menu'\)/g) || []).length === 2);
  assert.ok(/healRigAudioDevicesNow\('rig editor'\)/.test(app));
  assert.ok(/currentRigs = currentRigs\.map\(/.test(app), 'the editor copy is updated or its next save restores the dead IDs');
});

console.log('\nSettings saved line');
test('a failed save is named with the likely cause', () => {
  const line = S.describeSaveStatus({ now: 100000, files: [{ label: 'settings.json', lastWrite: { at: 40000, ok: false, error: "EPERM: operation not permitted, open '~\\AppData\\Roaming\\POTACAT\\settings.json'" } }] });
  assert.ok(/settings\.json FAILED to save 60 s ago: EPERM/.test(line), line);
  assert.ok(/Bitdefender Safe Files/.test(line));
});
test('a good save and an unsaved session read plainly', () => {
  const day = 86400000;
  const line = S.describeSaveStatus({ now: 10 * day, files: [
    { label: 'settings.json', lastWrite: { at: 10 * day - 120000, ok: true } },
    { label: 'profile AE5JE', mtimeMsAtLaunch: 7 * day, lastWrite: null },
  ] });
  assert.strictEqual(line, 'settings.json saved 2 min ago; profile AE5JE not saved this session (file last written 3 days ago)');
});
test('main records every settings write, logs a failure once, still throws', () => {
  const main = read('main.js');
  const fn = main.slice(main.indexOf('function _writeJsonAtomic('), main.indexOf('function settingsSaveStatusLine('));
  assert.ok(/_settingsWriteStatus\.set\(p, \{ at: Date\.now\(\), ok: true \}\)/.test(fn));
  assert.ok(/_settingsWriteFailSaid\.has\(msg\)/.test(fn) && /throw err;/.test(fn));
  assert.ok(/ipcMain\.handle\('settings-save-status'/.test(main));
  assert.ok(/'\*\*Settings saved:\*\* ' \+ md\.settingsSaved/.test(read('renderer', 'app.js')));
  assert.ok(/settingsSaveStatus: \(\) => ipcRenderer\.invoke\('settings-save-status'\)/.test(read('preload.js')));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
