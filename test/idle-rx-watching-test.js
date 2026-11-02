#!/usr/bin/env node
'use strict';
// W0TLP 2026-11-02: Idle Mode QSY'd his radio to 14.0956 in LSB while he
// watched it from his phone. A connected ECHOCAT device holds off Idle Mode,
// and the engine-only mode names reach the radio as a data mode.
// Run: node test/idle-rx-watching-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('the Idle Mode tick treats a connected ECHOCAT device as someone at the radio', () => {
  const start = main.indexOf('function startAutoSstvTimer(');
  const tick = main.slice(start, main.indexOf('function stopAutoSstvTimer(', start));
  assert.ok(/remoteServer\.activeClientContext\(\)/.test(tick), 'checks for a connected device');
  assert.ok(/if \(remoteWatching && !autoSstvActive\) lastActivityTime = Date\.now\(\);/.test(tick), 'restarts the countdown, leaves a running session alone');
  assert.ok(tick.indexOf('remoteWatching && !autoSstvActive') < tick.indexOf('const idle = Date.now() - lastActivityTime'), 'before the idle test');
});

// The same mapping, run against the codec tables it exists for.
const MAP = /^(WSPR|JS8|JTTY|PSK\d+)$/i;
function mapMode(m) { return (m && MAP.test(String(m))) ? 'DIGU' : m; }

test('tuneRadio maps WSPR, JS8, JTTY and PSK31 to DIGU before the CAT tune', () => {
  const at = main.indexOf("if (mode && /^(WSPR|JS8|JTTY|PSK\\d+)$/i.test(String(mode))) mode = 'DIGU';");
  assert.ok(at > 0, 'mapping present');
  const tune = main.indexOf('cat.tune(tuneFreqHz, mode,', at);
  assert.ok(tune > at && tune - at < 3000, 'just before cat.tune');
});
test('every mapped name lands on a mode the CI-V, Kenwood/Yaesu and rigctld codecs can set', () => {
  for (const m of ['WSPR', 'JS8', 'JTTY', 'PSK31', 'wspr']) assert.strictEqual(mapMode(m), 'DIGU', m);
  for (const m of ['FT8', 'USB', 'LSB', 'CW', 'PSK', 'DIGU', '']) assert.strictEqual(mapMode(m), m, 'unchanged: ' + m);
  const civ = fs.readFileSync(path.join(__dirname, '..', 'lib', 'codecs', 'civ-codec.js'), 'utf8');
  const ken = fs.readFileSync(path.join(__dirname, '..', 'lib', 'codecs', 'kenwood-codec.js'), 'utf8');
  const rig = fs.readFileSync(path.join(__dirname, '..', 'lib', 'codecs', 'rigctld-codec.js'), 'utf8');
  assert.ok(/'DIGU':\s*\{ civMode: 0x01, dataMode: true \}/.test(civ), 'CI-V has DIGU');
  assert.strictEqual((ken.match(/'DIGU':\s*\{ md:/g) || []).length, 2, 'Kenwood and Yaesu tables have DIGU');
  assert.ok(/'DIGU': 'PKTUSB'/.test(rig), 'rigctld has DIGU');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
