// SPDX-License-Identifier: Apache-2.0
'use strict';
// TCI rig gating: a Zeus / Thetis rig is wired in through a few gated
// branches in main.js, and no radio that is not TCI takes any of them.
// Receive and control only: every transmit entry point refuses a TCI rig.
// Run: node test/tci-gating-test.js

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { readSrc } = require('./_src');
const RigFamily = require('../lib/rig-family');
const TciRig = require('../lib/tci-rig');
const { resolveSetupNotes, radioTypeFromCatTarget } = require('../lib/rig-setup-notes');

const ROOT = path.join(__dirname, '..');
const MAIN = readSrc(path.join(ROOT, 'main.js'));
const APP = readSrc(path.join(ROOT, 'renderer', 'app.js'));
const HTML = readSrc(path.join(ROOT, 'renderer', 'index.html'));

function fnBody(src, header) {
  const at = src.indexOf(header);
  assert.ok(at !== -1, 'missing: ' + header);
  const open = src.indexOf('{', at + header.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error('unbalanced: ' + header);
}

test('only a tci catTarget is a TCI rig', () => {
  const body = fnBody(MAIN, 'function tciRigTarget() {');
  assert.match(body, /t\.type === 'tci'/);
  assert.match(body, /!settings\.catNone/);
  assert.match(body, /!isRemoteMode\(\)/);
  assert.equal(RigFamily.familyFromCatTarget({ type: 'tci', server: 'zeus' }), 'tci');
  assert.equal(RigFamily.familyFromRadioType('tci'), 'tci');
  for (const t of [{ type: 'tcp', host: '127.0.0.1', port: 5002 }, { type: 'serial' }, { type: 'icom' }, { type: 'rigctldnet' }, { type: 'flrig' }]) {
    assert.notEqual(RigFamily.familyFromCatTarget(t), 'tci');
  }
  assert.equal(radioTypeFromCatTarget({ type: 'tci' }), 'tci');
});

test('a TCI rig never sees a Flex audio option', () => {
  for (const o of RigFamily.audioSourcesFor('tci')) assert.ok(!/DAX|Flex|smartsdr/i.test(o.label + o.value) || o.value === 'dax', o.label);
  assert.ok(!RigFamily.audioSourcesFor('tci').some((o) => o.value === 'smartsdr'));
});

test('the TCI setup note shows for TCI rigs only', () => {
  const tci = resolveSetupNotes({ radioType: 'tci', platform: 'win32' });
  assert.ok(tci.some((n) => n.id === 'tci-server-on'));
  for (const radioType of ['flex', 'serialcat', 'icom', 'hamlib', 'rigctldnet', 'flrig']) {
    assert.ok(!resolveSetupNotes({ radioType, platform: 'win32' }).some((n) => n.id === 'tci-server-on'), radioType);
  }
});

test('main.js: each TCI branch is gated on the TCI rig', () => {
  assert.match(MAIN, /if \(target\.type === 'tci'\) return 'tci';/, 'detectRigType');
  assert.match(fnBody(MAIN, 'function _rigCapabilitiesForType(rigType) {'), /if \(rigType === 'tci'\) return tciRigCaps\(\);/);
  assert.match(MAIN, /if \(rigType === 'tci' && tciRigControl\(data\)\) return;/, 'applyRigControl');
  assert.match(fnBody(MAIN, 'function tuneRadio(freqKhz, mode, brng, { clearXit, origin, purpose } = {}) {'), /if \(tciRigTarget\(\)\) \{ tciRigTune\(freqHz, mode\); return; \}/);
  const connect = fnBody(MAIN, 'async function connectCat() {');
  assert.match(connect, /closeTciRig\(\);/);
  assert.match(connect, /if \(target\.type === 'tci'\) \{[\s\S]*?connectTciRig\(\);\s*return;\s*\}/);
  // The ECHOCAT controls hand a TCI rig to the one dispatcher.
  for (const action of ['set-filter-width', 'set-nb', 'set-rf-gain', 'set-tx-power']) {
    assert.match(MAIN, new RegExp(`if \\(tciRigTarget\\(\\)\\) \\{ applyRigControl\\(\\{ action: '${action}'`), action);
  }
  // Every use of the link outside the TCI block goes through a gate.
  const block = MAIN.slice(MAIN.indexOf('// --- TCI rig: a radio driven'), MAIN.indexOf('// --- TCI (Thetis/ExpertSDR3) panadapter spots ---'));
  const outside = MAIN.replace(block, '');
  for (const line of outside.split('\n')) {
    if (/tciRig\.\w+/.test(line)) assert.ok(/tciRigTarget\(\)/.test(line), 'tciRig used outside the TCI block without a gate: ' + line.trim());
  }
});

test('desktop PTT, Tune and the tuner never key a TCI rig', () => {
  const ptt = fnBody(MAIN, 'function handleRemotePtt(state, opts = {}) {');
  assert.match(ptt, /if \(tciRigTarget\(\)\) return tciRigPtt\(state\);/);
  const tp = fnBody(MAIN, 'function tciRigPtt(state) {');
  assert.match(tp, /if \(!state\) \{ if \(tciRig\) tciRig\.stopAllTx\('PTT released'\); return; \}/, 'a release ends any TCI over');
  assert.match(tp, /return false;\s*\}$/, 'a key-down is refused');
  assert.ok(!/startTx|startVoiceTx/.test(tp));
  // Ahead of every path that keys (only refusals come before it).
  assert.ok(ptt.indexOf('tciRigTarget()') < ptt.indexOf('atuWizardActive()'), 'before anything keys');
  assert.ok(ptt.indexOf('tciRigTarget()') < ptt.indexOf('gatedSetTransmit('), 'before gatedSetTransmit');
  // JTCAT Tune keys through handleRemotePtt, so the refusal stops it
  // (test/refused-key-audio-test.js: a refused key-down plays no tone).
  assert.match(fnBody(MAIN, 'function startJtcatTune(opts = {}) {'), /const keyed = handleRemotePtt\(true,/);
  assert.match(fnBody(MAIN, 'function tciRigControl(data) {'), /case 'atu-tune': case 'power-on': case 'power-off':/);
});

test('the only key-downs are lib/tci-tx.js, called from JTCAT tx-start and ECHOCAT voice', () => {
  const rigSrc = readSrc(path.join(ROOT, 'lib', 'tci-rig.js')).replace(/\/\/.*$/gm, '');
  assert.ok(!/trx:0,true/.test(rigSrc), 'lib/tci-rig.js never writes a key-down itself');
  assert.ok(TciRig.KEYING.test('trx:0,true,tci;'));
  const callers = [...MAIN.matchAll(/tciRig\.(startTx|startVoiceTx)\(/g)].length;
  assert.equal(callers, 2, 'one JTCAT call site and one voice call site');
  assert.match(fnBody(MAIN, 'function tciRigJtcatTx(data, mode) {'), /tciRig\.startTx\(/);
  assert.match(fnBody(MAIN, 'function tciRigVoicePtt(state) {'), /tciRig\.startVoiceTx\(/);
});

test('the rig editors offer TCI with a connection test', () => {
  assert.match(HTML, /name="radio-type" value="tci"/);
  assert.match(HTML, /name="welcome-radio-type" value="tci"/);
  assert.match(HTML, /<script src="\.\.\/lib\/tci-target\.js"><\/script>/);
  for (const id of ['rig-tci-server', 'rig-tci-host', 'rig-tci-port', 'rig-tci-check', 'welcome-tci-check']) assert.match(HTML, new RegExp(`id="${id}"`), id);
  assert.match(APP, /if \(radioType === 'tci'\) return readTciRigTarget\(rigTciFields\);/);
  assert.match(APP, /if \(type === 'tci'\) return readTciRigTarget\(welcomeTciFields\);/);
  assert.match(APP, /window\.api\.probeTciRig\(target\)/);
});
