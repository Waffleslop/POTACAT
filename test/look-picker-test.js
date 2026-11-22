#!/usr/bin/env node
'use strict';
// The look picker (#376, lib/look-picker.js): Appearance (Light, Dark, System)
// and a swatch card per theme, in Casey's order; Settings shows both modes,
// the Welcome step only the mode in force. Also the contrast rule: every text
// pair a theme draws reaches 4.5:1 (WCAG AA) in all six themes.
// Run: node test/look-picker-test.js
const assert = require('assert');
const LookPicker = require('../lib/look-picker');
const AppTheme = require('../lib/app-theme');
const gen = require('../scripts/gen-design-tokens-css');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

console.log('look picker');

test('Settings (scope all): Light / Dark / System, then both lists in order', () => {
  const m = LookPicker.model({ appearance: 'system', themeLight: 'shes-on-frequency', themeDark: 'miami-nights' }, true, 'all');
  assert.deepStrictEqual(m.appearance.map((a) => [a.name, a.checked]), [['Light', false], ['Dark', false], ['System', true]]);
  assert.deepStrictEqual(m.groups.map((g) => g.mode), ['light', 'dark']);
  assert.deepStrictEqual(m.groups[0].cards.map((c) => c.name), ['POTACAT Light', "She's On Frequency"]);
  assert.deepStrictEqual(m.groups[1].cards.map((c) => c.name), ['POTACAT Dark', 'Midnight', 'Acid Burn', 'Miami Nights']);
  assert.deepStrictEqual(m.groups[0].cards.filter((c) => c.checked).map((c) => c.id), ['shes-on-frequency']);
  assert.deepStrictEqual(m.groups[1].cards.filter((c) => c.checked).map((c) => c.id), ['miami-nights']);
  assert.strictEqual(m.groups[1].label, 'Dark theme (in use now)');
  assert.strictEqual(m.groups[0].label, 'Light theme');
  assert.strictEqual(m.systemNote, 'Following your computer: Dark now.');
});

test('Welcome (scope active): only the mode in force', () => {
  assert.deepStrictEqual(LookPicker.model({ appearance: 'light' }, true, 'active').groups.map((g) => g.mode), ['light']);
  assert.deepStrictEqual(LookPicker.model({ appearance: 'system' }, true, 'active').groups.map((g) => g.mode), ['dark']);
  assert.deepStrictEqual(LookPicker.model({ appearance: 'system' }, false, 'active').groups.map((g) => g.mode), ['light']);
  assert.strictEqual(LookPicker.model({ appearance: 'dark' }, false, 'active').groups[0].label, 'Dark theme');
  assert.strictEqual(LookPicker.model({ appearance: 'dark' }, false, 'active').systemNote, '');
});

test('a new install shows System with POTACAT Light and POTACAT Dark chosen', () => {
  const m = LookPicker.model({}, false, 'all');
  assert.ok(m.appearance.find((a) => a.id === 'system').checked);
  assert.deepStrictEqual(m.groups.map((g) => g.cards.find((c) => c.checked).id), ['potacat-light', 'potacat-dark']);
});

test('each swatch paints in its own theme column; the chrome reads only --ds-* roles', () => {
  const m = LookPicker.model({}, false, 'all');
  const cols = m.groups.flatMap((g) => g.cards.map((c) => c.column));
  assert.deepStrictEqual(cols, AppTheme.APP_THEMES.map((t) => t.column));
  const css = LookPicker.CSS;
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(css) && !/\brgba?\(/i.test(css), 'no literal colours: every colour is a theme role');
  assert.ok(/\.lsw-air \{[^}]*background: var\(--ds-air\); color: var\(--ds-on-air\)/.test(css), 'ON AIR sample on the air colour');
  assert.ok(!/\.lsw-air[^}]*--ds-brand/.test(css), 'never the brand colour for on air');
});

test('render(): picking the other mode\'s theme with a fixed Appearance switches the Appearance too', () => {
  // A minimal DOM, enough for render() to build and for clicks to fire.
  function node(tag) {
    const n = { tagName: tag, children: [], dataset: {}, attrs: {}, listeners: {}, className: '', classList: { add() {} },
      setAttribute(k, v) { this.attrs[k] = String(v); }, appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      addEventListener(t, fn) { this.listeners[t] = fn; }, contains() { return false; }, querySelector() { return null }, focus() {} };
    Object.defineProperty(n, 'textContent', { set(v) { this.children = []; this._text = v; }, get() { return this._text; } });
    return n;
  }
  const doc = { createElement: node, getElementById: () => null, head: node('head'), activeElement: null };
  const box = node('div'); box.ownerDocument = doc;
  let got = null;
  LookPicker.render(box, { state: { appearance: 'dark', themeLight: 'potacat-light', themeDark: 'midnight' }, systemDark: false, scope: 'all', onChange: (s) => { got = s; } });
  const all = []; (function walk(n) { all.push(n); n.children.forEach(walk); })(box);
  const card = all.find((n) => n.dataset.themeId === 'shes-on-frequency');
  card.listeners.click();
  assert.deepStrictEqual(got, { appearance: 'light', themeLight: 'shes-on-frequency', themeDark: 'midnight' });
  all.find((n) => n.dataset.themeId === 'acid-burn').listeners.click();
  assert.deepStrictEqual(got, { appearance: 'dark', themeLight: 'potacat-light', themeDark: 'acid-burn' });
  all.find((n) => n.dataset.appearance === 'system').listeners.click();
  assert.strictEqual(got.appearance, 'system');
  assert.strictEqual(all.filter((n) => n.attrs['data-ds']).length, 6, 'six swatches');
  assert.strictEqual(all.find((n) => n.dataset.themeId === 'midnight').attrs['aria-checked'], 'true');
  // With System on, a card only sets its mode's theme.
  LookPicker.render(box, { state: { appearance: 'system' }, systemDark: true, scope: 'all', onChange: (s) => { got = s; } });
  const all2 = []; (function walk(n) { all2.push(n); n.children.forEach(walk); })(box);
  all2.find((n) => n.dataset.themeId === 'shes-on-frequency').listeners.click();
  assert.strictEqual(got.appearance, 'system');
  assert.strictEqual(got.themeLight, 'shes-on-frequency');
});

// --- Contrast: every pair the themes draw text with, 4.5:1 or better ---------
function rgb(h) { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map((x) => x + x).join(''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); }
function lum(h) { return rgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }).reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0); }
function ratio(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

const PAIRS = [
  ['ink', 'bg'], ['ink', 'surface'], ['ink', 'fill'],
  ['ink-muted', 'bg'], ['ink-muted', 'surface'],
  ['tint', 'bg'], ['tint', 'surface'], ['ok', 'bg'], ['warn', 'bg'], ['danger', 'bg'],
  ['air-ink', 'bg'], ['air-ink', 'surface'],
  ['on-tint', 'tint'], ['on-ok', 'ok'], ['on-air', 'air'], ['on-danger', 'danger'], ['on-brand', 'brand'], ['on-control', 'control'],
];
const colors = gen.resolvedColors(gen.load());
for (const t of AppTheme.APP_THEMES) {
  test(`contrast 4.5:1 in ${t.name}: text on its backgrounds and on its fills`, () => {
    const c = colors[t.column];
    const low = PAIRS.map(([f, b]) => [f, b, ratio(c[f], c[b])]).filter((x) => x[2] < 4.5);
    assert.deepStrictEqual(low.map((x) => `${x[0]} on ${x[1]} ${x[2].toFixed(2)}:1`), []);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
