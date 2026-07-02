// CW paddle availability — will a remote key-press make real CW, or dead-key PTT?
// Regression for G5HOW (FTDx10): the paddle route on Yaesu/Kenwood serial rigs
// is bare PTT (TX1;/TX0;) — transmitter keys with no CW output or sidetone. The
// desktop must know this proactively at rig-connect so the phone blocks the
// press instead of dead-keying. Run: node test/cw-paddle-availability-test.js
'use strict';

const assert = require('assert');
const { cwPaddleAvailability } = require('../lib/cw-paddle-availability');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
function expect(input, wantAvail, wantReason, label) {
  const r = cwPaddleAvailability(input);
  check(r.available === wantAvail && r.reason === wantReason,
    `${label} → available=${r.available} reason=${r.reason}`);
}

console.log('Yaesu/Kenwood serial txrx dead-keys:');
// FTDX10 / FT-991 / FTDX101 etc: paddleKey 'txrx', protocol 'kenwood'.
expect({ transportType: 'serial', paddleKey: 'txrx', protocol: 'kenwood', hasKeyPort: false },
  false, 'txrx-ptt-only', 'Yaesu txrx, no key port');
// paddleKey may be unset on some kenwood models → defaults to 'txrx'.
expect({ transportType: 'serial', paddleKey: undefined, protocol: 'kenwood', hasKeyPort: false },
  false, 'txrx-ptt-only', 'kenwood default (no paddleKey), no key port');

console.log('A dedicated CW Key Port always keys for real:');
expect({ transportType: 'serial', paddleKey: 'txrx', protocol: 'kenwood', hasKeyPort: true },
  true, null, 'Yaesu txrx WITH key port configured');
expect({ transportType: 'rigctld', paddleKey: 'txrx', protocol: 'kenwood', hasKeyPort: true },
  true, null, 'rigctld WITH key port configured');

console.log('rigctld has no per-element CW keying:');
expect({ transportType: 'rigctld', paddleKey: 'dtr', protocol: 'civ', hasKeyPort: false },
  false, 'rigctld-no-per-element-cw', 'rigctld, no key port (any model)');

console.log('Real key-line routes stay available:');
// Icom 'txrx' is a real CI-V key line (0x1C 0x01), NOT the Yaesu dead PTT.
expect({ transportType: 'serial', paddleKey: 'txrx', protocol: 'civ', hasKeyPort: false },
  true, null, 'Icom txrx (CI-V key line)');
expect({ transportType: 'serial', paddleKey: 'dtr', protocol: 'civ', hasKeyPort: false },
  true, null, 'Icom DTR keying');
expect({ transportType: 'serial', paddleKey: 'dtr', protocol: 'kenwood', hasKeyPort: false },
  true, null, 'Kenwood DTR keying (not the txrx route)');
// Flex via SmartSDR keys through the TCP API, not CAT.
expect({ transportType: 'flex', paddleKey: 'txrx', protocol: 'smartsdr', hasKeyPort: false },
  true, null, 'Flex/SmartSDR');

console.log('Precedence: key port beats rigctld beats kenwood-txrx:');
expect({ transportType: 'rigctld', paddleKey: 'txrx', protocol: 'kenwood', hasKeyPort: false },
  false, 'rigctld-no-per-element-cw', 'Yaesu-over-rigctld reports the rigctld reason');
expect({}, true, null, 'empty input defaults available (older/unknown desktops assume OK)');

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, 'cw-paddle-availability tests failed');
