#!/usr/bin/env node
'use strict';
// LZ3AW 2026-10-01: "extra dot and sometimes extra dash", heard in his OWN
// browser sidetone, the same in iambic A and B. A paddle contact that
// bounces as it closes (down, up, down within a few ms) pressed again while
// its own element was sounding, which latched one more of the same element.
// Both keyers, run for real with real timers: the ECHOCAT web keyer
// (renderer/remote.js) and the desktop IambicKeyer (lib/keyer.js).
// Run: node test/paddle-bounce-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { IambicKeyer } = require('../lib/keyer');

const web = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'remote.js'), 'utf8');
const webSrc = web.slice(web.indexOf('  function createLocalCwKeyer(onKey) {'), web.indexOf('  // Phone-side sidetone is driven by the local keyer'));
// eslint-disable-next-line no-new-func
const createWebKeyer = new Function(webSrc + '; return createLocalCwKeyer;')();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WPM = 20; // 60 ms dot, 180 ms dash

function webKeyer(mode) {
  const els = [];
  const k = createWebKeyer((down, ms) => { if (down) els.push(ms < 120 ? '.' : '-'); });
  k.setWpm(WPM); k.setMode(mode);
  return { els, dit: (p) => k.paddleDit(p), dah: (p) => k.paddleDah(p), stop: () => k.stop() };
}
function deskKeyer(mode) {
  const els = [];
  const k = new IambicKeyer();
  k.setWpm(WPM); k.setMode(mode);
  let downAt = 0;
  k.on('key', (e) => {
    if (e.down) downAt = Date.now();
    else if (downAt) { els.push(Date.now() - downAt < 120 ? '.' : '-'); downAt = 0; }
  });
  return { els, dit: (p) => k.paddleDit(p), dah: (p) => k.paddleDah(p), stop: () => k.stop() };
}

// [delay before step ms, contact, pressed]
async function play(make, mode, steps) {
  const k = make(mode);
  for (const [wait, contact, pressed] of steps) { await sleep(wait); k[contact](pressed); }
  await sleep(500);
  k.stop();
  return k.els.join('');
}

const CASES = [
  ['one dot tap', '.', [[0, 'dit', true], [40, 'dit', false]]],
  ['one dot tap whose contact bounces on press', '.', [[0, 'dit', true], [3, 'dit', false], [2, 'dit', true], [35, 'dit', false]]],
  ['one dash tap whose contact bounces on press', '-', [[0, 'dah', true], [3, 'dah', false], [2, 'dah', true], [120, 'dah', false]]],
  ['one dot tap whose contact bounces on release', '.', [[0, 'dit', true], [40, 'dit', false], [3, 'dit', true], [2, 'dit', false]]],
  ['two quick dot taps are still "I"', '..', [[0, 'dit', true], [40, 'dit', false], [60, 'dit', true], [40, 'dit', false]]],
  ['a held dot repeats ("S" and more)', '...', [[0, 'dit', true], [290, 'dit', false]]],
  ['dash then dot paddle during it is still "N"', '-.', [[0, 'dah', true], [100, 'dit', true], [10, 'dah', false], [30, 'dit', false]]],
];

const cases = [];
for (const [kname, make] of [['web keyer', webKeyer], ['desktop keyer', deskKeyer]]) {
  for (const mode of ['iambicA', 'iambicB']) {
    for (const [name, want, steps] of CASES) {
      cases.push([`${kname} ${mode}: ${name}`, async () => {
        assert.strictEqual(await play(make, mode, steps), want);
      }]);
    }
  }
}

(async () => {
  let passed = 0, failed = 0;
  console.log('Paddle contact bounce');
  for (const [name, fn] of cases) {
    try { await fn(); passed++; console.log('  ok  ' + name); }
    catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + e.message.split('\n')[0]); }
  }
  console.log(`\nPaddle contact bounce: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
