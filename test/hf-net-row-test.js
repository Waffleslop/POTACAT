#!/usr/bin/env node
'use strict';
// Directory > HF Nets: the "Remove" button was cut in half (hoogskev
// 2026-10-31). Every table cell clips with an ellipsis and the action column
// was 60 px, narrower than the button. The column now fits both buttons
// whole and the action cell never clips.
// Run: node test/hf-net-row-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('the action column fits the Remove button (11 px text + 8 px padding + borders, plus cell padding)', () => {
  const m = /\.dirv-action-col \{ width: (\d+)px;/.exec(css);
  assert.ok(m, 'width rule present');
  assert.ok(Number(m[1]) >= 80, `width ${m[1]} px`);
});
test('the action cell never clips, and the buttons never wrap', () => {
  assert.ok(/\.directory-view-table tbody td\.dirv-action-col \{ overflow: visible; text-overflow: clip; \}/.test(css));
  assert.ok(/\.dirv-action-col \.dir-add-btn, \.dirv-action-col \.dir-remove-btn \{ white-space: nowrap; \}/.test(css));
});
test('the Settings net list keeps its buttons from shrinking (the name ellipsizes instead)', () => {
  assert.ok(/\.net-item-info \{\s*flex: 1;\s*min-width: 0;/.test(css));
  assert.ok(/\.node-item-btn,\s*\.node-delete-btn \{[^}]*flex-shrink: 0;/.test(css));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
