#!/usr/bin/env node
'use strict';
/**
 * #776: at connect, each ECHOCAT message's push log line names its total size
 * and its five largest fields in KB, so a slow-connect report shows what to
 * trim (auth-ok's settings, expedition-callsigns, directory, ...). Only in the
 * connect window, as the push line was before.
 */
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('lib/payload-field-sizes.js');
let P = null;
try { P = require('../lib/payload-field-sizes'); } catch { /* the checks below fail */ }
check('the module exists', () => assert.ok(P, 'lib/payload-field-sizes.js'));

const big = (n) => 'x'.repeat(n);
const authOk = {
  type: 'auth-ok',
  colorblindMode: false,
  settings: { grid: 'FN20', sstvTemplates: [{ bgDataUrl: big(20000) }], availableEvents: [big(6000)], watchlist: big(3000), kiwiSdrList: [big(2000)], cwMacros: [big(1000)], tiny: 1 },
  cwAvailable: true,
};
check('auth-ok: settings is split one level down, largest first, five at most', () => {
  const top = P.topFieldSizes(authOk);
  assert.deepStrictEqual(top.map((f) => f.field), ['settings.sstvTemplates', 'settings.availableEvents', 'settings.watchlist', 'settings.kiwiSdrList', 'settings.cwMacros']);
  assert.strictEqual(top[0].bytes, Buffer.byteLength(JSON.stringify(authOk.settings.sstvTemplates)));
});
check('an array field is measured whole; type is not a field', () => {
  const top = P.topFieldSizes({ type: 'expedition-callsigns', callsigns: [big(5000), big(5000)], at: 1 }, 5);
  assert.strictEqual(top[0].field, 'callsigns');
  assert.ok(!top.some((f) => f.field === 'type'));
});
check('one line: total in bytes and KB, then the top fields in KB', () => {
  const wire = JSON.stringify(authOk);
  const line = P.formatPushSizeLine('auth-ok', wire.length, authOk);
  assert.ok(/^push msg=auth-ok bytes=\d+ \(\d+\.\dKB\) top: settings\.sstvTemplates=19\.\dKB settings\.availableEvents=5\.\dKB settings\.watchlist=2\.9KB settings\.kiwiSdrList=2\.0KB settings\.cwMacros=1\.0KB$/.test(line), line);
  assert.ok(!/\n/.test(line));
});
check('a small message keeps the short line', () => {
  assert.strictEqual(P.formatPushSizeLine('pong', 20, { type: 'pong', t: 1 }), 'push msg=pong bytes=20 (0.0KB)');
});
check('a value that cannot be serialised counts 0, never throws', () => {
  const cyc = {}; cyc.self = cyc;
  assert.strictEqual(P.jsonBytes(cyc), 0);
  assert.deepStrictEqual(P.topFieldSizes(null), []);
});

console.log('lib/remote-server.js');
const rs = readSrc(path.join(ROOT, 'lib/remote-server.js'));
check('the connect-window push line carries the field sizes (connect only, streams excluded)', () => {
  assert.ok(/if \(now - ws\._connectedAtMs < 2000 && !RemoteServer\.PUSH_LOG_EXCLUDED\.has\(type\)\) \{\n\s+this\.emit\('log', PayloadFieldSizes\.formatPushSizeLine\(type, bytes, obj\)\);/.test(rs));
  assert.ok(!/this\.emit\('log', `push msg=\$\{type\} bytes=\$\{bytes\}`\);/.test(rs), 'the old bare line is gone');
  assert.strictEqual(rs.split('PayloadFieldSizes.formatPushSizeLine(').length, 2, 'one call site');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
