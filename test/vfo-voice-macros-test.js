#!/usr/bin/env node
'use strict';
/**
 * The VFO window's voice macro bar follows every change to the labels and
 * recordings (N0KAH 2026-10-28: a macro renamed in Settings kept its old name
 * in an open VFO window until it was closed and reopened).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'preload-vfo-popout.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'renderer/vfo-popout.html'), 'utf8');

const handler = (name) => {
  const i = main.indexOf("ipcMain.handle('" + name + "'");
  assert.ok(i > 0, name);
  return main.slice(i, main.indexOf('return true;', i));
};

check('a rename, a recording and a delete in Settings each tell the VFO window', () => {
  for (const h of ['voice-macro-labels-save', 'voice-macro-save', 'voice-macro-delete']) {
    assert.ok(/notifyVfoVoiceMacros\(\);/.test(handler(h)), h);
  }
});
check('so do a recording and a delete from the phone', () => {
  for (const ev of ["remoteServer.on('voice-macro-sync'", "remoteServer.on('voice-macro-delete'"]) {
    const i = main.indexOf(ev);
    assert.ok(i > 0, ev);
    assert.ok(/notifyVfoVoiceMacros\(\);/.test(main.slice(i, i + 700)), ev);
  }
});
check('the window redraws the bar, after any playback in progress', () => {
  assert.ok(/onVoiceMacrosChanged: \(cb\) => ipcRenderer\.on\('voice-macros-changed'/.test(preload));
  assert.ok(/onVoiceMacrosChanged\(\(\) => \{\s*if \(voicePlayingIdx >= 0\) \{ voiceMacrosStale = true; return; \}\s*loadVoiceMacros\(\)/.test(html));
  const stop = html.slice(html.indexOf('function stopVoicePlayback()'), html.indexOf('function stopVoicePlayback()') + 700);
  assert.ok(/if \(voiceMacrosStale\) \{\s*voiceMacrosStale = false;\s*loadVoiceMacros\(\)/.test(stop));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
