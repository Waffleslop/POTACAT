#!/usr/bin/env node
'use strict';
// #379: settings sync to POTACAT Cloud was never switched on. Its wiring
// (IPC cloud-get-settings / cloud-put-settings, preload cloudGetSettings /
// cloudPutSettings, CloudSync.getSettings / putSettings on /v1/settings) had
// no caller and was removed so it cannot be turned on by accident and
// overwrite a user's local settings. This guard keeps it gone. QSO log sync
// (/v1/sync/push) is a different path and is not affected.
// Run: node test/settings-sync-gone-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

console.log('Settings sync wiring stays removed (#379)');

const FILES = ['main.js', 'lib/cloud-ipc.js', 'lib/cloud-sync.js', 'preload.js', 'renderer/app.js', 'renderer/remote.js'];

test('no IPC channel or preload entry for settings sync', () => {
  for (const f of FILES) {
    const src = read(f);
    assert.ok(!/cloud-(get|put)-settings/.test(src), f + ' names cloud-get/put-settings');
    assert.ok(!/cloud(Get|Put)Settings/.test(src), f + ' names cloudGetSettings/cloudPutSettings');
  }
});

test('the Cloud client never calls /v1/settings', () => {
  for (const f of FILES) {
    assert.ok(!/['"`]\/v1\/settings['"`]/.test(read(f)), f + ' calls /v1/settings');
  }
  const sync = read('lib/cloud-sync.js');
  assert.ok(!/async\s+(get|put)Settings\s*\(/.test(sync), 'CloudSync has getSettings/putSettings');
});

test('QSO log sync is still there', () => {
  assert.ok(/\/v1\/sync\/push/.test(read('lib/cloud-sync.js')));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
