#!/usr/bin/env node
'use strict';
// A false park-to-park on the desktop side (the phone's 82b8724; review of the
// merged 1.13.11 chain, 2026-11-06). A contact logged as General after a POTA
// spot or a POTA contact must not carry that park.
//   1. ECHOCAT Web log sheet: a POTA spot prefilled the hidden program/park,
//      a General chip never cleared them, and the submit fell back to them.
//   2. The desktop's banner log: a type change hid the reference but kept it,
//      and the park went out with no program (main records it as worked).
// Run: node test/log-false-p2p-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const web = read('renderer/remote.js');
const app = read('renderer/app.js');

// The web sheet's own lines, from the typeToSig table to the comment.
function webSubmit({ type, hiddenSig, hiddenRef, typedRef }) {
  const start = web.lastIndexOf('const typeToSig', web.indexOf('const sig = typeToSig[logSelectedType]'));
  const end = web.indexOf('const logSheetComment', start);
  assert.ok(start > 0 && end > start, 'the submit block');
  const ctx = {
    logSelectedType: type, logSig: { value: hiddenSig }, logSigInfo: { value: hiddenRef }, logRefInput: { value: typedRef },
  };
  vm.createContext(ctx);
  vm.runInContext(web.slice(start, end) + '\nthis.out = { sig, sigInfo };', ctx);
  return JSON.parse(JSON.stringify(ctx.out));
}

test('web: General after a POTA spot sends no program and no park', () => {
  assert.deepStrictEqual(webSubmit({ type: 'dx', hiddenSig: 'POTA', hiddenRef: 'US-1234', typedRef: 'US-1234' }), { sig: '', sigInfo: '' });
});

test('web: a typed POTA park still goes out; a program with no chip (WWBOTA spot) keeps the spot\'s own', () => {
  assert.deepStrictEqual(webSubmit({ type: 'pota', hiddenSig: '', hiddenRef: '', typedRef: 'US-1234, US-5678' }), { sig: 'POTA', sigInfo: 'US-1234,US-5678' });
  assert.deepStrictEqual(webSubmit({ type: '', hiddenSig: 'WWBOTA', hiddenRef: 'B/G-2392', typedRef: '' }), { sig: 'WWBOTA', sigInfo: 'B/G-2392' });
});

test('web: a chosen program with its reference cleared does not pick the spot\'s park back up', () => {
  assert.deepStrictEqual(webSubmit({ type: 'sota', hiddenSig: 'POTA', hiddenRef: 'US-1234', typedRef: '' }), { sig: 'SOTA', sigInfo: '' });
});

test('web: picking a type chip clears the spot\'s hidden program and park', () => {
  const h = web.slice(web.indexOf("document.getElementById('log-type-picker').addEventListener('click'"), web.indexOf("document.getElementById('log-type-picker').addEventListener('click'") + 600);
  assert.ok(/logSig\.value = '';\s*logSigInfo\.value = '';\s*selectLogType\(chip\.dataset\.type\);/.test(h));
});

test('desktop banner: a type with no reference empties the reference box', () => {
  const h = app.slice(app.indexOf("blType.addEventListener('change', () => {"), app.indexOf("blType.addEventListener('change', () => {") + 700);
  assert.ok(/blRef\.classList\.toggle\('hidden', !needsRef\);\s*\n(\s*\/\/[^\n]*\n)*\s*if \(!needsRef\) blRef\.value = '';/.test(h));
});

test('desktop banner: a park goes out only with a program', () => {
  assert.ok(/sig, sigInfo: sig \? allRefs\.filter\(Boolean\)\.join\(','\) : '', potaRef,/.test(app));
  assert.ok(!/sig, sigInfo: allRefs\.filter\(Boolean\)\.join\(','\), potaRef,/.test(app));
});

test('the Log QSO pop-out and the spot Log dialog already tie the park to the program', () => {
  const pop = read('renderer/log-popout.js');
  assert.ok(/if \(selectedType !== 'dx' && ref\) \{\s*sig = selectedType\.toUpperCase\(\);\s*sigInfo = ref;/.test(pop));
  assert.ok(/const allRefs = sigInfo \? \[sigInfo, \.\.\.addlParks\]\.join\(','\) : '';/.test(app));
});

console.log(`\nNo false park-to-park on the desktop: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
