// resolveCwKeyPins — which serial modem-control line(s) key CW on the main CAT
// port. The per-rig cwKeyLine override must beat the rig-model default so an
// operator can match their radio's USB Keying (CW) = DTR/RTS menu, and every
// result must name BOTH lines explicitly (so the caller can force the un-keyed
// line low — node-serialport #2636). Run: node test/cw-key-line-test.js
'use strict';

const assert = require('assert');
const { resolveCwKeyPins } = require('../lib/cw-key-line');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
function expect(input, wantDtr, wantRts, label) {
  const r = resolveCwKeyPins(input);
  check(r.dtr === wantDtr && r.rts === wantRts,
    `${label} → dtr=${r.dtr} rts=${r.rts} (want dtr=${wantDtr} rts=${wantRts})`);
}

console.log('Explicit override wins over the model default:');
expect({ modelPins: { dtr: false, rts: true }, cwKeyLine: 'dtr' }, true, false, 'override DTR beats model RTS');
expect({ modelPins: { dtr: true, rts: false }, cwKeyLine: 'rts' }, false, true, 'override RTS beats model DTR');
expect({ modelPins: { dtr: true, rts: false }, cwKeyLine: 'both' }, true, true, 'override BOTH');

console.log('Auto / unset / unknown falls back to the model default:');
expect({ modelPins: { dtr: false, rts: true }, cwKeyLine: 'auto' }, false, true, 'auto → RTS model (IC-7300)');
expect({ modelPins: { dtr: true, rts: false }, cwKeyLine: 'auto' }, true, false, 'auto → DTR model');
expect({ modelPins: { dtr: false, rts: true } }, false, true, 'no cwKeyLine → model default');
expect({ modelPins: { dtr: true, rts: true }, cwKeyLine: 'nonsense' }, true, true, 'unknown value → model default');

console.log('Case-insensitive override:');
expect({ modelPins: { dtr: true, rts: false }, cwKeyLine: 'RTS' }, false, true, 'uppercase RTS');
expect({ modelPins: { dtr: true, rts: false }, cwKeyLine: 'Dtr' }, true, false, 'mixed-case Dtr');

console.log('Missing model default is safe (defaults to DTR-only):');
expect({}, true, false, 'empty input → dtr-only default');
expect({ cwKeyLine: 'rts' }, false, true, 'override with no model pins');
expect({ modelPins: null, cwKeyLine: 'auto' }, true, false, 'null modelPins → dtr-only');

console.log('Result always names both lines (no undefined that could latch):');
const keys = resolveCwKeyPins({ modelPins: { dtr: true }, cwKeyLine: 'auto' });
check(typeof keys.dtr === 'boolean' && typeof keys.rts === 'boolean',
  `both lines boolean → dtr=${keys.dtr} rts=${keys.rts}`);

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, 'cw-key-line tests failed');
