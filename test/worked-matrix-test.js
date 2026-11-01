#!/usr/bin/env node
'use strict';
// The worked grid in the log windows (GitHub #108, AE5JE): the bands and
// modes already worked with the call being logged, in the Log QSO window,
// the log pop-out and ECHOCAT Web.
// Run: node test/worked-matrix-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const WM = require('../lib/worked-matrix');
const JtcatParser = require('../renderer/jtcat-parser');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const worked = new Map([
  ['K1ABC', [{ band: '20M', mode: 'SSB' }, { band: '20m', mode: 'FT8', confirmed: true }, { band: '40m', mode: 'CW' }]],
  ['K1ABC/P', [{ band: '15m', mode: 'FT4' }]],
  ['W4/K1ABC', [{ band: '2m', mode: 'FM' }]],
  ['K1ABD', [{ band: '10m', mode: 'CW' }]],
]);

test('every form of the base call counts; another call does not', () => {
  const e = WM.entriesForCall(worked, 'k1abc', JtcatParser.baseCall);
  assert.strictEqual(e.length, 5);
});
test('rows are CW / Phone / Digital, columns are bands, confirmed beats worked', () => {
  const m = WM.buildWorkedMatrix(WM.entriesForCall(worked, 'K1ABC', JtcatParser.baseCall));
  assert.deepStrictEqual(m.rows.map((r) => r.label), ['CW', 'Phone', 'Digital']);
  const row = (f) => m.rows.find((r) => r.family === f).cells;
  assert.strictEqual(row('cw')['40m'], 'worked');
  assert.strictEqual(row('phone')['20m'], 'worked');
  assert.strictEqual(row('phone')['2m'], 'worked');
  assert.strictEqual(row('digital')['20m'], 'confirmed');
  assert.strictEqual(row('digital')['15m'], 'worked');
  assert.ok(m.bands.indexOf('160m') === 0 && m.bands.includes('2m') && m.bands.indexOf('2m') > m.bands.indexOf('6m'), m.bands.join(','));
  assert.strictEqual(m.total, 5);
});
test('the HTML marks W and C in POTACAT blue and green; a new call says so', () => {
  const html = WM.workedMatrixHtml(WM.buildWorkedMatrix(WM.entriesForCall(worked, 'K1ABC', JtcatParser.baseCall)));
  assert.ok(/class="wm-confirmed" style="[^"]*background:#4ecca3[^"]*">C</.test(html));
  assert.ok(/class="wm-worked" style="[^"]*background:#4fc3f7[^"]*">W</.test(html));
  assert.ok(!/#f0a500|yellow/i.test(html), 'never GridTracker yellow');
  assert.strictEqual(WM.workedMatrixHtml(WM.buildWorkedMatrix([])), '');
  assert.ok(/Not worked before/.test(WM.workedMatrixHtml(WM.buildWorkedMatrix([]), { showEmpty: true })));
});

test('Log QSO window: container, script, drawn on open and as the call is typed', () => {
  const html = read('renderer/index.html');
  assert.ok(html.includes('<div id="log-worked-matrix" class="log-worked-matrix"></div>'));
  assert.ok(html.indexOf('../lib/worked-matrix.js') > 0 && html.indexOf('../lib/worked-matrix.js') < html.indexOf('src="app.js"'));
  const app = read('renderer/app.js');
  assert.ok(/function renderLogWorkedMatrix\(\)/.test(app));
  assert.ok(/renderLogWorkedMatrix\(\);\s*refreshLogAsOperators\(\);[^\n]*\n\s*logDialog\.showModal\(\);/.test(app), 'on open');
  assert.ok(/logWorkedMatrixTimer = setTimeout\(renderLogWorkedMatrix, 200\)/.test(app), 'while typing');
});
test('log pop-out: main returns the grid with the callsign lookup and the window draws it', () => {
  const main = read('main.js');
  assert.ok(/return \{ qrz: qrzInfo, pastQsos, totalQsos: all\.length, workedMatrix \};/.test(main));
  assert.ok(read('renderer/log-popout.html').includes('<div id="lp-worked-matrix"></div>'));
  assert.ok(read('renderer/log-popout.html').includes('<script src="../lib/worked-matrix.js"></script>'));
  assert.ok(/renderWorkedMatrix\(result\.workedMatrix\)/.test(read('renderer/log-popout.js')));
});
test('ECHOCAT Web: inlined, drawn in the log sheet and the quick log', () => {
  assert.ok(read('lib/remote-server.js').includes("['worked-matrix-js', 'worked-matrix.js']"));
  const html = read('renderer/remote.html');
  assert.ok(html.includes('<!-- worked-matrix-js -->') && html.includes('id="ql-worked-matrix"') && html.includes('id="log-worked-matrix"'));
  const web = read('renderer/remote.js');
  assert.ok(/qlCall\.addEventListener\('input', \(\) => webRenderWorkedMatrix\(qlCall, 'ql-worked-matrix'\)\)/.test(web));
  assert.ok(/logCall\.value = p\.callsign \|\| '';\s*reportTypedCall\('log', logCall\.value\);[^\n]*\n\s*webRenderWorkedMatrix\(logCall, 'log-worked-matrix'\);/.test(web));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
