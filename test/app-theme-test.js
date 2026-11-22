#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// The six ECHOCAT themes on the desktop (#376, Casey 2026-11-12: "logical from
// light to dark to weird"). lib/app-theme.js decides the attributes from
// Appearance (Light / Dark / System) and one theme per mode, every window gets
// them at load (themeQuery -> popout-theme-boot*.js) and on change
// (broadcastAppTheme), and ds-bridge.css points the classic variables at the
// theme's roles. The classic looks and Halloween migrate once.
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

test("exactly six themes, in Casey's order: light to dark to weird", () => {
  assert.deepStrictEqual(AppTheme.APP_THEMES.map((t) => t.name),
    ['POTACAT Light', "She's On Frequency", 'POTACAT Dark', 'Midnight', 'Acid Burn', 'Miami Nights']);
  assert.deepStrictEqual(AppTheme.APP_THEMES.map((t) => t.id),
    ['potacat-light', 'shes-on-frequency', 'potacat-dark', 'midnight', 'acid-burn', 'miami-nights']);
  assert.deepStrictEqual(AppTheme.LIGHT_THEMES.map((t) => t.id), ['potacat-light', 'shes-on-frequency']);
  assert.deepStrictEqual(AppTheme.DARK_THEMES.map((t) => t.id), ['potacat-dark', 'midnight', 'acid-burn', 'miami-nights']);
  assert.deepStrictEqual(AppTheme.APPEARANCES.map((a) => a.name), ['Light', 'Dark', 'System']);
  assert.ok(!AppTheme.APP_THEMES.some((t) => /classic|halloween/i.test(t.id + t.name)), 'no classic or Halloween choice');
});

test('ids and columns match the generated token sheet, in the same order', () => {
  const gen = require('../scripts/gen-design-tokens-css');
  assert.deepStrictEqual(gen.THEMES.map((x) => x.id), AppTheme.APP_THEMES.map((x) => x.id));
  for (const t of AppTheme.APP_THEMES) {
    const g = gen.THEMES.find((x) => x.id === t.id);
    assert.strictEqual(g.column, t.column);
    assert.strictEqual(g.scheme, t.scheme);
  }
});

test('a new install: System, POTACAT Light by day, POTACAT Dark by night', () => {
  assert.deepStrictEqual(AppTheme.DEFAULTS, { appearance: 'system', themeLight: 'potacat-light', themeDark: 'potacat-dark' });
  assert.strictEqual(AppTheme.resolveAppTheme(AppTheme.DEFAULTS, false).appTheme, 'potacat-light');
  assert.strictEqual(AppTheme.resolveAppTheme(AppTheme.DEFAULTS, true).appTheme, 'potacat-dark');
});

test('Appearance picks the mode, the mode picks its theme; System follows the computer', () => {
  const s = { appearance: 'dark', themeLight: 'shes-on-frequency', themeDark: 'acid-burn' };
  assert.deepStrictEqual(AppTheme.resolveAppTheme(s, false), { theme: 'dark', variant: 'navy', ds: 'acid', appTheme: 'acid-burn', appearance: 'dark' });
  assert.strictEqual(AppTheme.resolveAppTheme(Object.assign({}, s, { appearance: 'light' }), true).ds, 'sof');
  assert.strictEqual(AppTheme.resolveAppTheme(Object.assign({}, s, { appearance: 'system' }), true).ds, 'acid');
  assert.strictEqual(AppTheme.resolveAppTheme(Object.assign({}, s, { appearance: 'system' }), false).ds, 'sof');
  // A theme in the wrong mode's slot, or an unknown id: that mode's first.
  assert.strictEqual(AppTheme.resolveAppTheme({ appearance: 'light', themeLight: 'midnight' }).appTheme, 'potacat-light');
  assert.strictEqual(AppTheme.resolveAppTheme({ appearance: 'dark', themeDark: 'nope' }).appTheme, 'potacat-dark');
  assert.strictEqual(AppTheme.resolveAppTheme({ appearance: 'weird', themeDark: 'midnight' }, true).appTheme, 'midnight', 'an unknown appearance is System');
});

test('migration table: Navy, Charcoal, Classic light, Halloween and the design themes', () => {
  const rows = [
    [{ appTheme: 'classic', lightMode: false, darkVariant: 'navy' }, 'potacat-dark', 'dark'],
    [{}, 'potacat-dark', 'dark'],
    [{ appTheme: 'classic', lightMode: false, darkVariant: 'charcoal' }, 'midnight', 'dark'],
    [{ darkVariant: 'charcoal' }, 'midnight', 'dark'],
    [{ appTheme: 'classic', lightMode: true, darkVariant: 'charcoal' }, 'potacat-light', 'light'],
    [{ lightMode: true }, 'potacat-light', 'light'],
    [{ appTheme: 'halloween', lightMode: false }, 'potacat-dark', 'dark'],
    [{ appTheme: 'acid-burn', lightMode: true }, 'acid-burn', 'dark'],
    [{ appTheme: 'shes-on-frequency', lightMode: false }, 'shes-on-frequency', 'light'],
    [{ appTheme: 'miami-nights' }, 'miami-nights', 'dark'],
    [{ appTheme: 'some-future-theme', lightMode: true }, 'potacat-light', 'light'],
    [{ appTheme: 'some-future-theme', lightMode: false }, 'potacat-dark', 'dark'],
  ];
  for (const [old, id, mode] of rows) {
    const m = AppTheme.migrateThemeSettings(old);
    const tag = JSON.stringify(old);
    assert.ok(m, tag);
    assert.strictEqual(m.theme.id, id, tag);
    assert.strictEqual(m.settings.appearance, mode, tag + ' keeps its mode, not System');
    // Both slots filled: the current mode gets the mapped theme, the other its default.
    assert.strictEqual(m.settings.themeLight, mode === 'light' ? id : 'potacat-light', tag);
    assert.strictEqual(m.settings.themeDark, mode === 'dark' ? id : 'potacat-dark', tag);
    assert.strictEqual(m.settings.appTheme, id);
    assert.strictEqual(m.settings.lightMode, mode === 'light');
    // The old values are remembered.
    assert.strictEqual(m.settings.themeLegacy.appTheme, old.appTheme === undefined ? null : old.appTheme);
    assert.strictEqual(m.settings.themeLegacy.lightMode, old.lightMode === undefined ? null : old.lightMode);
    assert.strictEqual(m.settings.themeLegacy.darkVariant, old.darkVariant === undefined ? null : old.darkVariant);
    // What a window paints before and after the migration is the same.
    assert.deepStrictEqual(AppTheme.resolveAppTheme(old, mode !== 'dark'), AppTheme.resolveAppTheme(m.settings, mode !== 'dark'), tag);
  }
});

test('migration runs once: settings with an appearance are left alone', () => {
  assert.strictEqual(AppTheme.migrateThemeSettings({ appearance: 'system', appTheme: 'classic', lightMode: true }), null);
  assert.strictEqual(AppTheme.migrateThemeSettings(AppTheme.DEFAULTS), null);
  assert.ok(AppTheme.migrateThemeSettings({ appearance: 'bogus' }), 'a broken appearance migrates');
});

test('the one-time message names the theme and the real Settings section', () => {
  assert.strictEqual(AppTheme.migrationNotice('Midnight'), 'Your theme is now Midnight, the same look as ECHOCAT. Change it in Settings > Display.');
  const html = read('renderer/index.html');
  assert.ok(html.includes('data-tab="display">Display</button>'), 'Settings has a Display tab');
  assert.ok(/data-settings-tab="display">\n\s+<legend>Display<\/legend>/.test(html));
});

test('settingsFor writes the three keys plus the theme in force', () => {
  assert.deepStrictEqual(AppTheme.settingsFor({ appearance: 'light', themeLight: 'shes-on-frequency', themeDark: 'midnight' }, true),
    { appearance: 'light', themeLight: 'shes-on-frequency', themeDark: 'midnight', appTheme: 'shes-on-frequency', lightMode: true });
  assert.deepStrictEqual(AppTheme.settingsFor({ appearance: 'system', themeLight: 'x', themeDark: 'potacat-light' }, true),
    { appearance: 'system', themeLight: 'potacat-light', themeDark: 'potacat-dark', appTheme: 'potacat-dark', lightMode: false });
});

test('ECHOCAT Web: the old Light/Dark choice maps once, nothing saved is System', () => {
  const store = (o) => (k) => (k in o ? o[k] : null);
  assert.deepStrictEqual(AppTheme.webState(store({})), AppTheme.DEFAULTS);
  assert.strictEqual(AppTheme.webState(store({ 'echocat-theme': 'light' })).appearance, 'light');
  assert.strictEqual(AppTheme.webState(store({ 'echocat-theme': 'dark' })).appearance, 'dark');
  assert.deepStrictEqual(AppTheme.webState(store({ 'echocat-appearance': 'dark', 'echocat-theme-dark': 'miami-nights', 'echocat-theme': 'light' })),
    { appearance: 'dark', themeLight: 'potacat-light', themeDark: 'miami-nights' });
  assert.deepStrictEqual(AppTheme.webState(() => { throw new Error('blocked'); }), AppTheme.DEFAULTS, 'storage blocked');
});

test('applyToDocument sets and clears the attributes', () => {
  const attrs = { 'data-dark-variant': 'charcoal' };
  const doc = { documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, removeAttribute: (k) => { delete attrs[k]; } } };
  AppTheme.applyToDocument(doc, AppTheme.resolveAppTheme({ appearance: 'dark', themeDark: 'acid-burn' }));
  assert.deepStrictEqual(attrs, { 'data-theme': 'dark', 'data-ds': 'acid' });
  AppTheme.applyToDocument(doc, AppTheme.resolveAppTheme({ appearance: 'light', themeLight: 'shes-on-frequency' }));
  assert.deepStrictEqual(attrs, { 'data-theme': 'light', 'data-ds': 'sof' });
});

test('every theme has a window background that matches its --ds-bg', () => {
  const css = read('renderer/tokens.css');
  for (const t of AppTheme.APP_THEMES) {
    const m = new RegExp('\\[data-ds="' + t.column + '"\\] \\{\\n  --ds-bg: (#[0-9a-f]{6});').exec(css);
    assert.ok(m, t.column);
    assert.strictEqual(AppTheme.WINDOW_BG[t.column], m[1], t.id);
  }
});

test('main: migrates once at start, follows the OS live, every window opens with themeQuery()', () => {
  const m = read('main.js');
  assert.ok(!m.includes("{ theme: settings.lightMode ? 'light' : 'dark', variant: settings.darkVariant || 'navy' }"), 'a window still builds its own theme payload');
  assert.ok((m.match(/themeQuery\(\)/g) || []).length >= 30);
  assert.ok(/function resolveTheme\(\) \{[\s\S]*?nativeTheme\.shouldUseDarkColors[\s\S]*?AppTheme\.resolveAppTheme\(settings, dark\)/.test(m));
  assert.ok(/function broadcastAppTheme\(\)[\s\S]*?BrowserWindow\.getAllWindows\(\)/.test(m));
  assert.ok(/nativeTheme\.on\('updated', \(\) => \{ if \(settings && settings\.appearance === 'system'\) broadcastAppTheme\(\); \}\)/.test(m));
  assert.ok(/settings = loadSettings\(\);\n\s+healActiveRigNow\('startup'\);[\s\S]{0,1200}AppTheme\.migrateThemeSettings\(settings\);[\s\S]{0,200}themeNotice: mig\.theme\.name[\s\S]{0,60}saveSettings\(settings\);/.test(m));
  assert.ok(/const _themeBefore = JSON\.stringify\(resolveTheme\(\)\);[^]{0,300}?\n\s+settings = \{ \.\.\.settings, \.\.\.newSettings \};[^]{0,400}?\n\s+if \(JSON\.stringify\(resolveTheme\(\)\) !== _themeBefore\) broadcastAppTheme\(\);/.test(m));
  for (const k of ["'appearance',", "'themeLight', 'themeDark',", "'themeLegacy',", "'themeNotice',", "'appTheme',"]) assert.ok(m.includes('  ' + k), k + ' in GLOBAL_KEYS');
  assert.ok(m.includes('themeNow: themeQuery() }));'), 'get-settings carries the theme in force');
  assert.ok(/'themeNow' in newSettings\) delete newSettings\.themeNow;/.test(m), 'never stored');
});

test('pop-outs read the theme in force, never lightMode / darkVariant, and set data-ds', () => {
  for (const f of fs.readdirSync(path.join(root, 'renderer')).filter((x) => /-popout\.js$/.test(x))) {
    const src = read('renderer/' + f);
    assert.ok(!/\.lightMode\b|\.darkVariant\b/.test(src), f + ' reads the old theme keys');
    if (src.includes('function _applyPopoutTheme(payload) {')) {
      assert.ok(/function _applyPopoutTheme\(payload\) \{\n  \/\/[^\n]*\n  if \(window\.applyPopoutTheme\) return window\.applyPopoutTheme\(payload\);/.test(src), f + ' delegates to the shared rule');
    }
  }
  for (const f of ['renderer/popout-theme-boot.js', 'renderer/popout-theme-bootstrap.js']) {
    const src = read(f);
    assert.ok(/window\.applyPopoutTheme = applyPopoutTheme;/.test(src), f);
    assert.ok(/setAttribute\('data-ds'/.test(src), f);
  }
});

test('every window that loads styles.css gets the tokens and the bridge', () => {
  const css = read('renderer/styles.css');
  assert.ok(css.startsWith('@import url("tokens.css");\n@import url("ds-bridge.css");'));
});

test('the bridge reads only tokens and leaves the classic fallback alone', () => {
  const b = read('renderer/ds-bridge.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(b) && !/\brgba?\(/i.test(b));
  for (const rule of b.match(/^[^{}\n][^{}]*\{/gm)) assert.ok(/\[data-ds/.test(rule), 'a bridge rule applies without data-ds: ' + rule.trim());
  for (const v of ['--bg-primary', '--text-primary', '--accent-red', '--accent-blue', '--accent-green', '--border-primary']) assert.ok(b.includes(v + ':'), v);
  // The classic palette is still the base, for a window that has no data-ds.
  const css = read('renderer/styles.css');
  assert.ok(/:root \{[\s\S]*?--bg-primary: #1a1a2e;/.test(css), 'navy base');
  assert.ok(/\[data-theme="light"\] \{[\s\S]*?--bg-primary:/.test(css), 'light base');
});

test('brand is identity only: PTT and alarms use the on-air ink', () => {
  const b = read('renderer/ds-bridge.css');
  assert.ok(/--accent-red: var\(--ds-air-ink\);/.test(b) && /--tx-active: var\(--ds-air\);/.test(b));
  assert.ok(!/--(accent-red|tx-active|warn|bad|ptt)[a-z-]*: var\(--ds-brand\)/.test(b), 'a state on the brand colour');
  assert.ok(read('renderer/vfo-popout.html').includes('--gold: var(--ds-warn);'), 'the VFO window\'s warning gold is a state');
  assert.ok(!/id="pota-sync-error"[^>]*accent-gold/.test(read('renderer/index.html')), 'an error on the brand colour');
  const r = read('renderer/remote.css');
  assert.ok(/:root\[data-ds\] \{[\s\S]*?--accent: var\(--ds-air-ink\);/.test(r), 'ECHOCAT Web PTT / stop on the on-air ink');
});

test('Acid Burn is mono everywhere: desktop windows, ECHOCAT Web and the swatch', () => {
  assert.ok(/\[data-ds="acid"\] \{[\s\S]*?--ds-font-body: var\(--ds-font-mono\);/.test(read('renderer/tokens.css')));
  assert.ok(/:root\[data-ds="acid"\] body,[\s\S]*?font-family: var\(--ds-font-mono\);/.test(read('renderer/ds-bridge.css')));
  assert.ok(/:root\[data-ds="acid"\] body,[\s\S]*?font-family: var\(--ds-font-mono\);/.test(read('renderer/remote.css')));
  assert.ok(/\.look-swatch \{[^}]*font-family: var\(--ds-font-body\)/.test(require('../lib/look-picker').CSS));
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

test('Settings, the sidebar and Welcome: the look picker replaces the old dropdown and switches', () => {
  const html = read('renderer/index.html');
  for (const gone of ['id="quick-theme"', 'id="set-app-theme"', 'id="welcome-theme"', 'id="quick-light-mode"', 'id="set-light-mode"', 'id="welcome-light-mode"', 'name="set-dark-variant"', 'Change Theme', 'Classic']) {
    assert.ok(!html.includes(gone), gone + ' is still in index.html');
  }
  assert.ok(html.includes('<div id="set-look-picker"></div>'));
  assert.ok(/<select id="quick-appearance"[^>]*>\s*<option value="light">Light<\/option>\s*<option value="dark">Dark<\/option>\s*<option value="system">System<\/option>/.test(html));
  assert.ok(/<script src="\.\.\/lib\/app-theme\.js"><\/script>\n\s*<script src="\.\.\/lib\/look-picker\.js"><\/script>/.test(html));
  const app = read('renderer/app.js');
  for (const gone of ['setLightMode', 'quickLightMode', 'welcomeLightMode', '_currentDarkVariant', '_currentAppTheme', 'THEME_CHOICES', 'set-dark-variant']) assert.ok(!app.includes(gone), gone + ' is still in app.js');
  assert.ok(/window\.LookPicker\.render\(document\.getElementById\('set-look-picker'\), \{ state: _themeState, systemDark: sd, scope: 'all'/.test(app));
  assert.ok(/\.\.\.\(window\.AppTheme \? window\.AppTheme\.settingsFor\(_themeState, _systemDark\(\)\) : \{\}\),/.test(app), 'Settings save writes the look');
  assert.ok(/_systemDarkQuery\.addEventListener\('change', _onSystemTheme\)/.test(app), 'System follows the OS live');
  assert.ok(/if \(settings\.themeNotice && window\.AppTheme\) \{\n\s+showLogToast\(window\.AppTheme\.migrationNotice\(settings\.themeNotice\), \{ sticky: true, onClick: \(\) => openSettingsDialog\('display'\) \}\);\n\s+window\.api\.saveSettings\(\{ themeNotice: null \}\);/.test(app), 'the message shows once');
});

test('Welcome: "Pick your look" comes right after the callsign, with the mode in force and a live preview', () => {
  const html = read('renderer/index.html');
  const w0 = html.indexOf('<dialog id="welcome-dialog">');
  const w = html.slice(w0, html.indexOf('</dialog>', w0));
  const iCall = w.indexOf('id="welcome-callsign"');
  const iLook = w.indexOf('>Pick your look</div>');
  const iIdle = w.indexOf('>Idle Mode</div>');
  assert.ok(iCall > 0 && iLook > iCall && iIdle > iLook, 'order: Station (callsign), Pick your look, Idle Mode');
  assert.ok(!/welcome-section-label[^>]*>[^<]*<\/div>[\s\S]*welcome-section-label/.test(w.slice(iCall, iLook)), 'no other section between the callsign and the look');
  assert.ok(w.includes('<div id="welcome-look-picker"></div>'));
  assert.ok(w.includes('The same six looks as the ECHOCAT app. Change any time in Settings &gt; Display.'));
  assert.ok(w.indexOf('Change Font Size') > iLook, 'the font-size hint moved with it');
  const app = read('renderer/app.js');
  assert.ok(/window\.LookPicker\.render\(document\.getElementById\('welcome-look-picker'\), \{ state: _themeState, systemDark: sd, scope: 'active', preview: true, onChange: applyLookChoice \}\);/.test(app));
});

test('ECHOCAT Web: the six looks, Light / Dark / System, inlined resolver, picker and tokens', () => {
  const html = read('renderer/remote.html');
  assert.ok(!html.includes('so-theme-dark') && !html.includes('so-theme-light'));
  assert.ok(html.includes('<div id="so-look-picker"></div>'));
  const iRes = html.indexOf('<!-- app-theme-js -->');
  const iPaint = html.indexOf('A.webState(');
  assert.ok(iRes > 0 && iPaint > iRes, 'resolver inlined before the pre-paint script');
  const srv = read('lib/remote-server.js');
  assert.ok(/\['app-theme-js', 'app-theme\.js'\], \['look-picker-js', 'look-picker\.js'\]/.test(srv));
  assert.ok(/tokensCss = fs\.readFileSync\(path\.join\(this\._basePath, 'tokens\.css'\), 'utf8'\);/.test(srv));
  assert.ok(/<style>\\n\$\{tokensCss\}\\n<\/style>\\n<style>\\n\$\{css\}\\n<\/style>/.test(srv), 'tokens ahead of the page sheet');
  const js = read('renderer/remote.js');
  assert.ok(/window\.LookPicker\.render\(document\.getElementById\('so-look-picker'\)/.test(js));
  assert.ok(/localStorage\.setItem\(AT\.WEB_KEYS\.appearance, lookState\.appearance\);/.test(js));
  assert.ok(/lookSysDark\.addEventListener\('change', onSys\)/.test(js));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
