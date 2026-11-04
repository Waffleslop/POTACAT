// test/yaesu-lines-low-test.js — a Yaesu went into TX as POTACAT connected
// (stein FTDX10 2026-11-01, Gavin G5HOW FTDX10 2026-11-03): Windows raises
// DTR/RTS when a port opens and Serial CAT only lowered them with "Disable
// DTR/RTS on connect" ticked. Every Yaesu now drops them at open, live link
// and Test Connection alike.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { getModel, holdSerialLinesLow } = require('../lib/rig-models');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');

console.log('serial lines at open:');
t('every Yaesu holds DTR/RTS low at open, ticked or not', () => {
  for (const m of ['FTDX10', 'FT-710', 'FT-991/991A', 'FT-891', 'FT-817/818']) {
    const model = getModel(m);
    assert.ok(model, m);
    assert.strictEqual(holdSerialLinesLow(model, { dtrOff: false }), true, m);
  }
});
t('other brands follow the operator\'s "Disable DTR/RTS on connect"', () => {
  const k = getModel('TS-590S/SG');
  assert.strictEqual(holdSerialLinesLow(k, { dtrOff: false }), false);
  assert.strictEqual(holdSerialLinesLow(k, { dtrOff: true }), true);
  assert.strictEqual(holdSerialLinesLow(null, {}), false);
});
t('the live Serial CAT connect and Test Connection both use it', () => {
  assert.ok(main.includes('dtrOff: holdSerialLinesLow(model, target), connectDelay: model.connectDelay'), 'connectCat');
  assert.ok(main.includes('const dtrOff = holdSerialLinesLow(model, { dtrOff: config.dtrOff });'), 'test-serial-cat');
});
t('under RTS/CTS flow control only DTR drops (the radio needs RTS to answer)', () => {
  const tr = fs.readFileSync(path.join(__dirname, '..', 'lib', 'transport.js'), 'utf8');
  assert.ok(/hardware \? \{ dtr: false, rts: true \} : \{ dtr: false, rts: false \}/.test(tr));
  assert.ok(/port\.set\(\{ dtr: false, rts: !!rtscts \}\)/.test(main), 'the probe keeps RTS under flow control too');
});
console.log('\nserial lines at open: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
