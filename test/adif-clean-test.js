#!/usr/bin/env node
'use strict';
// A NUL in a logged value broke cloud sync for one client, once a minute,
// for a week (cloud log "Push error: unsupported Unicode escape sequence",
// 2,402 times to 2026-10-20): Postgres jsonb refuses \u0000, the whole push
// batch 500s and the journal retries it for ever. lib/adif-clean.js strips
// C0 controls (tab/CR/LF kept) at buildAdifFields AND on the push /
// bulk-upload mapping, so an entry already stuck in a journal is cleaned
// on its next push.
// Run: node test/adif-clean-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { cleanText, cleanAdifFields } = require('../lib/adif-clean');
const { buildAdifFields } = require('../lib/adif-writer');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
console.log('ADIF control-character clean');

test('cleanText strips NUL and the other C0 controls, keeps tab/CR/LF and every printable', () => {
  assert.strictEqual(cleanText('K3S\u0000BP'), 'K3SBP');
  assert.strictEqual(cleanText('a\u0001b\u0007c\u001Fd\u007Fe'), 'abcde');
  assert.strictEqual(cleanText('line1\nline2\r\n\ttab'), 'line1\nline2\r\n\ttab');
  assert.strictEqual(cleanText('Grüße 73 — ÆØÅ 日本'), 'Grüße 73 — ÆØÅ 日本');
  assert.strictEqual(cleanText(null), '');
  assert.strictEqual(cleanText(42), '42');
});

test('cleanAdifFields copies the object, cleans strings only, leaves other types alone', () => {
  const src = { CALL: 'LZ3\u0000AW', COMMENT: 'ok', N: 5, X: null };
  const out = cleanAdifFields(src);
  assert.deepStrictEqual(out, { CALL: 'LZ3AW', COMMENT: 'ok', N: 5, X: null });
  assert.strictEqual(src.CALL, 'LZ3\u0000AW', 'source untouched');
  assert.strictEqual(cleanAdifFields(null), null);
});

test('buildAdifFields never writes a control character, and drops a value that was only controls', () => {
  const f = buildAdifFields({ callsign: 'W1AW', frequency: '14074', mode: 'FT8', qsoDate: '20261020', timeOn: '120000', name: 'Hi\u0000ram', comment: '\u0000' });
  assert.strictEqual(f.NAME, 'Hiram');
  assert.ok(!('COMMENT' in f), 'a value that is only a NUL is omitted, not written empty');
  for (const v of Object.values(f)) assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v), 'no control in ' + v);
});

test('cloud-sync cleans on push and on bulk upload (an already-stuck journal entry heals on its next push)', () => {
  const src = R('lib/cloud-sync.js');
  assert.ok(/adifFields: cleanAdifFields\(c\.adifFields\),/.test(src), 'push mapping');
  assert.ok(/qsos\.slice\(i, i \+ chunkSize\)\.map\(\(q\) => \(q && q\.adifFields \? \{ \.\.\.q, adifFields: cleanAdifFields\(q\.adifFields\) \} : q\)\)/.test(src), 'bulk-upload mapping');
  assert.ok(/require\('\.\/adif-clean'\)/.test(src) && /require\('\.\/adif-clean'\)/.test(R('lib/adif-writer.js')), 'both require the one module');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
