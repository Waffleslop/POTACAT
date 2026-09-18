// Callsign filter for the spot lists (LZ3AW, 2026-09-18).
// Run: node test/call-filter-test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseCallFilter, callMatchesFilter } = require('../lib/call-filter');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (err) { failed++; console.log('  ✗ FAIL: ' + name + '\n      ' + (err.stack || err.message)); }
}
const R = (f) => fs.readFileSync(path.join(__dirname, '..', 'renderer', f), 'utf8').replace(/\r\n/g, '\n');

test('empty filter matches everything', () => {
  assert.deepStrictEqual(parseCallFilter(''), []);
  assert.strictEqual(callMatchesFilter('W1AW', parseCallFilter('  , ; ')), true);
});
test('a token is a prefix; several tokens are OR; case-insensitive; commas, spaces or semicolons separate', () => {
  const f = parseCallFilter('lz, SP9ABC;k3');
  assert.strictEqual(callMatchesFilter('LZ3AW', f), true);
  assert.strictEqual(callMatchesFilter('lz1abc/p', f), true);
  assert.strictEqual(callMatchesFilter('SP9ABC/P', f), true);
  assert.strictEqual(callMatchesFilter('K3SBP', f), true);
  assert.strictEqual(callMatchesFilter('SP9ABD', f), false);
  assert.strictEqual(callMatchesFilter('DL/LZ3AW', f), false, 'prefix, not substring');
});
test('* and ? are wildcards; other regex characters are literal', () => {
  assert.strictEqual(callMatchesFilter('DL/LZ3AW', parseCallFilter('*LZ3AW')), true);
  assert.strictEqual(callMatchesFilter('W1AW', parseCallFilter('W?AW')), true);
  assert.strictEqual(callMatchesFilter('W12AW', parseCallFilter('W?AW')), false);
  assert.strictEqual(callMatchesFilter('K3SBP', parseCallFilter('K3.BP')), false, '. is literal');
  assert.doesNotThrow(() => parseCallFilter('(('));
});

test('desktop: field, script tag, and the check in BOTH filter branches (pinned and general)', () => {
  const html = R('index.html'), app = R('app.js');
  assert.ok(/<script src="\.\.\/lib\/call-filter\.js"><\/script>/.test(html));
  assert.ok(/id="call-filter"/.test(html));
  assert.strictEqual((app.match(/if \(callFilter\.length && !CallFilter\.callMatchesFilter\(s\.callsign, callFilter\)\) return false;/g) || []).length, 2);
  assert.ok(/localStorage\.setItem\('pota-cat-call-filter', callFilterEl\.value\)/.test(app), 'persisted per device');
});
test('web: field, the check in getFilteredSpots, and a VERBATIM copy of the matcher', () => {
  const html = R('remote.html'), web = R('remote.js');
  assert.ok(/id="rc-call-filter"/.test(html));
  assert.ok(/if \(callFilter\.length && !callMatchesFilter\(s\.callsign, callFilter\)\) return false;/.test(web));
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'call-filter.js'), 'utf8').replace(/\r\n/g, '\n');
  const body = (src, name) => { const i = src.indexOf(`function ${name}(`); return src.slice(i, src.indexOf('\n  }\n', i)).replace(/\s+/g, ' '); };
  for (const fn of ['parseCallFilter', 'callMatchesFilter']) assert.strictEqual(body(web, fn), body(lib, fn), fn + ' drifted from lib/call-filter.js');
  assert.ok(/localStorage\.setItem\('echocat-call-filter', callFilterEl\.value\)/.test(web));
});

console.log(`\nCall filter: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
