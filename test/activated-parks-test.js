#!/usr/bin/env node
'use strict';
// "Is it possible to import our activation report file from pota.app and have
// the activation status populated? AZ just added two new parks and they
// didn't stand out." (activator, Discord 2026-10-20). The pota.app Activations
// CSV + the local log mark parks this station has activated; the activator
// park picker shows NEW on the rest.
// Run: node test/activated-parks-test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parsePotaActivationsCSV } = require('../lib/pota-parks');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('Activated parks');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-act-'));
const write = (name, text) => { const p = path.join(tmp, name); fs.writeFileSync(p, text); return p; };

test('parser: columns found by header name; one entry per park, earliest date, summed QSOs', () => {
  const p = write('a.csv', [
    '"Date","Park Reference","Park Name","Location","QSOs"',
    '"2026-09-01","US-4571","Picacho Peak State Park","US-AZ","24"',
    '"2026-10-05","US-4571","Picacho Peak State Park","US-AZ","11"',
    '"2026-10-12","US-0049","Saguaro National Park","US-AZ","40"',
  ].join('\n'));
  const m = parsePotaActivationsCSV(p);
  assert.strictEqual(m.size, 2);
  assert.deepStrictEqual(m.get('US-4571'), { date: '2026-09-01', qsoCount: 35, parkName: 'Picacho Peak State Park' });
  assert.strictEqual(m.get('US-0049').qsoCount, 40);
});

test('parser: an export with other headers still finds the reference by its shape', () => {
  const p = write('b.csv', [
    'When,Where,Count',
    '2026-08-01,us-4571,12',
    '2026-08-02,K-1234,3',
    'junk,nothing,0',
  ].join('\n'));
  const m = parsePotaActivationsCSV(p);
  assert.deepStrictEqual([...m.keys()].sort(), ['K-1234', 'US-4571']);
  assert.strictEqual(m.get('US-4571').qsoCount, 12, 'count column found by name even when the ref column was discovered');
  assert.strictEqual(parsePotaActivationsCSV(write('c.csv', 'only,a,header')).size, 0);
});

test('main: activated parks = CSV + the log\'s MY_SIG_INFO activations; picker asks on open; CSV change reloads', () => {
  const main = R('main.js');
  assert.ok(/function loadActivatedParks\(\) \{[\s\S]*?parsePotaActivationsCSV\(settings\.potaActivationsPath\)[\s\S]*?for \(const a of getPastActivations\(\)\)/.test(main));
  assert.ok(main.includes("ipcMain.handle('get-activated-parks'") && main.includes("ipcMain.handle('choose-pota-activations-file'"));
  assert.ok(/const potaActivationsPathChanged = has\('potaActivationsPath'\)/.test(main));
  assert.ok(/if \(potaActivationsPathChanged \|\| \(has\('activationActive'\)[^\n]*\n\s*try \{ loadActivatedParks\(\); \} catch \{\}/.test(main), 'reloads on CSV change and activation start/stop');
  assert.ok(/ipcMain\.handle\('get-activated-parks', \(\) => \[\.\.\.activatedParks\.entries\(\)\]\);/.test(main), 'the picker reads the cache, never a per-keystroke log scan');
  const pre = R('preload.js');
  assert.ok(/choosePotaActivationsFile:|getActivatedParks:|onActivatedParks:/.test(pre));
});

test('activator park picker: NEW / activated badge, only once something is known', () => {
  const app = R('renderer/app.js'), html = R('renderer/index.html'), css = R('renderer/styles.css');
  assert.ok(/if \(!activatedParksLoaded\) await refreshActivatedParks\(\);/.test(app), 'asks main once, before the first render');
  assert.ok(/if \(activatedParksMap\.size > 0\) \{[\s\S]*?class="activator-dropdown-done"[\s\S]*?class="activator-dropdown-new"[^>]*>NEW</.test(app), 'badge only with data; NEW for never-activated');
  assert.ok(/id="set-pota-activations-path"/.test(html) && /potaActivationsPath: setPotaActivationsPath/.test(app) && /setPotaActivationsPath\.value = s\.potaActivationsPath \|\| '';/.test(app), 'Settings picker saved and restored');
  assert.ok(/\.activator-dropdown-new \{ background: var\(--source-pota, #4ecca3\); color: #1a1a2e; \}/.test(css));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
