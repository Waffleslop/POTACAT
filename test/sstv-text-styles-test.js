'use strict';
// #327 (Casey 2026-11-10): typeface, outline, shadow and letter spacing per
// SSTV text layer, in Templates and in the Compose/Reply editor. The rules
// live in lib/sstv-templates.js (layerStyle, layerFont) so the SSTV window,
// ECHOCAT Web and the phone draw a layer the same way.

const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const T = require('../lib/sstv-templates');

const root = path.join(__dirname, '..');
const sstv = readSrc(path.join(root, 'renderer', 'sstv-popout.js'));
const sstvHtml = readSrc(path.join(root, 'renderer', 'sstv-popout.html'));
const remote = readSrc(path.join(root, 'renderer', 'remote.js'));
const remoteHtml = readSrc(path.join(root, 'renderer', 'remote.html'));
const server = readSrc(path.join(root, 'lib', 'remote-server.js'));

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + e.message); }
}

test('the typefaces offered: Automatic, Plain, then the shipped OFL faces', () => {
  const faces = T.textFaces();
  assert.deepStrictEqual(faces.map((f) => f.id), ['', 'plain'].concat(T.FONTS.map((f) => f.id)));
  assert.strictEqual(faces[0].name, 'Automatic');
  assert.strictEqual(T.faceFor(''), null);
  assert.strictEqual(T.faceFor('nope'), null, 'an unknown id is automatic, never a guess');
  assert.strictEqual(T.faceFor('bungee').css, '"Bungee"');
});

test('a layer saved before #327 draws exactly as before (shadow when not outlined, no spacing)', () => {
  assert.deepStrictEqual(T.layerStyle({}), { face: '', outline: false, shadow: true, spacing: 0 });
  assert.deepStrictEqual(T.layerStyle({ outline: true }), { face: '', outline: true, shadow: false, spacing: 0 });
  assert.deepStrictEqual(T.layerStyle(null), { face: '', outline: false, shadow: true, spacing: 0 });
});

test('the operator\'s choices win, and every field is normalised', () => {
  assert.deepStrictEqual(T.layerStyle({ face: 'russo', outline: true, shadow: true, spacing: 3 }), { face: 'russo', outline: true, shadow: true, spacing: 3 });
  assert.strictEqual(T.layerStyle({ shadow: false }).shadow, false, 'shadow off on plain text');
  assert.strictEqual(T.layerStyle({ face: 'comic' }).face, '', 'unknown face: automatic');
  assert.strictEqual(T.layerStyle({ spacing: 99 }).spacing, T.SPACING_MAX);
  assert.strictEqual(T.layerStyle({ spacing: -50 }).spacing, T.SPACING_MIN);
  assert.strictEqual(T.layerStyle({ spacing: '2.6' }).spacing, 3, 'a typed value is rounded');
  assert.strictEqual(T.layerStyle({ spacing: 'x' }).spacing, 0);
  assert.strictEqual(T.layerStyle({ shadow: 'yes' }).shadow, true, 'only true/false count; anything else is automatic');
});

test('the font: a picked face wins over the station\'s and a saved template\'s; bold asks for 700', () => {
  const station = { css: '"Archivo Black"', weight: 400 };
  assert.deepStrictEqual(T.layerFont({ face: 'russo' }, station), { css: '"Russo One"', weight: 400 });
  assert.deepStrictEqual(T.layerFont({ face: 'russo', bold: true }, station), { css: '"Russo One"', weight: 700 });
  assert.deepStrictEqual(T.layerFont({ face: 'rubik', bold: true }, station), { css: '"Rubik"', weight: 800 }, 'a face heavier than bold keeps its weight');
  assert.deepStrictEqual(T.layerFont({}, station), station, 'automatic: the station\'s lettering');
  assert.deepStrictEqual(T.layerFont({ bold: true }, null), { css: T.PLAIN_FACE.css, weight: 700 }, 'automatic on your own text: plain, bold as before');
  assert.deepStrictEqual(T.layerFont({ face: 'plain' }, station), { css: T.PLAIN_FACE.css, weight: 400 }, 'Plain on a template line drops the station face');
});

test('SSTV window: the editor offers all four, and the layer draws with them', () => {
  assert.ok(/T\.textFaces\(\)/.test(sstv) && /faceSel\.addEventListener\('change', \(\) => \{ t\.face = faceSel\.value;/.test(sstv), 'typeface picker');
  assert.ok(/t\.outline = !style\.outline/.test(sstv), 'outline toggle');
  assert.ok(/t\.shadow = !style\.shadow/.test(sstv), 'shadow toggle');
  assert.ok(/t\.spacing = T\.layerStyle\(\{ spacing: spInput\.value \}\)\.spacing/.test(sstv), 'spacing, clamped by the shared rule');
  const box = sstv.slice(sstv.indexOf('function textBox('), sstv.indexOf('function drawTextLayer('));
  assert.ok(/T\.layerFont\(t, auto\)/.test(box) && /T\.layerStyle\(t\)/.test(box));
  assert.ok(/c\.letterSpacing = style\.spacing \+ 'px';/.test(box), 'spacing is measured, so centred and fitted lines stay right');
  assert.ok(/c\.letterSpacing = '0px';/.test(box), 'the shared context is left unspaced');
  const draw = sstv.slice(sstv.indexOf('function drawTextLayer('), sstv.indexOf('function applyStarter('));
  assert.ok(/ctx\.letterSpacing = b\.spacing \+ 'px';/.test(draw));
  assert.ok(/if \(b\.shadow\) shadowOn\(\);/.test(draw) && /else if \(b\.shadow\)/.test(draw), 'shadow with or without an outline');
  assert.ok(/select\.tp-face \{[^}]*var\(--bg-primary\)[^}]*var\(--text-primary\)[^}]*var\(--border-primary\)/.test(sstvHtml), 'the picker uses theme tokens');
});

test('SSTV window: the four fields are saved, kept in a template, loaded back and mirrored to the phone', () => {
  const save = sstv.slice(sstv.indexOf('function saveTextElements('), sstv.indexOf('// Add custom text layer'));
  assert.ok(/face: t\.face \|\| '', shadow: t\.shadow, spacing: t\.spacing \|\| 0,/.test(save));
  assert.ok(/fontWeight: t\.fontWeight, face: t\.face \|\| '', shadow: t\.shadow, spacing: t\.spacing \|\| 0 \};/.test(sstv), 'template save');
  assert.ok(/fontWeight: st\.weight, outline: !!t\.outline \}\)/.test(sstv), 'a template line keeps the outline the operator chose');
  assert.ok(/face: saved\.face \|\| '', shadow: saved\.shadow, spacing: saved\.spacing \|\| 0,/.test(sstv), 'template load');
  const push = sstv.slice(sstv.indexOf('function pushComposeStateNow('), sstv.indexOf('function saveTextElements('));
  assert.ok(/face: t\.face \|\| '', fontCss: b\.css, fontWeight: b\.weight, outline: b\.outline, shadow: b\.shadow, spacing: b\.spacing,/.test(push), 'the phone gets the font as drawn');
});

test('a mode change that doubles the width doubles letter spacing too, like x and size; the hello says so', () => {
  assert.ok(/t\.fontSize = Math\.max\(6, Math\.round\(\(t\.fontSize \|\| 14\) \* kx\)\); if \(t\.spacing\) t\.spacing = T\.layerStyle\(\{ spacing: t\.spacing \* kx \}\)\.spacing;/.test(sstv));
  assert.ok(/'sstv-text-styles',/.test(server), 'capability for the phone to gate on');
});

test('ECHOCAT Web: the shared rules are inlined, kept on every layer copy, and drawn', () => {
  assert.ok(/<!-- sstv-templates-js -->/.test(remoteHtml));
  assert.ok(/\['sstv-templates-js', 'sstv-templates\.js'\]/.test(server));
  const keeps = remote.match(/face: t\.face \|\| '', fontCss: t\.fontCss, fontWeight: t\.fontWeight, outline: !!t\.outline, shadow: t\.shadow, spacing: t\.spacing \|\| 0/g) || [];
  assert.strictEqual(keeps.length, 4, 'settings load, template load, compose mirror, template save');
  const fn = remote.slice(remote.indexOf('function sstvPhoneDrawText('), remote.indexOf('function sstvPhoneApplyComposeState('));
  assert.ok(/T\.layerStyle\(t\)/.test(fn) && /T\.layerFont\(/.test(fn) && /ctx\.letterSpacing/.test(fn) && /strokeText/.test(fn));
  assert.ok(/sstvPhoneDrawText\(sstvPhoneComposeCtx, t\);/.test(remote));
});

console.log(`\nSSTV text styles (#327): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
