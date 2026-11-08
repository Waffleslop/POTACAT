#!/usr/bin/env node
'use strict';
// GitHub #240 (hoogskev): the Log QSO form opened from the hunter table was
// still too narrow after 1.14.0 widened it to 500 px, its width could not be
// changed, and a bigger text size garbled the new log fields.
//
// The form must stay readable at POTACAT's Text size (the window zoom,
// 60-200 %) and at Windows display scale 125-150 %: both shrink the window
// in CSS px, so the form's limits are against the viewport, its paired
// fields wrap instead of squeezing, and the operator can drag it wider and
// have that width remembered.
//
// The rendered layout harness (test/layout/harness.js) needs Electron; this
// pins the CSS and markup rules that produce the layout, and checks the
// width arithmetic over the zoom x display-scale grid.
// Run: node test/log-form-layout-test.js
const { readSrc } = require('./_src');
const assert = require('assert');
const path = require('path');

const R = (f) => readSrc(path.join(__dirname, '..', f));
const css = R('renderer/styles.css');
const html = R('renderer/index.html');
const app = R('renderer/app.js');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

/** The declarations of the first rule whose selector list is exactly `sel`. */
function rule(sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('(^|\\n)' + esc + '\\s*\\{([^}]*)\\}').exec(css);
  assert.ok(m, 'no CSS rule for ' + sel);
  return m[2];
}
const decl = (body, prop) => {
  const m = new RegExp('(^|[;\\s])' + prop + ':\\s*([^;]+);').exec(body);
  return m ? m[2].trim() : null;
};

const dlg = rule('#log-dialog');
const logDialogHtml = html.slice(html.indexOf('<dialog id="log-dialog">'), html.indexOf('</dialog>', html.indexOf('<dialog id="log-dialog">')));

check('the form opens wider than 1.14.0\'s 500 px, but never wider than the window', () => {
  const w = decl(dlg, 'width');
  const m = /^min\((\d+)px, calc\(100vw - (\d+)px\)\)$/.exec(w || '');
  assert.ok(m, 'width: min(<px>, calc(100vw - <gutter>px)), got ' + w);
  assert.ok(+m[1] > 500, 'default width ' + m[1] + ' px is not wider than 500');
  assert.strictEqual(decl(dlg, 'max-width'), 'calc(100vw - 16px)', 'no fixed px cap: the operator may widen it to the window');
  assert.strictEqual(decl(dlg, 'max-height'), 'calc(100vh - 16px)');
  assert.strictEqual(decl(dlg, 'box-sizing'), 'border-box', 'width includes padding, so the saved width is the drawn width');
});

check('the operator can resize it (resize needs overflow other than visible)', () => {
  assert.strictEqual(decl(dlg, 'resize'), 'both');
  assert.ok(['auto', 'hidden', 'scroll'].includes(decl(dlg, 'overflow')), 'overflow ' + decl(dlg, 'overflow'));
  assert.ok(/^min\(\d+px, calc\(100vw - \d+px\)\)$/.test(decl(dlg, 'min-width')), 'min-width also yields to a small window');
});

check('paired fields wrap one under the other instead of squeezing', () => {
  const row = rule('#log-dialog .log-row');
  assert.strictEqual(decl(row, 'display'), 'flex');
  assert.strictEqual(decl(row, 'flex-wrap'), 'wrap');
  const lbl = rule('#log-dialog .log-row > label');
  assert.ok(/^1 1 \d+(\.\d+)?em$/.test(decl(lbl, 'flex') || ''), 'a field basis in em, so it scales with the text: ' + decl(lbl, 'flex'));
  assert.strictEqual(decl(lbl, 'min-width'), '0');
  const inputs = rule('#log-dialog label input,\n#log-dialog label select');
  assert.strictEqual(decl(inputs, 'max-width'), '100%', 'an input never runs out of its label');
  assert.strictEqual(decl(inputs, 'box-sizing'), 'border-box');
  assert.strictEqual(decl(rule('#log-dialog label'), 'overflow-wrap'), 'anywhere', 'a long label wraps, never under the next field');
  assert.ok(/\.log-type-chips \{[^}]*flex-wrap: wrap;/.test(css), 'program chips wrap');
  assert.strictEqual(decl(rule('#log-dialog .log-as-wrap'), 'flex-wrap'), 'wrap', 'Log for row wraps');
});

check('every paired row in the form uses the wrapping row, none the old fixed inline flex', () => {
  assert.ok(logDialogHtml.length > 1000, 'log dialog markup found');
  assert.ok(!/<div style="display:flex;gap:8px;">/.test(logDialogHtml), 'an inline non-wrapping row is left');
  assert.ok(!/<label style="flex:1;">/.test(logDialogHtml), 'an inline flex:1 label is left');
  assert.strictEqual((logDialogHtml.match(/<div class="log-row">/g) || []).length, 4, 'Callsign/Name, Frequency/Mode, Date/Time, RST Sent/Received');
  for (const id of ['log-callsign', 'log-op-name', 'log-frequency', 'log-mode', 'log-date', 'log-time', 'rst-sent-n1mm', 'rst-rcvd-n1mm']) {
    assert.ok(logDialogHtml.includes('id="' + id + '"'), id + ' still in the form');
  }
});

check('the width is remembered: restored before opening, kept inside the window, height left automatic', () => {
  assert.ok(/const LOG_DIALOG_WIDTH_KEY = 'potacat-log-dialog-width';/.test(app));
  const fn = /function sizeLogDialog\(\) \{([\s\S]*?)\n\}/.exec(app);
  assert.ok(fn, 'sizeLogDialog');
  assert.ok(/logDialog\.style\.height = '';/.test(fn[1]), 'height stays automatic');
  assert.ok(/Math\.min\(w, window\.innerWidth - 16\)/.test(fn[1]), 'clamped to the window');
  assert.ok(/sizeLogDialog\(\);\n\s*logDialog\.showModal\(\);\n\s*placeLogDialog\(\);/.test(app), 'sized before it opens and is placed');
  assert.ok(/localStorage\.setItem\(LOG_DIALOG_WIDTH_KEY, String\(px\)\)/.test(app), 'a grip drag saves the width');
  assert.ok(/logDialog\.style\.width === _logDialogAppliedWidth\) return;/.test(app), 'a clamped restore does not overwrite the saved width');
  assert.ok(/localStorage\.removeItem\(LOG_DIALOG_WIDTH_KEY\)/.test(app), 'double-click the title for the default width');
});

check('at Text size 100-200 % and display scale 100-150 %, the form fits the window and each field keeps 11em or wraps', () => {
  const w = decl(dlg, 'width');
  const [, defPx, gutter] = /^min\((\d+)px, calc\(100vw - (\d+)px\)\)$/.exec(w).map(Number);
  const pad = 2 * 20; // dialog { padding: 20px }
  const bodyPx = 14;  // body { font-size: 14px } — em is relative to it
  const basis = parseFloat(/^1 1 (\d+(?:\.\d+)?)em$/.exec(decl(rule('#log-dialog .log-row > label'), 'flex'))[1]) * bodyPx;
  for (const screen of [1366, 1600, 1920]) {
    for (const scale of [1, 1.25, 1.5]) {
      for (const zoom of [1, 1.2, 1.5, 2]) {
        const vw = screen / scale / zoom;              // the window's width in CSS px
        const width = Math.min(defPx, vw - gutter);
        assert.ok(width <= vw - gutter, 'fits ' + [screen, scale, zoom]);
        const content = width - pad;
        const perRow = content >= 2 * basis + 12 ? 2 : 1;
        const fieldPx = perRow === 2 ? (content - 12) / 2 : content;
        assert.ok(fieldPx >= Math.min(basis, content), `field ${fieldPx.toFixed(0)} px < ${basis} px at ${screen}/${scale}/${zoom}`);
      }
    }
  }
});

console.log(`\nLog QSO form width (#240): ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
