#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// The JTCAT map pop-out must not take RR73 (the FT8 "roger, 73" token, shaped
// like a Maidenhead grid) as a grid: it drew the sender at about 83.5 N, 175 E
// at the end of every QSO (#1029). The in-window map has skipped it since v1.10.0.
// Drives the real pop-out script against a fake Leaflet and a fake window.api.
// Run: node test/jtcat-map-popout-rr73-test.js
const assert = require('assert');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

function harness() {
  const rects = [];
  const layer = () => ({ addTo() { return this; }, removeLayer() {} });
  const shape = (kind) => function () {
    const o = { kind, el: { classList: { add() {}, remove() {} }, style: {} },
      addTo() { return o; }, bindTooltip() { return o; }, setTooltipContent() {}, setBounds() {}, setStyle() {},
      setLatLngs() {}, getLatLngs() { return []; }, getElement() { return o.el; } };
    if (kind === 'rect') rects.push(o);
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
  const parser = require('../renderer/jtcat-parser.js');
  const sandbox = {
    window: { api, JtcatParser: parser },
    document: { getElementById: el, addEventListener() {}, documentElement: el() },
    L, setTimeout, Date, Promise, console, JtcatParser: parser,
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(readSrc(path.join(__dirname, '..', 'renderer', 'jtcat-map-popout.js')), sandbox);
  return { h, rects };
}

(async () => {
  console.log('JTCAT map pop-out RR73');
  await test('a directed message ending RR73 does not place a station', async () => {
    const { h, rects } = harness();
    await new Promise((r) => setTimeout(r, 0));
    const before = rects.length;
    h.decode({ results: [{ text: 'K3SBP W1AW RR73' }] });
    assert.strictEqual(rects.length, before, 'RR73 is not a grid');
  });
  await test('a real grid from a directed message still places a station', async () => {
    const { h, rects } = harness();
    await new Promise((r) => setTimeout(r, 0));
    const before = rects.length;
    h.decode({ results: [{ text: 'K3SBP W1AW FN31' }] });
    assert.strictEqual(rects.length, before + 1);
  });
  await test('RR73 does not move a station already on the map', async () => {
    const { h, rects } = harness();
    await new Promise((r) => setTimeout(r, 0));
    h.decode({ results: [{ text: 'CQ W1AW FN31' }] });
    const box = rects[rects.length - 1];
    let moved = false;
    box.setBounds = () => { moved = true; };
    h.decode({ results: [{ text: 'K3SBP W1AW RR73' }] });
    assert.strictEqual(moved, false);
  });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
