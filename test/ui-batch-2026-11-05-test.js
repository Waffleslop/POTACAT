#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
/**
 * The 2026-11-05 UI batch from the Discord bug review (section E). Source
 * guards: each is a one-line cause that would be easy to undo by accident.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = (f) => readSrc(path.join(__dirname, '..', f)).replace(/\r\n/g, '\n');
const css = R('renderer/styles.css');
const app = R('renderer/app.js');
const main = R('main.js');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

check('Spots menu: a focused submenu yields to the hovered row (hoogskev)', () => {
  assert.ok(/\.spots-dropdown-panel:hover \.spots-category:not\(:hover\) > \.spots-submenu \{\s+display: none;/.test(css));
});
check('an open dialog is never part of the titlebar drag region (nj2dx, Station Setup X)', () => {
  assert.ok(/\ndialog\[open\] \{\n  -webkit-app-region: no-drag;/.test(css));
});
check('Winlink and Mercury titlebars clear the macOS traffic lights (hoogskev)', () => {
  assert.ok(/\.platform-darwin \.wl-titlebar \{ padding-left: 80px; height: 38px; \}/.test(R('renderer/winlink-popout.html')));
  assert.ok(/\.platform-darwin \.mq-titlebar \{ padding-left: 80px; height: 38px; \}/.test(R('renderer/mercury-popout.html')));
});
check('voice macro panel is pulled back into the window when shown and on resize (andrewmorkunas)', () => {
  assert.ok(/if \(voiceMacroBoxVisible\) requestAnimationFrame\(\(\) => clampFloatingBox\(voiceMacroBar, 'voiceMacroBoxPos'\)\);/.test(app));
  assert.ok(/clampFloatingBox\(document\.getElementById\('voice-macro-bar'\), 'voiceMacroBoxPos'\);/.test(app));
  assert.ok(/if \(Number\.isFinite\(left\) && Number\.isFinite\(top\)\) localStorage\.setItem\('voiceMacroBoxPos'/.test(app), 'never saves NaN');
});
check('VFO: typing into the Type a frequency box works (hoogskev)', () => {
  assert.ok(/if \(t !== kpInput && t && \(t\.tagName === 'INPUT'/.test(R('renderer/vfo-popout.html').split("document.addEventListener('keydown'")[1] || ''));
});
check('the tint button colour token is defined (Add channel was gray on 1.13.9, hoogskev)', () => {
  assert.ok(/--on-accent-blue:/.test(css));
  assert.ok(/color: var\(--on-accent-blue\)/.test(R('renderer/channels.css')));
});
check('Directory tabs step with the arrow keys (hoogskev)', () => {
  assert.ok(/currentView === 'directory'\s+&& !e\.target\.matches\('input, select, textarea'\)[\s\S]{0,200}directoryArrowStep\(e\.key === 'ArrowDown' \? 1 : -1\)/.test(app));
  assert.ok(/function directoryArrowStep\(step\) \{[\s\S]{0,600}rows\[idx\]\.click\(\);/.test(app));
});
check('the Log QSO dialog is wide enough for the worked-band grid (hoogskev)', () => {
  // #240 widened it again and made it resizable: at least 500 px, capped by the window.
  const w = /#log-dialog \{[\s\S]{0,900}?\n  width: min\((\d+)px, (?:96vw|calc\(100vw - \d+px\))\);/.exec(css);
  assert.ok(w && +w[1] >= 500, 'Log dialog at least 500 px wide');
  assert.ok(/\.log-worked-matrix \{ overflow-x: auto; \}/.test(css));
});
check('Settings Save reconnects the cluster only for a CHANGED panadapter gate (hoogskev: DX spots vanished)', () => {
  assert.ok(/const panadapterChanged = \['panadapterSyncTable'[\s\S]{0,400}\.some\(\(k\) => has\(k\) && JSON\.stringify\(newSettings\[k\]\) !== JSON\.stringify\(settings\[k\]\)\);/.test(main));
  const at = main.indexOf('const panadapterChanged = [');
  const merge = main.indexOf('settings = { ...settings, ...newSettings };', at - 20000);
  assert.ok(at > 0 && merge > at, 'decided before the merge');
  assert.ok(!/const panadapterChanged = has\('panadapterSyncTable'\)/.test(main));
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
