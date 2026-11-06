#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
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
const read = (p) => readSrc(path.join(root, p)).replace(/\r\n/g, '\n');

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
  assert.strictEqual(AppTheme.toggledAppTheme('shes-on-frequency', true), 'shes-on-frequency', 'a light design theme stays itself');
  assert.strictEqual(AppTheme.toggledAppTheme('shes-on-frequency', false), 'potacat-dark');
  assert.strictEqual(AppTheme.toggledAppTheme('miami-nights', false), 'miami-nights');
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

test('no rule puts white text on a themed accent (Acid Burn green and cyan need black): the --on-* variables', () => {
  const bad = [];
  for (const f of fs.readdirSync(path.join(root, 'renderer')).filter((x) => /\.(css|html)$/.test(x) && !/^remote\./.test(x))) {
    let src = read('renderer/' + f);
    if (f.endsWith('.html')) src = (src.match(/<style[^>]*>[\s\S]*?<\/style>/g) || []).join('\n');
    src = src.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/background(?:-color)?:\s*var\(--(accent-red|accent-blue|accent-green|accent-green-btn|accent|tx-active|red|ptt|ptt-on)\b/.test(m[2])
        && /(^|[;\s])color:\s*(#fff\b|#ffffff\b|white\b)/i.test(m[2])) bad.push(f + ': ' + m[1].trim());
    }
  }
  assert.deepStrictEqual(bad, []);
  const b = read('renderer/ds-bridge.css');
  for (const v of ['--on-accent-red', '--on-accent-blue', '--on-accent-green', '--on-tx-active']) assert.ok(b.includes(v + ':'), v);
});

test('one window title: every title bar reads the shared --titlebar-* values', () => {
  assert.ok(/\.titlebar-title \{\n  font-size: var\(--titlebar-font-size\);/.test(read('renderer/styles.css')));
  for (const [f, sel] of [['log-popout.html', '.lp-titlebar {'], ['winlink-popout.html', '.wl-title {'], ['mercury-popout.html', '.mq-title {'], ['scope-popout.html', '.sc-titlebar-title {'], ['sstv-popout.html', '.sstv-titlebar-title {'], ['atu-wizard-popout.html', '.aw-titlebar-title {']]) {
    const src = read('renderer/' + f);
    const i = src.indexOf(sel);
    assert.ok(i >= 0 && src.slice(i, src.indexOf('}', i)).includes('var(--titlebar-font-size)'), f);
  }
  // A bar sized by padding alone came out 29 px, and the macOS traffic lights
  // (y 6-22) sat on Winlink's "Send via" row (N0KAH, 1.13.6).
  for (const [f, sel] of [['log-popout.html', '.lp-titlebar {'], ['winlink-popout.html', '.wl-titlebar {'], ['mercury-popout.html', '.mq-titlebar {'], ['scope-popout.html', '.sc-titlebar {'], ['sstv-popout.html', '.sstv-titlebar {'], ['atu-wizard-popout.html', '.aw-titlebar {']]) {
    const src = read('renderer/' + f);
    const i = src.indexOf(sel);
    assert.ok(/height: var\(--titlebar-h\)/.test(src.slice(i, src.indexOf('}', i))), f + ' bar height');
  }
});

test('the VFO window (self-styled) follows a design theme: data-ds at boot, its own token block, the dial re-reads on change', () => {
  const boot = read('renderer/popout-theme-boot.js');
  assert.ok(/ds: q\.get\('ds'\)/.test(boot) && /setAttribute\('data-ds'/.test(boot));
  const v = read('renderer/vfo-popout.html');
  assert.ok(v.includes('<link rel="stylesheet" href="tokens.css">'));
  assert.ok(/:root\[data-ds\] \{[\s\S]*?--g: var\(--ds-bg\)/.test(v));
  assert.ok(/new MutationObserver\(\(\) => \{ readKnobColors\(\); drawVfoDial\(\); \}\)/.test(v));
});

test('Change Theme: every look is one dropdown entry, and a choice round-trips through the settings', () => {
  const ids = AppTheme.THEME_CHOICES.map(c => c.id);
  assert.deepStrictEqual(ids.slice(0, 3), ['classic-navy', 'classic-charcoal', 'classic-light']);
  for (const t of AppTheme.APP_THEMES.filter(t => t.column)) assert.ok(ids.includes(t.id), t.id + ' is in the dropdown');
  for (const id of ids) {
    const s = AppTheme.settingsForChoice(id);
    assert.strictEqual(AppTheme.choiceFor(Object.assign({ darkVariant: 'navy' }, s)), id, id + ' round trip');
    const r = AppTheme.resolveAppTheme(Object.assign({ darkVariant: 'navy' }, s));
    if (id === 'classic-light') assert.strictEqual(r.theme, 'light');
    if (id === 'classic-charcoal') assert.strictEqual(r.variant, 'charcoal');
  }
  // Old settings land on the right entry.
  assert.strictEqual(AppTheme.choiceFor({}), 'classic-navy');
  assert.strictEqual(AppTheme.choiceFor({ lightMode: true }), 'classic-light');
  assert.strictEqual(AppTheme.choiceFor({ darkVariant: 'charcoal' }), 'classic-charcoal');
  assert.strictEqual(AppTheme.choiceFor({ appTheme: 'midnight', lightMode: true }), 'midnight');
  assert.strictEqual(AppTheme.choiceFor({ appTheme: 'nope', lightMode: true }), 'classic-light');
  assert.deepStrictEqual(AppTheme.settingsForChoice('nope'), AppTheme.settingsForChoice('classic-navy'));
});

test('Change Theme: no on/off theme switch is left on screen (sidebar, Display, Welcome)', () => {
  const html = read('renderer/index.html');
  for (const id of ['quick-theme', 'set-app-theme', 'welcome-theme']) assert.ok(html.includes('<select id="' + id + '"'), id);
  for (const id of ['quick-light-mode', 'set-light-mode', 'welcome-light-mode']) {
    assert.ok(new RegExp('<input type="checkbox" id="' + id + '"( checked)? hidden style="display:none">').test(html), id + ' must stay hidden (the dropdown drives it)');
  }
  assert.ok(html.includes('id="set-dark-variant-group" class="dark-variant-group" hidden style="display:none"'), 'Navy/Charcoal radios hidden');
  assert.ok(!html.includes('<span>Dark Mode</span>'), 'no Dark Mode / Light Mode switch label');
  const app = read('renderer/app.js');
  assert.ok(app.includes("const appThemeVal = _currentAppTheme || 'classic';"), 'Settings save takes the theme the dropdown chose');
  assert.ok(app.includes("for (const id of ['quick-theme', 'set-app-theme', 'welcome-theme'])"));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
