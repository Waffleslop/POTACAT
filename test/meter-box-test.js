#!/usr/bin/env node
'use strict';
// NJ2DX 2026-11-21 (IC-7300, Discord): "the S-meter floating panel
// disappeared". It was off the edge of the window: the box stays hidden until
// the radio's first reading, clampFloatingBox skips a hidden box, and nothing
// clamped it when it appeared, so a spot saved on a bigger window put it out
// of sight. Every way the box appears now goes through syncMeterBoxShown,
// which clamps it in as it appears. And its colours are the theme's: the box
// was dark navy with grey text on every theme, the light ones included.
// Run: node test/meter-box-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('renderer/app.js');
const css = read('renderer/styles.css');

console.log('S-meter box: always on screen, in the theme');

test('the box appearing (first reading, or switched on) is clamped inside the window', () => {
  // Run the two helpers out of app.js against a fake box.
  const block = app.slice(app.indexOf('function syncMeterBoxShown()'), app.indexOf('let _floatingBoxResizeTimer'));
  const calls = [];
  const cls = new Set(['hidden']);
  const meterBox = { classList: { contains: (c) => cls.has(c), toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); } } };
  const env = { meterBox, meterBoxVisible: true, clampFloatingBox: (box, key) => calls.push(key) };
  // eslint-disable-next-line no-new-func
  const f = new Function('env', 'let { meterBox, meterBoxVisible, clampFloatingBox } = env;\n' + block + '\nreturn { showMeterBox, syncMeterBoxShown, set: (v) => { meterBoxVisible = v; } };')(env);
  f.showMeterBox();
  assert.strictEqual(cls.has('hidden'), false, 'shown');
  assert.deepStrictEqual(calls, ['meterBoxPos'], 'clamped as it appeared');
  f.showMeterBox();
  assert.deepStrictEqual(calls, ['meterBoxPos'], 'already shown: not clamped again on every reading');
  f.set(false); f.syncMeterBoxShown();
  assert.strictEqual(cls.has('hidden'), true, 'switched off');
});

test('no path shows the box without the clamp', () => {
  assert.ok(!/meterBox\.classList\.remove\('hidden'\)/.test(app), 'a reading shows it through showMeterBox()');
  assert.ok(!/meterBox\.classList\.toggle\('hidden', !meterBoxVisible\)/.test(app.replace(/function syncMeterBoxShown\(\)[\s\S]*?\n\}/, '')), 'the switches go through syncMeterBoxShown()');
  assert.ok((app.match(/showMeterBox\(\);/g) || []).length >= 4, 'every reading handler');
  assert.ok(/clampFloatingBox\(meterBox, 'meterBoxPos'\); \/\/ dropped past an edge/.test(app), 'a drop past an edge shows it inside');
});

test('the box draws with the theme\'s roles, not fixed colours', () => {
  const rule = css.slice(css.indexOf('.meter-box {'), css.indexOf('/* Floating CW Macro box'));
  assert.ok(!/#[0-9a-f]{3,6}\b|rgba\(22, 33, 62/i.test(rule.replace(/var\([^)]*\)/g, '')), 'no fixed colour in the meter box CSS: ' + rule);
  assert.ok(/background: var\(--bg-secondary\)/.test(rule) && /color: var\(--text-primary\)/.test(rule));
  const draw = app.slice(app.indexOf('function meterThemeColor('), app.indexOf('function drawMeterBar(') + 900);
  assert.ok(/meterThemeColor\('--bg-primary'/.test(draw) && /meterThemeColor\('--border-secondary'/.test(draw), 'track and ticks');
  assert.ok(/'--ok'/.test(draw) && /'--warn'/.test(draw) && /'--bad'/.test(draw), 'ok / warn / bad');
  const handlers = app.slice(app.indexOf('window.api.onCatSmeter((val) => {'), app.indexOf("pct < 0.9 ? 'warn' : 'bad'"));
  assert.ok(!/'#4ecca3'|'#ffd740'|'#e94560'|'#f0a500'/.test(handlers), 'readings use meterLevelColor');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
