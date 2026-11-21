#!/usr/bin/env node
'use strict';
// NJ2DX 2026-11-21 (IC-7300): from CW with a 500 Hz filter to FT8, the radio
// decoded fine on its wide data filter but the VFO window still said 500 Hz.
// POTACAT only ever SET an Icom's IF filter width (1A 03 <index>), never read
// it, so the display kept the last width it set. 1A 03 with no data reads it
// ("Sets or reads the IF filter width", IC-7300MK2 CI-V Reference Guide p.6;
// the index table, p.19, is the one setFilterWidth already uses).
// Run: node test/icom-filter-readback-test.js

const assert = require('assert');
const { CivCodec } = require('../lib/codecs/civ-codec');
const { getModel } = require('../lib/rig-models');

let pass = 0, fail = 0;
function test(name, fn) {
  try { const r = fn(); if (r && typeof r.then === 'function') return; pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

function ic7300() {
  const writes = [];
  const c = new CivCodec(getModel('IC-7300'), (b) => writes.push(Buffer.from(b).toString('hex')));
  const passbands = [], logs = [];
  c.on('passband', (hz) => passbands.push(hz));
  c.on('log', (l) => logs.push(l));
  return { c, writes, passbands, logs };
}
// FE FE E0 94 <cmd...> FD from the radio
const fromRadio = (c, hex) => c.onData(Buffer.from('fefee094' + hex + 'fd', 'hex'));

console.log('Icom IF filter width read back');

test('the read is 1A 03 with no data', () => {
  const { c, writes } = ic7300();
  c._lastMode = 'USB';
  c.getFilter();
  assert.deepStrictEqual(writes, ['fefe94e01a03fd']);
});

test('the answer is the radio\'s real width, from the same index table as the set', () => {
  const { c, passbands } = ic7300();
  c._lastMode = 'CW';
  fromRadio(c, '1a0309'); // index 9 = 500 Hz
  c._lastMode = 'USB';
  fromRadio(c, '1a0333'); // index 33 = 2900 Hz
  fromRadio(c, '1a0340'); // index 40 = 3600 Hz
  fromRadio(c, '1a0300'); // index 0 = 50 Hz
  c._lastMode = 'AM';
  fromRadio(c, '1a0349'); // AM index 49 = 10000 Hz
  assert.deepStrictEqual(passbands, [500, 2900, 3600, 50, 10000]);
});

test('NJ2DX: CW 500 Hz, then the radio reports a data mode: the width is read at once and the 500 goes', () => {
  const { c, writes, passbands } = ic7300();
  fromRadio(c, '040301');            // mode CW, FIL1
  fromRadio(c, '1a0309');            // 500 Hz
  writes.length = 0;
  return new Promise((resolve, reject) => {
    fromRadio(c, '040101');          // mode USB (the FT8 tune), FIL1
    setTimeout(() => {
      try {
        assert.ok(writes.includes('fefe94e01a03fd'), 'asked for the width after the mode change: ' + writes.join(' '));
        fromRadio(c, '1a0330');      // 2600 Hz
        assert.deepStrictEqual(passbands, [500, 2600]);
        resolve();
      } catch (e) { reject(e); }
    }, 320);
  }).then(() => { pass++; console.log('  ok  (async) the 500 Hz gave way to 2600 Hz'); }, (e) => { fail++; console.log('  FAIL (async) ' + e.message); });
});

test('FM has no width to read', () => {
  const { c, writes } = ic7300();
  c._lastMode = 'FM';
  c.getFilter();
  assert.deepStrictEqual(writes, []);
});

test('a radio that NAKs it three times is not asked again, and says so once', () => {
  const { c, writes, logs } = ic7300();
  c._lastMode = 'USB';
  for (let i = 0; i < 3; i++) { c.getFilter(); fromRadio(c, 'fa'); }
  writes.length = 0;
  c.getFilter();
  assert.deepStrictEqual(writes, [], 'latched off');
  assert.strictEqual(logs.filter((l) => /1A 03\) not supported/.test(l)).length, 1);
});

test('the slow poll reads it on a rig with the filter cap, and the controller passes it on', () => {
  const fs = require('fs');
  const path = require('path');
  const rc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'rig-controller.js'), 'utf8');
  assert.ok(/if \(caps\.filter && typeof this\._codec\.getFilter === 'function'\) this\._codec\.getFilter\(\);/.test(rc));
  assert.ok(/this\._codec\.on\('passband', \(hz\) => this\.emit\('passband', hz\)\);/.test(rc));
  assert.strictEqual(getModel('IC-7300').caps.filter, true);
});

setTimeout(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 600);
