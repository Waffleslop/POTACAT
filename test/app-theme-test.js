#!/usr/bin/env node
'use strict';
// Design-system themes on the desktop (docs/design-system-plan.md Phase 3):
// lib/app-theme.js decides the attributes, every window gets them at load
// (themeQuery -> popout-theme-bootstrap.js) and on change (broadcastAppTheme),
// and ds-bridge.css points the classic variables at the theme's roles.
// Run: node test/app-theme-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const AppTheme = require('../lib/app-theme');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

console.log('app theme');

test('classic (and no setting, and an unknown id) keeps lightMode + darkVariant exactly as before', () => {
  assert.deepStrictEqual(AppTheme.resolveAppTheme({}), { theme: 'dark', variant: 'navy', ds: null, appTheme: 'classic' });
  assert.deepStrictEqual(AppTheme.resolveAppTheme({ lightMode: true }), { theme: 'light', variant: 'navy', ds: null, appTheme: 'classic' });
  assert.deepStrictEqual(AppTheme.resolveAppTheme({ darkVariant: 'charcoal' }), { theme: 'dark', variant: 'charcoal', ds: null, appTheme: 'classic' });
  assert.strictEqual(AppTheme.resolveAppTheme({ appTheme: 'trekker', lightMode: true }).ds, null);
});

test('a design-system theme decides light vs dark itself and names its token column', () => {
  assert.deepStrictEqual(AppTheme.resolveAppTheme({ appTheme: 'acid-burn', lightMode: true }), { theme: 'dark', variant: 'navy', ds: 'acid', appTheme: 'acid-burn' });
  assert.strictEqual(AppTheme.resolveAppTheme({ appTheme: 'potacat-light' }).theme, 'light');
  assert.strictEqual(AppTheme.resolveAppTheme({ appTheme: 'potacat-dark' }).ds, 'night');
  assert.strictEqual(AppTheme.resolveAppTheme({ appTheme: 'midnight' }).ds, 'dark');
});

test('ids and columns match the phone and the generated token sheet', () => {
  const gen = require('../scripts/gen-design-tokens-css');
  for (const t of AppTheme.APP_THEMES.filter((x) => x.column)) {
    const g = gen.THEMES.find((x) => x.id === t.id);
    assert.ok(g, t.id + ' missing from the generator');
    assert.strictEqual(g.column, t.column);
    assert.strictEqual(g.scheme, t.scheme);
  }
});

test('the quick toggle moves between a design theme\'s light and dark, and leaves classic alone', () => {
  assert.strictEqual(AppTheme.toggledAppTheme('acid-burn', true), 'potacat-light');
  assert.strictEqual(AppTheme.toggledAppTheme('potacat-light', false), 'potacat-dark');
  assert.strictEqual(AppTheme.toggledAppTheme('midnight', false), 'midnight');
  assert.strictEqual(AppTheme.toggledAppTheme('classic', true), 'classic');
});

test('applyToDocument sets and clears the three attributes', () => {
  const attrs = {};
  const doc = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; } } };
  AppTheme.applyToDocument(doc, AppTheme.resolveAppTheme({ appTheme: 'acid-burn' }));
  assert.deepStrictEqual(attrs, { 'data-theme': 'dark', 'data-ds': 'acid' });
  AppTheme.applyToDocument(doc, AppTheme.resolveAppTheme({ darkVariant: 'charcoal' }));
  assert.deepStrictEqual(attrs, { 'data-theme': 'dark', 'data-dark-variant': 'charcoal' });
});

test('main: every window opens with themeQuery(), theme changes broadcast to all windows, appTheme is machine-global', () => {
  const m = read('main.js');
  assert.ok(!m.includes("{ theme: settings.lightMode ? 'light' : 'dark', variant: settings.darkVariant || 'navy' }"), 'a window still builds its own theme payload');
  assert.ok((m.match(/themeQuery\(\)/g) || []).length >= 30);
  assert.ok(/function broadcastAppTheme\(\)[\s\S]*?BrowserWindow\.getAllWindows\(\)/.test(m));
  assert.ok(/const _themeBefore = JSON\.stringify\(AppTheme\.resolveAppTheme\(settings\)\);\n\s+settings = \{ \.\.\.settings, \.\.\.newSettings \};\n\s+if \(JSON\.stringify\(AppTheme\.resolveAppTheme\(settings\)\) !== _themeBefore\) broadcastAppTheme\(\);/.test(m));
  assert.ok(/'appTheme',\s+\/\//.test(m), 'appTheme in GLOBAL_KEYS');
});

test('every window that loads styles.css gets the tokens and the bridge; the bootstrap stamps data-ds', () => {
  const css = read('renderer/styles.css');
  assert.ok(css.startsWith('@import url("tokens.css");\n@import url("ds-bridge.css");'));
  assert.ok(/p\.get\('ds'\)[\s\S]*setAttribute\('data-ds', ds\)/.test(read('renderer/popout-theme-bootstrap.js')));
});

test('the bridge reads only tokens and leaves the classic themes alone', () => {
  const b = read('renderer/ds-bridge.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(b) && !/\brgba?\(/i.test(b));
  for (const rule of b.match(/^[^{}\n][^{}]*\{/gm)) assert.ok(/\[data-ds/.test(rule), 'a bridge rule applies without data-ds: ' + rule.trim());
  for (const v of ['--bg-primary', '--text-primary', '--accent-red', '--accent-blue', '--accent-green', '--border-primary']) assert.ok(b.includes(v + ':'), v);
});

test('main window: the Theme picker is saved, loaded and applied through the shared resolver', () => {
  const a = read('renderer/app.js');
  assert.ok(/appTheme: appThemeVal,/.test(a));
  assert.ok(/_currentAppTheme = settings\.appTheme \|\| 'classic';/.test(a));
  assert.ok(/window\.AppTheme\.resolveAppTheme\(/.test(a));
  assert.ok(/id="set-app-theme"/.test(read('renderer/index.html')));
  assert.ok(/<script src="\.\.\/lib\/app-theme\.js"><\/script>/.test(read('renderer/index.html')));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
