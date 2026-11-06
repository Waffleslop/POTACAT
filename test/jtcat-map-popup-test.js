#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// The JTCAT map popup names the station as a QRZ link (kilrath8954
// 2026-10-31: it showed only the operator's name and grid; the Spots map
// already linked the call).
// Run: node test/jtcat-map-popup-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const pop = readSrc(path.join(__dirname, '..', 'renderer', 'jtcat-popout.js'));
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const start = pop.indexOf('  function stationPopupHtml(call, grid) {');
const end = pop.indexOf('  function fetchQrzName(call) {', start);
const ctx = {
  myCallsign: 'K3SBP', qrzCache: { W1AW: { name: 'Hiram' } },
  esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
};
vm.createContext(ctx);
vm.runInContext(pop.slice(start, end) + '\nthis.html = stationPopupHtml;', ctx);

test('another station: the call is a QRZ link, with the grid and the QRZ name', () => {
  const h = ctx.html('W1AW', 'FN31');
  assert.ok(/<a href="#" class="jp-popup-qrz" data-call="W1AW"[^>]*>W1AW<\/a>/.test(h), h);
  assert.ok(h.includes('[FN31]') && h.includes('Hiram') && h.includes('jp-popup-qso'));
});
test('my own square: no link, no QSO button', () => {
  const h = ctx.html('K3SBP', 'FN20');
  assert.ok(!h.includes('jp-popup-qrz') && !h.includes('jp-popup-qso') && h.includes('<b style="color:#fff;">K3SBP</b>'));
});
test('the link opens QRZ for the base call', () => {
  assert.ok(/qrzA\.addEventListener\('click'[\s\S]{0,300}openExternal\('https:\/\/www\.qrz\.com\/db\/' \+ encodeURIComponent\(JtcatParser\.baseCall\(c\)\)\)/.test(pop));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
