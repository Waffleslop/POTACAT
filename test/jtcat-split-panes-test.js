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
  assert.ok(/var splitLeftPanes = \[decodePaneEl, document\.getElementById\('jp-psk-pane'\), document\.getElementById\('jp-jtty-pane'\)\]/.test(JS));
  assert.ok(/splitLeftPanes\.forEach\(function\(el\) \{ el\.style\.flex = String\(p\) \+ ' 1 0'; \}\);/.test(JS));
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
console.log(`\nJTCAT split panes: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
