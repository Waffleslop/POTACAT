#!/usr/bin/env node
'use strict';
// Settings > Cloud polish (Casey 2026-10-20): the live tunnel link must be
// readable on charcoal, the start-at-login checkbox must not take a third
// of its row, and the on-air badge (potacat.com/badge) is the first embed.
// Run: node test/cloud-tab-ui-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('Settings > Cloud tab');
const css = R('renderer/styles.css'), html = R('renderer/index.html'), ui = R('renderer/cloud-ui.js');

test('tunnel host link has its own colour (theme accent, not the browser default)', () => {
  assert.ok(/#cloud-tunnel-host a \{\n\s*color: var\(--accent-blue\);\n\s*font-weight: 600;\n\s*text-decoration: underline;/.test(css));
  assert.ok(/#cloud-tunnel-host a:hover \{ color: var\(--accent-green\); \}/.test(css));
  assert.ok(/\[data-dark-variant="charcoal"\] \{[\s\S]*?--accent-blue: #38bdf8;/.test(css), 'charcoal defines the accent the link now uses');
});

test('start-at-login checkbox row uses .checkbox-label (width: auto on the box)', () => {
  assert.ok(/<label class="checkbox-label" style="margin-top:6px;margin-bottom:0;cursor:pointer;">\n\s*<input type="checkbox" id="cloud-tunnel-startup-launcher" checked>/.test(html));
  assert.ok(/\.checkbox-label input\[type="checkbox"\] \{\n\s*width: auto;/.test(css));
});

test('on-air badge is the first embed: Build opens the builder, Copy gives the image link', () => {
  const table = html.slice(html.indexOf('id="cloud-embed-table"'), html.indexOf('id="cloud-embed-copied"'));
  const first = table.indexOf('data-widget="onair-badge"'), card = table.indexOf('data-widget="card"');
  assert.ok(first > 0 && first < card, 'badge row above Latest Activation');
  assert.ok(/class="cloud-embed-view" data-widget="onair-badge"[^>]*>Build</.test(table));
  assert.ok(/const onairBadgeBuilder = 'https:\/\/potacat\.com\/badge\/';/.test(ui));
  assert.ok(/if \(widget === 'onair-badge'\) \{ window\.api\.openExternal\(onairBadgeBuilder\); return; \}/.test(ui), 'Build needs no callsign');
  assert.ok(/<img src="https:\/\/potacat\.com\/badge\/\$\{cs\}\.svg"/.test(ui) && /href="https:\/\/potacat\.com\/onair\/\$\{cs\}"/.test(ui), 'the plan\'s snippet');
  assert.ok(/widget === 'onair-badge'\n\s*\? onairBadgeEmbed\(cs\)/.test(ui), 'Copy branches to the image link');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
