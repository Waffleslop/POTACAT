#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// A perfect match shows 1.0 while transmitting, not a dash (IC-7100 with an
// external tuner, November 2026). A radio reports 1.0:1 as wire 0; on receive
// 0 is the rest value POTACAT sends after TX and stays a dash.
// Run: node test/swr-display-test.js
const assert = require('assert');
const path = require('path');
const S = require('../lib/swr-display');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const root = path.join(__dirname, '..');
const src = (f) => readSrc(path.join(root, f));

test('0 while transmitting is 1.0; 0 on receive is a dash', () => {
  assert.strictEqual(S.ratio(0, true), 1);
  assert.strictEqual(S.text(S.ratio(0, true)), '1.0');
  assert.strictEqual(S.ratio(0, false), null);
  assert.strictEqual(S.text(S.ratio(0, false)), '—');
});
test('a value above 0 is its ratio on TX and RX (ratio = 1 + value / 60)', () => {
  for (const tx of [true, false]) {
    assert.strictEqual(S.text(S.ratio(30, tx)), '1.5');
    assert.strictEqual(S.text(S.ratio(60, tx)), '2.0');
    assert.strictEqual(S.text(S.ratio(255, tx)), '5.3');
  }
  assert.strictEqual(S.text(11), '>10');
});
test('nothing yet, or nonsense, is a dash even while transmitting', () => {
  for (const v of [null, undefined, NaN, 'x', -5]) {
    assert.strictEqual(S.text(S.ratio(v, true)), '—', String(v));
  }
});

test('the main window meter box uses it with the TX state and redraws on key-up', () => {
  const app = src('renderer/app.js');
  assert.ok(/SwrDisplay\.ratio\(meterSwrWire, meterTxOn\)/.test(app));
  assert.ok(/onRemoteTxState\(\(on\) => \{\s*meterTxOn = !!on;\s*if \(!meterTxOn && meterSwrWire === 0\) drawSwrMeter\(\)/.test(app));
  assert.ok(/<script src="\.\.\/lib\/swr-display\.js"><\/script>/.test(src('renderer/index.html')));
});
test('the VFO window uses it with the TX state it already has and redraws on key-up', () => {
  const vfo = src('renderer/vfo-popout.html');
  assert.ok(/SwrDisplay\.ratio\(lastSwrWire, VfoMonitorTxMute\.transmitting\(pttDown, vfoRadioTx\)\)/.test(vfo));
  assert.ok(/if \(lastSwrWire === 0\) drawSwrRow\(\)/.test(vfo));
  assert.ok(vfo.indexOf('<script src="../lib/swr-display.js"></script>') > 0);
});
test('ECHOCAT Web no longer skips 0: it uses txState, inlines the module, redraws on key-up', () => {
  const remote = src('renderer/remote.js');
  assert.ok(/SwrDisplay\.ratio\(val, txState\)/.test(remote));
  assert.ok(!/if \(!echoMeterEnabled \|\| val <= 0\) return;/.test(remote), 'the old skip is gone');
  assert.ok(/if \(!s\.txState && echoSwrWire === 0\) updateEchoSwr\(0\)/.test(remote));
  assert.ok(/\['swr-display-js', 'swr-display\.js'\]/.test(src('lib/remote-server.js')));
  assert.ok(/<!-- swr-display-js -->/.test(src('renderer/remote.html')));
});
test('this test is in the list CI runs', () => {
  assert.ok(src('scripts/run-tests.js').includes("'test/swr-display-test.js'"));
});

console.log(`\nSWR display: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
