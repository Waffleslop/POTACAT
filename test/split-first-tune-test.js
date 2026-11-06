// test/split-first-tune-test.js — GitHub #113 item 2 (mdeltito, FT-710):
// the first tune of every session sent split OFF (`ST0;`), cancelling a
// split the operator had set on the radio. POTACAT now sends split off only
// to undo a split it turned on itself.
'use strict';
const { readSrc } = require('./_src');
const assert = require('assert');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
const settle = () => new Promise(r => setTimeout(r, 450));

function rig() {
  const codec = new EventEmitter();
  codec.calls = [];
  codec.resolveMode = (m) => m;
  for (const fn of ['setMode', 'setFrequency', 'setFilterWidth', 'setXit', 'poll', 'getFilter']) codec[fn] = () => {};
  codec.setSplit = (on) => codec.calls.push(on);
  const transport = new EventEmitter();
  transport.write = () => {};
  const cat = new RigController({ brand: 'Yaesu', tune: {} }, transport, codec);
  cat.connected = true;
  cat._startPolling = () => {};
  cat._stopPolling = () => {};
  return { cat, codec };
}

(async () => {
  console.log('split on tune:');
  await t('the first tune after connect sends no split command (an operator split survives)', async () => {
    const { cat, codec } = rig();
    cat.tune(14074000, 'USB', { split: false });
    await settle();
    cat.tune(14075000, 'USB', { split: false });
    await settle();
    assert.deepStrictEqual(codec.calls, []);
  });
  await t('split asked for: on once, then off once when no longer asked', async () => {
    const { cat, codec } = rig();
    cat.tune(14195000, 'USB', { split: true });
    await settle();
    cat.tune(14196000, 'USB', { split: true });
    await settle();
    cat.tune(14074000, 'USB', { split: false });
    await settle();
    cat.tune(14075000, 'USB', { split: false });
    await settle();
    assert.deepStrictEqual(codec.calls, [true, false]);
  });
  await t('an explicit setSplit(false) counts as ours: the next tune sends nothing more', async () => {
    const { cat, codec } = rig();
    cat.setSplit(false);
    cat.tune(14074000, 'USB', { split: false });
    await settle();
    assert.deepStrictEqual(codec.calls, [false]);
  });
  console.log('mode, frequency, then key (#113 item 1):');
  await t('the PTT path re-sends the frequency right after the mode, before the key-down', async () => {
    const { cat, codec } = rig();
    const order = [];
    codec.setMode = (m) => order.push('mode ' + m);
    codec.setFrequency = (hz) => order.push('freq ' + hz);
    codec.setTransmit = (on) => order.push('tx ' + on);
    cat.setModeOnly('PKTUSB', 14250000, { anchorNow: true });
    cat.setTransmit(true);
    assert.deepStrictEqual(order, ['mode PKTUSB', 'freq 14250000', 'tx true']);
    await settle();
    assert.deepStrictEqual(order, ['mode PKTUSB', 'freq 14250000', 'tx true'], 'no second frequency write during TX');
  });
  await t('without anchorNow (the key-up restore) the re-anchor still waits 200 ms', async () => {
    const { cat, codec } = rig();
    const order = [];
    codec.setMode = (m) => order.push('mode ' + m);
    codec.setFrequency = (hz) => order.push('freq ' + hz);
    cat.setModeOnly('USB', 14250000);
    assert.deepStrictEqual(order, ['mode USB']);
    await settle();
    assert.deepStrictEqual(order, ['mode USB', 'freq 14250000']);
  });
  await t('main.js keys SSB-over-DATA with anchorNow', () => {
    const src = readSrc(require('path').join(__dirname, '..', 'main.js'));
    assert.ok(/cat\.setModeOnly\(dataMode, _ssbFreqBeforePtt, \{ noAnchor: _icomData, anchorNow: true \}\)/.test(src));
  });
  console.log('\nsplit on tune: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
