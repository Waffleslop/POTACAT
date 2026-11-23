#!/usr/bin/env node
'use strict';
// #866 (Discord "APRS TX Bug", an IC-7300 on macOS, 1.14.7): the APRS window
// could not be closed on a Mac. It was created with plain `frame: false`, so
// macOS drew no traffic lights, and styles.css hides `.titlebar-controls` on
// macOS (where the traffic lights take their place), so the drawn buttons went
// too, and with them the APRS views and settings. The JTCAT map pop-out had
// the same fault. Every visible frameless window now uses the macOS
// `titleBarStyle: 'hiddenInset'` form, and a title bar that also holds the
// window's own controls keeps them on a Mac.
// Run: node test/mac-frameless-windows-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const main = read('main.js').replace(/\r\n/g, '\n');
const WF = require('../lib/window-frame');
// #345: the frame now comes from windowFrame() (lib/window-frame.js), still hiddenInset on a Mac.
const MAC_FORM = /isMac \? \{ titleBarStyle: 'hiddenInset' \}|\.\.\.windowFrame\(\)/;

console.log('Frameless windows on macOS (#866)');

test('every visible frameless window keeps the macOS traffic lights (hiddenInset on a Mac)', () => {
  const bad = [];
  const re = /new BrowserWindow\(\{/g;
  let m;
  while ((m = re.exec(main))) {
    // The options object: up to its closing `});` at the same depth (good enough: options hold no `});`).
    const opts = main.slice(m.index, main.indexOf('});', m.index));
    if (!/frame: false/.test(opts)) continue;
    if (/offscreen: true/.test(opts) || /show: false/.test(opts) && /offscreen/.test(opts)) continue; // an off-screen render, never seen
    if (/isMac \? \{ titleBarStyle: 'hiddenInset' \} : \{ frame: false \}/.test(opts)) continue;
    if (/\.\.\.windowFrame\(\)/.test(opts)) continue; // #345: the one rule, hiddenInset on a Mac (tested below)
    const line = main.slice(0, m.index).split('\n').length;
    bad.push('main.js:' + line + ' ' + (opts.match(/title: '([^']+)'/) || ['', '(untitled)'])[1]);
  }
  assert.deepStrictEqual(bad, [], 'plain frame:false leaves a Mac with no close: ' + bad.join(', '));
});

test('the APRS window, the JTCAT map and the JS8 Heartbeat Map use the Mac form', () => {
  const at = (needle) => main.slice(main.indexOf(needle), main.indexOf(needle) + 700);
  assert.ok(MAC_FORM.test(at("aprsWin = new BrowserWindow({")));
  assert.ok(MAC_FORM.test(at("jtcatMapPopoutWin = new BrowserWindow({")));
  assert.ok(MAC_FORM.test(at("js8MapWin = new BrowserWindow({")));
});

test('windowFrame() (lib/window-frame.js, #345) gives a Mac hiddenInset whatever the Linux setting says', () => {
  assert.deepStrictEqual(WF.windowFrameFor('darwin', {}), { titleBarStyle: 'hiddenInset' });
  assert.deepStrictEqual(WF.windowFrameFor('darwin', { linuxNativeFrame: true }), { titleBarStyle: 'hiddenInset' });
  assert.ok(/function windowFrame\(\) \{\s*return WindowFrame\.windowFrameFor\(process\.platform/.test(main));
});

test('on a Mac the APRS views and settings, and the JTCAT map Worked button, stay; only the drawn window buttons go', () => {
  const css = read('renderer/styles.css');
  assert.ok(/\.platform-darwin \.titlebar-controls\.titlebar-keep-on-mac \{\s*display: flex;/.test(css));
  assert.ok(/\.platform-darwin \.titlebar-controls\.titlebar-keep-on-mac #tb-close/.test(css));
  assert.ok(read('renderer/aprs-popout.html').includes('<div class="titlebar-controls titlebar-keep-on-mac">'));
  assert.ok(read('renderer/jtcat-map-popout.html').includes('<div class="titlebar-controls titlebar-keep-on-mac">'));
  // The Worked button has no tb-min/max/close id, so it stays.
  assert.ok(read('renderer/jtcat-map-popout.html').includes('id="tb-worked"'));
});

test('the JS8 Heartbeat Map now tells its page the platform, so a Mac hides the drawn buttons for the traffic lights', () => {
  assert.ok(/platform: process\.platform/.test(read('preload-js8-map-popout.js')));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
