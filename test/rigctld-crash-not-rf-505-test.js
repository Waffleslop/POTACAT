#!/usr/bin/env node
'use strict';
// #505 (N6UGP, Xiegu X5105 via rigctld, 1.14.4): rigctld crashed (SIGSEGV)
// right after a CW send, and the log then blamed RF in the USB cable ("add a
// ferrite choke"). The crash itself is fixed (no KEYSPD to that backend,
// test/cw-key-both-lines-test.js); this pins the message: over rigctld, a
// link loss right after a CW send waits a moment and names a rigctld crash
// when there was one, instead of RF.
//
// Run: node test/rigctld-crash-not-rf-505-test.js

const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

const main = readSrc(path.join(__dirname, '..', 'main.js'));
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + '\n    ' + (e.stack || e.message)); }
}

test('rigctldDiedOnItsOwn records when rigctld stopped', () => {
  const i = main.indexOf('function rigctldDiedOnItsOwn(code, signal) {');
  assert.ok(i > 0);
  assert.ok(/_rigctldDiedAtMs = now;/.test(main.slice(i, i + 400)));
});

test('over rigctld the RF hint waits and gives way to a rigctld crash', () => {
  const i = main.indexOf('const rfSuspect = _lastCwKeyMs');
  assert.ok(i > 0);
  const block = main.slice(i, i + 3000);
  assert.ok(/const viaRigctld = !!\(settings\.catTarget && settings\.catTarget\.type === 'rigctld'\);/.test(block));
  assert.ok(/if \(rfSuspect && viaRigctld\) \{\s*setTimeout\(\(\) => \{\s*if \(Date\.now\(\) - _rigctldDiedAtMs < 3000\)/.test(block));
  assert.ok(/rigctld \(Hamlib\) stopped during the CW send, not because of RF/.test(block));
  assert.ok(/sayLinkLost\(false\);\s*\} else \{\s*sayLinkLost\(true\);/.test(block), 'RF only when rigctld did not stop');
});

test('a serial or Flex link still gets the RF hint at once', () => {
  const i = main.indexOf('const rfSuspect = _lastCwKeyMs');
  const block = main.slice(i, i + 3000);
  assert.ok(/\} else \{\s*sayLinkLost\(rfSuspect\);\s*\}/.test(block));
  assert.ok(/RF is likely resetting the USB device/.test(block));
});

console.log(`\nrigctld crash is not RF (#505): ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
