#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
/**
 * #931: WinlinkState.setModes kept id, available, reason and label and dropped
 * each mode's `note`, so the caveat lib/winlink-modes.js writes for a radio
 * mode the operator must set by hand ("no CAT control": ARDOP, packet,
 * Mercury) never reached the Winlink window, which shows m.note next to
 * Connect (renderer/winlink-popout.js). Found while building #930.
 *
 * Run: node test/winlink-mode-note-test.js
 */
const assert = require('assert');
const path = require('path');
const { WinlinkState } = require('../lib/winlink-state');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const NOTE = 'No CAT control: set the radio to the gateway frequency yourself.';

test('a mode note survives setModes into the snapshot', () => {
  const s = new WinlinkState();
  s.setModes([
    { id: 'ardop', label: 'ARDOP', available: true, reason: '', note: NOTE },
    { id: 'packet', label: 'Packet', available: true, reason: '', note: 'FM note' },
    { id: 'telnet', label: 'Internet', available: true, reason: '' },
  ]);
  const m = s.snapshot().modes;
  assert.strictEqual(m.find((x) => x.id === 'ardop').note, NOTE);
  assert.strictEqual(m.find((x) => x.id === 'packet').note, 'FM note');
  assert.strictEqual(m.find((x) => x.id === 'telnet').note, '', 'no note: empty, never undefined');
});
test('the other fields are unchanged', () => {
  const s = new WinlinkState();
  s.setModes([{ id: 'mercury', available: 0, reason: 'not installed' }]);
  assert.deepStrictEqual(s.snapshot().modes[0], { id: 'mercury', available: false, reason: 'not installed', label: 'mercury', note: '' });
});
test('the Winlink window reads m.note', () => {
  const pop = readSrc(path.join(__dirname, '..', 'renderer', 'winlink-popout.js'));
  assert.ok(/if \(m\.note\) note = m\.note;/.test(pop));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
