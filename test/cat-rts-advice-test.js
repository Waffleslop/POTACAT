#!/usr/bin/env node
'use strict';
// #849: a toast and the rig-editor help told the operator to set the radio's
// CAT RTS menu to ENABLE, the opposite of the rig setup notes (FT-991A: "Set
// CAT RTS to DISABLE", lib/rig-setup-notes.js). And the toast fires only on a
// network CAT link (lib/cat.js CatClient: TCP and the K4 on the network),
// where no serial RTS line exists at all. A direct-serial radio that waits for
// RTS is tried with RTS/CTS by POTACAT itself (main.js serial handshake trial),
// so nothing asks the operator to change that menu by hand.
// Run: node test/cat-rts-advice-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('renderer/app.js');
const html = read('renderer/index.html');
const main = read('main.js');

console.log('CAT RTS advice (#849)');

test('no surface tells the operator to set the radio\'s CAT RTS menu to Enable', () => {
  for (const [name, src] of [['renderer/app.js', app], ['renderer/index.html', html], ['main.js', main], ['renderer/remote.js', read('renderer/remote.js')]]) {
    assert.ok(!/CAT RTS[^.<]*\bto Enable\b/i.test(src), name + ' still says to set CAT RTS to Enable');
  }
});

test('the tune-unconfirmed warning says what POTACAT saw and that it is a network link, not an RTS setting', () => {
  const m = app.match(/function catTuneUnconfirmedText\(info\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'catTuneUnconfirmedText in app.js');
  // eslint-disable-next-line no-new-func
  const fn = new Function(m[0] + '\nreturn catTuneUnconfirmedText;')();
  const t = fn({ targetHz: 14074000, attempts: 3 });
  assert.strictEqual(t, 'The radio answers but did not move to 14074.0 kHz after 3 tries. This is a network CAT link, so it is not a cable or RTS setting: check that the program at the other end (SmartSDR CAT, the TS-2000 emulation, the K4) lets POTACAT change the frequency.');
  assert.ok(/did not move to the frequency asked/.test(fn({})));
  assert.ok(!/Disable DTR\/RTS/.test(t), 'no serial checkbox advice on a network link');
});

test('the premise holds: only the network CAT client emits tune-unconfirmed', () => {
  assert.ok(/if \(target\.type === 'tcp' \|\| target\.type === 'k4-network'\) \{\s*cat = new CatClient\(\);/.test(main));
  assert.strictEqual((main.match(/new CatClient\(\)/g) || []).length, 1);
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'lib'))) {
    if (!f.endsWith('.js') || f === 'cat.js') continue;
    assert.ok(!/'tune-unconfirmed'/.test(read('lib/' + f)), 'lib/' + f + ' emits tune-unconfirmed too');
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
