// VFO window, two layouts (Casey 2026-11-10, approved as a plan page): a
// Large VFO and a Small VFO, each with its own list of what shows and in what
// order, in one list per size; a one-line Small VFO; CAT buttons the operator
// picks; Scan from the Small VFO; the gear on the Small VFO opens the Large
// VFO's settings; the WebSDR under the knob by default.
// Run: node test/vfo-layout-test.js
'use strict';
const { readSrc } = require('./_src');

const assert = require('assert');
const path = require('path');
const L = require('../lib/vfo-layout');
const { RIG_CONTROLS } = require('../lib/rig-controls');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const root = path.join(__dirname, '..');
const vfo = readSrc(path.join(root, 'renderer', 'vfo-popout.html'));
const main = readSrc(path.join(root, 'main.js'));
const preload = readSrc(path.join(root, 'preload-vfo-popout.js'));

console.log('VFO layouts');

test("Small VFO defaults are Casey's: frequency, mode, band, Audio, PTT, Log, S-meter, Volume, Scan", () => {
  const s = L.normalizeSmall(null);
  const shown = s.order.filter(k => s.on[k]).sort();
  assert.deepStrictEqual(shown, ['audio', 'band', 'freq', 'log', 'mode', 'ptt', 'scan', 'smeter', 'volume'].sort());
  assert.strictEqual(s.order[0], 'freq');
  assert.strictEqual(s.on.cat, false, 'CAT buttons are there to add, not on by default');
  assert.deepStrictEqual(s.cat, ['set-nr', 'set-nb', 'atu-tune'], 'picked for when they are switched on');
});

test('a saved Small layout keeps its order and switches; frequency stays first and on; new items land in place', () => {
  const s = L.normalizeSmall({ order: ['ptt', 'freq', 'bogus', 'mode', 'ptt'], on: { freq: false, scan: false, cat: true }, cat: ['set-anf', 'nope', 'custom:Tuner', 'custom:'] });
  assert.strictEqual(s.order[0], 'freq');
  assert.strictEqual(s.order[1], 'ptt');
  assert.ok(s.order.indexOf('mode') < s.order.indexOf('band'));
  assert.strictEqual(new Set(s.order).size, L.SMALL_KEYS.length, 'every item once');
  assert.strictEqual(s.on.freq, true);
  assert.strictEqual(s.on.scan, false);
  assert.strictEqual(s.on.cat, true);
  assert.deepStrictEqual(s.cat, ['set-anf', 'custom:Tuner']);
});

test('moving never puts anything before the frequency', () => {
  const s = L.normalizeSmall(null);
  const o = L.move(s.order, 'ptt', 0);
  assert.strictEqual(o[0], 'freq');
  assert.strictEqual(o[1], 'ptt');
  assert.deepStrictEqual(L.move(s.order, 'freq', 5), s.order);
});

test('too narrow: items hide from the end of the line back, never frequency or PTT', () => {
  const h = L.hideOrder(null);
  assert.ok(!h.includes('freq') && !h.includes('ptt'));
  assert.strictEqual(h[0], 'log');
  assert.ok(!h.includes('cat'), 'an item that is off is not on the line to hide');
  const moved = { order: L.move(L.normalizeSmall(null).order, 'log', 1) };
  assert.strictEqual(L.hideOrder(moved)[0], 'volume', 'Log moved forward: what is now last (PTT aside) hides first');
  assert.strictEqual(L.hideOrder(moved).slice(-1)[0], 'log');
});

test('Large VFO: the WebSDR sits under the knob by default; a saved order is kept; solar has its own row', () => {
  assert.deepStrictEqual(L.LARGE_KEYS.slice(0, 2), ['knob', 'kiwi']);
  const saved = ['knob', 'band', 'favorites', 'filter', 'filter-slider', 'txpower', 'controls', 'profiles', 'cw-controls', 'cw', 'voice', 'kiwi'];
  const o = L.normalizeOrder(saved, L.LARGE_KEYS);
  assert.strictEqual(o[o.length - 1], 'kiwi', 'an operator who moved blocks keeps their order');
  assert.strictEqual(o[o.indexOf('controls') + 1], 'solar', 'solar, new as a block, lands after the CAT buttons');
});

test('every CAT choice is a real rig control with the same caps flag', () => {
  for (const c of L.CAT_CHOICES) {
    const r = RIG_CONTROLS[c.key];
    assert.ok(r, c.key + ' is in lib/rig-controls.js');
    assert.strictEqual(r.caps, c.caps, c.key + ' caps');
    assert.strictEqual(!!c.momentary, r.kind === 'momentary', c.key + ' kind');
  }
  assert.deepStrictEqual(L.CAT_DEFAULT_LARGE, ['set-nb', 'atu-tune'], 'the Large VFO keeps the NB and ATU it always had');
});

test('CAT buttons: only what the radio takes, custom ones while they exist; unknown radio offers all', () => {
  const caps = { nb: true, nr: false, atu: true };
  const btns = L.catButtons(['set-nr', 'set-nb', 'atu-tune', 'custom:Tuner', 'custom:Gone'], caps, [{ name: 'Tuner', command: 'AC002;' }]);
  assert.deepStrictEqual(btns.map(b => b.label), ['NB', 'ATU', 'Tuner']);
  assert.strictEqual(btns[1].momentary, true);
  assert.strictEqual(L.catOffer(null, []).length, L.CAT_CHOICES.length);
  assert.deepStrictEqual(L.catOffer(caps, [{ name: 'Tuner', command: 'x' }]).map(o => o.key), ['set-nb', 'atu-tune', 'custom:Tuner']);
});

test('the page: one line in the title bar, real controls moved in and home, never wrapped', () => {
  assert.ok(/<div class="mini-strip" id="mini-strip"><\/div>/.test(vfo));
  assert.ok(/el\._miniHome = document\.createComment\(/.test(vfo) && /function miniSendHome\(\)/.test(vfo));
  assert.ok(/for \(const k of VfoLayout\.hideOrder\(vfoSmall\)\)/.test(vfo), 'narrow: hides from the end');
  assert.ok(/\.mini-strip \.ptt-btn \{ display: flex !important; flex: none; height: 36px; min-width: 112px;/.test(vfo), 'a wider PTT');
  assert.ok(/body\.mini \.scroll > :not\(\.swr-alert\.show\) \{ display: none !important; \}/.test(vfo), 'the SWR guard is never hidden');
  assert.ok(/<script src="\.\.\/lib\/vfo-layout\.js"><\/script>/.test(vfo));
  assert.ok(!/body\.mini \.chip-row/.test(vfo), 'Audio no longer sits under the frequency');
});

test('settings: Large and Small tabs, one list per size, the gear on the Small VFO opens the Large with its settings', () => {
  assert.ok(/id="size-large"/.test(vfo) && /id="size-small"/.test(vfo));
  assert.ok(/id="large-top"/.test(vfo) && /id="order-list"/.test(vfo) && /id="large-bottom"/.test(vfo) && /id="small-list"/.test(vfo));
  assert.ok(/if \(vfoMini\) \{ sheetFromMini = true; setMini\(false, \{ save: false \}\); openSheet\(true, 'small'\); return; \}/.test(vfo));
  assert.ok(/if \(!open && sheetFromMini\) \{ sheetFromMini = false; setMini\(true, \{ save: false \}\); \}/.test(vfo));
  assert.ok(/id="mini-preview"/.test(vfo) && /function renderMiniPreview\(\)/.test(vfo));
  assert.ok(!/<span class="lbl">Show in this window<\/span>/.test(vfo) && !/<span class="lbl">Order<\/span>/.test(vfo), 'the two old lists are one');
  assert.ok(/window\.api\.saveSettings\(\{ vfoSmall \}\)/.test(vfo) && /window\.api\.saveSettings\(\{ vfoCatLarge \}\)/.test(vfo));
});

test('Scan from the Small VFO goes to the main window (or stops the phone) and comes back as state', () => {
  assert.ok(/scanToggle: \(\) => ipcRenderer\.send\('vfo-scan-toggle'\)/.test(preload));
  const i = main.indexOf("ipcMain.on('vfo-scan-toggle'");
  const h = main.slice(i, i + 600);
  assert.ok(/remote-scan-control', \{ action: 'stop' \}/.test(h) && /remote-scan-control', \{ action: 'start' \}/.test(h));
  assert.ok(/_phoneScanning && remoteServer/.test(h));
  assert.ok(/_phoneScanning = !!scanning;\s*\n\s*sendVfoScanState\(\);/.test(main));
});

test('main: the window opens the size it was left, at its width; open state is written on open and close', () => {
  const i = main.indexOf("ipcMain.on('vfo-popout-open'");
  const h = main.slice(i, i + 7000);
  assert.ok(/if \(settings\.vfoCompact\) \{/.test(h) && /VfoCompact\.miniSize\(\{ saved: settings\.vfoMiniWidth \}\)/.test(h));
  assert.ok(/settings\.vfoMiniWidth = vfoPopoutWin\.getBounds\(\)\.width;/.test(h), 'the operator\'s own width');
  assert.ok(/settings\.vfoPopoutOpen = true; saveSettings\(settings\);/.test(h));
  assert.ok(/if \(!_appWindowsClosing && settings\.vfoPopoutOpen\) \{ settings\.vfoPopoutOpen = false; saveSettings\(settings\); \}/.test(h));
  assert.ok(/catCaps: vfoCatCaps\(\),/.test(main) && /apf: _currentApfState,/.test(main));
});

test('#283: a rig preset row stays inside its box: name and detail shrink with an ellipsis', () => {
  assert.ok(/\.profile-name \{[^}]*min-width: 0;/.test(vfo));
  assert.ok(/\.profile-detail \{[^}]*min-width: 0; max-width: 55%; overflow: hidden; text-overflow: ellipsis;/.test(vfo));
  assert.ok(/item\.title = 'Apply "' \+ p\.name \+ '": ' \+ rigPresetDetail\(p\);/.test(vfo), 'the whole text is on hover');
});

test('Small VFO: one line or two (Casey 2026-11-11: "a little less wide and taller")', () => {
  assert.strictEqual(L.normalizeSmall(null).rows, 1, 'one line by default, as before');
  assert.strictEqual(L.normalizeSmall({ rows: 2 }).rows, 2);
  assert.strictEqual(L.normalizeSmall({ rows: 3 }).rows, 1, 'anything else is one line');
  // The narrowest width that keeps the items, in order, on two rows.
  const ws = [200, 60, 40, 40, 120, 90];
  assert.strictEqual(L.rowsWidth(ws, 8, 1), 590, 'one line: the whole line');
  const two = L.rowsWidth(ws, 8, 2);
  assert.ok(two < 590 && two >= 200, 'two lines: narrower, never under the widest item');
  assert.strictEqual(two, 314);
  assert.ok(L.rowsWidth(ws, 8, 2) <= L.rowsWidth(ws, 8, 2) + 0 && L.rowsWidth([500], 8, 2) === 500, 'one wide item is its own width');
  assert.strictEqual(L.rowsWidth([], 8, 2), 0);
});

test('the page: the Lines choice in Small VFO settings wraps the strip and refits the window', () => {
  assert.ok(/id="small-rows-1"[^>]*>One line<\/button>/.test(vfo) && /id="small-rows-2"[^>]*>Two lines<\/button>/.test(vfo));
  assert.ok(/body\.mini\.mini-two #mini-strip, \.mini-strip\.preview\.two \{ flex-wrap: wrap;/.test(vfo));
  assert.ok(/document\.body\.classList\.toggle\('mini-two', vfoSmall\.rows === 2\);/.test(vfo));
  assert.ok(/VfoLayout\.rowsWidth\(kids\.map\(el => el\.getBoundingClientRect\(\)\.width\), gap, 2\)/.test(vfo), 'the window is as narrow as two rows allow');
  assert.ok(/miniRowCount\(\) <= vfoSmall\.rows/.test(vfo), 'items hide from the end only when two rows are not enough');
  assert.ok(/function setSmallRows\(n\)[\s\S]{0,300}miniFitNext = true;\s*if \(vfoMini\) setMini\(true, \{ save: false \}\);/.test(vfo), 'switching refits the strip');
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/vfo-layout-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
