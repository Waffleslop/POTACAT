#!/usr/bin/env node
'use strict';
// Text macros with no grid square set (first run, part 1, leaves the grid
// blank until the operator types one). Nothing malformed goes on the air or
// into a public spot:
//   re-spot {QTH}  -> "in {QTH}" is dropped, the rest posts
//   PSK $GRID      -> the macro is refused with a sentence
//   CW {MYGRID}    -> the macro is refused with a sentence, nothing keyed
//   SSTV {GRID}    -> "Grid {GRID}" is dropped from the picture's text
// Run: node test/grid-macros-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/grid-macros');
const B = require('../lib/cw-banks');
const T = require('../lib/sstv-templates');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

// ---- Re-spot {QTH} --------------------------------------------------------
test('re-spot: a grid fills {QTH} as before', () => {
  assert.strictEqual(G.fillRespotQth('{rst} in {QTH} 73s {mycallsign} via POTACAT', 'FN20jb'), '{rst} in FN20jb 73s {mycallsign} via POTACAT');
  assert.strictEqual(G.fillRespotQth('Heard in {qth}', ' EM12 '), 'Heard in EM12');
});

test('re-spot: no grid drops "in {QTH}", never posts "in" with nothing after it', () => {
  assert.strictEqual(G.fillRespotQth('{rst} in {QTH} 73s {mycallsign} via POTACAT', ''), '{rst} 73s {mycallsign} via POTACAT');
  assert.strictEqual(G.fillRespotQth('Heard in {QTH} 73s {mycallsign} via POTACAT', undefined), 'Heard 73s {mycallsign} via POTACAT');
  assert.strictEqual(G.fillRespotQth('Heard strong in {QTH}; 73s {callsign} via POTACAT', null), 'Heard strong; 73s {callsign} via POTACAT');
  assert.strictEqual(G.fillRespotQth('{QTH} 59 tnx', ''), '59 tnx', 'a bare {QTH} goes too');
  assert.strictEqual(G.fillRespotQth('59 tnx', ''), '59 tnx', 'no {QTH}: untouched');
});

test('re-spot: every expansion uses fillRespotQth, none replaces {QTH} by hand', () => {
  for (const f of ['main.js', 'renderer/app.js', 'renderer/log-popout.js', 'renderer/remote.js']) {
    const s = read(f);
    assert.ok(!/\.replace\(\/\\\{QTH\\\}\/gi,/.test(s), f + ' still replaces {QTH} itself');
    assert.ok(/GridMacros\.fillRespotQth\(/.test(s), f + ' does not call GridMacros.fillRespotQth');
  }
  const counts = { 'renderer/app.js': 3, 'renderer/remote.js': 2, 'renderer/log-popout.js': 1, 'main.js': 1 };
  for (const [f, n] of Object.entries(counts)) {
    assert.strictEqual(read(f).split('GridMacros.fillRespotQth(').length - 1, n, f + ' expansion count');
  }
  assert.ok(/const GridMacros = require\('\.\/lib\/grid-macros'\)/.test(read('main.js')));
});

test('lib/grid-macros.js is loaded on every page that uses it', () => {
  for (const f of ['renderer/index.html', 'renderer/log-popout.html', 'renderer/jtcat-popout.html']) {
    assert.ok(read(f).includes('<script src="../lib/grid-macros.js"></script>'), f);
  }
  assert.ok(read('renderer/remote.html').includes('<!-- grid-macros-js -->'), 'remote.html marker');
  assert.ok(read('lib/remote-server.js').includes("['grid-macros-js', 'grid-macros.js']"), 'remote-server inlines it');
});

// ---- PSK $GRID ------------------------------------------------------------
test('PSK: $GRID with no grid is refused; with a grid, or without $GRID, it goes', () => {
  const exch = '$CALL de $MYCALL  UR RSQ 599 599  QTH grid $GRID $GRID  BTU $CALL de $MYCALL K\n';
  assert.strictEqual(G.pskMacroBlocked(exch, ''), true);
  assert.strictEqual(G.pskMacroBlocked(exch, '  '), true);
  assert.strictEqual(G.pskMacroBlocked(exch, 'FN20'), false);
  assert.strictEqual(G.pskMacroBlocked('CQ CQ de $MYCALL K', ''), false);
  assert.ok(/Settings > Station/.test(G.NO_GRID_TEXT) && /Not sent/.test(G.NO_GRID_TEXT));
});

test('PSK: both macro buttons check before inserting anything', () => {
  const pop = read('renderer/jtcat-popout.js');
  const i = pop.indexOf('GridMacros.pskMacroBlocked(m.text, myGrid)');
  assert.ok(i > 0, 'JTCAT pop-out checks');
  assert.ok(i < pop.indexOf('var t = pskSubstituteMacro(m.text);', i), 'pop-out checks before substituting');
  const web = read('renderer/remote.js');
  const j = web.indexOf('GridMacros.pskMacroBlocked(m.text, phoneGrid)');
  assert.ok(j > 0, 'ECHOCAT Web checks');
  assert.ok(j < web.indexOf('const sub = pskSubstituteMacro(m.text);', j), 'web checks before substituting');
});

// ---- CW {MYGRID} ----------------------------------------------------------
test('CW: {MYGRID} with no grid refuses the macro (text empty, missing named)', () => {
  const r = B.expandVars('{CALL} 5NN QTH {MYGRID} {MYGRID}', { call: 'k1abc', myGrid: '' });
  assert.strictEqual(r.text, '');
  assert.deepStrictEqual(r.missing, ['{MYGRID}']);
  const ok = B.expandVars('{CALL} 5NN QTH {MYGRID}', { call: 'k1abc', myGrid: 'fn20' });
  assert.strictEqual(ok.text, 'K1ABC 5NN QTH FN20');
  assert.deepStrictEqual(ok.missing, []);
  assert.strictEqual(B.expandVars('TU 73', {}).text, 'TU 73', 'a macro without {MYGRID} needs no grid');
});

test('CW: every desktop sink sends only a non-empty expansion and says why', () => {
  const s = read('renderer/app.js');
  assert.ok(!/sendCwText\(expandDesktopCwMacros\(/.test(s), 'a sink sends the expansion unchecked');
  assert.ok(/if \(ex\.missing && ex\.missing\.length\) \{ cwReportNoGrid\(\); return ''; \}/.test(s), 'expandDesktopCwMacros refuses');
  assert.ok(/function cwReportNoGrid\(\) \{\n  showLogToast\(GridMacros\.NO_GRID_TEXT/.test(s));
  assert.ok(s.split('cwReportNoGrid()').length - 1 >= 3, 'ESM Enter and F-keys report it too');
});

// ---- SSTV {GRID} ----------------------------------------------------------
test('SSTV: no grid drops "Grid {GRID}" from the picture text', () => {
  assert.strictEqual(T.fillVars('Grid {GRID}', { GRID: '' }), '');
  assert.strictEqual(T.fillVars('Grid {GRID} · 73 from the park', { GRID: '' }), '73 from the park');
  assert.strictEqual(T.fillVars('{MYCALL} · QTH: {GRID}', { MYCALL: 'K1ABC' }), 'K1ABC');
  assert.strictEqual(T.fillVars('{MYCALL} {GRID} {UTC}', { MYCALL: 'K1ABC', UTC: '12:00Z' }), 'K1ABC 12:00Z');
});

test('SSTV: with a grid, text is filled as before', () => {
  assert.strictEqual(T.fillVars('Grid {GRID} · 73 from the park', { GRID: 'FN20' }), 'Grid FN20 · 73 from the park');
  assert.strictEqual(T.fillVars('CQ POTA {PARK}', {}), 'CQ POTA ', 'other blanks unchanged');
});

// ---- APRS precision labels (a follow-up from the grid audit) ---------------
test('APRS: with no grid the grid choices name no made-up square (was "(FN20)")', () => {
  const W = require('../lib/aprs-window-state');
  const c = W.precisionChoices({ grid: '', settings: {} });
  assert.strictEqual(c[0].label, 'Grid square, 4 characters');
  assert.strictEqual(c[1].label, 'Grid square, 6 characters');
  assert.ok(c[0].disabled && c[1].disabled);
  assert.ok(!/FN20/.test(JSON.stringify(c)), 'no FN20 anywhere');
  assert.ok(/Settings > Station/.test(c[0].note));
  assert.strictEqual(W.precisionChoices({ grid: 'FN20', settings: {} })[0].label, 'Grid square, 4 characters (FN20)', 'with a grid: unchanged');
});

console.log(`\nGrid macros with no grid: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
