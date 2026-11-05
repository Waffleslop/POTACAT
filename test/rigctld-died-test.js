#!/usr/bin/env node
'use strict';
/**
 * LA8JKA 2026-11-02: the rigctld POTACAT started stopped the moment ECHOCAT
 * connected, and POTACAT retried a dead port for good with no line saying so.
 * A rigctld that stops by itself is now logged and restarted (3 in 10 min),
 * and a phone's unchanged CW speed at connect sends the radio nothing.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const codec = fs.readFileSync(path.join(__dirname, '..', 'lib/codecs/rigctld-codec.js'), 'utf8');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
check('an exit nobody asked for is told apart from killRigctld (which nulls rigctldProc first)', () => {
  assert.ok(/const diedOnItsOwn = settled && !portOverride && rigctldProc === proc;/.test(main));
  assert.ok(/if \(diedOnItsOwn\) rigctldDiedOnItsOwn\(code, signal\);/.test(main));
  const kill = /function killRigctld\(\) \{[\s\S]*?\n\}/.exec(main)[0];
  assert.ok(/rigctldProc\.kill\(\)[\s\S]*rigctldProc = null/.test(kill));
});
check('it is logged and restarted, at most 3 times in 10 minutes', () => {
  const fn = /function rigctldDiedOnItsOwn\(code, signal\) \{[\s\S]*?\n\}/.exec(main)[0];
  assert.ok(/stopped by itself/.test(fn));
  assert.ok(/_rigctldRespawns\.length >= 3/.test(fn) && /10 \* 60 \* 1000/.test(fn));
  assert.ok(/connectCatSafe\('rigctld restart'\)/.test(fn));
  assert.ok(/t\.type !== 'rigctld' \|\| rigctldProc/.test(fn), 'not when the rig changed or one is already back');
});
check('ECHOCAT cw-config: an unchanged speed sends nothing', () => {
  const h = /remoteServer\.on\('cw-config'[\s\S]*?\n  \}\);/.exec(main)[0];
  assert.ok(/if \(wpm === settings\.cwWpm && \(!cat \|\| cat\._cwWpm === wpm\)\) return;/.test(h));
});
check('the speed write is in the log', () => {
  assert.ok(/emit\('log', `CW speed write: "L KEYSPD/.test(codec));
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
