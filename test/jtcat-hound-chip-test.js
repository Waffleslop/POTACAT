// test/jtcat-hound-chip-test.js — #160: the HOUND chip on the JTCAT pop-out
// main screen is a two-way toggle. It is always visible, reads as off when
// Hound is off, and clicking it runs the same toggleHoundMode as Options.
'use strict';
const { readSrc } = require('./_src');
const assert = require('assert');
const path = require('path');
const js = readSrc(path.join(__dirname, '..', 'renderer', 'jtcat-popout.js')).replace(/\r\n/g, '\n');
const html = readSrc(path.join(__dirname, '..', 'renderer', 'jtcat-popout.html')).replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
function fakeEl() {
  const set = new Set(); const attrs = {};
  return {
    classList: {
      toggle(c, on) { if (on === undefined) on = !set.has(c); if (on) set.add(c); else set.delete(c); return on; },
      contains(c) { return set.has(c); }, add(c) { set.add(c); }, remove(c) { set.delete(c); },
    },
    setAttribute(k, v) { attrs[k] = String(v); }, attrs, set,
  };
}
function extract(name) {
  const i = js.indexOf('function ' + name + '(');
  assert.ok(i !== -1, name + ' exists');
  let depth = 0, j = js.indexOf('{', i);
  for (let k = j; k < js.length; k++) {
    if (js[k] === '{') depth++;
    else if (js[k] === '}' && --depth === 0) return js.slice(i, k + 1);
  }
  throw new Error('unbalanced ' + name);
}
function run(initial) {
  const chip = fakeEl(), toggle = fakeEl(), saved = [];
  const f = new Function('houndChip', 'houndToggle', 'window', 'houndMode',
    extract('reflectHound') + '\n' + extract('toggleHoundMode') +
    '\nreflectHound();\nreturn { chip: houndChip, click: toggleHoundMode, get: function(){ return houndMode; } };');
  const r = f(chip, toggle, { api: { saveSettings: (s) => saved.push(s) } }, initial);
  return Object.assign(r, { toggle, saved });
}
console.log('jtcat hound chip:');
t('chip is in the markup without the hidden class', () => {
  const m = html.match(/<button id="jp-hound-chip"[^>]*>/);
  assert.ok(m, 'chip present');
  assert.ok(!/class="[^"]*\bhidden\b/.test(m[0]), 'not hidden: ' + m[0]);
  assert.ok(m[0].includes('Hound mode: answer a DXpedition Fox. Click to turn on/off.'), 'plain tooltip');
});
t('Hound off: chip visible and marked off', () => {
  const r = run(false);
  assert.ok(!r.chip.classList.contains('hidden'));
  assert.ok(r.chip.classList.contains('off'));
  assert.strictEqual(r.chip.attrs['aria-pressed'], 'false');
});
t('click turns Hound on, then off, and saves + syncs Options row', () => {
  const r = run(false);
  r.click();
  assert.strictEqual(r.get(), true);
  assert.ok(!r.chip.classList.contains('off') && !r.chip.classList.contains('hidden'));
  assert.ok(r.toggle.classList.contains('active'));
  assert.deepStrictEqual(r.saved[0], { jtcatHoundMode: true });
  r.click();
  assert.ok(r.chip.classList.contains('off') && !r.chip.classList.contains('hidden'));
  assert.ok(!r.toggle.classList.contains('active'));
});
t('chip and Options row share toggleHoundMode', () => {
  assert.ok(js.includes("houndChip.addEventListener('click', toggleHoundMode)"));
  assert.ok(js.includes("houndToggle.addEventListener('click', toggleHoundMode)"));
});
t('off state has its own styling', () => {
  assert.ok(/#jp-hound-chip\.off\s*\{/.test(html));
});
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
