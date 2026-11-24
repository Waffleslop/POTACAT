#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
/**
 * #944: on a desktop driving a shack, the shack's frequency reached the main,
 * JS8 and SSTV windows but not the Band Scope window, so the scope kept the
 * frequency it opened with (readout and tuning lines frozen) while clicks
 * still tuned the radio (geoolddude, 1.14.7, Mac to a Windows shack).
 *
 * Run: node test/remote-scope-freq-test.js
 */
const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const main = readSrc(path.join(__dirname, '..', 'main.js')).replace(/\r\n/g, '\n');

test('the remote snapshot passes the dial to the Band Scope window too', () => {
  const m = main.match(/for \(const w of \[([^\]]*)\]\) \{\n\s*if \(!w \|\| w\.isDestroyed\(\)\) continue;\n\s*if \(typeof snap\.freq === 'number' && snap\.freq > 0\) w\.webContents\.send\('cat-frequency', snap\.freq\);/);
  assert.ok(m, 'the remote snapshot fan-out');
  const list = m[1].split(',').map((x) => x.trim());
  assert.ok(list.includes('scopePopoutWin'), 'Band Scope window in the list: ' + m[1]);
  for (const w of ['win', 'js8PopoutWin', 'sstvPopoutWin']) assert.ok(list.includes(w), w + ' still there');
});
test('the scope window moves on cat-frequency', () => {
  const sp = readSrc(path.join(__dirname, '..', 'renderer', 'scope-popout.js'));
  assert.ok(/onCatFrequency/.test(sp));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
