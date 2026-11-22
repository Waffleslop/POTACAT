'use strict';
// #394: an SDR wired to a radio's IF output stays on the IF; an antenna or
// RX OUT connection follows the dial exactly as before.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/sdr-scope');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message || e)); }
}

test('defaults: follow the dial, no IF, not mirrored', () => {
  const s = S.normalizeSdrSettings({});
  assert.strictEqual(s.tapMode, 'follow');
  assert.strictEqual(s.ifHz, 0);
  assert.strictEqual(s.invertIf, false);
  assert.strictEqual(S.isFixedIf(s), false);
});

test('follow (antenna, RX OUT, upconverter): same centre as before, every dial', () => {
  for (const offsetHz of [0, 125000000, -5000]) {
    const s = S.normalizeSdrSettings({ offsetHz });
    for (const dial of [0, 7074000, 14074000, 50313000]) {
      assert.strictEqual(S.sdrTuneHz(dial, s), S.sdrCenterForDial(dial, offsetHz), `${dial}+${offsetHz}`);
      assert.strictEqual(S.shareCenterHz(dial, 12345, s), 12345);
    }
  }
});

test('follow: frames pass through untouched (same object)', () => {
  const f = { seq: 1, wf1: Uint8Array.from([1, 2, 3]) };
  assert.strictEqual(S.orientFrame(f, S.normalizeSdrSettings({})), f);
  assert.strictEqual(S.orientFrame(f, S.normalizeSdrSettings({ invertIf: true })), f, 'invert means nothing off a fixed IF');
});

test('fixed IF: the SDR stays on the IF whatever the dial', () => {
  const s = S.normalizeSdrSettings({ tapMode: 'fixedIf', ifHz: 9005000, offsetHz: 125000000 });
  assert.strictEqual(S.isFixedIf(s), true);
  for (const dial of [0, 3573000, 14074000, 28074000]) assert.strictEqual(S.sdrTuneHz(dial, s), 9005000);
  const cmds = S.setupCommands(s, S.sdrTuneHz(14074000, s));
  const freq = cmds.find((b) => b[0] === S.CMD.FREQ);
  assert.strictEqual(freq.readUInt32BE(1), 9005000);
});

test('fixed IF with no IF frequency set falls back to following the dial', () => {
  const s = S.normalizeSdrSettings({ tapMode: 'fixedIf', ifHz: 0 });
  assert.strictEqual(S.isFixedIf(s), false);
  assert.strictEqual(S.sdrTuneHz(7074000, s), 7074000);
});

test('fixed IF, mirrored: bins reversed; not mirrored: untouched', () => {
  const f = { seq: 7, kind: 0, wf1: Uint8Array.from([10, 20, 30, 40]), aligned: true };
  const inv = S.orientFrame(f, S.normalizeSdrSettings({ tapMode: 'fixedIf', ifHz: 455000, invertIf: true }));
  assert.deepStrictEqual(Array.from(inv.wf1), [40, 30, 20, 10]);
  assert.strictEqual(inv.seq, 7);
  assert.deepStrictEqual(Array.from(f.wf1), [10, 20, 30, 40], 'the source frame is not changed');
  const plain = S.orientFrame(f, S.normalizeSdrSettings({ tapMode: 'fixedIf', ifHz: 455000 }));
  assert.strictEqual(plain, f);
});

test('fixed IF: a listener sharing the IQ is given the dial as the centre', () => {
  const s = S.normalizeSdrSettings({ tapMode: 'fixedIf', ifHz: 9005000 });
  // rtltcp-audio offset = target + offsetHz - centre: 1 kHz above the dial -> +1 kHz in the IF.
  assert.strictEqual(14075000 + s.offsetHz - S.shareCenterHz(14074000, 9005000, s), 1000);
});

test('main.js tunes, retunes and shares through the fixed-IF helpers', () => {
  const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(/sdrScopeTunedHz = SdrScope\.sdrTuneHz\(dial, cfg\)/.test(MAIN));
  assert.ok(/SdrScope\.sdrTuneHz\(dialHz, sdrScopeCfg\)/.test(MAIN));
  assert.ok(/SdrScope\.sdrTuneHz\(yaesuScopeState\.centerHz, sdrScopeCfg\)/.test(MAIN));
  assert.ok(/SdrScope\.shareCenterHz\(yaesuScopeState\.centerHz, sdrScopeTunedHz, cfg\)/.test(MAIN));
  assert.ok(!/sdrCenterForDial\(/.test(MAIN), 'no path tunes the SDR around the helpers');
});

test('rig editor: the connection choice, IF frequency and mirror box are saved', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  for (const id of ['set-sdr-scope-tap', 'set-sdr-scope-if', 'set-sdr-scope-invert']) assert.ok(html.includes('id="' + id + '"'), id);
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.ok(/tapMode: el\('set-sdr-scope-tap'\)/.test(app));
  assert.ok(/ifHz: el\('set-sdr-scope-if'\)/.test(app));
  assert.ok(/invertIf: !!\(el\('set-sdr-scope-invert'\)/.test(app));
});

console.log(`\nSDR IF tap: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
