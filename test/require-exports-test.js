#!/usr/bin/env node
'use strict';
// Every name main.js destructures out of a lib module must actually be
// exported by that module.
//
// 1.10.15 (2026-09-09) shipped with main.js doing
//   const { checkClockOffset, syncSystemClock, classifyClockOffset } = require('./lib/ntp');
// against a lib/ntp.js that did not export classifyClockOffset — the main.js
// half of the change was committed and the lib half was never staged. A
// destructured name that does not exist is silently `undefined`, so nothing
// failed at startup; every clock check in the release threw
// "classifyClockOffset is not a function" at the one moment it was asked to
// work. CI never saw it because it runs individual test files, not a launch.
// Run: node test/require-exports-test.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const ENTRY = ['main.js', 'preload.js'];
let checked = 0, fail = 0;

for (const entry of ENTRY) {
  const src = fs.readFileSync(path.join(root, entry), 'utf8');
  const re = /^\s*const \{([^}]*)\} = require\('(\.\/lib\/[^']+)'\);/gm;
  let m;
  while ((m = re.exec(src))) {
    const names = m[1].split(',').map(s => s.trim()).filter(Boolean)
      .map(s => s.split(':')[0].trim()); // `{ a: b }` renames a
    let mod;
    try { mod = require(path.join(root, m[2])); }
    catch (e) {
      // A bare checkout (CI runs these files without npm ci) has no serialport,
      // ws or sql.js; that is not the bug this test is for. Anything else —
      // a syntax error, a missing ./lib sibling — is.
      const missing = e.code === 'MODULE_NOT_FOUND' && /Cannot find module '([^'.][^']*)'/.exec(e.message);
      if (missing) { console.log('  skip ' + m[2] + ' (npm package ' + missing[1] + ' not installed)'); continue; }
      fail++;
      console.log('  FAIL ' + entry + ' requires ' + m[2] + ' which does not load: ' + e.message.split('\n')[0]);
      continue;
    }
    for (const n of names) {
      checked++;
      if (!(n in mod)) {
        fail++;
        console.log('  FAIL ' + entry + ' destructures ' + n + ' from ' + m[2] + ' but the module does not export it');
      }
    }
  }
}

console.log(`\nRequire exports: ${checked} names checked across ${ENTRY.join(', ')}, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
