'use strict';
// KF0WWL 2026-10-23: an empty settings.remoteAudioInput made the ECHOCAT bridge
// and the JTCAT window open the Mac's built-in mic while the rig held the CODEC.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { healRigAudioMirror } = require('../lib/rig-audio-mirror');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };
t('an empty mirror is restored from the active rig', () => {
  const s = { activeRigId: 'a', rigs: [{ id: 'a', remoteAudioInput: 'codec-in', remoteAudioOutput: 'codec-out' }], remoteAudioInput: '', remoteAudioOutput: 'codec-out' };
  const r = healRigAudioMirror(s);
  assert.ok(r.changed); assert.strictEqual(s.remoteAudioInput, 'codec-in'); assert.strictEqual(r.fields.length, 1);
});
t('a rig with no device never blanks the mirror', () => {
  const s = { activeRigId: 'a', rigs: [{ id: 'a' }], remoteAudioInput: 'x' };
  assert.ok(!healRigAudioMirror(s).changed); assert.strictEqual(s.remoteAudioInput, 'x');
});
t('no active rig: untouched', () => {
  const s = { activeRigId: 'zz', rigs: [{ id: 'a', remoteAudioInput: 'c' }], remoteAudioInput: '' };
  assert.ok(!healRigAudioMirror(s).changed);
});
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const jt = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'jtcat-popout.js'), 'utf8');
const br = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote-audio.html'), 'utf8');
t('wired at startup/connect and on every settings save', () => {
  assert.ok(/healRigAudioMirrorNow\(where\);/.test(main));
  assert.ok(/healRigAudioMirror\(settings\);\r?\n\s*saveSettings\(settings\);/.test(main));
});
t('the Settings save never writes an empty mirror when no rig is checked', () => {
  assert.ok(!/remoteAudioInput: selectedRig \? \(selectedRig\.remoteAudioInput \|\| ''\) : ''/.test(app));
});
t('the JTCAT window never falls back to the default input', () => {
  assert.ok(!/delete constraints\.deviceId;\r?\n\s*popoutAudioStream = await navigator\.mediaDevices\.getUserMedia/.test(jt));
});
t('an unconfigured bridge prefers the output device\'s own input', () => {
  assert.ok(/d\.groupId === out\.groupId/.test(br));
});
console.log(`Rig audio mirror: ${n} passed, 0 failed`);
