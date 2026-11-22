#!/usr/bin/env node
'use strict';
// ECHOCAT 2026-11-22 (Casey: "fix xit registry"): the registry row for
// set-cw-xit named its field hz, but remote-server and main read msg.value,
// and the phone sends value. Harmless while only hello is validated; wrong
// the day inbound messages are. The row must name the field the code reads.
// Run: node test/set-cw-xit-registry-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('../lib/echocat-protocol');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
let pass = 0, fail = 0;
function test(name, fn) { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }

test('the set-cw-xit row names value, the field remote-server reads', () => {
  const row = (P.MESSAGES || P.messages || {})['set-cw-xit'];
  assert.ok(row, 'set-cw-xit is registered');
  assert.deepStrictEqual(Object.keys(row.fields || {}), ['value']);
  assert.ok(/this\.emit\('set-cw-xit', \{ value: msg\.value \}\)/.test(read('lib/remote-server.js')));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
