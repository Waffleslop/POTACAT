#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Every window POTACAT opens follows two rules (Casey 2026-11-11: "ensure that
// we always set new windows as the same theme, and they remember
// position/shape/size"):
//
//  1. Theme: it opens in the operator's theme on its first painted frame.
//     backgroundColor: getThemeWindowBg() in its options (no white flash
//     before the page loads), loadFile with { query: themeQuery() }, and a page
//     whose first script is popout-theme-boot.js or popout-theme-bootstrap.js
//     (they stamp data-theme / data-dark-variant / data-ds from that query).
//     Later theme changes reach every window through broadcastAppTheme().
//  2. Place: it opens where it was, at the size it was. A NEW window calls
//     rememberWindowPlace(win, '<name>Bounds'), which also saves on move and
//     resize, so a crash or an update restart keeps the place. The windows
//     below in OWN_PLACE had their own restore/save code before the helper; the
//     list only shrinks.
//
// Hidden helper windows (audio bridges, offscreen renders) have no theme or
// place to keep; they are named in HIDDEN with the reason.
//
// A window that shows a page that is not POTACAT's is named in THIRD_PARTY.
// Its page cannot load popout-theme-boot.js and must never get a preload, so
// the theme rule for it is its background colour only. In exchange it must be
// locked down, and that is checked here instead: the exception is never a
// loosening.
// Run: node test/window-rules-test.js
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
const WP = require('../lib/window-place');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

// Never shown: no theme or place to keep.
const HIDDEN = {
  modemBridgeWin: 'hidden audio bridge for the Winlink modem',
  remoteAudioClientWin: 'hidden WebRTC audio for desktop-to-desktop ECHOCAT',
  remoteAudioWin: 'hidden WebRTC audio for ECHOCAT',
};
// Shows a third-party page (see the header): theme by background only, and locked down.
const THIRD_PARTY = {
  winlinkFormWin: "Pat's own Winlink form page (#346): Winlink's HTML and script, not ours",
};
// Restore and save their own place (settings key). Do not add to this list:
// a new window calls rememberWindowPlace().
const OWN_PLACE = {
  win: 'windowBounds',
  popoutWin: 'mapPopoutBounds',
  propPopoutWin: 'propPopoutBounds',
  qsoPopoutWin: 'qsoPopoutBounds',
  logPopoutWin: 'logPopoutBounds',
  spotsPopoutWin: 'spotsPopoutBounds',
  clusterPopoutWin: 'clusterPopoutBounds',
  actmapPopoutWin: 'actmapPopoutBounds',
  vfoPopoutWin: 'vfoPopoutBounds',
  conditionsPopoutWin: 'conditionsPopoutBounds',
  jtcatPopoutWin: 'jtcatPopoutBounds',
  mercuryPopoutWin: 'mercuryPopoutBounds',
  winlinkPopoutWin: 'winlinkPopoutBounds',
  js8PopoutWin: 'js8PopoutBounds',
  sstvPopoutWin: 'sstvPopoutBounds',
  atuWizardWin: 'atuWizardPopoutBounds',
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every `<name> = new BrowserWindow({ ... })` with its options block.
const windows = [];
for (const m of main.matchAll(/(?:(?:const|let)\s+)?(\w+)\s*=\s*new BrowserWindow\(\{/g)) {
  const opts = main.slice(m.index, main.indexOf('});', m.index));
  windows.push({ name: m[1], opts, line: main.slice(0, m.index).split('\n').length });
}
const visible = windows.filter((w) => !HIDDEN[w.name] && !/offscreen:\s*true/.test(w.opts));

console.log('Window rules: theme and place');

test('found the windows (sanity)', () => {
  assert.ok(windows.length >= 25, 'only ' + windows.length);
  assert.strictEqual((main.match(/new BrowserWindow\(/g) || []).length, windows.length,
    'a BrowserWindow not assigned to a name: give it one so this test can follow it');
  for (const n of [...Object.keys(HIDDEN), ...Object.keys(OWN_PLACE), ...Object.keys(THIRD_PARTY)]) {
    assert.ok(windows.some((w) => w.name === n), `${n} is listed here but no longer in main.js: remove it from the list`);
  }
});

for (const w of visible) {
  if (THIRD_PARTY[w.name]) {
    test(`${w.name} (main.js:${w.line}): a third-party page, in the theme's background and locked down`, () => {
      assert.ok(/backgroundColor:\s*getThemeWindowBg\(\)/.test(w.opts), 'needs backgroundColor: getThemeWindowBg() in its options');
      for (const re of [/sandbox:\s*true/, /contextIsolation:\s*true/, /nodeIntegration:\s*false/, /webSecurity:\s*true/, /\bpartition\b/]) {
        assert.ok(re.test(w.opts), `its webPreferences need ${re.source}`);
      }
      assert.ok(!/preload/.test(w.opts), 'never a preload: the page is not ours');
      assert.ok(!/nodeIntegrationInSubFrames|webviewTag|allowRunningInsecureContent|experimentalFeatures/.test(w.opts), 'nothing that loosens it');
      assert.ok(!new RegExp(esc(w.name) + '\\.loadFile\\(').test(main), 'it shows a page that is not ours, never one of renderer/');
    });
    test(`${w.name} (main.js:${w.line}): remembers its place and size`, () => {
      assert.ok(new RegExp('rememberWindowPlace\\(' + esc(w.name) + ", '\\w+Bounds'").test(main),
        `call rememberWindowPlace(${w.name}, '<name>Bounds', { minWidth, minHeight }) right after creating it`);
    });
    continue;
  }
  test(`${w.name} (main.js:${w.line}): opens in the theme`, () => {
    assert.ok(/backgroundColor:\s*getThemeWindowBg\(\)/.test(w.opts), 'needs backgroundColor: getThemeWindowBg() in its options');
    const load = main.match(new RegExp(esc(w.name) + "\\.loadFile\\(([^\\n]*?)'(?:renderer/)?([\\w-]+\\.html)'\\)?,\\s*\\{\\s*query:\\s*(\\w+(?:\\(\\))?)\\s*\\}"));
    assert.ok(load, `needs ${w.name}.loadFile(<page>.html, { query: themeQuery() })`);
    const q = load[3];
    assert.ok(q === 'themeQuery()' || new RegExp('const ' + esc(q) + ' = themeQuery\\(\\);').test(main),
      `its query must be themeQuery() (or a copy of it), not ${q}`);
    const html = readSrc(path.join(root, 'renderer', load[2]));
    assert.ok(/<script src="popout-theme-boot(strap)?\.js"><\/script>/.test(html),
      `renderer/${load[2]} must load popout-theme-boot.js (or popout-theme-bootstrap.js) before its stylesheets`);
    const firstScript = html.indexOf('<script');
    const firstStyle = html.search(/<link rel="stylesheet"|<style/);
    assert.ok(firstStyle < 0 || firstScript < firstStyle, `renderer/${load[2]}: the theme script must come before the first stylesheet`);
  });

  test(`${w.name} (main.js:${w.line}): remembers its place and size`, () => {
    const key = OWN_PLACE[w.name];
    if (!key) {
      assert.ok(new RegExp('rememberWindowPlace\\(' + esc(w.name) + ", '\\w+Bounds'").test(main),
        `call rememberWindowPlace(${w.name}, '<name>Bounds', { minWidth, minHeight }) right after creating it`);
      return;
    }
    assert.ok(new RegExp('const saved = settings\\.' + key + '\\b').test(main), `restores settings.${key}`);
    const saves = new RegExp('settings\\.' + key + ' = (' + esc(w.name) + '\\.get(Normal)?Bounds\\(\\)|\\{ x: b\\.x, y: b\\.y, width: b\\.width, height: b\\.height \\})').test(main);
    assert.ok(saves, `saves settings.${key} from the window's bounds`);
  });
}

test('rememberWindowPlace restores only an on-screen place and saves on move, resize and close', () => {
  const i = main.indexOf('function rememberWindowPlace(');
  assert.ok(i > 0);
  const f = main.slice(i, main.indexOf('\n}\n', i));
  assert.ok(/WindowPlace\.restorable\(saved, minWidth, minHeight\) && isOnScreen\(saved\)\) w\.setBounds\(clampToWorkArea\(saved\)\)/.test(f));
  assert.ok(/w\.on\('move', soon\);/.test(f) && /w\.on\('resize', soon\);/.test(f) && /w\.on\('close', \(\) => \{ clearTimeout\(timer\); save\(\); \}\);/.test(f));
  assert.ok(/w\.getNormalBounds\(\)/.test(f), 'a maximized window keeps the size it un-maximizes to');
  assert.ok(/w\.isMinimized\(\)/.test(f), 'never saves a minimized place');
});

test('lib/window-place: what is worth restoring, and when a write is needed', () => {
  assert.strictEqual(WP.restorable({ x: 10, y: 20, width: 400, height: 300 }, 360, 300), true);
  assert.strictEqual(WP.restorable({ x: 10, y: 20, width: 300, height: 300 }, 360, 300), false, 'smaller than the window allows');
  assert.strictEqual(WP.restorable({ x: -1500, y: 0, width: 400, height: 300 }), true, 'a monitor left of the primary has negative x');
  assert.strictEqual(WP.restorable({ x: null, y: 0, width: 400, height: 300 }), false);
  assert.strictEqual(WP.restorable({ x: 'a', y: 0, width: 400, height: 300 }), false);
  assert.strictEqual(WP.restorable(null), false);
  assert.deepStrictEqual(WP.toSaved({ x: 1.4, y: 2.6, width: 400, height: 300, extra: 1 }), { x: 1, y: 3, width: 400, height: 300 });
  assert.strictEqual(WP.same({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 }), true);
  assert.strictEqual(WP.same({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 5 }), false);
  assert.strictEqual(WP.same(undefined, { x: 1, y: 2, width: 3, height: 4 }), false);
});

test('a window across two monitors is restored exactly; one hanging off a screen is pulled back', () => {
  // A 1920x1080 primary (taskbar 48) and a 1200x1920 portrait monitor to its right.
  const areas = [{ x: 0, y: 0, width: 1920, height: 1032 }, { x: 1920, y: 0, width: 1200, height: 1872 }];
  assert.strictEqual(WP.onWorkAreas({ x: 1300, y: 250, width: 700, height: 500 }, areas), true, 'straddles both: stays');
  assert.strictEqual(WP.onWorkAreas({ x: 100, y: 60, width: 420, height: 820 }, areas), true);
  assert.strictEqual(WP.onWorkAreas({ x: 2000, y: 1800, width: 640, height: 52 }, areas), true, 'the strip at the bottom of the portrait monitor');
  assert.strictEqual(WP.onWorkAreas({ x: 2000, y: 1800, width: 420, height: 820 }, areas), false, 'grown past the bottom: pulled back');
  assert.strictEqual(WP.onWorkAreas({ x: 1700, y: 900, width: 700, height: 500 }, areas), false, 'its lower-left corner is under the primary taskbar');
  assert.strictEqual(WP.onWorkAreas({ x: -50, y: 10, width: 400, height: 300 }, areas), false, 'off the left edge');
  assert.strictEqual(WP.onWorkAreas({ x: 0, y: 0, width: 1920, height: 1032 }, areas), true, 'exactly the work area');
  const c = main.slice(main.indexOf('function clampToWorkArea('), main.indexOf('function clampToWorkArea(') + 600);
  assert.ok(/onWorkAreas\(bounds, screen\.getAllDisplays\(\)\.map\(\(d\) => d\.workArea\)\)/.test(c), 'every restore goes through this');
});

// #252 (ik4idf, three screens): the Band Scope and Bandspread pop-outs kept
// their own restore/save code, which never saved while maximized (and the Band
// Scope saved only at close). They use the helper now, under the settings keys
// they always had, so a place saved by an older version still restores.
for (const [name, key] of [['scopePopoutWin', 'scopePopoutBounds'], ['bandspreadPopoutWin', 'bandspreadPopoutBounds']]) {
  test(`${name}: the helper keeps its place, with the window's own minimum size (#252)`, () => {
    const w = windows.find((x) => x.name === name);
    assert.ok(w, name + ' is in main.js');
    const call = main.match(new RegExp('rememberWindowPlace\\(' + name + ", '" + key + "', \\{ minWidth: (\\d+), minHeight: (\\d+) \\}\\);"));
    assert.ok(call, `rememberWindowPlace(${name}, '${key}', { minWidth, minHeight })`);
    const min = w.opts.match(/minWidth:\s*(\d+),\s*minHeight:\s*(\d+)/);
    assert.ok(min, 'the window sets minWidth and minHeight');
    assert.deepStrictEqual([call[1], call[2]], [min[1], min[2]], 'the helper restores nothing smaller than the window allows');
    assert.ok(!new RegExp('settings\\.' + key + '\\s*=[^=]').test(main), 'no save of its own beside the helper');
    assert.ok(!new RegExp('const saved = settings\\.' + key + '\\b').test(main), 'no restore of its own beside the helper');
    assert.ok(!new RegExp(name + "\\.on\\('(move|resize|close)'").test(main), 'no move, resize or close handler of its own for the place');
  });
}

// The helper itself, run against a fake window and fake monitors: the text of
// isOnScreen, clampToWorkArea and rememberWindowPlace from main.js.
function placeHarness(displays, settings) {
  const src = ['isOnScreen', 'clampToWorkArea', 'rememberWindowPlace'].map((fn) => {
    const i = main.indexOf('function ' + fn + '(');
    assert.ok(i > 0, fn + ' is in main.js');
    return main.slice(i, main.indexOf('\n}\n', i) + 3);
  }).join('\n');
  const overlap = (d, b) => Math.max(0, Math.min(d.x + d.width, b.x + b.width) - Math.max(d.x, b.x))
    * Math.max(0, Math.min(d.y + d.height, b.y + b.height) - Math.max(d.y, b.y));
  const screen = {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0],
    getDisplayMatching: (b) => displays.slice().sort((p, q) => overlap(q.bounds, b) - overlap(p.bounds, b))[0],
  };
  const h = { writes: 0, timers: [] };
  const saveSettings = () => { h.writes++; };
  const req = (id) => { assert.strictEqual(id, './lib/window-place'); return WP; };
  const later = (fn, ms) => { h.timers.push({ fn, ms }); return h.timers.length; };
  const cancel = (id) => { if (id) h.timers[id - 1] = null; };
  h.runTimers = () => { const t = h.timers.filter(Boolean); h.timers = []; t.forEach((x) => x.fn()); return t.length; };
  h.remember = new Function('screen', 'settings', 'saveSettings', 'require', 'setTimeout', 'clearTimeout',
    src + '\nreturn rememberWindowPlace;')(screen, settings, saveSettings, req, later, cancel);
  return h;
}
function fakeWindow(bounds) {
  const on = {};
  const w = {
    bounds: { ...bounds }, normal: { ...bounds }, minimized: false,
    setBounds(b) { w.bounds = { ...b }; w.normal = { ...b }; },
    getBounds: () => w.bounds, getNormalBounds: () => w.normal,
    isDestroyed: () => false, isMinimized: () => w.minimized, isFullScreen: () => false,
    on(ev, fn) { (on[ev] = on[ev] || []).push(fn); },
    emit(ev) { (on[ev] || []).forEach((fn) => fn()); },
  };
  return w;
}
const disp = (x, y, width, height) => ({ bounds: { x, y, width, height }, workArea: { x, y, width, height: height - 48 } });
// Three 1920x1080 monitors side by side; the primary is the middle one.
const THREE = [disp(0, 0, 1920, 1080), disp(-1920, 0, 1920, 1080), disp(1920, 0, 1920, 1080)];
const SCOPE_MIN = { minWidth: 480, minHeight: 300 };
const DEFAULT_PLACE = { x: 460, y: 220, width: 1000, height: 640 };

test('a scope left maximized on the third monitor reopens on the third monitor (#252)', () => {
  const settings = {};
  const w = fakeWindow(DEFAULT_PLACE);
  placeHarness(THREE, settings).remember(w, 'scopePopoutBounds', SCOPE_MIN);
  // Dragged to the right-hand monitor, maximized there, then closed.
  w.normal = { x: 2200, y: 150, width: 1100, height: 700 };
  w.bounds = { x: 1920, y: 0, width: 1920, height: 1032 };
  w.emit('close');
  assert.deepStrictEqual(settings.scopePopoutBounds, { x: 2200, y: 150, width: 1100, height: 700 });
  const again = fakeWindow(DEFAULT_PLACE);
  placeHarness(THREE, settings).remember(again, 'scopePopoutBounds', SCOPE_MIN);
  assert.deepStrictEqual(again.bounds, { x: 2200, y: 150, width: 1100, height: 700 });
});

test('a move or a resize is saved 0.7 s after it stops, without waiting for close', () => {
  const settings = {};
  const h = placeHarness(THREE, settings);
  const w = fakeWindow(DEFAULT_PLACE);
  h.remember(w, 'scopePopoutBounds', SCOPE_MIN);
  w.setBounds({ x: -1700, y: 90, width: 900, height: 500 });
  w.emit('move'); w.emit('move'); w.emit('resize');
  assert.strictEqual(settings.scopePopoutBounds, undefined, 'not on every pixel of a drag');
  assert.deepStrictEqual(h.timers.filter(Boolean).map((t) => t.ms), [700], 'one pending save');
  assert.strictEqual(h.runTimers(), 1);
  assert.deepStrictEqual(settings.scopePopoutBounds, { x: -1700, y: 90, width: 900, height: 500 });
  assert.strictEqual(h.writes, 1);
  w.emit('close');
  assert.strictEqual(h.writes, 1, 'an unchanged place is not written again');
  w.minimized = true; w.normal = { x: -32000, y: -32000, width: 160, height: 28 };
  w.emit('close');
  assert.strictEqual(h.writes, 1, 'a minimized window saves nothing');
});

test('a place on the left monitor (negative x) restores exactly; at exactly the minimum size too', () => {
  const w = fakeWindow(DEFAULT_PLACE);
  placeHarness(THREE, { scopePopoutBounds: { x: -1700, y: 90, width: 900, height: 500 } }).remember(w, 'scopePopoutBounds', SCOPE_MIN);
  assert.deepStrictEqual(w.bounds, { x: -1700, y: 90, width: 900, height: 500 });
  const min = fakeWindow(DEFAULT_PLACE);
  placeHarness(THREE, { scopePopoutBounds: { x: 2000, y: 40, width: 480, height: 300 } }).remember(min, 'scopePopoutBounds', SCOPE_MIN);
  assert.deepStrictEqual(min.bounds, { x: 2000, y: 40, width: 480, height: 300 }, 'the old code wanted height > 300 and dropped this one');
});

test('its monitor gone: the default place; partly off a screen: pulled back; too small: not restored', () => {
  const one = [THREE[0]];
  const gone = fakeWindow(DEFAULT_PLACE);
  placeHarness(one, { scopePopoutBounds: { x: 2200, y: 150, width: 1100, height: 700 } }).remember(gone, 'scopePopoutBounds', SCOPE_MIN);
  assert.deepStrictEqual(gone.bounds, DEFAULT_PLACE, 'left where Electron centred it on the primary');
  const part = fakeWindow(DEFAULT_PLACE);
  placeHarness(one, { scopePopoutBounds: { x: 1500, y: 700, width: 1100, height: 700 } }).remember(part, 'scopePopoutBounds', SCOPE_MIN);
  assert.deepStrictEqual(part.bounds, { x: 820, y: 332, width: 1100, height: 700 }, 'wholly on the work area');
  const small = fakeWindow(DEFAULT_PLACE);
  placeHarness(one, { scopePopoutBounds: { x: 100, y: 100, width: 300, height: 200 } }).remember(small, 'scopePopoutBounds', SCOPE_MIN);
  assert.deepStrictEqual(small.bounds, DEFAULT_PLACE);
});

test('this test is in the list CI runs', () => {
  assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/window-rules-test.js'"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
