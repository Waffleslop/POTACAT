// VFO window redesign (Casey 2026-11-10, reviewed as a mock-up first):
// a labelled Audio on / Audio off button, a mini VFO strip that grows back,
// and POTACAT colours for PTT, the sliders and the CW panel.
// Run: node test/vfo-compact-test.js
'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const path = require('path');
const C = require('../lib/vfo-compact');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const root = path.join(__dirname, '..');
const vfo = readSrc(path.join(root, 'renderer', 'vfo-popout.html'));
const main = readSrc(path.join(root, 'main.js'));

console.log('VFO mini and colours');

test('the strip: the operator\'s width, else the line\'s, inside 320..1600; the measured height inside 44..260', () => {
  assert.deepStrictEqual(C.miniSize({ width: 700, height: 52 }), { width: 700, height: 52 });
  assert.deepStrictEqual(C.miniSize({ width: 700, height: 52, saved: 540 }), { width: 540, height: 52 }, 'a dragged width wins');
  assert.deepStrictEqual(C.miniSize({ width: 5000, height: 20 }), { width: 1600, height: 44 });
  assert.deepStrictEqual(C.miniSize({ width: 100, height: 999 }), { width: 320, height: 260 });
  assert.deepStrictEqual(C.miniSize({}), { width: 640, height: 52 });
});

test('growing back uses the size from before the shrink, else the default; a close in mini saves the full size', () => {
  assert.deepStrictEqual(C.fullSize({ width: 420, height: 820 }, { width: 380 }), { width: 420, height: 820 });
  assert.deepStrictEqual(C.fullSize(null, { width: 380 }), { width: 380, height: 760 });
  assert.deepStrictEqual(C.fullSize({ width: 50, height: 100 }, { width: 200 }), { width: 360, height: 760 });
  assert.deepStrictEqual(C.savedBounds({ x: 10, y: 20, width: 380, height: 108 }, { width: 360, height: 760 }), { x: 10, y: 20, width: 360, height: 760 });
});

test('main: vfo-set-compact remembers the full size once, sizes the strip, restores, and saves the choice', () => {
  const i = main.indexOf("ipcMain.on('vfo-set-compact'");
  const h = main.slice(i, i + 1800);
  assert.ok(/if \(!_vfoCompactNow\) settings\.vfoFullSize = \{ width: b\.width, height: b\.height \};/.test(h), 'remembered before the first shrink only');
  assert.ok(/VfoCompact\.miniSize\(\{ width, height, saved: settings\.vfoMiniWidth \}\)/.test(h) && /setMinimumSize\(VfoCompact\.MINI\.minWidth, VfoCompact\.MINI\.minHeight\)/.test(h));
  assert.ok(/VfoCompact\.fullSize\(settings\.vfoFullSize, b\)/.test(h) && /setMinimumSize\(300, 360\)/.test(h), 'grows back with the old minimum');
  assert.ok(/if \(save && settings\.vfoCompact !== !!on\) \{ settings\.vfoCompact = !!on; saveSettings\(settings\); \}/.test(h));
  assert.ok(/_vfoCompactNow \? VfoCompact\.savedBounds\(vfoPopoutWin\.getBounds\(\), settings\.vfoFullSize\)/.test(main), 'never saved at strip height');
  assert.ok(/setVfoCompact: \(on, height, save, width, fit\) => ipcRenderer\.send\('vfo-set-compact'/.test(readSrc(path.join(root, 'preload-vfo-popout.js'))));
});

test('the page: a title-bar button switches, the strip is the Small VFO line (test/vfo-layout-test.js)', () => {
  assert.ok(/id="mini-btn"/.test(vfo) && /miniBtn\.addEventListener\('click', \(\) => setMini\(!vfoMini\)\);/.test(vfo));
  assert.ok(/if \(s && s\.vfoCompact\) setMini\(true, \{ save: false \}\);/.test(vfo), 'opens the way it was left');
  assert.ok(/body\.mini \.scroll > :not\(\.swr-alert\.show\) \{ display: none !important; \}/.test(vfo), 'the SWR guard is never hidden by the strip');
  assert.ok(/\.mini-strip \.band-chip:not\(:empty\) \{ display: inline-block; \}/.test(vfo) && /bandChip\.textContent = cur \|\| '';/.test(vfo));
  assert.ok(/new ResizeObserver\(/.test(vfo), 'the strip follows its content (the SWR guard)');
});

test('the speaker says Audio on or Audio off; the click is unchanged', () => {
  const i = vfo.indexOf('function updateAudioBtn()');
  const f = vfo.slice(i, vfo.indexOf('\n}\n', i));
  assert.ok(/const on = audioMonitorActive && !audioMonitorMuted;/.test(f));
  assert.ok(/'Audio on' : 'Audio off'/.test(f) && /'ib audio-btn ' \+ \(on \? 'on' : 'off'\)/.test(f));
  assert.ok(/\.audio-btn\.on \{ background: var\(--green-tint\); color: var\(--green\); \}/.test(vfo));
  assert.ok(/\.audio-btn\.off \{ background: var\(--red-tint\); color: var\(--red\); \}/.test(vfo));
  assert.ok(/speakerOff: '<svg/.test(vfo), 'a slashed speaker');
});

test('colours: PTT is POTACAT red at rest, sliders get a dark track, TX power is red, the CW panel loses its gold', () => {
  assert.ok(/--ptt: #e94560; --ptt-on: #e94560;/.test(vfo), 'navy');
  assert.ok(/--ptt: #ef4444; --ptt-on: #ef4444;/.test(vfo), 'charcoal');
  assert.ok(!/#c8334f/.test(vfo), 'the old crimson is gone');
  assert.ok(/--in: var\(--ds-bg\);/.test(vfo) && !/--in: var\(--ds-control\)/.test(vfo), 'design-system wells follow the page colour (dark slabs on the light themes before)');
  assert.ok(/--ptt: var\(--ds-air\); --ptt-on: var\(--ds-air\);/.test(vfo) && !/--ptt: var\(--ds-air-deep\)/.test(vfo), 'design-system themes: the on-air red, not its deep shade');
  assert.ok(/input\[type="range"\] \{ accent-color: var\(--blue\); color-scheme: dark; \}/.test(vfo) && /\[data-theme="light"\] input\[type="range"\] \{ color-scheme: light; \}/.test(vfo));
  assert.ok(/#vfo-txpower \{ accent-color: var\(--ptt-on\); \}/.test(vfo));
  assert.ok(/\.cw-send-btn \{ border: 0; background: var\(--ptt-on\); color: var\(--on-ptt\);/.test(vfo) && />Send<\/button>/.test(vfo));
  assert.ok(/\.cw-wpm-val \{[^}]*color: var\(--blue\);/.test(vfo) && /\.cw-macro-btn \{ color: var\(--t\); \}/.test(vfo));
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/vfo-compact-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
