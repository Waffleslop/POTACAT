#!/usr/bin/env node
'use strict';
// LZ3AW round 13 (wishlist 2026-10-16), the first batch of small, clear items:
//   3  web VFO pane: Live button on the CW typing field (shares the CW tab's mode)
//   8  web Log tab: date/time stamped with now and kept current until edited
//   11 desktop: F1–F12 send CW macros 1–12 while the CW macro box is open
//   13 JTCAT: time / dB / DT / DF / country readable (secondary, 12 px)
//   14 JTCAT filter: several callsigns or words, any match
//   17 web FT8 period bar runs on the desktop's clock (hello.now)
//   20/21 dim text tokens raised on every theme, web greys made tokens
//   22 web spot card: the callsign opens QRZ, the rest of the card tunes
// Run: node test/lz3aw-round13-test.js
require('./ws-stub-if-missing');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('../lib/echocat-protocol');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('LZ3AW round 13');

const app = R('renderer/app.js'), web = R('renderer/remote.js'), webHtml = R('renderer/remote.html');
const pop = R('renderer/jtcat-popout.js'), popHtml = R('renderer/jtcat-popout.html');
const css = R('renderer/styles.css'), webCss = R('renderer/remote.css');

test('11: bare F1–F12 send CW macros only while the macro box is open, user bindings untouched', () => {
  assert.ok(/\/\^F\(\[1-9\]\|1\[0-2\]\)\$\/\.test\(e\.key\) && cwMacroBoxVisible/.test(app), 'gated on the box');
  assert.ok(/bareFKey && !e\.shiftKey && \/\^F\(\[1-9\]\|1\[0-2\]\)\$\//.test(app), 'bare keys only — Ctrl+F1 stays the hotkey table\'s');
  assert.ok(/e\.target === cwMacroInput\)\)/.test(app), 'works from the macro box\'s own text field');
  assert.ok(/function sendCwMacroByIndex\(i\) \{[\s\S]*?return false;[\s\S]*?window\.api\.sendCwText\(expandDesktopCwMacros\(m\.text\)\);\n\s*return true;/.test(app), 'same send as the button; false when there is no macro');
  const fIdx = app.indexOf("/^F([1-9]|1[0-2])$/.test(e.key) && cwMacroBoxVisible");
  const helpIdx = app.indexOf("if (e.key === 'F1' && bareFKey");
  assert.ok(fIdx > 0 && fIdx < helpIdx, 'macro keys are tried before the F1 help / F2 logbook defaults');
  assert.ok(/<kbd>F1<\/kbd>–<kbd>F12<\/kbd><\/td><td>CW macros 1–12 while the CW macro box is open/.test(R('renderer/index.html')), 'hotkeys help lists it');
});
test('14: decode filter takes several callsigns or words, any of them matches', () => {
  assert.ok(/searchTokens = searchFilter\.split\(\/\[\\s,;\]\+\/\)\.filter\(Boolean\);/.test(pop));
  assert.ok(/!searchTokens\.some\(function \(t\) \{ return c\.upper\.indexOf\(t\) !== -1; \}\)\) return false;/.test(pop));
  assert.ok(/ft8SearchTokens = ft8SearchFilter\.split\(\/\[\\s,;\]\+\/\)\.filter\(Boolean\);/.test(web));
  assert.ok(/!ft8SearchTokens\.some\(function \(t\) \{ return upper\.indexOf\(t\) !== -1; \}\)\) return;/.test(web));
  // the rule, run for real
  const tokens = 'LZ3AW, sp9abc k1'.toUpperCase().split(/[\s,;]+/).filter(Boolean);
  const show = (line) => tokens.some((t) => line.toUpperCase().indexOf(t) !== -1);
  assert.ok(show('CQ SP9ABC/P KO02') && show('K1ABC LZ3AW -10') && !show('CQ W1AW FN31'));
});
test('17: the server hello carries the desktop clock and the web period bar runs on it', () => {
  const h = P.buildServerHello({ serverVersion: 'x' });
  assert.ok(typeof h.now === 'number' && Math.abs(h.now - Date.now()) < 2000, 'hello.now = Date.now()');
  assert.ok(P.MESSAGES.hello.fields.now, 'declared in the protocol');
  assert.ok(/serverClockOffsetMs = msg\.now - Date\.now\(\);/.test(web));
  assert.ok(/const now = \(Date\.now\(\) \+ serverClockOffsetMs\) \/ 1000;/.test(web), 'countdown uses the offset');
});
test('8: web Log tab date/time stamped now and kept current until edited', () => {
  assert.ok(/function ltStampNow\(\)/.test(web));
  assert.ok(/setInterval\(\(\) => \{ if \(!ltTimeDirty\) ltStampNow\(\); \}, 15000\);/.test(web));
  assert.ok(/ltDateEl\.addEventListener\('input', \(\) => \{ ltTimeDirty = true; \}\);/.test(web));
  assert.ok(/function resetLogTabForm\(\) \{\n\s*ltTimeDirty = false;\n\s*ltStampNow\(\);/.test(web), 'a new QSO starts on now again');
  assert.ok(!/blank = now/.test(webHtml.slice(webHtml.indexOf('id="lt-date"') - 200, webHtml.indexOf('id="lt-date"'))), 'label no longer says blank = now');
});
test('3: VFO pane CW field has a Live button sharing the CW tab\'s mode; TX only clears in live mode', () => {
  assert.ok(/id="vf-cw-live"/.test(webHtml));
  assert.ok(/if \(vfCwLiveBtn\) vfCwLiveBtn\.classList\.toggle\('active', cwLiveMode\);/.test(web), 'one state, two buttons');
  assert.ok(/vfIn\.addEventListener\('input', \(\) => \{\n\s*if \(!cwLiveMode\) return;\n\s*const r = cwLiveInputDelta\(vfIn, vfCwLiveSent\);/.test(web));
  assert.ok(/if \(cwLiveMode\) \{ vfCwInput\.value = ''; vfCwLiveSent = 0; return; \}/.test(web), 'TX in live mode never re-sends the line');
  assert.ok(/const r = cwLiveInputDelta\(cwTextInput, cwLiveSent\);/.test(web), 'the CW tab uses the same helper');
});
test('22: tapping the callsign on a web spot card opens QRZ; the card still tunes', () => {
  assert.ok(/const callTarget = e\.target\.closest\('\.spot-call'\);[\s\S]*?window\.open\('https:\/\/www\.qrz\.com\/db\/' \+ encodeURIComponent\(base\), '_blank', 'noopener'\);\n\s*return;/.test(web));
  const i = web.indexOf("const callTarget = e.target.closest('.spot-call');");
  assert.ok(web.indexOf("type: 'tune',", i) > i, 'tune path follows the QRZ branch');
  assert.ok(/\.spot-call \{ cursor: pointer; text-decoration: underline dotted;/.test(webCss));
});
test('13 + 20/21: readable greys — tokens raised on every theme, JTCAT cells secondary at 12 px, web greys are tokens', () => {
  const hex = (v) => parseInt(v.slice(1), 16);
  const lum = (v) => { const n = hex(v); return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114; };
  const navy = css.slice(css.indexOf('--text-secondary: #a0a0c0;'), css.indexOf('--text-secondary: #a0a0c0;') + 400);
  const m = navy.match(/--text-tertiary: (#[0-9a-f]{6});\n\s*--text-dim: (#[0-9a-f]{6});\n\s*--text-dimmer: (#[0-9a-f]{6});/);
  assert.ok(m, 'navy tokens');
  assert.ok(lum(m[1]) > lum('#808090') && lum(m[2]) > lum('#606080') && lum(m[3]) > lum('#404060'), 'navy greys brighter than before');
  assert.ok(lum(m[1]) < lum('#a0a0c0') && lum(m[2]) < lum(m[1]) && lum(m[3]) < lum(m[2]), 'still a ladder below secondary');
  assert.ok(/--text-dim: #9a9ab0;/.test(webCss) && /--text-dim: #5e5e76;/.test(webCss), 'web dark and light tokens');
  assert.ok(!/\.ft8-row \.ft8-dt \{ color: #666/.test(webCss) && /\.ft8-entity \{ font-size: 11px; color: var\(--text-dim\);/.test(webCss), 'web FT8 greys are tokens');
  assert.ok(/\.jp-row \.jp-time \{[^}]*color: var\(--text-secondary\); font-size: 12px;/.test(popHtml));
  assert.ok(/\.jp-row \.jp-dt \{[^}]*color: var\(--text-secondary\); font-size: 12px; \}/.test(popHtml));
  assert.ok(/\.jp-entity \{ font-size: 11px; color: var\(--text-secondary\);/.test(popHtml));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
