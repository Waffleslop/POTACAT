#!/usr/bin/env node
'use strict';
// Activation window + shareable image (NO4D 2026-09-25; Casey: IG/FB/TikTok
// image with safe zones). Source guards on the parts that are easy to break
// and hard to notice. Run: node test/activation-share-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const main = read('main.js');
const share = read('renderer/actmap-share.html');
const shareJs = read('renderer/actmap-share.js');

console.log('activation share');

test('share sizes: post 1080x1350, story 1080x1920', () => {
  assert.ok(/post: \{ width: 1080, height: 1350 \}, story: \{ width: 1080, height: 1920 \}/.test(main));
});

test('safe zones: post keeps text in the centre square, story clears the platform UI', () => {
  assert.ok(/--safe-top: 135px; --safe-bottom: 135px; --safe-left: 80px; --safe-right: 80px;/.test(share), 'post safe zone');
  assert.ok(/--safe-top: 270px; --safe-bottom: 420px; --safe-left: 64px; --safe-right: 150px;/.test(share), 'story safe zone');
  assert.ok(/#head \{ top: calc\(var\(--safe-top\) \+ 24px\); \}/.test(share) && /#foot \{ bottom: calc\(var\(--safe-bottom\) \+ 24px\); \}/.test(share));
});

test('rendered off-screen, viewport set through CDP only after the page loads', () => {
  const fn = main.slice(main.indexOf('async function renderActivationShareImage'), main.indexOf("ipcMain.handle('actmap-save-image'"));
  assert.ok(/offscreen: true/.test(fn), 'a hidden, non-offscreen window never paints');
  const load = fn.indexOf("await w.loadFile(path.join(__dirname, 'renderer', 'actmap-share.html'));");
  const emu = fn.indexOf("await dbg.sendCommand('Emulation.setDeviceMetricsOverride', metrics);");
  assert.ok(load > 0 && emu > load, 'emulation before the first load crashes Electron');
  assert.strictEqual(fn.split("'Emulation.setDeviceMetricsOverride'").length, 2, 'exactly one override, after load');
  assert.ok(/Page\.captureScreenshot/.test(fn));
});

test('the map fits between the text blocks and never shows the world edge', () => {
  assert.ok(/paddingTopLeft: \[90, topPad\], paddingBottomRight: \[90, bottomPad\]/.test(shareJs));
  assert.ok(/latLngToContainerPoint\(\[85\.0511, lng\]\)/.test(shareJs) && /fill-top/.test(shareJs));
});

test('branding is small and faint; OSM attribution is on the image', () => {
  assert.ok(/\.brand \{[^}]*font-size: 22px;[^}]*color: var\(--ink-faint\);/.test(share));
  assert.ok(/Map &copy; OpenStreetMap contributors/.test(share));
});

test('FT8 window offers the Activation window while an activation runs', () => {
  const html = read('renderer/jtcat-popout.html');
  const js = read('renderer/jtcat-popout.js');
  assert.ok(/id="jp-activation-btn"[^>]*hidden/.test(html));
  assert.ok(/window\.api\.onActivationState\(showActivationBtn\)/.test(js));
  assert.ok(/jtcatPopoutWin\.webContents\.send\('activation-state', !!newSettings\.activationActive\)/.test(main));
});

test('the Activation window log follows edits and deletes in the main window', () => {
  const app = read('renderer/app.js');
  const fn = app.slice(app.indexOf('function renderActivatorLog()'), app.indexOf('function renderActivatorLog()') + 800);
  assert.ok(/logOnly: true/.test(fn));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
