#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// GitHub #199 (w0tlp): a TX power slider in the VFO pop-out window. It is the
// main window's Rig panel TX Pwr slider in a second place: the same caps from
// main (range, step, decimals, power choices, already rescaled by the rig's
// Full power (W) in lib/rig-full-power.js), the same set-tx-power through the
// one rig-control dispatcher (where a Guest Pass cap is enforced), the radio's
// own reported level, hidden where the radio has no txpower capability.
// Run: node test/vfo-tx-power-test.js
const assert = require('assert');
const path = require('path');
const vm = require('vm');
const RigPowerView = require('../lib/rig-power-view');
const { applyFullPower } = require('../lib/rig-full-power');
const { RIG_MODELS } = require('../lib/rig-models');

const root = path.join(__dirname, '..');
const html = readSrc(path.join(root, 'renderer', 'vfo-popout.html'));
const main = readSrc(path.join(root, 'main.js'));
const app = readSrc(path.join(root, 'renderer', 'app.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message || e)); }
}

// The payload main builds (jtcatPopoutRigPowerPayload) from a model's caps.
function payloadFor(model, extra) {
  return Object.assign({
    watts: 0, known: false, settable: true, capable: true,
    minPower: model.minPower != null ? model.minPower : 0,
    maxPower: model.maxPower != null ? model.maxPower : 100,
    powerStep: model.powerStep != null ? model.powerStep : 1,
    powerDecimals: model.powerDecimals != null ? model.powerDecimals : 0,
    powerChoices: Array.isArray(model.powerChoices) ? model.powerChoices : null,
  }, extra || {});
}

console.log('VFO window: TX power (#199) — the view');
test('hidden on a radio without the txpower capability', () => {
  const v = RigPowerView.powerView(payloadFor({}, { capable: false, settable: false, watts: 50, known: true }));
  assert.strictEqual(v.shown, false);
  assert.strictEqual(RigPowerView.powerView(null).shown, false);
});
test('shown but disabled when the radio can only be read', () => {
  const v = RigPowerView.powerView(payloadFor({}, { settable: false, watts: 40, known: true }));
  assert.strictEqual(v.shown, true);
  assert.strictEqual(v.enabled, false);
});
test('range and step are the caps main sends, unchanged', () => {
  const v = RigPowerView.powerView(payloadFor({ minPower: 5, maxPower: 100, powerStep: 1 }));
  assert.deepStrictEqual([v.min, v.max, v.step, v.decimals, v.useSelect], [5, 100, 1, 0, false]);
});
test('Full power (W) scaling reaches the slider through the caps (5 W rig behind a 100 W TS-2000)', () => {
  const model = applyFullPower(RIG_MODELS['TS-2000'], { fullPowerW: 5 });
  const v = RigPowerView.powerView(payloadFor(model, { watts: 2.5, known: true }));
  assert.strictEqual(v.max, 5);
  assert.strictEqual(v.step, 0.1);
  assert.strictEqual(v.decimals, 1);
  assert.strictEqual(v.label, '2.5W');
});
test('a model with a power table gets the select, like the main slider', () => {
  const v = RigPowerView.powerView(payloadFor({ powerChoices: [0.5, 1, 2.5, 5] }, { watts: 2.4, known: true }));
  assert.strictEqual(v.useSelect, true);
  assert.deepStrictEqual(v.choices, [0.5, 1, 2.5, 5]);
  assert.strictEqual(v.selectValue, '2.5', 'nearest choice to the reported level');
});
test('an unreported level shows a dash, never 0 W', () => {
  const v = RigPowerView.powerView(payloadFor({}, { watts: 0, known: false }));
  assert.strictEqual(v.known, false);
  assert.strictEqual(v.label, '—');
});
test('the label is the main window’s rigFormatPower, character for character', () => {
  const m = app.match(/function rigFormatPower\(watts\) \{[\s\S]*?\n\}/);
  assert.ok(m, 'rigFormatPower in app.js');
  for (const [w, d] of [[5, 0], [2.5, 1], [100, 0], [0.1, 1], [37.4, 0]]) {
    const ctx = { rigCurrentCaps: { powerDecimals: d }, Number, Math, parseInt };
    vm.runInNewContext(m[0] + '\nout = rigFormatPower(' + w + ');', ctx);
    assert.strictEqual(RigPowerView.formatWatts(w, d), ctx.out, w + ' W at ' + d + ' decimals');
  }
});

console.log('VFO window: TX power — a drag sends at most a few updates per second');
function fakeClock() {
  let now = 0; const timers = [];
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const t = { at: now + ms, fn, live: true }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.live = false; },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter(t => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at; due.live = false; due.fn();
      }
      now = end;
    },
  };
}
function gapsOk(times) {
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] < 250) return false;
  return true;
}
test('a one-second drag at 50 ms per step sends no more than 4 sets, the last one the final value', () => {
  const clk = fakeClock(); const sent = [], at = [];
  const send = RigPowerView.createPowerSender((w) => { sent.push(w); at.push(clk.now()); }, clk);
  for (let i = 1; i <= 20; i++) { send(i * 5); clk.advance(50); }
  clk.advance(1000);
  assert.ok(sent.length >= 1 && sent.length <= 4, 'sent ' + sent.length + ': ' + sent.join(','));
  assert.ok(gapsOk(at), 'sets ' + at.join(','));
  assert.strictEqual(sent[sent.length - 1], 100);
});
test('a slow drag (150 ms per step) is held to one set per 250 ms, the last one the final value', () => {
  const clk = fakeClock(); const sent = [], at = [];
  const send = RigPowerView.createPowerSender((w) => { sent.push(w); at.push(clk.now()); }, clk);
  for (let i = 1; i <= 20; i++) { send(i); clk.advance(150); } // 3 s
  clk.advance(1000);
  assert.ok(sent.length > 1, 'the radio follows a slow drag');
  assert.ok(gapsOk(at), 'sets ' + at.join(','));
  assert.strictEqual(sent[sent.length - 1], 20);
});
test('a single click sends once, promptly', () => {
  const clk = fakeClock(); const sent = [];
  const send = RigPowerView.createPowerSender((w) => sent.push(w), clk);
  send(25); clk.advance(100);
  assert.deepStrictEqual(sent, [25]);
});

console.log('VFO window: TX power — wiring');
test('main sends the shared power payload in vfo-radio-state', () => {
  const fn = main.slice(main.indexOf('function sendVfoState()'), main.indexOf('function vfoWfmAvailable()'));
  assert.ok(/rigPower: jtcatPopoutRigPowerPayload\(\)/.test(fn), 'rigPower in sendVfoState');
});
test('the payload carries the txpower capability and the model caps (Full power applied in getActiveRigModel)', () => {
  const fn = main.slice(main.indexOf('function jtcatPopoutRigPowerPayload()'), main.indexOf('let _winlinkRigPowerSig'));
  assert.ok(/capable: !!caps\.txpower/.test(fn));
  assert.ok(/maxPower: caps\.maxPower/.test(fn) && /powerChoices:/.test(fn));
  assert.ok(/RigFullPower\.applyFullPower\(_activeRigModelBase\(\), activeRig\)/.test(main));
});
test('set-tx-power still goes through the Guest Pass gates in the dispatcher', () => {
  const c = main.slice(main.indexOf("case 'set-tx-power': {"), main.indexOf("case 'set-filter-width': {"));
  assert.ok(/gatedSmartSdrTxPower\(value\)/.test(c) && /gatedSetTxPower\(value/.test(c));
});
test('the window loads the shared view and has the control', () => {
  assert.ok(/<script src="\.\.\/lib\/rig-power-view\.js"><\/script>/.test(html));
  assert.ok(/id="sec-txpower"/.test(html) && /id="vfo-txpower"/.test(html) && /id="vfo-txpower-select"/.test(html));
});
test('it renders from s.rigPower and writes through rigControl set-tx-power, debounced', () => {
  assert.ok(/s\.rigPower\b[\s\S]{0,80}applyVfoTxPower\(s\.rigPower\)/.test(html));
  assert.ok(/RigPowerView\.powerView\(/.test(html));
  assert.ok(/RigPowerView\.createPowerSender\(\s*\(?w\)?\s*=>\s*window\.api\.rigControl\(\{ action: 'set-tx-power', value: w \}\)/.test(html));
});
test('a readback never yanks the thumb mid-drag', () => {
  assert.ok(/document\.activeElement === vfoTxPwrRange/.test(html));
});
test('the block is in the dial-pane order, after the filter slider', () => {
  // The Large VFO's blocks: names and order in lib/vfo-layout.js, elements in the page.
  const layout = require('fs').readFileSync(path.join(__dirname, '..', 'lib', 'vfo-layout.js'), 'utf8');
  assert.ok(/\{ key: 'filter-slider'[^\n]*\n\s*\{ key: 'txpower',\s+name: 'TX power' \}/.test(layout));
  assert.ok(/txpower: 'sec-txpower'/.test(html));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
