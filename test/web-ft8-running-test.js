#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// kc8zp 2026-11-03: the engine's { state: 'stopped' } status has no `running`
// key, and the web page read it as running, so opening its FT8 tab after an
// idle stop never sent jtcat-start (the phone app always sends it).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const web = readSrc(path.join(__dirname, '..', 'renderer/remote.js'));
const eng = readSrc(path.join(__dirname, '..', 'lib/ft8-engine.js'));
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
check('running only on running:true or state running', () => {
  assert.ok(/ft8Running = msg\.running === true \|\| msg\.state === 'running';/.test(web));
  assert.ok(!/ft8Running = msg\.running !== false;/.test(web));
});
check('the engine really does say stopped without a running key', () => {
  assert.ok(/emit\('status', \{ state: 'stopped' \}\)/.test(eng));
});
check('the evaluation the page does', () => {
  const run = (msg) => msg.running === true || msg.state === 'running';
  assert.strictEqual(run({ state: 'stopped' }), false);
  assert.strictEqual(run({ running: false }), false);
  assert.strictEqual(run({ state: 'running', mode: 'FT8' }), true);
});
check('opening the FT8 tab starts a stopped engine', () => {
  // Stopped, or the shack's idle receive (Casey 2026-11-12): ft8TakeEngine sends jtcat-start.
  assert.ok(/tab === 'ft8'\) \{[\s\S]{0,300}if \(!ft8Running \|\| ft8IdleRx\) ft8TakeEngine\(\);/.test(web));
  assert.ok(/function ft8TakeEngine\(\) \{[\s\S]{0,400}ft8Send\(\{ type: 'jtcat-start', mode: ft8Mode \}\);/.test(web));
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
