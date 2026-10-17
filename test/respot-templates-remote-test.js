#!/usr/bin/env node
'use strict';
// ECHOCAT gets every re-spot template and the saved re-spot messages, and a
// desktop edit reaches a connected device at once (K8IKO 2026-10-02; mobile
// half: potacat-meta work/open/respot-templates-mobile.md).
// Run: node test/respot-templates-remote-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const fnStart = src.indexOf('function updateRemoteSettings()');
const payload = src.slice(fnStart, fnStart + 4000);

test('settings-update carries every program template and the saved messages', () => {
  for (const k of ['respotTemplate:', 'dxRespotTemplate:', 'wwffRespotTemplate:', 'llotaRespotTemplate:', 'wwbotaRespotTemplate:', 'respotPresets:']) {
    assert.ok(payload.includes(k), k);
  }
});

test('saved messages are sent trimmed, without blanks', () => {
  assert.ok(payload.includes("settings.respotPresets.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim())"));
});

test('saving any re-spot setting re-pushes to connected devices', () => {
  const save = src.slice(src.indexOf("ipcMain.handle('save-settings'"));
  const gate = save.slice(0, save.indexOf('updateRemoteSettings();'));
  for (const k of ['respotTemplate', 'dxRespotTemplate', 'wwffRespotTemplate', 'llotaRespotTemplate', 'wwbotaRespotTemplate', 'respotPresets', 'respotDefault']) {
    assert.ok(gate.includes(`has('${k}')`), k);
  }
});

console.log(`\nRe-spot templates to ECHOCAT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
