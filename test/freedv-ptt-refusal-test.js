'use strict';
// FDV1 row 4: POTACAT cannot transmit FreeDV yet, so a voice key-down while a
// FreeDV mode runs is refused from every surface, with one plain sentence.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { freedvPttRefusal, FREEDV_PTT_REFUSAL } = require('../lib/freedv-ptt');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ok', name); }

t('voice key-down in a FreeDV mode is refused', () => {
  assert.strictEqual(freedvPttRefusal({ state: true, freedvRunning: true }), FREEDV_PTT_REFUSAL);
});
t('a release always passes', () => {
  assert.strictEqual(freedvPttRefusal({ state: false, freedvRunning: true }), null);
});
t('no FreeDV running: voice passes', () => {
  assert.strictEqual(freedvPttRefusal({ state: true, freedvRunning: false }), null);
});
t('a key-down that names its emission (FT8, SSTV, Winlink, tune) passes', () => {
  for (const emission of ['DATA', 'SSTV']) {
    assert.strictEqual(freedvPttRefusal({ state: true, freedvRunning: true, emission }), null);
  }
  assert.strictEqual(freedvPttRefusal({ state: true, freedvRunning: true, forceDataMode: true }), null);
});
t('the sentence is plain and names what to do', () => {
  assert.ok(/FreeDV transmit/.test(FREEDV_PTT_REFUSAL));
  assert.ok(/SSB/.test(FREEDV_PTT_REFUSAL));
});

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const start = main.indexOf('function handleRemotePtt(state, opts = {}) {');
const body = main.slice(start, start + 12000);

t('the one PTT dispatcher asks the FreeDV rule before any radio path', () => {
  assert.ok(start > 0, 'handleRemotePtt found');
  const rule = body.indexOf('FreedvPtt.freedvPttRefusal(');
  assert.ok(rule > 0, 'handleRemotePtt calls freedvPttRefusal');
  for (const later of ['tciRigTarget()', 'const target = settings.catTarget;']) {
    const at = body.indexOf(later);
    assert.ok(at > rule, `${later} comes after the FreeDV refusal`);
  }
  // Remote mode keys the shack, which applies its own refusal.
  assert.ok(body.indexOf('if (isRemoteMode())') < rule);
});
t('the refusal is said on the VFO window, the main window and to ECHOCAT clients', () => {
  const rule = body.indexOf('FreedvPtt.freedvPttRefusal(');
  const block = body.slice(rule, body.indexOf('return false;', rule));
  assert.ok(block.includes("vfoPopoutWin.webContents.send('tune-blocked', freedvWhy)"));
  assert.ok(block.includes("'app-notice'"));
  assert.ok(block.includes("type: 'tune-blocked', reason: freedvWhy"));
  assert.ok(block.includes("type: 'ptt-refused', kind: 'freedv', message: freedvWhy"));
});

const proto = require('../lib/echocat-protocol');
t('ptt-refused: by optional, kind optional (agreed with ECHOCAT 2026-11-16)', () => {
  const table = proto.MESSAGES;
  const row = table['ptt-refused'];
  assert.ok(row, 'ptt-refused row present');
  assert.strictEqual(row.fields.by.required, false);
  assert.strictEqual(row.fields.kind.required, false);
  assert.notStrictEqual(row.fields.message.required, false);
});

const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
t('the FreeDV setting no longer claims PTT encodes FreeDV', () => {
  assert.ok(!html.includes('PTT encodes FreeDV'));
  assert.ok(html.includes('Transmit is coming in a later update'));
});

console.log(`freedv-ptt-refusal-test: ${passed} passed`);
