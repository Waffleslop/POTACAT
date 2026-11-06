// test/rig-test-saved-note-test.js — the rig editor's Test checks the EDITOR's
// port; a passing Test on a rig whose saved port is blank or different looked
// like "done" (KK6EZA IC-705 1.13.9, arys64/KO6BAH FTDX10, NJ2DX IC-7300).
'use strict';
const { readSrc } = require('./_src');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const app = readSrc(path.join(__dirname, '..', 'renderer', 'app.js')).replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
const src = app.slice(app.indexOf('function rigTestSavedNote('), app.indexOf('\n}\n', app.indexOf('function rigTestSavedNote(')) + 2);
const make = (editingRigId, currentRigs) => new Function('editingRigId', 'currentRigs', src + '; return rigTestSavedNote;')(editingRigId, currentRigs);

console.log('rig editor Test, saved or not:');
t('a saved rig with no port: the result says the tested port is not saved', () => {
  const note = make('r1', [{ id: 'r1', catTarget: { type: 'icom', path: '' } }])('COM6');
  assert.ok(/COM6 is not saved on this radio yet \(no port is saved\): press Save/.test(note), note);
});
t('a different saved port is named', () => {
  const note = make('r1', [{ id: 'r1', catTarget: { type: 'serial', path: 'COM9' } }])('COM10');
  assert.ok(/saved with COM9/.test(note), note);
});
t('rigctld keeps its port in serialPort', () => {
  assert.strictEqual(make('r1', [{ id: 'r1', catTarget: { type: 'rigctld', serialPort: 'com3' } }])('COM3'), '');
});
t('the saved port, tested: nothing extra', () => {
  assert.strictEqual(make('r1', [{ id: 'r1', catTarget: { type: 'serial', path: 'COM4' } }])('COM4'), '');
});
t('a radio not saved yet says so', () => {
  assert.ok(/not saved yet: press Save/.test(make(null, [])('COM4')));
});
t('all three Test buttons append it to "Connected!"', () => {
  assert.ok(app.includes("(result.note ? ` (${result.note})` : '') + rigTestSavedNote(portPath);"), 'Serial CAT');
  assert.ok(app.includes('`Connected! Freq: ${freqMHz} MHz` + rigTestSavedNote(serialPort);'), 'Hamlib');
  assert.ok(app.includes('resultEl.textContent = `Connected! Freq: ${result.frequency} MHz` + rigTestSavedNote(portPath);'), 'Icom CI-V');
});
console.log('\nrig editor Test: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
