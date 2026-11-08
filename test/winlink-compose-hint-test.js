// #188 NA4DQ: the compose body placeholder follows the session mode, so VHF
// packet does not say "HF". Pulls composeHint() out of the renderer and runs it.
// Run: node test/winlink-compose-hint-test.js
'use strict';
const { readSrc } = require('./_src');
const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const js = readSrc(path.join(ROOT, 'renderer', 'winlink-popout.js')).replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

function load() {
  const m = js.match(/function composeHint\(id\) \{[\s\S]*?\n  \}/);
  assert.ok(m, 'composeHint exists in winlink-popout.js');
  return new Function(m[0] + '; return composeHint;')();
}

test('HF modes keep the HF wording', () => {
  const h = load();
  for (const id of ['ardop', 'vara', 'mercury']) assert.ok(/\bHF\b/.test(h(id)), id + ': ' + h(id));
});
test('packet says VHF packet, never HF', () => {
  const t = load()('packet');
  assert.ok(/packet/i.test(t) && !/\bHF\b/.test(t), t);
});
test('VARA FM says FM, never HF', () => {
  const t = load()('varafm');
  assert.ok(/\bFM\b/.test(t) && !/\bHF\b/.test(t), t);
});
test('telnet and unknown are neutral', () => {
  const h = load();
  for (const id of ['telnet', undefined]) assert.ok(!/\bHF\b|\bFM\b|packet/i.test(h(id)), String(h(id)));
});
test('placeholder is set on mode change (renderModeNote)', () => {
  const i = js.indexOf('function renderModeNote(');
  const body = js.slice(i, js.indexOf('\n  }\n', i));
  assert.ok(/\$\('wl-c-body'\)\.placeholder = composeHint\(m\.id\)/.test(body), 'renderModeNote sets the placeholder');
  assert.ok(/addEventListener\('change', function \(\) \{[\s\S]{0,300}renderModeNote\(\)/.test(js), 'mode change calls renderModeNote');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
