#!/usr/bin/env node
'use strict';
// JTCAT re-spots a hunted activator after a logged contact, opt-in only, with
// the same flags the Log QSO window's re-spot box sets.
// Run: node test/jtcat-auto-respot-test.js
const assert = require('assert');
const path = require('path');
const vm = require('vm');
const { readSrc } = require('./_src');

const root = path.join(__dirname, '..');
const main = readSrc(path.join(root, 'main.js'));
const html = readSrc(path.join(root, 'renderer/jtcat-popout.html'));
const pop = readSrc(path.join(root, 'renderer/jtcat-popout.js'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}
function fnBody(src, header) {
  const i = src.indexOf(header);
  assert.ok(i >= 0, 'missing: ' + header);
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error('unbalanced');
}
function run(settings, refs) {
  const logs = [];
  const ctx = { settings, sendCatLog: (m) => logs.push(m) };
  vm.createContext(ctx);
  vm.runInContext(fnBody(main, 'function jtcatApplyAutoRespot(') + '\nthis.f = jtcatApplyAutoRespot;', ctx);
  const q = { callsign: 'DK5UR', hunted: refs.map((r) => ({ ...r })) };
  ctx.f(q, refs);
  return { q, logs };
}

test('off by default: nothing is set, no spot goes out', () => {
  const { q } = run({}, [{ sig: 'POTA', ref: 'DE-1197' }]);
  assert.strictEqual(q.respot, undefined);
});

test('on: POTA re-spot with the POTA template, the POTA ref first (only the first record carries the flags)', () => {
  const { q, logs } = run({ jtcatAutoRespot: true, respotTemplate: '{rst} tnx {mycallsign}' }, [{ sig: 'WWFF', ref: 'DLFF-0123' }, { sig: 'POTA', ref: 'DE-1197' }]);
  assert.strictEqual(q.respot, true);
  assert.strictEqual(q.hunted[0].sig, 'POTA');
  assert.strictEqual(q.wwffRespot, true);
  assert.strictEqual(q.wwffReference, 'DLFF-0123');
  assert.strictEqual(q.respotComment, '{rst} tnx {mycallsign}');
  assert.ok(/Re-spot after the contact: DK5UR @ POTA DE-1197, WWFF DLFF-0123/.test(logs[0]));
});

test('on, but a summit or other program only: nothing (no SOTA re-spot path here)', () => {
  const { q } = run({ jtcatAutoRespot: true }, [{ sig: 'SOTA', ref: 'DM/NS-001' }]);
  assert.strictEqual(q.respot, undefined);
  assert.strictEqual(q.wwffRespot, undefined);
});

test('wired after the hunted-park match; the JTCAT window has the switch', () => {
  assert.ok(/sendCatLog\(`\[JTCAT\] Hunted park matched:[^\n]*\n\s*jtcatApplyAutoRespot\(qsoData, hunted\.refs\);/.test(main));
  assert.ok(/id="jp-auto-respot"/.test(html));
  assert.ok(/window\.api\.saveSettings\(\{ jtcatAutoRespot: autoRespot \}\)/.test(pop));
  assert.ok(/autoRespot = s\.jtcatAutoRespot === true;/.test(pop));
});

console.log(`\nJTCAT auto re-spot: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
