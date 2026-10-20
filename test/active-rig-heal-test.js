#!/usr/bin/env node
'use strict';
// SP5GB (1.11.7, six rigs): activeRigId named no rig while catTarget still
// pointed at COM15 — "None" in the editor, "Connecting to Kenwood on COM15"
// in the log, every model lookup falling through to the generic table, and
// the pill's None click answering "6 rigs are configured but none is set
// ACTIVE". lib/active-rig.js adopts the rig whose target is the connection
// target; the Settings full save now sends catTarget with the selected rig.
// Run: node test/active-rig-heal-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { sameTarget, findRigByTarget, healActiveRig } = require('../lib/active-rig');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('Active rig heal');

const serial = (p) => ({ type: 'serial', path: p, baudRate: 38400 });
const rigs = [
  { id: 'a', name: 'FT-710', catTarget: serial('COM3') },
  { id: 'b', name: 'FX4CR', model: 'TS-590S/SG', catTarget: serial('COM15') },
  { id: 'c', name: 'Flex', catTarget: { type: 'smartsdr', host: '192.168.1.10', port: 4992 } },
  { id: 'd', name: 'Pebble', catTarget: { type: 'none' } },
];

test('sameTarget: serial by path (case-insensitive), tcp by host+port, type must match', () => {
  assert.ok(sameTarget(serial('COM15'), { type: 'serial', path: 'com15', baudRate: 9600 }), 'baud is not identity');
  assert.ok(!sameTarget(serial('COM15'), serial('COM3')));
  assert.ok(sameTarget({ type: 'smartsdr', host: '192.168.1.10', port: 4992 }, { type: 'smartsdr', host: '192.168.1.10', port: '4992' }));
  assert.ok(!sameTarget({ type: 'rigctld', host: '127.0.0.1', port: 4532 }, { type: 'rigctld', host: '127.0.0.1', port: 4533 }));
  assert.ok(!sameTarget({ type: 'rigctld', host: '127.0.0.1', port: 4532 }, { type: 'tcp', host: '127.0.0.1', port: 4532 }), 'type differs');
  assert.ok(!sameTarget(null, serial('COM15')) && !sameTarget({}, {}), 'empty never matches');
});

test('healActiveRig adopts the rig whose target is in use, never clears, never touches the target', () => {
  const s = { rigs, activeRigId: 'deleted-id', catTarget: serial('com15') };
  const r = healActiveRig(s);
  assert.deepStrictEqual({ changed: r.changed, reason: r.reason, id: r.rig.id, staleId: r.staleId }, { changed: true, reason: 'adopted', id: 'b', staleId: 'deleted-id' });
  assert.strictEqual(s.activeRigId, 'b');
  assert.strictEqual(s.catTarget.path, 'com15', 'target untouched');
  const ok = healActiveRig({ rigs, activeRigId: 'a', catTarget: serial('COM15') });
  assert.strictEqual(ok.reason, 'ok', 'a valid id is never second-guessed, even against a different target');
  const un = healActiveRig({ rigs, activeRigId: 'gone', catTarget: serial('COM9') });
  assert.deepStrictEqual({ changed: un.changed, reason: un.reason }, { changed: false, reason: 'unmatched' });
  assert.strictEqual(healActiveRig({ rigs: [], activeRigId: 'x', catTarget: serial('COM1') }).reason, 'no-rigs');
  assert.strictEqual(healActiveRig({ rigs, activeRigId: null, catTarget: null }).reason, 'unmatched', 'null target adopts nothing');
  assert.strictEqual(findRigByTarget(rigs, { type: 'none' }).id, 'd', 'no-CAT rig matches by type');
});

test('main.js heals at startup and before every connect, logging and saving', () => {
  const main = R('main.js');
  assert.ok(/settings = loadSettings\(\);\n\s*healActiveRigNow\('startup'\);/.test(main), 'startup');
  assert.ok(/killRigctld\(\);\n\s*healActiveRigNow\('connect'\);\n\s*let target = settings\.catTarget;/.test(main), 'connectCat, before the target is read');
  assert.ok(/function healActiveRigNow\(where\) \{[\s\S]*?sendCatLog\(`\[CAT\] activeRigId named no rig[\s\S]*?saveSettings\(settings\)/.test(main), 'logs and saves on a repair');
});

test('the Settings full save sends catTarget with the selected rig, and nothing when None is chosen', () => {
  const app = R('renderer/app.js');
  assert.ok(/activeRigId: selectedRigId \|\| null,[\s\S]{0,700}\.\.\.\(rigTarget \? \{ catTarget: rigTarget \} : \{\}\),/.test(app));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
