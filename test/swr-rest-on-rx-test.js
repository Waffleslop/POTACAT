#!/usr/bin/env node
'use strict';
// SWR and ALC read only while transmitting, so on receive the last TX value
// stayed on every display (davidcappello, IC-9700 over LAN: "SWR stays at the
// last TX value"). Back on receive they rest: SWR 1.0 (wire 0) and ALC 0.
// Also pins the Icom SWR scale (CI-V 15 12) to Hamlib's IC7300_SWR_CAL, the
// same on the IC-7100/7300/7610/9700/705.
// Run: node test/swr-rest-on-rx-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

// Run the real txMetersRestOnRx against fakes.
function restFn() {
  const i = main.indexOf('function txMetersRestOnRx() {');
  assert.ok(i > 0, 'txMetersRestOnRx exists');
  const src = main.slice(i, main.indexOf('\n}\n', i) + 2);
  return (state) => {
    const sent = [];
    // eslint-disable-next-line no-new-func
    new Function('state', 'sendCatSwr', 'sendCatAlc', `let _currentSwr = state.swr, _currentAlc = state.alc;\n${src}\ntxMetersRestOnRx();`)(
      state, (v) => sent.push(['swr', v]), (v) => sent.push(['alc', v]));
    return sent;
  };
}

test('after TX the SWR and ALC displays go back to rest', () => {
  assert.deepStrictEqual(restFn()({ swr: 48, alc: 120 }), [['swr', 0], ['alc', 0]]);
});

test('already at rest: nothing is sent', () => {
  assert.deepStrictEqual(restFn()({ swr: 0, alc: 0 }), []);
});

test('it runs on POTACAT\'s own release and when the radio reports receive', () => {
  assert.ok(/controller\.on\('ptt', \(on\) => \{ if \(!on && controller === cat\) txMetersRestOnRx\(\); \}\);/.test(main));
  const i = main.indexOf('function handleRemotePtt(state, opts = {}) {');
  const body = main.slice(i, main.indexOf('\nfunction _isEffectivelyTransmitting', i));
  assert.ok(/if \(!state\) setTimeout\(\(\) => \{ if \(!_remoteTxState && !\(cat && cat\._transmitting\)\) txMetersRestOnRx\(\); \}, 600\);/.test(body));
});

test('Icom SWR scale: 0 = 1.0, 48 = 1.5, 80 = 2.0, 120 = 3.0 (wire = (ratio - 1) x 60)', () => {
  const civ = fs.readFileSync(path.join(__dirname, '..', 'lib', 'codecs', 'civ-codec.js'), 'utf8');
  assert.ok(/const ICOM_SWR_CAL = \[\[0, 1\.0\], \[48, 1\.5\], \[80, 2\.0\], \[120, 3\.0\], \[240, 6\.0\], \[255, 6\.25\]\];/.test(civ));
  assert.ok(/this\._sendCmd\(0x15, 0x12\)/.test(civ));
});

console.log(`\nSWR rests on RX: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
