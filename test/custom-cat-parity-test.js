#!/usr/bin/env node
'use strict';
// Custom CAT slots: desktop (renderer/app.js) vs web (renderer/remote.js).
//
// The web client rendered EVERY slot as a plain button firing `command`, so a
// toggle only ever sent its On command ("not working as toggle, at all" —
// LZ3AW 2026-08-28) and a slider sent its raw template, placeholders and all,
// straight at the radio. Worse, the web editor rebuilt each slot as
// {name, command}, dropping type/commandOff/min/max — and SAVED that back to
// the desktop, so merely opening Edit in the browser destroyed the operator's
// configuration.
//
// Neither renderer can be require()'d (no Node in the renderer, and remote.js
// is inlined into a single page at serve time), so this extracts each file's
// customSliderCommand and runs both through one vector table — the placeholder
// contract is duplicated by necessity and must never drift — then pins the
// structural fixes in the web source.
// Run: node test/custom-cat-parity-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const R = (f) => fs.readFileSync(path.join(__dirname, '..', 'renderer', f), 'utf8');
const APP = R('app.js');
const REMOTE = R('remote.js');
// Third copy (2026-09-19): the desktop VFO pop-out draws slider slots too, so
// it carries its own substitution and must not drift from the other two.
const VFO = R('vfo-popout.html');

/** Pull one function's source out of a renderer file and make it callable. */
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.notStrictEqual(start, -1, name + ' not found');
  // Brace-match from the signature's opening brace.
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.notStrictEqual(end, -1, name + ' unbalanced');
  // eslint-disable-next-line no-new-func
  return new Function(src.slice(start, end) + '; return ' + name + ';')();
}

const appSlider = extractFn(APP, 'customSliderCommand');
const webSlider = extractFn(REMOTE, 'customSliderCommand');
const vfoSlider = extractFn(VFO, 'customSliderCommand');

// [template, value, expected] — the placeholder contract both sides implement.
const VECTORS = [
  ['SQ0{v3};', 42, 'SQ0042;'],
  ['SQ0{v3};', 5, 'SQ0005;'],
  ['SQ0{v3};', 255, 'SQ0255;'],
  ['PC{v3};', 100, 'PC100;'],
  ['{v}', 7, '7'],
  ['{v2}', 7, '07'],
  ['{v4}', 7, '0007'],
  ['SQ0', 42, 'SQ042'],            // no placeholder -> value appended
  ['AG0{v3};MG{v3};', 12, 'AG0012;MG012;'], // repeated placeholder
  ['{v}-{v2}', 3, '3-03'],         // mixed widths
  ['{v}', 42.6, '43'],             // rounds, never truncates
  ['{v3}', 0, '000'],
  // {bcd}: an Icom CI-V level, two BCD bytes (K8IKO IC-7410, 0-255)
  ['FE FE 80 E0 14 02 {bcd} FD', 255, 'FE FE 80 E0 14 02 02 55 FD'],
  ['FE FE 80 E0 14 02 {bcd} FD', 7, 'FE FE 80 E0 14 02 00 07 FD'],
  ['fefe80e01402{bcd}fd', 128, 'fefe80e014020128fd'], // unbroken frame stays unbroken
];

test('desktop, web and VFO pop-out slider substitution agree on every vector', () => {
  for (const [tpl, val, expected] of VECTORS) {
    assert.strictEqual(appSlider(tpl, val), expected,
      'desktop: ' + tpl + ' @ ' + val);
    assert.strictEqual(webSlider(tpl, val), expected,
      'web: ' + tpl + ' @ ' + val + ' (drifted from the desktop contract)');
    assert.strictEqual(vfoSlider(tpl, val), expected,
      'VFO pop-out: ' + tpl + ' @ ' + val + ' (drifted from the desktop contract)');
  }
});

test('a value never reaches the radio with placeholders still in it', () => {
  for (const [tpl, val] of VECTORS) {
    for (const out of [appSlider(tpl, val), webSlider(tpl, val)]) {
      assert.ok(!/\{v\d?\}/.test(out), 'unsubstituted placeholder in: ' + out);
    }
  }
});

test('web renderer branches on slot TYPE (toggle/slider), not just command', () => {
  assert.ok(/entry\.type === 'toggle'/.test(REMOTE), 'no toggle type branch');
  assert.ok(/entry\.type === 'slider'/.test(REMOTE), 'no slider type branch');
  // The toggle must be able to send the OFF command — the whole bug.
  assert.ok(/commandOff/.test(REMOTE), 'web never reads commandOff');
  assert.ok(/customToggleState/.test(REMOTE), 'no session toggle state');
});

test('web editor PRESERVES unedited slot fields (no silent downgrade)', () => {
  // The destructive shape was a literal rebuild from the two inputs:
  //   customCatData[j] = { name: ..., command: ... };
  const destructive = /customCatData\[j\]\s*=\s*\{\s*\n\s*name:/;
  assert.ok(!destructive.test(REMOTE),
    'web editor rebuilds the slot from scratch — type/commandOff/min/max are lost');
  assert.ok(/hasOwnProperty\.call\(prev, k\)/.test(REMOTE), 'no field-preserving copy');
});

test('the desktop type vocabulary is exactly what the web accepts', () => {
  // Desktop writes these three; web must not invent a fourth or miss one.
  assert.ok(/b\.type === 'toggle' \|\| b\.type === 'slider'/.test(APP), 'desktop vocabulary moved');
  for (const t of ['toggle', 'slider']) {
    assert.ok(REMOTE.includes("entry.type === '" + t + "'"), 'web missing type ' + t);
  }
});

// LZ3AW 2026-10-17: a toggle can FOLLOW a state the radio reports. One list
// (lib/custom-cat-follow.js) for all three surfaces, and each surface asks it
// both what to show and which command a click sends.
const Follow = require('../lib/custom-cat-follow.js');
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('follow: radio state wins, last-sent is the fallback, the click moves AWAY from the radio', () => {
  const slot = { follows: 'split' };
  assert.deepStrictEqual(Follow.toggleView(slot, { split: true }, false), { on: true, fromRadio: true, nextCommand: 'off' });
  assert.deepStrictEqual(Follow.toggleView(slot, { split: false }, true), { on: false, fromRadio: true, nextCommand: 'on' });
  assert.deepStrictEqual(Follow.toggleView(slot, {}, true), { on: true, fromRadio: false, nextCommand: 'off' }, 'state not reported: last sent');
  assert.deepStrictEqual(Follow.toggleView({}, { split: true }, false), { on: false, fromRadio: false, nextCommand: 'on' }, 'unlinked toggle ignores the radio');
  assert.strictEqual(Follow.followedState('atu', { atuActive: true }), true, 'main window field name');
  assert.strictEqual(Follow.followedState('atu', { atu: false }), false, 'VFO/ECHOCAT field name');
  assert.strictEqual(Follow.followedState('nope', { nope: true }), null);
  assert.ok(Follow.FOLLOWABLE.every((f) => f.key && f.label && f.fields.length));
});

test('follow: every surface loads the one list and uses it for paint AND click', () => {
  assert.ok(/<script src="\.\.\/lib\/custom-cat-follow\.js"><\/script>/.test(R('index.html')), 'desktop loads it');
  assert.ok(/<script src="\.\.\/lib\/custom-cat-follow\.js"><\/script>/.test(VFO), 'VFO pop-out loads it');
  assert.ok(/<!-- custom-cat-follow-js -->/.test(R('remote.html')), 'web page placeholder');
  assert.ok(/html\.replace\('<!-- custom-cat-follow-js -->'/.test(fs.readFileSync(path.join(__dirname, '..', 'lib', 'remote-server.js'), 'utf8')), 'server inlines it');
  for (const [name, src] of [['desktop', APP], ['web', REMOTE], ['VFO', VFO]]) {
    assert.ok(/CustomCatFollow\.toggleView\(/.test(src), name + ' paints from toggleView');
    assert.ok(/nextCommand === 'on'/.test(src), name + ' clicks by nextCommand');
  }
  assert.ok(/CustomCatFollow\.FOLLOWABLE/.test(APP) && /CustomCatFollow\.FOLLOWABLE/.test(REMOTE), 'both editors offer the same Follows list');
  assert.ok(/if \(followEl\) \{ if \(followEl\.value\) next\.follows = followEl\.value; else delete next\.follows; \}/.test(REMOTE), 'the web editor saves follows');
});

test('follow: every followable state reaches the VFO pop-out and ECHOCAT', () => {
  const vfoState = MAIN.slice(MAIN.indexOf('function sendVfoState() {'), MAIN.indexOf('function applyFreedvAudioMute('));
  const remote = MAIN.slice(MAIN.indexOf('function broadcastRemoteRadioStatus() {'), MAIN.indexOf('function broadcastRemoteRadioStatus() {') + 6000);
  for (const f of Follow.FOLLOWABLE) {
    assert.ok(f.fields.some((fld) => new RegExp('\\b' + fld + ':').test(vfoState)), 'VFO state lacks ' + f.key);
    assert.ok(f.fields.some((fld) => new RegExp('\\b' + fld + ':').test(remote)), 'ECHOCAT status lacks ' + f.key);
  }
});

console.log(`\nCustom CAT parity: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
