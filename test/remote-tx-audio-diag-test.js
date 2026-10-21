#!/usr/bin/env node
'use strict';
// KI7LIK (IC-7300 on Linux, 2026-10-20): "able to PTT but it doesn't seem to
// be modulating." His log showed the [PTT] mode swaps and nothing about the
// audio: the bridge logged the RX capture device but never the device the
// phone's microphone is PLAYED to, and its TX peak meter fed the VFO window
// and the phone, never the log. Two lines close that gap.
// Run: node test/remote-tx-audio-diag-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('Remote TX audio diagnostics');
const main = R('main.js'), bridge = R('renderer/remote-audio.html');

test('bridge: when the device track arrives it names the output it plays to (label, default, missing, or dax_tx)', () => {
  const on = bridge.slice(bridge.indexOf('pc.ontrack = async (event) => {'), bridge.indexOf('pc.ontrack = async (event) => {') + 1400);
  assert.ok(/sendAudioStatus\(\{ txOutputLabel: label \}\)/.test(on));
  assert.ok(/the system default output \(set the rig\\?'s audio Output in Settings > My Rigs\)/.test(on), 'unset id = default output, named as such');
  assert.ok(/x\.kind === 'audiooutput' && x\.deviceId === config\.outputDeviceId/.test(on), 'label resolved by id');
  assert.ok(/an output device that is not present/.test(on), 'a stale id says so');
  assert.ok(/SmartSDR direct \(dax_tx stream\)/.test(on));
  assert.ok(/playing the device's microphone to: \$\{status\.txOutputLabel\}/.test(main), 'main logs it');
});

test('main: one line per remote press — peak dBFS, or SILENT', () => {
  assert.ok(/^const _remoteTxPress = \{ on: false, peak: 0, since: 0 \};/m.test(main));
  assert.ok(/^const REMOTE_TX_SILENT_PEAK = 0\.003;/m.test(main), '≈ -50 dBFS');
  assert.ok(/remoteServer\.on\('ptt', \(\{ state \}\) => \{\n\s*const _pttT0 = Date\.now\(\);[^\n]*\n[\s\S]{0,600}noteRemoteTxPress\(!!state\);/.test(main), 'hooked on every remote press and release, before the FT8 guard');
  assert.ok(/ipcMain\.on\('remote-audio-tx-meter', \(_e, peak\) => \{\n\s*if \(_remoteTxPress\.on && Number\(peak\) > _remoteTxPress\.peak\) _remoteTxPress\.peak = Number\(peak\);/.test(main), 'the meter feeds the press');
  assert.ok(/device microphone during that \$\{secs\} s press: SILENT/.test(main) && /peak \$\{\(20 \* Math\.log10\(p\)\)\.toFixed\(0\)\} dBFS/.test(main));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
