#!/usr/bin/env node
'use strict';
// SSTV transmit reaches the rig through its USB audio, so the key-down must
// say it carries audio (SSB-over-DATA) and, on an Icom, must switch to
// USB-D/LSB-D for the transmission: the IC-7300's factory DATA OFF MOD is
// MIC,ACC, so plain USB keyed with no audio (WB8IMY, 2026-09-26).
// Run: node test/sstv-tx-data-mode-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

console.log('sstv tx data mode');

test('SSTV key-down declares audio and forces data mode on an Icom', () => {
  const at = src.indexOf("sstvEngine.on('encode-complete'");
  assert.ok(at > 0, 'encode-complete handler not found');
  const handler = src.slice(at, at + 3000);
  assert.ok(/const _sstvIcom = detectRigType\(\) === 'icom' \|\| \(getActiveRigModel\(\)\?\.brand === 'Icom'\);/.test(handler), 'Icom detection');
  assert.ok(/handleRemotePtt\(true, \{ audio: true, forceDataMode: _sstvIcom \}\);/.test(handler), 'key-down options');
  assert.ok(!/handleRemotePtt\(true\);/.test(handler), 'a bare key-down is back');
});

test('handleRemotePtt honours forceDataMode even with SSB-over-DATA off or JTCAT loaded', () => {
  assert.ok(/const forceData = !!opts\.forceDataMode;\n\s*if \(state && \(settings\.ssbOverData \|\| forceData\) && audioActive && \(!ft8Engine \|\| forceData\)\) \{/.test(src));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
