// Every Test Connection handler that opens a COM port first stops POTACAT's
// own rigctld and waits, as test-serial-cat does. Disconnecting the TCP
// client to rigctld is not enough: rigctld keeps the port open, so the
// Icom CI-V test failed with "Opening COM5: Access denied" for an operator
// moving from a Hamlib rig entry to "Icom (CI-V)" (IC-7100, 1.14.7, #910).
// Run: node test/cat-test-kills-rigctld-test.js
'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const path = require('path');

const main = readSrc(path.join(__dirname, '..', 'main.js')).replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

// Each test handler, from its registration to its own closing "  });"
// (the registrations sit at two-space indent; the body is deeper).
function handlers() {
  const out = [];
  const re = /\n {2}(?:handleCatTest|ipcMain\.handle)\('(test-[\w-]+)'/g;
  let m;
  while ((m = re.exec(main))) {
    const at = m.index + 1;
    const end = main.indexOf('\n  });', at);
    assert.ok(end > at, 'no end found for ' + m[1]);
    out.push({ name: m[1], body: main.slice(at, end) });
  }
  return out;
}

const OPEN = /new SerialPort\(|probeSerialCat\(/;
const serial = handlers().filter((h) => OPEN.test(h.body));

test('the serial and CI-V tests are both found (the guard is not vacuous)', () => {
  const names = serial.map((h) => h.name);
  assert.ok(names.includes('test-serial-cat'), names.join(', '));
  assert.ok(names.includes('test-icom-civ'), names.join(', '));
});

for (const h of serial) {
  test(h.name + ': killRigctld() and a wait come before the port is opened', () => {
    const open = h.body.search(OPEN);
    const kill = h.body.indexOf('killRigctld()');
    assert.ok(kill >= 0 && kill < open, h.name + ' opens the port without killRigctld() first');
    const between = h.body.slice(kill, open);
    assert.ok(/setTimeout\(|waitForSerialPortFree\(/.test(between),
      h.name + ' opens the port without waiting for it after killRigctld()');
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
