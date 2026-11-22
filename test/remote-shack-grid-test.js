#!/usr/bin/env node
'use strict';
/**
 * #774: on a POTACAT desktop driving a shack (Guest Pass, or the owner away
 * from home), the JTCAT map centred on this computer's own grid, while the
 * decodes are heard at the shack. The shack's grid already rides auth-ok
 * (and settings-update) as settings.grid; main keeps it as remoteShackGrid,
 * get-settings carries it as shackGrid in remote mode, and the JTCAT window
 * and its map pop-out use it there.
 */
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('lib/shack-grid.js');
let SG = null;
try { SG = require('../lib/shack-grid'); } catch { /* the checks below fail */ }
check('the module exists', () => assert.ok(SG, 'lib/shack-grid.js'));
check('takes the shack grid from its settings blob, upper case', () => {
  assert.strictEqual(SG.shackGridFrom({ grid: 'fn20ab' }), 'FN20AB');
  assert.strictEqual(SG.shackGridFrom({ grid: ' em79 ' }), 'EM79');
});
check('no settings, no grid, or not a Maidenhead locator: empty', () => {
  assert.strictEqual(SG.shackGridFrom(null), '');
  assert.strictEqual(SG.shackGridFrom({}), '');
  assert.strictEqual(SG.shackGridFrom({ grid: 'nowhere' }), '');
  assert.strictEqual(SG.shackGridFrom({ grid: 12 }), '');
});

console.log('main.js');
const main = readSrc(path.join(ROOT, 'main.js'));
check('auth-ok (connected) keeps the shack grid', () => {
  const i = main.indexOf("remoteClient.on('connected', (info) => {");
  const block = main.slice(i, main.indexOf("remoteClient.on('disconnected'", i));
  assert.ok(/remoteShackGrid = ShackGrid\.shackGridFrom\(info\.settings\);/.test(block));
});
check('a settings-update from the shack refreshes it', () => {
  assert.ok(/if \(msg\.type === 'settings-update' && msg\.settings && typeof msg\.settings\.grid === 'string'\) remoteShackGrid = ShackGrid\.shackGridFrom\(msg\.settings\);/.test(main));
});
check('get-settings carries shackGrid only in remote mode', () => {
  assert.ok(/ipcMain\.handle\('get-settings', \(\) => \(\{ [^\n]*shackGrid: isRemoteMode\(\) \? remoteShackGrid : ''/.test(main));
});

console.log('The JTCAT window and its map');
for (const f of ['renderer/jtcat-popout.js', 'renderer/jtcat-map-popout.js']) {
  const src = readSrc(path.join(ROOT, f));
  check(f + ': the shack grid when remote, this computer\'s grid otherwise', () => {
    assert.ok(/myGrid = \(\(s\.remoteShack && s\.shackGrid\) \|\| s\.grid \|\| ''\)\.toUpperCase\(\)\.substring\(0, 4\);/.test(src));
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
