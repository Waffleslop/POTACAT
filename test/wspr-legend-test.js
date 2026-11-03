#!/usr/bin/env node
'use strict';
// The WSPR map legend explains the SNR dot colours from the SAME table that
// colours the dots (a user remembered a legend; there was none, 2026-10-24).
// Run: node test/wspr-legend-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const js = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'jtcat-popout.js'), 'utf8').replace(/\r\n/g, '\n');
const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'jtcat-popout.html'), 'utf8');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const start = js.indexOf('var WSPR_SNR_STEPS = [');
const end = js.indexOf('// The map legend for WSPR');
const steps = new Function(js.slice(start, end) + '; return { WSPR_SNR_STEPS, WSPR_SNR_NONE, wsprSnrColor };')();

test('the dots and the legend share one colour table', () => {
  const { WSPR_SNR_STEPS, WSPR_SNR_NONE, wsprSnrColor } = steps;
  assert.strictEqual(wsprSnrColor(-5), WSPR_SNR_STEPS[0].color);
  assert.strictEqual(wsprSnrColor(-10), '#4ecca3');
  assert.strictEqual(wsprSnrColor(-15), '#f0a500');
  assert.strictEqual(wsprSnrColor(-20), '#f0a500');
  assert.strictEqual(wsprSnrColor(-21), '#e94560');
  assert.strictEqual(wsprSnrColor(null), WSPR_SNR_NONE.color);
  assert.ok(/WSPR_SNR_STEPS\.concat\(\[WSPR_SNR_NONE\]\)\.forEach/.test(js), 'the legend is drawn from the table');
});

test('shown in WSPR mode only, styled', () => {
  assert.ok(/var lg = wsprLegendControl\(\);\n\s*if \(lg && !lg\._map\) lg\.addTo\(map\);/.test(js));
  assert.ok(/if \(wsprLegend && wsprLegend\._map\) wsprLegend\.remove\(\);/.test(js));
  assert.ok(html.includes('.jp-wspr-legend {'));
});

console.log(`\nWSPR legend: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
