#!/usr/bin/env node
'use strict';
// KF0TDB 2026-10-02 (FT-991A): Test Connection passed, then every click said
// "Radio not connected - check the USB/serial link (Settings > My Rigs)".
// Each test disconnects the live link to free the port and never put it back.
// Run: node test/test-connection-restore-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
console.log('Test Connection restores the live link');

test('every test that disconnects the live link is registered through handleCatTest', () => {
  for (const name of ['test-serial-cat', 'test-icom-civ', 'test-civ-tcp', 'test-icom-network']) {
    assert.ok(main.includes(`handleCatTest('${name}',`), name + ' is not wrapped');
    assert.ok(!main.includes(`ipcMain.handle('${name}'`), name + ' is registered without the restore');
  }
});

test('the wrapper reconnects the saved rig after the port is free, pass or fail', () => {
  const w = main.slice(main.indexOf('const handleCatTest = '), main.indexOf("handleCatTest('test-serial-cat'"));
  assert.ok(/finally \{/.test(w), 'not in a finally: a failed test would leave the link down');
  assert.ok(/waitForSerialPortFree\(testedPath, 3000\)/.test(w), 'reconnects before Windows releases the port');
  assert.ok(/connectCatSafe\(label \+ ' finished'\)/.test(w));
});

test('the FT-991/991A setup note names CAT RTS = DISABLE (KF0TDB)', () => {
  const N = require('../lib/rig-setup-notes');
  const ids = N.resolveSetupNotes({ model: 'FT-991/991A', radioType: 'serialcat', platform: 'win32' }).map((n) => n.id);
  assert.ok(ids.includes('ft991-cat-rts'), ids.join(','));
  const other = N.resolveSetupNotes({ model: 'FT-710', radioType: 'serialcat', platform: 'win32' }).map((n) => n.id);
  assert.ok(!other.includes('ft991-cat-rts'), 'shown for another radio');
});

console.log(`\nTest Connection restores the live link: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
