#!/usr/bin/env node
'use strict';
// Settings meets the contrast rule in every theme (Casey 2026-11-11: "Set up
// VARA HF for me" was black text on dark green in She's On Frequency).
// The rendered check is scripts/settings-contrast-audit.js (Electron, all ten
// themes, every element that draws text); this test pins its fixes in source.
// Run: node test/settings-contrast-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

const root = path.join(__dirname, '..');
const css = readSrc(path.join(root, 'renderer', 'styles.css')).replace(/\r\n/g, '\n');
const bridge = readSrc(path.join(root, 'renderer', 'ds-bridge.css')).replace(/\r\n/g, '\n');
const html = readSrc(path.join(root, 'renderer', 'index.html')).replace(/\r\n/g, '\n');
const app = readSrc(path.join(root, 'renderer', 'app.js'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
function rule(sel) {
  const i = css.indexOf(sel + ' {');
  assert.ok(i >= 0, sel + ' exists');
  return css.slice(i, css.indexOf('}', i) + 1);
}

console.log('Settings contrast');

test('the green button reads its theme\'s "on" colour, never a hard-coded black', () => {
  assert.ok(/color: var\(--on-accent-green-btn\);/.test(rule('.btn-primary')));
  assert.ok(!/\.btn-primary \{ color: #000; \}/.test(css), 'the WCAG override that forced black is gone');
  assert.ok(/--on-accent-green-btn: #10131a;/.test(css), 'dark text on the classic light-green button');
  assert.ok(/--accent-green-btn: #1b5e3b;\n  --on-accent-green-btn: #fff;/.test(css), 'white on the WCAG theme\'s dark green');
  assert.ok(/--on-accent-green-btn: var\(--ds-on-ok\);/.test(bridge), 'each design theme\'s own "on ok" (She\'s On Frequency: white on #1e5c34)');
});

test('text on the classic dark themes\' light blue and green fills is dark; the light theme keeps white', () => {
  assert.ok(/--on-accent-blue: #10131a;\n  --on-accent-green: #10131a;/.test(css));
  assert.ok(/\[data-theme="light"\] \{[^}]*--on-accent-blue: #fff;\n  --on-accent-green: #fff;/.test(css));
  assert.ok(/--accent-blue: #1565c0;/.test(css), 'the classic light link blue passes on its tinted panels');
  assert.ok(/color: var\(--on-accent-green\);/.test(rule('.rig-editor-buttons button:first-child')), 'Save Rig / Save Net');
});

test('red used as text has its own token (Navy lightens it; the brand fill stays)', () => {
  assert.ok(/--accent-red-text: var\(--accent-red\);/.test(css));
  assert.ok(/:root:not\(\[data-theme="light"\]\):not\(\[data-dark-variant\]\):not\(\[data-ds\]\) \{\n  --accent-red-text: #ff6b81;/.test(css));
  assert.ok(/--accent-red-text: var\(--ds-air-ink\);/.test(bridge));
  for (const sel of ['dialog h3', '.btn-danger', '.status.disconnected', '.settings-tab.settings-tab-action']) {
    assert.ok(/color: var\(--accent-red-text\);/.test(rule(sel)), sel);
  }
  assert.ok(/--accent-red: #e94560;/.test(css), 'the brand red itself is unchanged');
});

test('no hard-coded text colour inside the Settings dialog', () => {
  const s = html.indexOf('<dialog id="settings-dialog">');
  const e = html.indexOf('<dialog id="park-state-dialog">');
  const box = html.slice(s, e);
  const hex = box.match(/(?:^|[;"\s])color:\s*#[0-9a-f]{3,8}\b/gi) || [];
  assert.deepStrictEqual(hex, [], 'inline colours must be theme tokens');
  assert.ok(!/var\(--text-dim,#888\)/.test(box));
});

test('the rules Settings uses are theme tokens', () => {
  assert.ok(/color: var\(--text-secondary\);/.test(rule('.flex-status')));
  assert.ok(/color: var\(--text-secondary\);/.test(rule('.settings-version')));
  assert.ok(/color: var\(--accent-blue\);/.test(rule('#net-editor h4')), 'not the net yellow (1.3:1 on light)');
  assert.ok(/\.cloud-yearly-btn \{ background: var\(--accent-blue\); border-color: var\(--accent-blue\); color: var\(--on-accent-blue\); \}/.test(css));
  assert.ok(/#settings-dialog a:not\(\[class\]\):not\(\[style\*="color"\]\) \{ color: var\(--link, var\(--accent-blue\)\); \}/.test(css), 'no browser-blue links');
  assert.ok(/\[data-theme="light"\] \{[^}]*--warn: #8a5c00;/.test(css), 'warnings readable on light');
  assert.ok(!/launcherStatusPill\.style\.color = '#/.test(app), 'the launcher pill paints with tokens');
});

test('the rendered audit exists and this test is in the list CI runs', () => {
  const audit = readSrc(path.join(root, 'scripts', 'settings-contrast-audit.js'));
  assert.ok(audit.includes('On Frequency') && audit.includes('Halloween') && /ratio\(fg, bg\)/.test(audit), 'all ten themes, measured');
  assert.ok(readSrc(path.join(root, 'scripts', 'run-tests.js')).includes("'test/settings-contrast-test.js'"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
