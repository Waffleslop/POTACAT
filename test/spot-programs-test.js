'use strict';
const { readSrc } = require('./_src');
// An activator spotted on POTA and SOTA at once is one row with
// sources ['pota', 'sota', ...]. The Source column clipped the SOTA pill
// behind the "…" and the Ref column showed only the park, so the table never
// said the contact also counts for SOTA. lib/spot-programs.js decides the
// pills and the Ref text. Run: node test/spot-programs-test.js
const assert = require('assert');
const path = require('path');
const { sourcePills, refDisplay } = require('../lib/spot-programs');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}

const ROOT = path.join(__dirname, '..');
const LABELS = { pota: 'POTA', sota: 'SOTA', wwff: 'WWFF', dxc: 'Cluster', cwspots: 'CW' };

// The row as main.js builds it for IK6BAK/P on IT-0843 + I/UM-069
const potaSota = {
  source: 'pota', sources: ['pota', 'sota', 'dxc'],
  reference: 'IT-0843', sotaReference: 'I/UM-069',
};

test('a POTA + SOTA spot shows both program pills, the feed only in the tooltip', () => {
  const r = sourcePills(potaSota, LABELS);
  assert.deepStrictEqual(r.pills, ['pota', 'sota']);
  assert.strictEqual(r.multiProgram, true);
  assert.strictEqual(r.title, 'Spotted by: POTA, SOTA, Cluster');
});

test('a single-program spot keeps every source pill, as before', () => {
  const r = sourcePills({ source: 'pota', sources: ['pota', 'dxc', 'cwspots'] }, LABELS);
  assert.deepStrictEqual(r.pills, ['pota', 'dxc', 'cwspots']);
  assert.strictEqual(r.multiProgram, false);
});

test('a spot without `sources` falls back to its source, no tooltip', () => {
  const r = sourcePills({ source: 'sota' }, LABELS);
  assert.deepStrictEqual(r.pills, ['sota']);
  assert.strictEqual(r.title, '');
});

test('the Ref column shows the summit next to the park', () => {
  assert.strictEqual(refDisplay(potaSota), 'IT-0843 / I/UM-069');
});

test('POTA + WWFF still reads "park / WWFF ref"', () => {
  assert.strictEqual(refDisplay({ source: 'pota', reference: 'PL-0455', wwffReference: 'SPFF-0123' }), 'PL-0455 / SPFF-0123');
});

test('a SOTA-primary row does not repeat its own summit', () => {
  assert.strictEqual(refDisplay({ source: 'sota', reference: 'I/UM-069', sotaReference: 'I/UM-069', potaReference: 'IT-0843' }), 'I/UM-069 / IT-0843');
});

test('the spot table uses the module and loads it', () => {
  const app = readSrc(path.join(ROOT, 'renderer', 'app.js'));
  assert.ok(/SpotPrograms\.sourcePills\(s, SOURCE_LABELS\)/.test(app), 'Source cell');
  assert.ok(/SpotPrograms\.refDisplay\(s\)/.test(app), 'Ref cell');
  assert.ok(/<script src="\.\.\/lib\/spot-programs\.js"><\/script>/.test(readSrc(path.join(ROOT, 'renderer', 'index.html'))));
  assert.ok(/td\.source-multi-program \{ white-space: normal;/.test(readSrc(path.join(ROOT, 'renderer', 'styles.css'))));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
