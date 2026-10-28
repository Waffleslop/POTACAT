#!/usr/bin/env node
'use strict';
// The desktop's design tokens (docs/design-system-plan.md Phase 1).
// 1. assets/design/tokens.json is the phone's file, byte for byte, when the
//    potacat-app checkout sits beside this one (skipped in CI, where it does not).
// 2. renderer/tokens.css is current: regenerating gives the committed file.
// 3. The phone's contrast contract (potacat-app __tests__/designTokens.test.ts,
//    the same 33 pairs) holds in every theme: a skin that breaks one fails here.
// 4. Every colour resolves to a literal; every theme the desktop offers has a block.
// Run: node test/design-tokens-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const gen = require('../scripts/gen-design-tokens-css');

let passed = 0, failed = 0, skipped = 0;
function test(name, fn) {
  try { const r = fn(); if (r === 'skip') { skipped++; console.log('  skip ' + name); } else { passed++; console.log('  ok  ' + name); } }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
const root = path.join(__dirname, '..');
const t = gen.load();

function luminance(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const f = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
// The phone's pairs, in the file's kebab names.
const PAIRS = [
  ...['bg', 'surface', 'fill'].map((g) => ['ink', g, 4.5]),
  ...['bg', 'surface', 'fill'].map((g) => ['ink-muted', g, 4.5]),
  ['brand', 'surface', 4.5], ['brand', 'brand-subtle', 4.5], ['on-brand', 'brand', 4.5],
  ['tint', 'surface', 4.5], ['tint', 'fill', 4.5], ['tint', 'tint-subtle', 4.5], ['on-tint', 'tint', 4.5],
  ['ok', 'surface', 4.5], ['ok', 'ok-subtle', 4.5], ['on-ok', 'ok', 4.5],
  ['warn', 'surface', 4.5], ['warn', 'warn-subtle', 4.5], ['on-warn', 'warn', 4.5],
  ['danger', 'surface', 4.5], ['danger', 'danger-subtle', 4.5], ['on-danger', 'danger', 4.5],
  ['on-air', 'air', 4.5], ['air-ink', 'surface', 4.5], ['air-ink', 'air-subtle', 4.5],
  ['air', 'bg', 3], ['air', 'surface', 3],
  ['on-control', 'control', 4.5], ['band', 'surface', 4.5],
  ['mode-voice', 'mode-voice-subtle', 4.5], ['mode-cw', 'mode-cw-subtle', 4.5], ['mode-digital', 'mode-digital-subtle', 4.5],
  ['tint', 'bg', 3],
];

console.log('design tokens');

test('assets/design/tokens.json is the phone\'s token file, unchanged', () => {
  const phone = path.join(root, '..', 'potacat-app', 'docs', 'design-system', 'tokens.json');
  if (!fs.existsSync(phone)) return 'skip';
  const h = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  assert.strictEqual(h(gen.SRC), h(phone),
    'the two token files differ: copy potacat-app/docs/design-system/tokens.json to assets/design/tokens.json and run node scripts/gen-design-tokens-css.js');
});

test('renderer/tokens.css is current (regenerate with node scripts/gen-design-tokens-css.js)', () => {
  const want = gen.generate(t).replace(/\r\n/g, '\n');
  const have = fs.readFileSync(gen.OUT, 'utf8').replace(/\r\n/g, '\n');
  assert.ok(have === want, 'renderer/tokens.css is stale');
});

const colors = gen.resolvedColors(t);
for (const col of Object.keys(colors)) {
  test(`${col}: every colour resolves to a literal`, () => {
    for (const [k, v] of Object.entries(colors[col])) assert.match(v, /^(#[0-9a-f]{6}|rgba\([\d.,\s]+\))$/i, k + ' = ' + v);
  });
  test(`${col}: meets every contrast pair`, () => {
    for (const [ink, ground, min] of PAIRS) {
      const r = contrast(colors[col][ink], colors[col][ground]);
      assert.ok(r >= min, `${col}: ${ink} on ${ground} is ${r.toFixed(2)}, needs ${min}`);
    }
  });
}

test('every desktop theme has a block, ids match the phone, Acid Burn is mono', () => {
  const css = fs.readFileSync(gen.OUT, 'utf8');
  const cols = t.color.themes.map((x) => x.id);
  for (const th of gen.THEMES) {
    assert.ok(cols.includes(th.column), th.id + ' names a column the file lacks');
    assert.ok(css.includes(`[data-ds="${th.column}"] {`), th.id + ' block');
  }
  assert.deepStrictEqual(gen.THEMES.map((x) => x.id), ['potacat-dark', 'midnight', 'acid-burn', 'potacat-light']);
  const acid = css.slice(css.indexOf('[data-ds="acid"] {'));
  assert.ok(/--ds-font-body: var\(--ds-font-mono\);/.test(acid.slice(0, acid.indexOf('}'))));
});

test('band colours (one per band, data colours) and the fixed icon sizes are emitted', () => {
  const css = fs.readFileSync(gen.OUT, 'utf8');
  for (const b of ['160m', '80m', '40m', '20m', '6m', '2m', '70cm', '1-25m', '1-25cm', '2200m', '630m']) {
    assert.ok(new RegExp('--ds-band-' + b + ': #[0-9a-f]{6};', 'i').test(css), 'band-' + b);
  }
  assert.ok(/--ds-icon-sm: 14px;/.test(css) && /--ds-icon-md: 18px;/.test(css) && /--ds-icon-lg: 24px;/.test(css));
});

test('type: 21 styles, each sized by --ds-font-scale, tabular numerals, chrome pins the scale', () => {
  const css = fs.readFileSync(gen.OUT, 'utf8');
  const n = t.type.groups.reduce((a, g) => a + g.styles.length, 0);
  assert.strictEqual(n, 21);
  assert.strictEqual((css.match(/^\.ds-[a-z-]+ \{ font-family/gm) || []).length, 21);
  assert.ok(/\.ds-numeric-dial \{[^}]*calc\(var\(--ds-font-scale\) \* 38px\)[^}]*tabular-nums/.test(css));
  assert.ok(/\.ds-chrome \{ --ds-font-scale: 1; \}/.test(css));
});

test('ds.css reads only tokens: no hex, rgb() or white-text literals, every variable defined', () => {
  const css = fs.readFileSync(path.join(root, 'renderer', 'ds.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(css), 'a hex colour in ds.css');
  assert.ok(!/\brgba?\(/i.test(css), 'an rgb() colour in ds.css');
  assert.ok(!/color:\s*(white|#fff)/i.test(css), 'white text in ds.css');
  const defined = new Set((fs.readFileSync(gen.OUT, 'utf8') + css).match(/--ds-[a-z0-9-]+(?=\s*:)/g));
  for (const v of (css.match(/var\((--ds-[a-z0-9-]+)/g) || []).map((x) => x.slice(4))) assert.ok(defined.has(v), v + ' is used but never defined');
});

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
