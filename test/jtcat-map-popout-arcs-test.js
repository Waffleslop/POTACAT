#!/usr/bin/env node
'use strict';
// The JTCAT map pop-out draws the QSO arcs the JTCAT window's inline map does
// (TacticalIndex 2026-10-26: the pop-out had no "transmission routes"). It
// never registered our own station, so every arc to or from us returned early.
// Drives the real pop-out script against a fake Leaflet and a fake window.api.
// Run: node test/jtcat-map-popout-arcs-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

function harness() {
  const polylines = [];
  const layer = () => ({ addTo() { return this; }, removeLayer() {} });
  const shape = (kind) => function () {
    const o = { kind, el: { classList: { add() {}, remove() {} }, style: {} },
      addTo() { return o; }, bindTooltip() { return o; }, setTooltipContent() {}, setBounds() {}, setStyle() {},
      setLatLngs() {}, getLatLngs() { return []; }, getElement() { return o.el; } };
    if (kind === 'polyline') polylines.push(o);
    return o;
  };
  const L = {
    map: () => ({ setView() { return this; } }),
    tileLayer: () => ({ addTo() {} }),
    layerGroup: layer,
    rectangle: shape('rect'),
    polyline: shape('polyline'),
  };
  const h = {};
  const api = {
    minimize() {}, maximize() {}, close() {}, onPopoutTheme() {},
    getSettings: () => Promise.resolve({ myCallsign: 'K3SBP', grid: 'FN20jb' }),
    onJtcatDecode: (f) => { h.decode = f; },
    onJtcatQsoState: (f) => { h.qso = f; },
    onJtcatTxStatus: (f) => { h.tx = f; },
  };
  const el = () => ({ addEventListener() {}, style: {}, setAttribute() {}, removeAttribute() {} });
  const sandbox = {
    window: { api, JtcatParser: require('../renderer/jtcat-parser.js') },
    document: { getElementById: el, addEventListener() {}, documentElement: el() },
    L, setTimeout, Date, Promise, console, JtcatParser: require('../renderer/jtcat-parser.js'),
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'jtcat-map-popout.js'), 'utf8'), sandbox);
  return { h, polylines };
}

(async () => {
  console.log('JTCAT map pop-out arcs');
  await test('an arc to the station we are working is drawn', async () => {
    const { h, polylines } = harness();
    await new Promise((r) => setTimeout(r, 0)); // settings → home station
    h.decode({ results: [{ text: 'CQ W1AW FN31' }] });
    h.qso({ phase: 'reply', call: 'W1AW', grid: 'FN31' });
    assert.strictEqual(polylines.length, 1, 'one arc us -> W1AW');
    h.tx({ state: 'tx' });
    assert.strictEqual(polylines.length, 1, 'the same arc is reused, not stacked');
  });
  await test('an arc between two other stations still draws', async () => {
    const { h, polylines } = harness();
    await new Promise((r) => setTimeout(r, 0));
    h.decode({ results: [{ text: 'CQ W1AW FN31' }, { text: 'W1AW N0KAH EN34' }] });
    assert.strictEqual(polylines.length, 1);
  });
  await test('the pop-out loads the shared CQ parser', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'jtcat-map-popout.html'), 'utf8');
    assert.ok(/<script src="jtcat-parser\.js"><\/script>\s*\n\s*<script src="jtcat-map-popout\.js">/.test(html));
  });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
