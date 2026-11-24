#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
/**
 * Who may claim the potacat:// link handler (Casey, 2026-11-22): a packaged
 * POTACAT as before; a development run only with the default user data
 * folder, not from a git worktree, and with its app path; a worktree or
 * scratch run never.
 *
 * Run: node test/protocol-registration-test.js
 */
const assert = require('assert');
const path = require('path');
const { decideProtocolRegistration: decide } = require('../lib/protocol-registration');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const DEF = path.resolve('/Users/op/AppData/Roaming/POTACAT');
const dev = (over) => Object.assign({
  isPackaged: false,
  execPath: path.resolve('/p/desktop/node_modules/electron/dist/electron.exe'),
  appPath: path.resolve('/p/desktop'),
  userDataPath: DEF, defaultUserDataPath: DEF,
  hasUserDataSwitch: false, appIsWorktree: false,
}, over || {});

test('a packaged POTACAT registers as before, with no arguments', () => {
  assert.deepStrictEqual(decide({ isPackaged: true }), { register: true });
});
test('the main checkout\'s npm start registers with its app path', () => {
  const r = decide(dev());
  assert.strictEqual(r.register, true);
  assert.strictEqual(r.path, dev().execPath);
  assert.deepStrictEqual(r.args, [path.resolve('/p/desktop')]);
});
test('a scratch run with its own --user-data-dir never claims it', () => {
  assert.strictEqual(decide(dev({ hasUserDataSwitch: true })).register, false);
  assert.strictEqual(decide(dev({ userDataPath: path.resolve('/tmp/scratch') })).register, false);
});
test('a worktree run never claims it, even with the default user data folder', () => {
  const r = decide(dev({ appIsWorktree: true }));
  assert.strictEqual(r.register, false);
  assert.ok(/worktree/.test(r.why));
});
test('the user data comparison ignores case (Windows paths)', () => {
  assert.strictEqual(decide(dev({ userDataPath: DEF.toUpperCase() })).register, true);
});
test('a dev run without an app path does not register a bare runtime', () => {
  assert.strictEqual(decide(dev({ appPath: '' })).register, false);
});

const main = readSrc(path.join(__dirname, '..', 'main.js')).replace(/\r\n/g, '\n');
test('main.js asks the rule and registers dev runs with path and args', () => {
  assert.ok(main.includes('ProtocolRegistration.decideProtocolRegistration({'));
  assert.ok(/app\.setAsDefaultProtocolClient\('potacat', reg\.path, reg\.args\)/.test(main), 'dev form with the app path');
  assert.ok(/app\.isDefaultProtocolClient\('potacat', reg\.path, reg\.args\)/.test(main), 'checked in the same form, so it does not re-register every start');
  assert.ok(/hasUserDataSwitch: app\.commandLine\.hasSwitch\('user-data-dir'\)/.test(main));
  assert.strictEqual((main.match(/setAsDefaultProtocolClient\('potacat'\)/g) || []).length, 1, 'the no-argument form only in the packaged branch');
  const bare = main.indexOf("app.setAsDefaultProtocolClient('potacat');");
  assert.ok(bare > main.indexOf('} else if (reg.args) {'), 'no unconditional registration');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
