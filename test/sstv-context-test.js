#!/usr/bin/env node
'use strict';
// The SSTV window's template context ({MYCALL} {GRID} {PARK} {NAME} {RIG},
// the typed call) comes from main's sstv-context handler, which called the
// RENDERER's primaryParkRef()/primaryParkName(): a ReferenceError on every
// request since 1.11.0, so the window never got any of it. Found 2026-10-21
// in a two-instance desktop-to-desktop run.
// Run: node test/sstv-context-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const at = main.indexOf("ipcMain.handle('sstv-context', () => {");
assert.ok(at > 0, 'handler found');
const body = main.slice(at, main.indexOf('\n  });\n', at)).replace(/\/\/.*$/gm, '');
const called = [...new Set([...body.matchAll(/(?<![.\w])([a-zA-Z_]\w*)\(\)/g)].map(m => m[1]))];
for (const fn of called) {
  const defined = main.includes('function ' + fn + '(') || new RegExp('\\b(const|let|var) ' + fn + '\\s*=').test(main);
  assert.ok(defined, `sstv-context calls ${fn}(), which main.js must define`);
}
assert.ok(/park: \(\(settings\.activatorParkRefs \|\| \[\]\)\[0\] \|\| \{\}\)\.ref \|\| ''/.test(body));
console.log('SSTV context: 1 passed, 0 failed');
