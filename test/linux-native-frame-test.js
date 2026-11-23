#!/usr/bin/env node
'use strict';
// #345 (Discord "Windows don't have a drop-down menu in Linux", KL7UT
// 2026-11-10): POTACAT's windows are frameless, so on Linux the window
// manager draws no title bar and its window menu (move to workspace, always on
// top) is missing. An opt-in setting, Linux only and off by default, gives
// every POTACAT window the system frame instead, and each page then hides its
// own drawn window buttons (and its title bar, where that holds nothing else)
// so there are never two title bars.
// Run: node test/linux-native-frame-test.js

const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const root = path.join(__dirname, '..');
const read = (f) => readSrc(path.join(root, f));

console.log('Linux system title bar (#345)');

let WF = {};
try { WF = require('../lib/window-frame'); } catch (e) { /* the tests below fail with the reason */ }

test('windowFrameFor: Linux with the setting on gets the system frame', () => {
  assert.deepStrictEqual(WF.windowFrameFor('linux', { linuxNativeFrame: true }), { frame: true });
});
test('windowFrameFor: Linux with the setting off (or absent) stays frameless', () => {
  assert.deepStrictEqual(WF.windowFrameFor('linux', { linuxNativeFrame: false }), { frame: false });
  assert.deepStrictEqual(WF.windowFrameFor('linux', {}), { frame: false });
  assert.deepStrictEqual(WF.windowFrameFor('linux', null), { frame: false });
  assert.deepStrictEqual(WF.windowFrameFor('linux', { linuxNativeFrame: 'yes' }), { frame: false }, 'only a real true turns it on');
});
test('windowFrameFor: Windows stays frameless whatever the setting says', () => {
  assert.deepStrictEqual(WF.windowFrameFor('win32', { linuxNativeFrame: true }), { frame: false });
  assert.deepStrictEqual(WF.windowFrameFor('win32', {}), { frame: false });
});
test('windowFrameFor: macOS keeps hiddenInset (the traffic lights, #866) whatever the setting says', () => {
  assert.deepStrictEqual(WF.windowFrameFor('darwin', { linuxNativeFrame: true }), { titleBarStyle: 'hiddenInset' });
  assert.deepStrictEqual(WF.windowFrameFor('darwin', {}), { titleBarStyle: 'hiddenInset' });
});
test('usesNativeFrame matches windowFrameFor', () => {
  assert.strictEqual(WF.usesNativeFrame('linux', { linuxNativeFrame: true }), true);
  assert.strictEqual(WF.usesNativeFrame('linux', {}), false);
  assert.strictEqual(WF.usesNativeFrame('win32', { linuxNativeFrame: true }), false);
  assert.strictEqual(WF.usesNativeFrame('darwin', { linuxNativeFrame: true }), false);
});

const main = read('main.js');

test('every visible window takes its frame from windowFrame(); none hand-builds frame or titleBarStyle', () => {
  const bad = [];
  let n = 0;
  for (const m of main.matchAll(/(\w+)\s*=\s*new BrowserWindow\(\{/g)) {
    const opts = main.slice(m.index, main.indexOf('});', m.index)).replace(/\/\/[^\n]*/g, ''); // comments may name the old form
    const line = main.slice(0, m.index).split('\n').length;
    if (/offscreen:\s*true/.test(opts)) continue; // an off-screen render, never seen
    const hasFrameOpt = /\bframe:|titleBarStyle/.test(opts);
    if (/\.\.\.windowFrame\(\)/.test(opts)) { n++; if (/\bframe:|titleBarStyle/.test(opts.replace(/\.\.\.windowFrame\(\),?/, ''))) bad.push(`${m[1]} (main.js:${line}) sets a frame beside windowFrame()`); continue; }
    if (hasFrameOpt) bad.push(`${m[1]} (main.js:${line})`);
  }
  assert.deepStrictEqual(bad, [], 'use ...windowFrame() instead: ' + bad.join(', '));
  assert.ok(n >= 23, 'only ' + n + ' windows use windowFrame()');
});

test('windowFrame() and the page query both come from lib/window-frame.js, read once per run (applies on restart)', () => {
  assert.ok(/require\('\.\/lib\/window-frame'\)/.test(main));
  const fn = main.slice(main.indexOf('let _windowFrameSettings'), main.indexOf('function themeQuery()'));
  assert.ok(/WindowFrame\.windowFrameFor\(process\.platform/.test(fn), 'windowFrame() calls WindowFrame.windowFrameFor(process.platform, ...)');
  assert.ok(/_windowFrameSettings/.test(fn), 'the setting is latched at the first window, so a change waits for a restart');
  const tq = main.slice(main.indexOf('function themeQuery()'), main.indexOf('function themeQuery()') + 400);
  assert.ok(/usesNativeFrame/.test(tq) && /q\.frame = 'native'/.test(tq), "themeQuery() tells every page frame=native");
});

test('both theme boot scripts mark <html class="native-frame"> from the query and load native-frame.css', () => {
  for (const f of ['renderer/popout-theme-boot.js', 'renderer/popout-theme-bootstrap.js']) {
    const s = read(f);
    assert.ok(/q\.get\('frame'\) === 'native'/.test(s), f + ' reads frame=native');
    assert.ok(/classList\.add\('native-frame'\)/.test(s), f + ' adds the native-frame class');
    assert.ok(/native-frame\.css/.test(s), f + ' loads native-frame.css');
  }
});

test('every page with a drawn title bar loads one of the boot scripts', () => {
  const fs = require('fs');
  const pages = fs.readdirSync(path.join(root, 'renderer')).filter((f) => f.endsWith('.html'));
  const missing = [];
  for (const p of pages) {
    const h = read('renderer/' + p);
    if (!/titlebar/.test(h)) continue;
    if (!/<script src="popout-theme-boot(strap)?\.js"><\/script>/.test(h)) missing.push(p);
  }
  assert.deepStrictEqual(missing, []);
});

test('native-frame.css hides the drawn title bars and window buttons, only under html.native-frame', () => {
  const css = read('renderer/native-frame.css');
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Every selector is scoped to the class, so nothing changes without it.
  for (const sel of rules.split('}').map((r) => r.split('{')[0]).join(',').split(',').map((s) => s.trim()).filter(Boolean)) {
    assert.ok(sel.startsWith('html.native-frame '), 'unscoped selector: ' + sel);
  }
  // Plain title bars (title + buttons) go entirely.
  for (const cls of ['.titlebar', '.aw-titlebar', '.sc-titlebar', '.sstv-titlebar', '.lp-titlebar']) {
    assert.ok(new RegExp('html\\.native-frame ' + cls.replace('.', '\\.') + '[^{]*\\{[^}]*display:\\s*none').test(rules)
      || new RegExp('html\\.native-frame ' + cls.replace('.', '\\.') + '[\\s\\S]*?\\{[^}]*display:\\s*none').test(rules), cls + ' hidden');
  }
  // Bars that hold their own controls stay, but their window buttons go.
  assert.ok(/:has\(\.titlebar-keep-on-mac\)/.test(rules), 'the APRS and JTCAT map bars keep their controls');
  for (const sel of ['#tb-min', '#tb-max', '#tb-close', '.mq-winbtn', '.wl-winbtn', '.win-btn']) {
    assert.ok(rules.includes(sel), sel + ' hidden');
  }
  assert.ok(/-webkit-app-region:\s*no-drag/.test(rules), 'a kept bar is no longer a drag region (the system frame moves the window)');
});

test('every kind of drawn title bar in renderer/ is named in native-frame.css (a new one must be added there)', () => {
  const fs = require('fs');
  const css = read('renderer/native-frame.css');
  const missing = [];
  for (const p of fs.readdirSync(path.join(root, 'renderer')).filter((f) => f.endsWith('.html'))) {
    for (const m of read('renderer/' + p).matchAll(/<div class="((?:[a-z0-9]+-)?titlebar)"/g)) {
      if (!new RegExp('html\\.native-frame \\.' + m[1] + '\\b').test(css)) missing.push(p + ': .' + m[1]);
    }
  }
  assert.deepStrictEqual(missing, []);
});

const html = read('renderer/index.html');
const app = read('renderer/app.js');

test('the setting is a checkbox in Settings > Display, inside a Linux-only block, saying a restart applies it', () => {
  const at = html.indexOf('id="set-linux-native-frame"');
  assert.ok(at > 0, 'checkbox #set-linux-native-frame');
  const block = html.slice(html.lastIndexOf('<div id="linux-native-frame-row"', at), at + 800);
  assert.ok(/<div id="linux-native-frame-row"[^>]*class="[^"]*hidden/.test(block), 'the row starts hidden');
  assert.ok(/type="checkbox"/.test(block));
  assert.ok(/Use the system title bar/.test(block));
  assert.ok(/restart/i.test(block), 'help text says a restart applies it');
  const fs = html.slice(html.lastIndexOf('<fieldset', at), at);
  assert.ok(/data-settings-tab="display"/.test(fs), 'in a Display fieldset');
});

test('the row is shown only on Linux', () => {
  assert.ok(/linux-native-frame-row'\)[\s\S]{0,120}classList\.toggle\('hidden', window\.api\.platform !== 'linux'\)/.test(app));
});

test('the setting defaults off, loads with === true and saves as linuxNativeFrame', () => {
  assert.ok(/setLinuxNativeFrame\.checked = s\.linuxNativeFrame === true;/.test(app));
  assert.ok(/linuxNativeFrame: setLinuxNativeFrame\.checked/.test(app));
  assert.ok(!/id="set-linux-native-frame"[^>]*checked/.test(html), 'unchecked in the markup');
  assert.deepStrictEqual(WF.windowFrameFor('linux', {}), { frame: false });
});

test('with the system frame, the main window title (mode and version) goes to the system title bar', () => {
  const fn = app.slice(app.indexOf('function updateTitleBar()'), app.indexOf('function updateTitleBar()') + 700);
  assert.ok(/classList\.contains\('native-frame'\)[\s\S]*document\.title = /.test(fn));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
