#!/usr/bin/env node
'use strict';
// N0KAH 2026-10-01: on a Mac the Log and VFO pop-outs showed the system
// traffic lights AND our own minimize/maximize/close buttons, with the title
// under the traffic lights. Every pop-out opens with titleBarStyle
// 'hiddenInset' on macOS, so each one must (1) get the platform-darwin class,
// which renderer/popout-theme-boot.js sets before first paint, and (2) hide
// its own window buttons under that class. Seven pop-outs had neither.
// Run: node test/mac-titlebar-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const R = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
console.log('macOS title bars');

const main = R('main.js');
// Every pop-out page a hiddenInset window loads (the main window, index.html,
// has its own titlebar handling in app.js).
const pages = new Set();
for (const m of main.matchAll(/titleBarStyle: 'hiddenInset'/g)) {
  const after = main.slice(m.index, m.index + 4000);
  const page = (after.match(/([a-z0-9-]+-popout)\.html/) || [])[1];
  if (page) pages.add(page);
}

test('the boot script marks <html> platform-darwin from the preload\'s platform', () => {
  const boot = R('renderer/popout-theme-boot.js');
  assert.ok(/window\.api\.platform === 'darwin'\) document\.documentElement\.classList\.add\('platform-darwin'\)/.test(boot));
});

test('found the pop-outs (sanity)', () => {
  assert.ok(pages.size >= 15, 'only found ' + [...pages].join(', '));
  for (const p of ['log-popout', 'vfo-popout', 'spots-popout', 'sstv-popout']) assert.ok(pages.has(p), p);
});

for (const page of [...pages].sort()) {
  test(`${page}: loads the boot script and hides its own window buttons on macOS`, () => {
    const html = R(`renderer/${page}.html`);
    assert.ok(html.includes('popout-theme-boot.js'), 'does not load popout-theme-boot.js');
    // Shared classes from styles.css (.titlebar-controls is hidden there) or
    // a page-local .platform-darwin rule for its own button class.
    const sharedControls = /class="titlebar-controls"/.test(html) && /styles\.css/.test(html);
    const ownRule = /\.platform-darwin [^{]*\{[^}]*display:\s*none/.test(html);
    const jsRule = fs.existsSync(path.join(root, 'renderer', page + '.css'))
      && /\.platform-darwin [^{]*\{[^}]*display:\s*none/.test(R(`renderer/${page}.css`));
    const hasButtons = /minimize|title="Minimize"|&#x2013;|&#x2014;|&#8211;/i.test(html);
    if (hasButtons) assert.ok(sharedControls || ownRule || jsRule, 'shows its own window buttons on macOS');
  });
}

test('the shared rule in styles.css still hides .titlebar-controls and clears the traffic lights', () => {
  const css = R('renderer/styles.css');
  assert.ok(/\.platform-darwin \.titlebar \{\s*padding-left: 80px;/.test(css));
  assert.ok(/\.platform-darwin \.titlebar-controls \{\s*display: none;/.test(css));
});

console.log(`\nmacOS title bars: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
