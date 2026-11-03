#!/usr/bin/env node
'use strict';
// nj7n_nate (IC-705 on a Pi, ECHOCAT): two repeater memories with a NEGATIVE
// offset keyed fine from the hand mic, but every ECHOCAT PTT went out with a
// POSITIVE offset. With SSB-over-DATA on, the PTT swaps FM to FM-D (so the
// phone's USB audio reaches the transmitter) and back, and setModeOnly
// re-sent the frequency 200 ms after each mode set: a re-anchor that exists
// for a Yaesu, whose dial moves on a mode change. A frequency set takes an
// Icom out of MEMORY mode into the VFO, with the VFO's own duplex. An Icom
// never moves its dial on a mode change, so it gets no re-anchor there.
// Run: node test/icom-ptt-memory-mode-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

function makeRig() {
  const codec = new EventEmitter();
  codec.sent = [];
  codec.setMode = (m, hz) => codec.sent.push(['mode', m, hz]);
  codec.setFrequency = (hz) => codec.sent.push(['freq', hz]);
  codec.resolveMode = (m) => m;
  const transport = new EventEmitter();
  transport.write = () => {};
  const rig = new RigController({ brand: 'Icom', tune: {} }, transport, codec);
  rig.connected = true;
  rig._startPolling = () => {};
  rig._stopPolling = () => {};
  return { rig, codec };
}
const flush = (rig) => { for (const t of rig._pendingTimers.splice(0)) { clearTimeout(t); } };
const runTimers = async () => new Promise((r) => setTimeout(r, 260));

console.log('Icom PTT mode swap and memory mode');
(async () => {
  {
    const { rig, codec } = makeRig();
    rig.setModeOnly('DIGFM', 146940000, { noAnchor: true });
    await runTimers();
    test('noAnchor: the mode goes out, with its frequency for the sideband, and no frequency set follows', () => {
      assert.deepStrictEqual(codec.sent, [['mode', 'DIGFM', 146940000]]);
    });
    flush(rig);
  }
  {
    const { rig, codec } = makeRig();
    rig.setModeOnly('PKTUSB', 14074000);
    await runTimers();
    test('without it (a Yaesu): the re-anchor still follows the mode', () => {
      assert.deepStrictEqual(codec.sent, [['mode', 'PKTUSB', 14074000], ['freq', 14074000]]);
    });
    flush(rig);
  }
  test('main.js: an Icom swap and its restore both skip the re-anchor', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(/cat\.setModeOnly\(dataMode, _ssbFreqBeforePtt, \{ noAnchor: _icomData \}\)/.test(main), 'the swap');
    assert.ok(/cat\.setModeOnly\(restoreMode, restoreFreq, \{ noAnchor: _restoreIcom \}\)/.test(main), 'the restore');
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
