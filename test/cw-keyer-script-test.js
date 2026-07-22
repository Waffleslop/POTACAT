// buildPersistentKeyerScript — the inline Python for the persistent CW keyer
// used on TIOCMSET-rejecting serial ports (Linux cp210x). The generated script
// must be syntactically sane, key the CORRECT modem line, embed the port path +
// morse table safely, and expose the paddle (1/0) + text (T) command dispatch.
// Run: node test/cw-keyer-script-test.js
'use strict';

const assert = require('assert');
const { buildPersistentKeyerScript } = require('../lib/cw-keyer-script');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}

const MORSE = { A: '.-', B: '-...', Q: '--.-' };

console.log('Pin selection drives the right modem line:');
const dtr = buildPersistentKeyerScript({ portPath: '/dev/ttyUSB1', line: 'dtr', morse: MORSE });
check(dtr.includes('    port.dtr = on\n') && !dtr.includes('port.rts = on'), 'dtr → keys DTR only');
const rts = buildPersistentKeyerScript({ portPath: '/dev/ttyUSB1', line: 'rts', morse: MORSE });
check(rts.includes('    port.rts = on\n') && !rts.includes('port.dtr = on'), 'rts → keys RTS only');
const both = buildPersistentKeyerScript({ portPath: '/dev/ttyUSB1', line: 'both', morse: MORSE });
check(both.includes('    port.dtr = on\n') && both.includes('    port.rts = on\n'), 'both → keys DTR and RTS');
const dflt = buildPersistentKeyerScript({ portPath: '/x', line: 'nonsense', morse: MORSE });
check(dflt.includes('    port.dtr = on\n') && !dflt.includes('port.rts = on'), 'unknown line → DTR default');

console.log('Command dispatch is present:');
check(dtr.includes('if cmd == "Q": break'), 'Q quits');
check(dtr.includes('elif cmd == "1": key(True)'), '1 = key down');
check(dtr.includes('elif cmd == "0": key(False)'), '0 = key up');
check(dtr.includes('elif cmd == "A": key(False)'), 'A = abort/key up');
check(dtr.includes('elif cmd[:1] == "T":'), 'T = text render');
check(dtr.includes('select.select([sys.stdin]'), 'reads stdin via select (real-time)');
check(dtr.includes('port.dtr = False') && dtr.includes('port.rts = False') && dtr.indexOf('port.open()') > dtr.indexOf('port.dtr = False'),
  'both lines forced low BEFORE open (no key blip on open)');

console.log('Port path + morse embedded safely:');
check(dtr.includes("port.port = '/dev/ttyUSB1'"), 'port path embedded');
const inj = buildPersistentKeyerScript({ portPath: "/x'; import os#", line: 'dtr', morse: MORSE });
check(!inj.includes("import os'") && !inj.includes("\\'"), 'quotes/backslashes stripped from path (no injection)');
check(dtr.includes('json.loads('), 'morse loaded as JSON');
check(dtr.includes('--.-'), 'morse table content embedded (Q = --.-)');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
