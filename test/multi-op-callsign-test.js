'use strict';
// A comma-separated callsign is one QSO per operator of a multi-op activation
// (W9TEF 2026-10-18: the Log QSO window saved "K1A,K1B,K1C" as ONE callsign,
// which DXKeeper refused; the bottom bar and Log QSO dialog always split it).
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

test('Log QSO window: one save per callsign, own QRZ data, only the first re-spots', () => {
  const js = R('renderer/log-popout.js');
  const i = js.indexOf('async function doSave()');
  const body = js.slice(i, js.indexOf('\n  }\n', i));
  assert.ok(/const calls = built\.data\.callsign\.split\(','\)/.test(body), 'splits');
  assert.ok(/for \(let ci = 0; ci < calls\.length; ci\+\+\)/.test(body), 'loops');
  assert.ok(/if \(ci > 0\) \{\n\s*for \(const k of \['respot'/.test(body), 'later copies never re-spot');
  assert.ok(/window\.api\.callsignInfo\(calls\[ci\], 1\)/.test(body), 'per-call QRZ lookup');
  assert.ok(/result = await window\.api\.saveQso\(data\);/.test(body), 'saves each record');
});

test('saveQsoRecord splits any comma list a caller still sends', () => {
  const main = R('main.js');
  const i = main.indexOf('async function saveQsoRecord(');
  const body = main.slice(i, i + 4000);
  assert.ok(/qsoData\.callsign\.includes\(','\)/.test(body));
  assert.ok(/for \(const k of LogAs\.RESPOT_KEYS\) delete q\[k\];/.test(body), 'later copies never re-spot');
  assert.ok(body.indexOf("includes(',')") < body.indexOf('LogAs.logAsTargets('), 'split by callsign before the per-operator fan-out');
});

test('the other log forms keep splitting (bottom bar, Log QSO dialog, ECHOCAT Web)', () => {
  const app = R('renderer/app.js');
  assert.strictEqual((app.match(/\.split\(','\)\.map\(c => c\.trim\(\)\)\.filter\(Boolean\);/g) || []).length >= 2, true);
  assert.ok(/raw\.split\(','\)\.map\(function \(s\) \{ return s\.trim\(\); \}\)\.filter\(Boolean\)/.test(R('renderer/remote.js')));
});

console.log(`\nMulti-op callsigns: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
