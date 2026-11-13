// The SSTV window's Drive slider (#279, droidbot2 2026-11-08): it "can't be
// dragged all the way to the bottom" and "shows no value". A saved 0 came back
// as 50 % (`settings.sstvTxGain || 0.5`) and was sent at 50 % (`|| 0.5` at
// transmit), so the bottom of the slider did nothing; and there was no number
// to repeat a setting by. lib/sstv-drive.js keeps 0 as 0; the window shows the
// percentage like the FT8 window's TX drive.
// Run: node test/sstv-drive-test.js
'use strict';
const { readSrc } = require('./_src');
const assert = require('assert');
const path = require('path');
const D = require('../lib/sstv-drive');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message || e)); }
}
const root = path.join(__dirname, '..');
const js = readSrc(path.join(root, 'renderer', 'sstv-popout.js'));
const html = readSrc(path.join(root, 'renderer', 'sstv-popout.html'));
const main = readSrc(path.join(root, 'main.js'));

console.log('SSTV drive');

test('a saved 0 opens at 0 %, not 50 %', () => {
  assert.strictEqual(D.pctFromSaved(0), 0);
  assert.strictEqual(D.pctFromSaved('0'), 0);
});

test('both ends and the middle round-trip', () => {
  for (const pct of [0, 1, 37, 50, 99, 100]) assert.strictEqual(D.pctFromSaved(D.gainFromPct(pct)), pct, pct + ' %');
  assert.strictEqual(D.gainFromPct(0), 0);
  assert.strictEqual(D.gainFromPct(100), 1);
  assert.strictEqual(D.gainFromPct('0'), 0, 'the slider value is a string');
});

test('nothing saved, or junk, is 50 %; out of range is clamped', () => {
  assert.strictEqual(D.pctFromSaved(undefined), 50);
  assert.strictEqual(D.pctFromSaved(null), 50);
  assert.strictEqual(D.pctFromSaved('abc'), 50);
  assert.strictEqual(D.pctFromSaved(1.7), 100);
  assert.strictEqual(D.pctFromSaved(-1), 0);
  assert.strictEqual(D.gainFromPct(''), 0.5);
  assert.strictEqual(D.gainFromPct(150), 1);
  assert.strictEqual(D.gainFromPct(-5), 0);
});

test('the label is a whole percentage', () => {
  assert.strictEqual(D.label(0), '0%');
  assert.strictEqual(D.label('64'), '64%');
  assert.strictEqual(D.label(100), '100%');
});

test('the window reads, saves and transmits the drive through lib/sstv-drive.js, with no `|| 0.5`', () => {
  assert.ok(!/sstvTxGain\s*\|\|/.test(js), 'no `sstvTxGain ||` fallback');
  assert.ok(!/txGainSlider\.value\s*\/\s*100\)\s*\|\|/.test(js), 'no `(value / 100) ||` at transmit');
  assert.ok(/SstvDrive\.pctFromSaved\(settings\.sstvTxGain\)/.test(js), 'restore');
  assert.ok(/sstvTxGain:\s*window\.SstvDrive\.gainFromPct\(txGainSlider\.value\)/.test(js), 'save');
  assert.ok(/gainLevel\s*=\s*window\.SstvDrive\.gainFromPct\(txGainSlider\.value\)/.test(js), 'transmit');
  assert.ok(html.indexOf('../lib/sstv-drive.js') > -1 && html.indexOf('../lib/sstv-drive.js') < html.indexOf('sstv-popout.js"'), 'loaded before the window script');
});

test('the value is shown beside the slider and follows the drag', () => {
  assert.ok(/<input type="range" id="tx-gain" min="0" max="100"[^>]*>\s*<output id="tx-gain-val"/.test(html), 'an output right after the slider');
  assert.ok(/txGainSlider\.addEventListener\('input', showDrive\)/.test(js), 'updates while dragging');
});

test('the slider is never squeezed by a crowded top bar, and the bar wraps instead of cutting off buttons', () => {
  assert.ok(/\.top-drive input \{[^}]*width: 90px[^}]*flex-shrink: 0/.test(html), 'a fixed, unshrinkable width');
  assert.ok(/\.top \{[^}]*flex-wrap: wrap/.test(html), 'the top bar wraps');
  assert.ok(/<div class="top-right">[\s\S]*id="tx-gain"[\s\S]*id="gear-btn"[\s\S]*<\/div>/.test(html), 'Drive, the meters and the buttons wrap together');
});

test('the Icom network route reads the saved drive without turning 0 into 50 %', () => {
  assert.ok(/const sstvTxGain = clampNumber\(settings\.sstvTxGain, 0, 1, 0\.5\)/.test(main));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
