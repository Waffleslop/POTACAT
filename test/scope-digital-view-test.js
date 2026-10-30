#!/usr/bin/env node
'use strict';
/**
 * The band scope's tight view for a digital mode (Casey 2026-10-30): the Flex
 * pan zooms to the mode's decode window and centres on it while the JTCAT
 * window's strip is showing, and every surface draws the same offset axis.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const V = require('../lib/scope-digital-view');
const A = require('../lib/scope-axis');
const F = require('../lib/flex-scope');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('The view per mode');
check('WSPR: centred on dial + 1500 Hz, as narrow as the radio allows', () => {
  const v = V.digitalView({ mode: 'WSPR', rigMode: 'USB', minSpanHz: 1230 });
  assert.deepStrictEqual(v, { offsetHz: 1500, spanHz: 1230, window: { lo: 1400, hi: 1600 } });
});
check('FT8, FT4, FT2, JTTY, PSK31: the whole 200-3000 Hz window, 100 Hz either side', () => {
  for (const mode of ['FT8', 'FT4', 'FT2', 'JTTY', 'PSK31', 'ft8']) {
    const v = V.digitalView({ mode, rigMode: 'DIGU', minSpanHz: 1230 });
    assert.deepStrictEqual(v, { offsetHz: 1600, spanHz: 3000, window: { lo: 200, hi: 3000 } }, mode);
  }
});
check('the window always fits inside the span', () => {
  for (const mode of ['WSPR', 'FT8']) {
    const v = V.digitalView({ mode, rigMode: 'USB' });
    assert.ok(v.offsetHz - v.spanHz / 2 <= v.window.lo && v.offsetHz + v.spanHz / 2 >= v.window.hi, mode);
  }
});
check('a radio that has not said its minimum: the 8600 figure', () => {
  assert.strictEqual(V.digitalView({ mode: 'WSPR' }).spanHz, V.FLEX_MIN_SPAN_HZ);
});
check('LSB: the window is below the dial', () => {
  const v = V.digitalView({ mode: 'FT8', rigMode: 'LSB' });
  assert.deepStrictEqual(v, { offsetHz: -1600, spanHz: 3000, window: { lo: -3000, hi: -200 } });
});
check('no mode, or a mode with no window: no view', () => {
  assert.strictEqual(V.digitalView({ mode: '' }), null);
  assert.strictEqual(V.digitalView({ mode: 'SSTV' }), null);
  assert.strictEqual(V.viewKey(null), '');
});
check('the key changes with the mode and the side, not otherwise', () => {
  const k = (m, r) => V.viewKey(V.digitalView({ mode: m, rigMode: r, minSpanHz: 1230 }));
  assert.strictEqual(k('FT8', 'USB'), k('FT4', 'DIGU'));
  assert.notStrictEqual(k('FT8', 'USB'), k('WSPR', 'USB'));
  assert.notStrictEqual(k('FT8', 'USB'), k('FT8', 'LSB'));
});

console.log('The shared axis');
check('an offset moves a centred axis, and a click lands on the right audio frequency', () => {
  const dial = 14095600;
  const st = { anchor: 'center', spanHz: 1230, centerOffsetHz: 1500 };
  const c = A.axisCenterFor(st, dial);
  assert.strictEqual(c, dial + 1500);
  const ax = A.scopeAxis({ centerHz: c, spanHz: 1230, anchor: 'center' });
  const mid = A.binToHz(ax, 849 / 2);
  assert.ok(Math.abs(mid - (dial + 1500)) < 2, 'centre ' + mid);
  const lo = A.hzToBin(ax, dial + 1400), hi = A.hzToBin(ax, dial + 1600);
  assert.ok(lo != null && hi != null && lo < hi, 'the WSPR window is on screen');
});
check('no offset: unchanged (the dial is the centre)', () => {
  assert.strictEqual(A.axisCenterFor({ anchor: 'center' }, 7074000), 7074000);
  assert.strictEqual(A.axisCenterFor({ anchor: 'fixed', centerHz: 7100000, centerOffsetHz: 1500 }, 7074000), 7100000);
  assert.strictEqual(A.axisCenterFor({ anchor: 'center', centerOffsetHz: 1500 }, 0), 0);
});

console.log('The radio');
check('the pan status min_bw is read (real 8600 status: 1230 Hz)', () => {
  const line = fs.readFileSync(path.join(__dirname, 'fixtures/flex-pan/8600-status.txt'), 'utf8')
    .split(/\r?\n/).find((l) => /\|display pan 0x[0-9A-F]+ .*min_bw=/i.test(l));
  assert.ok(line, 'a pan status line with min_bw');
  assert.strictEqual(F.parsePanGeometry(line).minSpanHz, 1230);
});

console.log('Wiring');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const pop = fs.readFileSync(path.join(ROOT, 'renderer/jtcat-popout.js'), 'utf8');
check('main checks the view on every pan frame and when the strip shows or hides', () => {
  assert.ok(/smartSdr\.on\('pan-frame', \(f\) => \{ if \(flexScopeOn\) \{ flexDigitalViewSync\(\);/.test(main));
  assert.ok(/'jtcat-scope-watch'[\s\S]{0,400}flexDigitalViewSync\(\)/.test(main));
});
check('the view is only for the JTCAT strip, and the operator zoom comes back', () => {
  const fn = /function flexDigitalViewWanted\(\) \{[\s\S]*?\n\}/.exec(main)[0];
  assert.ok(/yaesuScopeJtcatWants/.test(fn) && /jtcatPopoutWin/.test(fn));
  const sync = /function flexDigitalViewSync\(\) \{[\s\S]*?\n\}/.exec(main)[0];
  assert.ok(/settings\.flexScopeSpanHz/.test(sync), 'restores the saved zoom');
  assert.ok(!/saveSettings/.test(sync), 'never saves the digital view as the operator zoom');
});
check('the dial recentres the pan with the offset', () => {
  assert.ok(/flexScopeQueueCenter\(hz \+ \(yaesuScopeState\.centerOffsetHz \|\| 0\)\)/.test(main));
});
check('ECHOCAT gets the offset and window (an explicit field list)', () => {
  assert.ok(/centerOffsetHz: s\.centerOffsetHz \|\| 0, decodeWindow: s\.decodeWindow \|\| null/.test(main));
});
check('a click on the strip in the digital view sets the audio frequency, not the dial', () => {
  const fn = /function bsTune\(frac\) \{[\s\S]*?\n  \}/.exec(pop)[0];
  assert.ok(/decodeWindow/.test(fn) && /jtcatSetTxFreq\(audio, true\)/.test(fn));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
