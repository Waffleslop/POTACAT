'use strict';
// GitHub #680: a band button returns to the radio's last frequency on that band.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { noteDial, jumpTarget, rigKey } = require('../lib/band-last-freq');

let pass = 0;
function t(name, fn) { fn(); pass++; }

t('nothing remembered: the preset', () => {
  assert.strictEqual(jumpTarget({}, 'r1', 14200), 14200);
  assert.strictEqual(jumpTarget(undefined, 'r1', 14200), 14200);
});

t('a dial reading is remembered per band and comes back', () => {
  const s = {};
  assert.strictEqual(noteDial(s, 'r1', 14074000), '20m');
  noteDial(s, 'r1', 14285500);
  noteDial(s, 'r1', 7185000);
  assert.strictEqual(jumpTarget(s, 'r1', 14200), 14285.5);
  assert.strictEqual(jumpTarget(s, 'r1', 7200), 7185);
  assert.strictEqual(jumpTarget(s, 'r1', 21200), 21200, 'a band never visited keeps its preset');
});

t('each rig has its own memory', () => {
  const s = {};
  noteDial(s, 'ftx1', 14250000);
  noteDial(s, 'ic7300', 14030000);
  assert.strictEqual(jumpTarget(s, 'ftx1', 14200), 14250);
  assert.strictEqual(jumpTarget(s, 'ic7300', 14200), 14030);
  assert.strictEqual(jumpTarget(s, 'other', 14200), 14200);
});

t('no rig id: one shared "default" memory', () => {
  const s = {};
  noteDial(s, '', 18100000);
  assert.strictEqual(rigKey(null), 'default');
  assert.strictEqual(jumpTarget(s, undefined, 18120), 18100);
});

t('off-band readings are not remembered', () => {
  const s = {};
  assert.strictEqual(noteDial(s, 'r1', 9500000), null);
  assert.strictEqual(noteDial(s, 'r1', 0), null);
  assert.strictEqual(noteDial(s, 'r1', NaN), null);
  assert.deepStrictEqual(s, {});
});

t('a stored value that is not on the band falls back to the preset', () => {
  const s = { r1: { '20m': 7100, '40m': 'junk' } };
  assert.strictEqual(jumpTarget(s, 'r1', 14200), 14200);
  assert.strictEqual(jumpTarget(s, 'r1', 7200), 7200);
});

t('Hz precision is kept', () => {
  const s = {};
  noteDial(s, 'r1', 3573123);
  assert.strictEqual(jumpTarget(s, 'r1', 3600), 3573.123);
});

// Wiring: both band-button surfaces ask main for the target; main notes every
// dial reading the radio reports.
t('wiring', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.ok(/ipcMain\.handle\('band-jump-target'/.test(main), 'main answers band-jump-target');
  assert.ok(/BandLastFreq\.noteDial\(/.test(main), 'main notes the dial');
  assert.ok(/'bandLastFreq'/.test(main), 'bandLastFreq is a machine-wide setting');
  const vfo = fs.readFileSync(path.join(root, 'renderer', 'vfo-popout.html'), 'utf8');
  assert.ok(/bandJumpTarget\(/.test(vfo), 'VFO band buttons ask for the target');
  const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  assert.ok(/bandJumpTarget\(/.test(app), 'main-window band buttons ask for the target');
  for (const p of ['preload.js', 'preload-vfo-popout.js']) {
    const src = fs.readFileSync(path.join(root, p), 'utf8');
    assert.ok(/bandJumpTarget:\s*\(frequency\)\s*=>\s*ipcRenderer\.invoke\('band-jump-target'/.test(src), p + ' exposes bandJumpTarget');
  }
});

console.log(`band-last-freq-test: ${pass} passed`);
