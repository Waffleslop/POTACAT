// SSTV never moves a radio to a band it is not set up for (#292, Casey
// 2026-11-10: "If you open SSTV on a radio configured strictly for VHF/UHF, it
// will tune the radio to 20m SSTV"). His choice: do not tune and say SSTV is
// on HF; no 2 m SSTV.
// Run: node test/sstv-start-band-test.js
'use strict';
const { readSrc } = require('./_src');
const assert = require('assert');
const path = require('path');
const S = require('../lib/sstv-start-band');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message || e)); }
}
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
const js = readSrc(path.join(root, 'renderer', 'sstv-popout.js'));
const html = readSrc(path.join(root, 'renderer', 'sstv-popout.html'));

const VU = ['2m', '70cm'];
const HF = ['80m', '40m', '20m', '15m', '10m'];

console.log('SSTV start band');

test('Idle Mode: 20 m by day, 40 m by night, as before, on an HF radio or an unknown one', () => {
  assert.deepStrictEqual(S.autoChannel(HF, true), { freqKhz: 14230, mode: 'USB' });
  assert.deepStrictEqual(S.autoChannel(HF, false), { freqKhz: 7171, mode: 'LSB' });
  assert.deepStrictEqual(S.autoChannel(null, true), { freqKhz: 14230, mode: 'USB' }, 'bands not known: not restricted');
});

test('Idle Mode: the other band when the preferred one is not on the radio', () => {
  assert.deepStrictEqual(S.autoChannel(['40m', '80m'], true), { freqKhz: 7171, mode: 'LSB' });
  assert.deepStrictEqual(S.autoChannel(['20m'], false), { freqKhz: 14230, mode: 'USB' });
});

test('Idle Mode: a VHF/UHF-only radio is not tuned at all', () => {
  assert.strictEqual(S.autoChannel(VU, true), null);
  assert.strictEqual(S.autoChannel(VU, false), null);
});

test('the window: the selected channel, else the first usable one in the list, else none', () => {
  const list = [
    { value: '3845', mode: 'LSB', band: '80m' }, { value: '7171', mode: 'LSB', band: '40m' },
    { value: '14230', mode: 'USB', band: '20m' }, { value: '50680', mode: 'USB', band: '6m' },
  ];
  assert.strictEqual(S.windowChannel(HF, list, '14230').value, '14230');
  assert.strictEqual(S.windowChannel(['6m', '2m'], list, '14230').value, '50680', 'a 6 m radio gets 6 m SSTV');
  assert.strictEqual(S.windowChannel(VU, list, '14230'), null);
  assert.strictEqual(S.windowChannel(null, list, '14230').value, '14230');
  assert.ok(/SSTV is on HF/.test(S.NO_BAND_NOTE) && /left where it is/.test(S.NO_BAND_NOTE));
});

test('wired: main checks the radio\'s bands, a null channel does not tune, the window reads bands before its first tune', () => {
  assert.ok(/const SstvStartBand = require\('\.\/lib\/sstv-start-band'\);/.test(main));
  assert.ok(/if \(!autoSstvBand\) \{/.test(main) && /if \(newBand && newBand\.freqKhz !== autoSstvCurrentFreq\)/.test(main));
  assert.ok(/<script src="\.\.\/lib\/sstv-start-band\.js"><\/script>/.test(html));
  const i = js.indexOf('const d = await window.api.rigBandsGet();');
  assert.ok(i > 0 && i < js.indexOf('sstvAutoQsy(q.get('), 'bands first, then the tune');
  assert.ok(/window\.api\.onRefocusQsy\(\(target\) => \{\n\s+try \{ sstvAutoQsy\(target\); \}/.test(js), 'a re-open follows the same rule');
  assert.ok(/statusBar\.textContent = window\.SstvStartBand\.NO_BAND_NOTE;/.test(js));
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/sstv-start-band-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
