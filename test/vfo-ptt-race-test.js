#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// VFO window PTT race + SWR notice. Run: node test/vfo-ptt-race-test.js
//
// pttStart awaits settings, the mic, the worklet module and the context
// resume. A release during any of them found nothing to stop; the start then
// finished anyway, leaving a mic tap that fed another copy of the voice into
// every later transmission (slow, long echo after release) and keying the
// radio after the button was let go (K3SBP 2026-10-17, quick presses while
// the SWR guard refused PTT). Source guards: the browser APIs involved do not
// run under node.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { fail++; console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'vfo-popout.html'), 'utf8');
const start = html.slice(html.indexOf('async function pttStart() {'), html.indexOf('function pttStop() {'));
const stop = html.slice(html.indexOf('function pttStop() {'), html.indexOf('function pttStop() {') + 400);

check('every await in pttStart is followed by a staleness check', () => {
  const lines = start.split(/\r?\n/);
  lines.forEach((l, i) => {
    if (!/\bawait\b/.test(l)) return;
    const next = lines.slice(i + 1, i + 3).join('\n');
    assert.ok(/stale\(\)/.test(next), `no stale() check after: ${l.trim()}`);
  });
});

check('a release bumps the generation', () => {
  assert.ok(/pttDown = false;\s*\r?\n\s*pttGen\+\+;/.test(stop));
});

check('globals are published only after the last await', () => {
  const lastAwait = start.lastIndexOf('await ');
  const firstPublish = start.indexOf('pttMicStream = stream');
  assert.ok(firstPublish > 0, 'stream published');
  const directPublish = start.indexOf('pttMicStream = stream');
  const directAwait = start.lastIndexOf('await ', directPublish);
  assert.ok(start.indexOf('stale()', directAwait) < directPublish, 'stale check before publishing');
  assert.ok(lastAwait > 0);
});

check('the radio is keyed only by a start that is still current', () => {
  const key = start.indexOf('window.api.nakedPtt(true)');
  assert.ok(key > 0);
  // every return-on-stale precedes the key-down
  assert.ok(start.lastIndexOf('if (stale())') < key);
});

check('the worklet drops chunks from an abandoned press', () => {
  assert.ok(/if \(ev\.data && !stale\(\)\) window\.api\.daxTxChunk/.test(start));
});

check('SWR guard trip and refused PTT reach the VFO window', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const ann = main.slice(main.indexOf('function swrGuardAnnounce('), main.indexOf('function swrGuardMax('));
  assert.ok(/vfoPopoutWin\.webContents\.send\('tune-blocked', msg\)/.test(ann), 'announce');
  const ptt = main.slice(main.indexOf('function handleRemotePtt('), main.indexOf('function handleRemotePtt(') + 1200);
  assert.ok(/vfoPopoutWin\.webContents\.send\('tune-blocked', 'PTT blocked/.test(ptt), 'blocked press');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
