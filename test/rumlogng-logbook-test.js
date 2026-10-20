#!/usr/bin/env node
'use strict';
// RUMlogNG in the logbook list (Albert R. Treado, 2026-10-20: a Mac user who
// settled on RUMlogNG). RUMlogNG saves QSOs that arrive as WSJT-X datagrams
// (Preferences > UDP > "Save QSOs to logbook"), the protocol hamrsBridge
// already speaks for HamRS / Logger32 / MacLoggerDX — so the entry is one
// more name on that path, and the ONE list WSJTX_BINARY_LOGGERS keeps the
// three sites (startup start, save-settings restart, forwardToLogbook) agreed.
// Also here: the ECHOCAT Web dropdown must survive a scroll INSIDE itself
// (LZ3AW 2026-10-20: "when you try to scroll, the menu disappears").
// Run: node test/rumlogng-logbook-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('RUMlogNG logbook + web dropdown scroll');

const main = R('main.js'), app = R('renderer/app.js'), html = R('renderer/index.html'), web = R('renderer/remote.js');

test('rig editor lists RUMlogNG', () => {
  assert.ok(/<option value="rumlogng">RUMlogNG<\/option>/.test(html));
});

test('Settings help names the RUMlogNG preference and the port', () => {
  const m = app.match(/rumlogng: \{ port: 2237, help: '([^']+)' \}/);
  assert.ok(m, 'LOGBOOK_DEFAULTS.rumlogng');
  assert.ok(/Preferences > UDP/.test(m[1]) && /Save QSOs to logbook/.test(m[1]), 'the RUMlogNG setting by name');
  assert.ok(/2238/.test(m[1]), 'the port-clash workaround (WSJT-X / GridTracker on 2237)');
});

test('one list of WSJT-X-datagram logbooks, read at all three sites', () => {
  assert.ok(/const WSJTX_BINARY_LOGGERS = new Set\(\['hamrs', 'logger32', 'macloggerdx', 'rumlogng'\]\);/.test(main), 'the list');
  const uses = main.match(/WSJTX_BINARY_LOGGERS\.has\(settings\.logbookType\)/g) || [];
  assert.strictEqual(uses.length, 2, 'startup start + save-settings restart');
  assert.ok(!/new Set\(\['hamrs', 'logger32', 'macloggerdx'\]\)/.test(main), 'no second, shorter copy');
  assert.ok(!/logbookType === 'hamrs' \|\| settings\.logbookType === 'logger32'/.test(main), 'the startup start no longer names two of the four');
});

test('forwardToLogbook sends RUMlogNG over the WSJT-X bridge', () => {
  const fn = main.slice(main.indexOf('function forwardToLogbook('), main.indexOf('function sendUdpAdif('));
  assert.ok(/if \(type === 'macloggerdx' \|\| type === 'rumlogng'\) \{[\s\S]*?return hamrsBridge\.sendQso\(qsoData, adifText\);/.test(fn));
});

test('web dropdown: a scroll inside the open panel does not close it', () => {
  const fn = web.slice(web.indexOf('function openDropdownPanel('), web.indexOf('function initMultiDropdown('));
  assert.ok(/const close = \(e\) => \{\n\s*if \(e && e\.target && e\.target !== window && e\.target !== document && panel\.contains\(e\.target\)\) return;/.test(fn), 'inside-panel scroll ignored');
  assert.ok(/window\.addEventListener\('scroll', close, true\);/.test(fn), 'page/bar scroll still closes it');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
