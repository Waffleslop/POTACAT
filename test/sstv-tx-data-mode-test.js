#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
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
const src = readSrc(path.join(__dirname, '..', 'main.js')).replace(/\r\n/g, '\n');

console.log('sstv tx data mode');

test('SSTV key-down declares audio and forces data mode on an Icom', () => {
  const at = src.indexOf("sstvEngine.on('encode-complete'");
  assert.ok(at > 0, 'encode-complete handler not found');
  const handler = src.slice(at, at + 3000);
  assert.ok(/const _sstvIcom = detectRigType\(\) === 'icom' \|\| \(getActiveRigModel\(\)\?\.brand === 'Icom'\);/.test(handler), 'Icom detection');
  assert.ok(/handleRemotePtt\(true, \{ audio: true, forceDataMode: _sstvIcom, emission: 'SSTV', txKind: 'sstv'(, lanOwner: [^}]+)? \}\) === false\) \{/.test(handler), 'key-down options (SSTV is judged where phone goes)');
  assert.ok(!/handleRemotePtt\(true\);/.test(handler), 'a bare key-down is back');
});

test('handleRemotePtt honours forceDataMode even with SSB-over-DATA off or JTCAT loaded', () => {
  // The rule lives in lib/rig-audio-jack.js pttDataPlan (#153): forced stands on a
  // data-jack rig (every rig before #153); a microphone-jack rig never switches.
  assert.ok(/forced: !!opts\.forceDataMode,/.test(src));
  assert.ok(/const forceData = _dataPlanJack\.forceData;/.test(src));
  const J = require('../lib/rig-audio-jack');
  const p = J.pttDataPlan({ jack: 'data', voiceSwitch: null, ssbOverData: false, forced: true });
  assert.ok(p.want && p.forceData, 'forced switches with SSB-over-DATA off');
  // `&& !opts.noDataSwap`: only Station Setup's voice test sets it (never SSTV).
  assert.ok(/if \(state && _dataPlanJack\.want && !opts\.noDataSwap && !yaesuVoice && !voiceInData && audioActive && \(!ft8Engine \|\| forceData\)\) \{/.test(src));
});

test('voice on a Yaesu never goes to DATA-U (K3SBP FT-710 voice macros)', () => {
  // The rule is lib/rig-audio-jack.js pttDataPlan (#153): unset, voice on a Yaesu
  // stays in USB/LSB; only the rig's own tick box switches it.
  assert.ok(/yaesu: !!\(_pttRig && _pttRig\.brand === 'Yaesu'\),/.test(src), 'yaesu fed to the rule');
  assert.ok(/const yaesuVoice = _dataPlanJack\.yaesuVoice;/.test(src), 'yaesuVoice rule');
  const J = require('../lib/rig-audio-jack');
  assert.strictEqual(J.pttDataPlan({ jack: 'data', voiceSwitch: null, ssbOverData: true, yaesu: true }).yaesuVoice, true);
  assert.strictEqual(J.pttDataPlan({ jack: 'data', voiceSwitch: null, ssbOverData: true, yaesu: true, freedvRunning: true }).yaesuVoice, false);
  const at = src.indexOf('const yaesuVoice');
  const sw = src.indexOf('&& !yaesuVoice && !voiceInData && audioActive');
  assert.ok(at > 0 && sw > at, 'the rule is decided before the mode switch');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
