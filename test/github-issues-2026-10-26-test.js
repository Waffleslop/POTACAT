#!/usr/bin/env node
/* eslint-disable no-console */
'use strict';
//
// GitHub issues reviewed 2026-10-26:
//  #107 FT-450 Test Connection: "FA28074000;" (8 digits) reported as no valid reply.
//  #106 TS-2000 + SignaLink: CAT TX keys the front mic; the interface must key it.
//  #103 FTDX10: Auto held RTS low and a radio with CAT RTS on never answered.
// (#100 Yaesu VS; readback and #102 CI-V 15 11 power meter are in test/rig-test.js.)
//
// Run:  node test/github-issues-2026-10-26-test.js

const fs = require('fs');
const path = require('path');

let pass = 0;
let fail = 0;
const failures = [];
function assert(cond, msg) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(msg);
  console.log(`  ✗ ${msg}`);
}
function section(name) { console.log(`\n=== ${name} ===`); }
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const main = read('main.js');
const html = read('renderer/index.html');
const app = read('renderer/app.js');

section('#107 serial CAT test accepts an 8-digit FA reply');
{
  const m = /const faMatch = \/FA\(\\d\{(\d+),(\d+)\}\);\/\.exec\(buf\)/.exec(main);
  assert(m, 'test-serial-cat matches FA replies with a digit range');
  if (m) {
    const re = new RegExp(`FA(\\d{${m[1]},${m[2]}});`);
    assert(re.test('FA28074000;FA28074000;'), 'FT-450 / FTDX3000 8-digit reply passes');
    assert(re.test('FA014074000;'), '9-digit Yaesu reply passes');
    assert(re.test('FA00014074000;'), '11-digit Kenwood reply passes');
    assert(!re.test('FA1407400;'), 'a 7-digit fragment is not a frequency');
  }
}

section('#106 "The audio interface keys it" on a CAT radio');
{
  const g = main.slice(main.indexOf('function gatedSetTransmit(state)'), main.indexOf('function gatedSetTxPower('));
  const voxAt = g.indexOf("t.ptt === 'vox'");
  const catAt = g.indexOf('cat.setTransmit(state)');
  assert(voxAt > 0 && catAt > voxAt, 'gatedSetTransmit skips CAT TX when the interface keys');
  assert(/t\.type !== 'none'/.test(g), 'the no-CAT radio type keeps its own PTT routes');
  assert(/id="set-serialcat-ptt"/.test(html), 'Serial CAT editor has the Transmit (PTT) choice');
  assert(/set-serialcat-ptt'\) \|\| \{\}\)\.value === 'vox'\) \? \{ ptt: 'vox' \}/.test(app), 'the editor saves ptt:vox on the serial target');
  assert(/savedTarget\.ptt === 'vox' \? 'vox' : 'cat'/.test(app), 'the editor loads it back');
}

section('#103 Auto RTS: a silent Yaesu is tried with RTS/CTS for the session');
{
  assert(/function armSerialHandshakeNoAnswerTrial\(/.test(main), 'trial exists');
  assert(/model\.brand === 'Yaesu'\) armSerialHandshakeNoAnswerTrial\(cat, transport, target, hs\)/.test(main), 'armed on the direct-serial connect for Yaesu on Auto');
  const fn = main.slice(main.indexOf('function armSerialHandshakeNoAnswerTrial('), main.indexOf('async function connectCat()'));
  const saveAt = fn.indexOf("serialHandshake = 'hardware'");
  const onFreq = fn.indexOf("rigCat.once('frequency'");
  assert(onFreq > 0 && saveAt > onFreq && saveAt < fn.indexOf("transport.once('connect'"), 'RTS/CTS is saved only after the radio answered on it');
  assert(/_serialHsTrial\.set\(path, 'done'\)/.test(fn), 'a trial that fails ends, never loops');
  assert(/hs\.source === 'model' && _serialHsTrial\.get\(target\.path\) === 'hardware'/.test(main), 'only Auto (model default) is overridden by the trial — a choice on the rig never is');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('Failures:\n - ' + failures.join('\n - ')); process.exit(1); }
