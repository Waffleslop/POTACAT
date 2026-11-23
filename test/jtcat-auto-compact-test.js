'use strict';
// #857: the JTCAT window picks a compact layout by itself on a short screen
// (a 1366x768 laptop): by the screen's work area, not the window height. lib/jtcat-layout.js decides; renderer/jtcat-popout.js
// applies it as body.jp-compact and never moves or resizes the window.
// Options > The picture > Layout: Automatic (default), Full, Compact.
// An explicit Full or Compact always wins over the automatic pick.
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

const ROOT = path.join(__dirname, '..');
let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failures.push(name); console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       ')); }
}

let L = null;
try { L = require('../lib/jtcat-layout'); } catch (e) { L = null; }
function lib() { assert.ok(L, 'lib/jtcat-layout.js exists'); return L; }

const js = readSrc(path.join(ROOT, 'renderer', 'jtcat-popout.js'));
const html = readSrc(path.join(ROOT, 'renderer', 'jtcat-popout.html'));
const main = readSrc(path.join(ROOT, 'main.js'));
const doc = readSrc(path.join(ROOT, 'docs', 'JTCAT.md'));

function extract(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i !== -1, name + ' exists');
  let depth = 0;
  const j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
}

// ---------------------------------------------------------------------------
// Automatic decides by the SCREEN's usable height (its work area), not the
// window's (Casey, 2026-11-23): Full when the work area fits the Full layout,
// Compact only on a short screen. The threshold is measured (see the lib).
// ---------------------------------------------------------------------------
test('threshold: the Full layout needs a work area of 840 px; one edge, no hysteresis band', () => {
  const { FULL_FROM, COMPACT_BELOW } = lib();
  assert.strictEqual(FULL_FROM, 840);
  assert.strictEqual(COMPACT_BELOW, FULL_FROM, 'compact below the same edge');
});

test('Automatic: a tall screen is Full whatever the window height (the default 700 px window too)', () => {
  const { pick } = lib();
  for (const screenHeight of [840, 900, 1032, 1400, 2112]) {
    for (const height of [480, 560, 700, 799, 1000]) {
      for (const current of ['full', 'compact']) {
        assert.strictEqual(pick({ choice: 'auto', screenHeight, height, current }), 'full', screenHeight + ' screen, ' + height + ' window, from ' + current);
      }
    }
  }
});

test('Automatic: a short screen (1366x768, 728..768 px work area) is Compact', () => {
  const { pick } = lib();
  for (const screenHeight of [600, 728, 768, 824, 839]) {
    for (const current of ['full', 'compact']) {
      assert.strictEqual(pick({ choice: 'auto', screenHeight, height: 700, current }), 'compact', screenHeight + ' from ' + current);
    }
  }
});

test('zoom: the rule is in CSS px, the work area divided by the zoom factor', () => {
  const { pick, cssScreenHeight } = lib();
  assert.strictEqual(cssScreenHeight(1032, 1), 1032);
  assert.strictEqual(Math.round(cssScreenHeight(824, 0.9)), 916);
  assert.strictEqual(Math.round(cssScreenHeight(1032, 1.3)), 794);
  assert.strictEqual(cssScreenHeight(1032, 0), 1032, 'no zoom known: as 1');
  assert.strictEqual(cssScreenHeight(1032, NaN), 1032);
  // 1920x1080 at 125% (824 px work area) is Compact; one Ctrl and minus (0.9) brings Full.
  assert.strictEqual(pick({ choice: 'auto', screenHeight: 824, zoom: 1 }), 'compact');
  assert.strictEqual(pick({ choice: 'auto', screenHeight: 824, zoom: 0.9 }), 'full');
  // Zooming in far enough on a 1080 screen makes it short in CSS px.
  assert.strictEqual(pick({ choice: 'auto', screenHeight: 1032, zoom: 1.3 }), 'compact');
  assert.strictEqual(pick({ choice: 'auto', screenHeight: 1032, zoom: 1.2 }), 'full');
});

test('moving to another display re-evaluates: tall to short goes Compact, short to tall goes Full', () => {
  const { pick } = lib();
  let cur = 'full';
  const seen = [];
  for (const screenHeight of [1032, 728, 728, 1400, 1032, 768]) {
    const next = pick({ choice: 'auto', screenHeight, current: cur });
    if (next !== cur) seen.push(screenHeight + ':' + next);
    cur = next;
  }
  assert.deepStrictEqual(seen, ['728:compact', '1400:full', '768:compact']);
});

test('window resize alone never switches: same screen, any window height, same layout', () => {
  const { pick } = lib();
  for (const screenHeight of [728, 1032]) {
    const want = screenHeight >= 840 ? 'full' : 'compact';
    let cur = want;
    for (const height of [700, 805, 799, 801, 798, 841, 480, 1000]) {
      cur = pick({ choice: 'auto', screenHeight, height, current: cur });
      assert.strictEqual(cur, want, screenHeight + ' screen, ' + height + ' window');
    }
  }
});

test('an explicit choice always wins over the automatic pick', () => {
  const { pick } = lib();
  for (const screenHeight of [600, 728, 839, 840, 1032, 1400]) {
    for (const cur of ['full', 'compact']) {
      assert.strictEqual(pick({ choice: 'full', screenHeight, current: cur }), 'full', 'Full at ' + screenHeight);
      assert.strictEqual(pick({ choice: 'compact', screenHeight, current: cur }), 'compact', 'Compact at ' + screenHeight);
    }
  }
});

test('no screen height known: keep what is shown, full by default', () => {
  const { pick } = lib();
  assert.strictEqual(pick({ choice: 'auto', screenHeight: 0 }), 'full');
  assert.strictEqual(pick({ choice: 'auto', screenHeight: NaN, current: 'compact' }), 'compact');
  assert.strictEqual(pick({ choice: 'auto' }), 'full');
  assert.strictEqual(pick({ choice: 'auto', height: 500 }), 'full', 'the window height alone decides nothing');
});

// ---------------------------------------------------------------------------
// Migration of saved choices: there was no layout setting before #857. A
// missing or unknown value is Automatic; a saved Full or Compact is kept as it
// is. The automatic pick is never written back, so it never turns into a choice.
// ---------------------------------------------------------------------------
test('migration: no saved jtcatLayout (every install before #857) reads as Automatic', () => {
  const { normalizeChoice, DEFAULT_CHOICE } = lib();
  assert.strictEqual(DEFAULT_CHOICE, 'auto');
  for (const v of [undefined, null, '', 'AUTO ', 'big', 0, 1, true, false, {}, []]) {
    assert.strictEqual(normalizeChoice(v), 'auto', JSON.stringify(v));
  }
});

test('migration: an operator who explicitly chose a layout keeps it', () => {
  const { normalizeChoice, pick } = lib();
  assert.strictEqual(normalizeChoice('full'), 'full');
  assert.strictEqual(normalizeChoice('compact'), 'compact');
  assert.strictEqual(normalizeChoice('auto'), 'auto');
  // A saved Full on a short laptop stays full; a saved Compact on a tall screen stays compact.
  assert.strictEqual(pick({ choice: normalizeChoice('full'), screenHeight: 728, current: 'full' }), 'full');
  assert.strictEqual(pick({ choice: normalizeChoice('compact'), screenHeight: 1400, current: 'full' }), 'compact');
});

test('migration: only the operator\'s own choice is saved, never the automatic pick', () => {
  const saves = js.match(/saveSettings\(\{\s*jtcatLayout\b[^)]*\)/g) || [];
  assert.strictEqual(saves.length, 1, 'one place writes jtcatLayout: ' + JSON.stringify(saves));
  const apply = extract(js, 'applyJpLayout');
  assert.ok(!/saveSettings/.test(apply), 'applyJpLayout (the automatic pick) never saves');
  const setChoice = extract(js, 'setJpLayoutChoice');
  assert.ok(/if \(persist\) window\.api\.saveSettings\(\{ jtcatLayout: layoutChoice \}\)/.test(setChoice), 'saved only when persist (the select)');
  assert.ok(/layoutSelect\.addEventListener\('change', function\(\) \{ setJpLayoutChoice\(layoutSelect\.value, true\); \}\)/.test(js), 'the select is the one persisting caller');
  assert.ok(/setJpLayoutChoice\(s\.jtcatLayout, false\)/.test(js), 'settings load applies without saving');
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
test('wiring: the window loads lib/jtcat-layout.js before jtcat-popout.js', () => {
  const a = html.indexOf('<script src="../lib/jtcat-layout.js"></script>');
  const b = html.indexOf('<script src="jtcat-popout.js"></script>');
  assert.ok(a !== -1, 'script tag');
  assert.ok(a < b, 'before jtcat-popout.js');
});

test('wiring: Options > The picture has Layout with Automatic (default), Full and Compact', () => {
  const m = /<select id="jp-layout"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  assert.ok(m, '#jp-layout select');
  const opts = [...m[1].matchAll(/<option value="(\w+)"( selected)?>([^<]+)<\/option>/g)].map((x) => [x[1], !!x[2], x[3]]);
  assert.deepStrictEqual(opts.map((o) => o[0]), ['auto', 'full', 'compact']);
  assert.deepStrictEqual(opts.map((o) => o[2]), ['Automatic', 'Full', 'Compact']);
  assert.ok(opts[0][1], 'Automatic is selected by default');
  const picture = html.indexOf('<div class="jp-opt-section">The picture</div>');
  const special = html.indexOf('<div class="jp-opt-section">Special events only</div>');
  const at = html.indexOf('id="jp-layout"');
  assert.ok(picture < at && at < special, 'inside The picture');
});

test('wiring: the compact layout is CSS on body.jp-compact and shrinks the chrome, not the text', () => {
  assert.ok(/body\.jp-compact \.jp-waterfall \{[^}]*height: 48px/.test(html), 'a shorter waterfall');
  assert.ok(/body\.jp-compact \.jp-btn\.jp-big \{[^}]*height: 34px/.test(html), 'shorter big buttons');
  assert.ok(/body\.jp-compact \.jp-row \{[^}]*padding: 1px 10px/.test(html), 'tighter decode rows');
  const rules = (html.match(/body\.jp-compact[^{]*\{[^}]*\}/g) || []).join('\n');
  const sizes = [...rules.matchAll(/font-size: (\d+)px/g)].map((x) => Number(x[1]));
  assert.ok(sizes.every((n) => n >= 13), 'no text under 13 px in compact: ' + sizes.join(','));
});

test('wiring: the window picks from the screen work area and its zoom, and sizes the waterfall after a switch', () => {
  const apply = extract(js, 'applyJpLayout');
  assert.ok(/JtcatLayout\.pick\(\{ choice: layoutChoice, screenHeight: layoutScreenHeight\(\), zoom: layoutZoom\(\), current: layoutNow \}\)/.test(apply), 'pick from the screen, in CSS px');
  assert.ok(!/innerHeight/.test(apply), 'never the window height');
  assert.ok(/screen\.availHeight/.test(extract(js, 'layoutScreenHeight')), 'the work area as the page sees it');
  assert.ok(/window\.api\.getZoom\(\)/.test(extract(js, 'layoutZoom')), 'the zoom factor');
  assert.ok(/document\.body\.classList\.toggle\('jp-compact', next === 'compact'\)/.test(apply), 'body class');
  assert.ok(/resizeWaterfall\(\)/.test(apply), 'the canvas follows its new height');
});

test('wiring: moving to another display or a work-area change re-evaluates', () => {
  // main.js tells the window the work area of the display it is on, when it
  // moves and when any display's metrics change.
  assert.ok(main.indexOf('function sendJtcatWorkArea(') !== -1, 'sendJtcatWorkArea in main.js');
  const fn = extract(main, 'sendJtcatWorkArea');
  assert.ok(/screen\.getDisplayMatching\(jtcatPopoutWin\.getBounds\(\)\)/.test(fn), 'the display the window is on');
  assert.ok(/workArea\.height/.test(fn) && /'jtcat-work-area'/.test(fn), 'sends its work-area height');
  assert.ok(/jtcatPopoutWin\.on\('moved', sendJtcatWorkArea\)/.test(main), 'on move');
  assert.ok(/screen\.on\('display-metrics-changed', sendJtcatWorkArea\)/.test(main), 'on a work-area change');
  const pre = readSrc(path.join(ROOT, 'preload-jtcat-popout.js'));
  assert.ok(/onJtcatWorkArea: \(cb\) => ipcRenderer\.on\('jtcat-work-area'/.test(pre), 'preload');
  const flat = js.replace(/\n\s*/g, ' ');
  assert.ok(/window\.api\.onJtcatWorkArea\(function\(h\) \{[^}]*applyJpLayout\(\)/.test(flat), 'the window re-picks');
  // A zoom change does not fire resize (measured in Electron 39), so the zoom
  // keys re-pick themselves. The window height is not an input.
  const zoom = js.slice(js.indexOf('// --- Zoom (Ctrl+/Ctrl-) ---'), js.indexOf('// --- VFO Lock'));
  assert.ok(zoom.length > 100, 'the zoom block');
  assert.strictEqual((zoom.match(/window\.api\.setZoom\(/g) || []).length, 3, 'three zoom keys');
  assert.ok(/scheduleJpLayout\(\)/.test(zoom), 'the zoom keys re-pick the layout');
  const sched = extract(js, 'scheduleJpLayout');
  assert.ok(/applyJpLayout\(\)/.test(sched) && !/requestAnimationFrame/.test(sched), 'picks at once: a withheld frame must not swallow a pick');
  assert.ok(/window\.addEventListener\('resize', scheduleJpLayout\)/.test(js), 'resize re-checks (a DPI change), harmless otherwise');
});

test('wiring: changing the layout never moves or resizes the window', () => {
  const block = js.slice(js.indexOf('// #857 Layout:'), js.indexOf('// end #857'));
  assert.ok(block.length > 200, 'the #857 block is marked');
  assert.ok(!/setBounds|setSize|resizeTo|resizeBy|moveTo|moveBy|setZoom/.test(block), 'no window geometry or zoom calls');
});

test('wiring: the automatic switch says so once, and only for Automatic', () => {
  const apply = extract(js, 'applyJpLayout');
  assert.ok(/next === 'compact' && layoutChoice === 'auto'\) tellCompactOnce\(\)/.test(apply));
  const tell = extract(js, 'tellCompactOnce');
  assert.ok(/localStorage\.getItem\('jtcat-compact-told'\)/.test(tell) && /localStorage\.setItem\('jtcat-compact-told', '1'\)/.test(tell), 'remembered once');
  assert.ok(/Options > Layout/.test(tell), 'names where to change it');
  assert.ok(/this screen is short/.test(tell) && !/this window is short/.test(tell), 'the screen is short, not the window');
});

test('wiring: jtcatLayout is a machine-wide display setting, documented', () => {
  assert.ok(/'jtcatLayout',/.test(main.slice(main.indexOf('const GLOBAL_KEYS'), main.indexOf('const GLOBAL_KEYS') + 6000)), 'GLOBAL_KEYS');
  assert.ok(/jtcatLayout/.test(doc), 'docs/JTCAT.md');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
