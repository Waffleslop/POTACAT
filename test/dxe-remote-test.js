#!/usr/bin/env node
'use strict';
/**
 * DXpedition spot flags reach ECHOCAT (potacat-meta dxe-flags-to-remote, filed by the
 * app session 2026-10-07). The phone needs enableDxe + enableDxeSources to badge
 * spots and to say "DXpedition spots are off" truthfully; the desktop sent neither.
 *
 * Run: node test/dxe-remote-test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e).split('\n')[0]); }
}
const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8').replace(/\r\n/g, '\n');

console.log('DXpedition spot flags to ECHOCAT');

test("main's helper fills every source, default on", () => {
  const a = main.indexOf("const DXE_SOURCE_KEYS_MAIN");
  const b = main.indexOf('// A phone changed the DXpedition flags');
  const make = new Function('settings', main.slice(a, b) + '\nreturn dxeSourcesForRemote;');
  assert.deepStrictEqual(make({})(), { clublog: true, 'dx-world': true, dxnews: true, ng3k: true });
  assert.deepStrictEqual(make({ enableDxeSources: { ng3k: false } })(), { clublog: true, 'dx-world': true, dxnews: true, ng3k: false });
});

test('both keys ride the ECHOCAT settings blob', () => {
  assert.ok(/enableDxe: settings\.enableDxe !== false,\n\s+enableDxeSources: dxeSourcesForRemote\(\),/.test(main));
});

test('a desktop change pushes settings-update', () => {
  assert.ok(/has\('enableDxe'\) \|\| has\('enableDxeSources'\)\) \{\n\s+updateRemoteSettings\(\);/.test(main));
});

test('a phone change merges sources, refreshes the desktop window, and echoes to every client', () => {
  assert.ok(/for \(const k of DXE_SOURCE_KEYS_MAIN\) if \(typeof partial\.enableDxeSources\[k\] === 'boolean'\) merged\[k\]/.test(main), 'one source never clears the others');
  assert.ok(/if \(partial && 'enableDxe' in partial\) partial\.enableDxe = partial\.enableDxe !== false;/.test(main), "the phone's Turn on can switch the master back on");
  assert.ok(/if \(dxeChanged\) pushDxeSettingsToWindow\(\);/.test(main));
  assert.ok(/if \(sdrSync \|\| dxeChanged \|\| jttyKeys/.test(main));
  assert.ok(/onDxeSettings: \(cb\) => ipcRenderer\.on\('dxe-settings'/.test(fs.readFileSync(path.join(root, 'preload.js'), 'utf8')));
  assert.ok(/window\.api\.onDxeSettings\(\(d\) => \{[\s\S]{0,400}syncSpotsPanel\(\)[\s\S]{0,120}render\(\)/.test(app), 'the window applies it live');
});

console.log(`\nDXE flags to ECHOCAT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
