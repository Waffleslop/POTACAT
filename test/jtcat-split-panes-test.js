'use strict';
// The JTCAT pop-out's map splitter must size the PSK31 and JTTY panes too
// (Chris / W7RTA 2026-10-17: in PSK31 or JTTY the map covered almost the
// whole window and dragging the splitter barely moved it). The keyboard panes
// carry CSS flex:1; with the split set only on the (hidden) FT8 decode pane,
// the map's 20-80 weight beat 1 every time.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const JS = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'jtcat-popout.js'), 'utf8').replace(/\r\n/g, '\n');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'jtcat-popout.html'), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
test('every left pane gets the split, not only the FT8 decode pane', () => {
  // A hard-coded list missed WSPR (2026-10-21: the map took 98% in WSPR and
  // dragging did nothing). It is every child of the row left of the splitter.
  assert.ok(/var splitLeftPanes = Array\.prototype\.filter\.call\(\n\s+\(document\.querySelector\('\.jp-main'\) \|\| document\.body\)\.children,/.test(JS));
  assert.ok(/splitLeftPanes\.forEach\(function\(el\) \{ el\.style\.flex = String\(p\) \+ ' 1 0'; \}\);/.test(JS));
  assert.ok(/localStorage\.setItem\(SPLIT_LS_KEY, String\(splitCurrentPct\)\)/.test(JS), 'saves the applied split, whichever pane is showing');
  // Every pane in that row is one the split now reaches.
  const row = HTML.slice(HTML.lastIndexOf('<div class="jp-main">'), HTML.indexOf('class="jp-map-pane"', HTML.lastIndexOf('<div class="jp-main">')));
  for (const id of ['class="jp-decode-pane"', 'id="jp-wspr-pane"', 'id="jp-psk-pane"', 'id="jp-jtty-pane"']) assert.ok(row.indexOf(id) > 0, id + ' sits left of the splitter');
});
test('the split is applied at load even with nothing saved (keyboard panes never keep flex:1)', () => {
  assert.ok(/applySplitPct\(isNaN\(savedPct\) \? 50 : savedPct\);/.test(JS));
});
test('the panes it sizes sit beside the map in the same row', () => {
  const main = HTML.slice(HTML.lastIndexOf('<div class="jp-main">'));
  for (const id of ['class="jp-decode-pane"', 'id="jp-psk-pane"', 'id="jp-jtty-pane"', 'id="jp-splitter"', 'class="jp-map-pane"']) {
    assert.ok(main.indexOf(id) > 0, id);
  }
  assert.ok(/\.jp-psk-pane \{ flex: 1;/.test(HTML), 'the CSS default the inline split must override');
});
// LZ3AW item 12: Band Activity / My Activity are resizable the same way.
test('a divider between Band Activity and My Activity, persisted, double-click resets', () => {
  const main = HTML.slice(HTML.indexOf('<div class="jp-decode-pane">'), HTML.indexOf('id="jp-wspr-pane"'));
  const band = main.indexOf('id="jp-band-activity"'), div = main.indexOf('id="jp-activity-splitter"'), mine = main.indexOf('id="jp-my-activity"');
  assert.ok(band > 0 && div > band && mine > div, 'the divider sits between the two lists');
  assert.ok(/\.jp-hsplitter \{[^}]*cursor: row-resize/.test(HTML), 'styled as a row splitter');
  assert.ok(/var ACT_SPLIT_LS_KEY = 'jtcat-popout-activity-split-pct';/.test(JS), 'persisted per machine');
  assert.ok(/actSections\[0\]\.style\.flex = String\(p\) \+ ' 1 0';/.test(JS) && /actSections\[1\]\.style\.flex = String\(100 - p\) \+ ' 1 0';/.test(JS), 'flex ratios, not pixels');
  assert.ok(/actSplitEl\.addEventListener\('dblclick'[\s\S]{0,120}applyActivitySplitPct\(50\)/.test(JS), 'double-click resets');
});
console.log(`\nJTCAT split panes: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
