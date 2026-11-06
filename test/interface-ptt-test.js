#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
/**
 * "The audio interface keys it" on every CAT type that has no port of its own
 * to key (WX4MWA 2026-11-04: TS-2000 + SignaLink through flrig keyed the front
 * mic over CAT, and the choice was offered only on Serial CAT and Icom).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const html = readSrc(path.join(ROOT, 'renderer/index.html'));
const app = readSrc(path.join(ROOT, 'renderer/app.js'));
const main = readSrc(path.join(ROOT, 'main.js'));
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
for (const id of ['set-flrig-ptt', 'set-rigctldnet-ptt']) {
  check(id + ': over CAT or the interface, saved and loaded', () => {
    const at = html.indexOf('<select id="' + id + '">');
    const sel = at < 0 ? null : [null, html.slice(at, html.indexOf('</select>', at))];
    assert.ok(sel, 'the select exists');
    assert.ok(/value="cat"/.test(sel[1]) && /value="vox"/.test(sel[1]));
    assert.ok(!/value="rts"|value="dtr"/.test(sel[1]), 'no port lines: flrig / the remote rigctld holds the port');
    assert.ok(app.includes("...pttChoiceField('" + id + "')"), 'saved on the target');
    assert.ok(app.includes("document.getElementById('" + id + "')"), 'loaded from the target');
  });
}
check('main honours ptt vox for any CAT type', () => {
  assert.ok(/if \(t && t\.type !== 'none' && t\.ptt === 'vox'\) \{/.test(main));
});
check('the TS-2000 note points at the choice', () => {
  const N = require('../lib/rig-setup-notes');
  const list = N.SETUP_NOTES || N.NOTES || N.notes || [];
  const src = readSrc(path.join(ROOT, 'lib/rig-setup-notes.js'));
  assert.ok(/id: 'ts2000-interface-ptt'/.test(src) || list.some((n) => n.id === 'ts2000-interface-ptt'));
  assert.ok(html.includes("The audio interface keys it (SignaLink, the radio's VOX)"));
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
