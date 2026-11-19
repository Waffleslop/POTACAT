#!/usr/bin/env node
'use strict';
// The APRS window's "Listen on my radio" bar (renderer/aprs-listen-bar.js) gets
// its state on first open. On a FLEX-8600M on 2026-11-18 the band chip row was
// empty when the window opened: main's push answered 'aprs-ready', which the
// map script sends before this bar's script has loaded and attached its
// listener, so the push was missed until the next one. The bar now asks for
// the state itself once it listens.
// Run: node test/aprs-listen-bar-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

/** Just enough DOM for the bar: every id exists, children are kept. */
function fakeDom() {
  const els = {};
  const make = (tag) => {
    const cls = new Set();
    const el = {
      tagName: tag, children: [], attrs: {}, listeners: {}, checked: false, title: '', type: '',
      _text: '',
      get textContent() { return this._text; },
      set textContent(v) { this._text = String(v); if (v === '') this.children = []; },
      get className() { return Array.from(cls).join(' '); },
      set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)); },
      classList: {
        add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
        toggle: (c, on) => { if (on === undefined ? !cls.has(c) : on) cls.add(c); else cls.delete(c); },
      },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      appendChild(c) { this.children.push(c); return c; },
      addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    };
    return el;
  };
  return {
    els,
    document: {
      getElementById: (id) => (els[id] = els[id] || make('div')),
      createElement: (tag) => make(tag),
    },
  };
}

function loadBar() {
  const dom = fakeDom();
  const calls = [];
  let onListen = null;
  const api = {
    listenSet: (on) => calls.push(['set', on]),
    listenBand: (b) => calls.push(['band', b]),
    onListen: (cb) => { calls.push(['onListen']); onListen = cb; },
    onIgate: () => {},
    listenGet: () => calls.push(['get']),
  };
  const ctx = { window: { api }, document: dom.document, setInterval: () => 0, Date, Array, String };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'aprs-listen-bar.js'), 'utf8'), ctx);
  return { dom, calls, push: (s) => onListen && onListen(s) };
}

console.log('APRS listen bar');

test('on load the bar asks main for its state, after its listener is attached', () => {
  const { calls } = loadBar();
  const get = calls.findIndex((c) => c[0] === 'get');
  const on = calls.findIndex((c) => c[0] === 'onListen');
  assert.ok(on >= 0, 'listens');
  assert.ok(get > on, 'asks after it listens (asked at ' + get + ', listening at ' + on + ')');
});

test('the answer is drawn: a refusal shows its one sentence', () => {
  const { dom, push } = loadBar();
  push({ on: false, state: 'refused', sentence: 'Connect your radio to listen to APRS.', band: '2m', mhz: '', heard: 0, lastAt: 0, note: '' });
  assert.strictEqual(dom.els['aprs-listen-why'].textContent, 'Connect your radio to listen to APRS.');
  assert.strictEqual(dom.els['aprs-listen-why'].classList.contains('hidden'), false);
});

test('phase 3: the 30 m chip is there from the answer to the first ask (the 8600M\'s empty row)', () => {
  const { dom, calls, push } = loadBar();
  assert.strictEqual(dom.els['aprs-listen-bands'].children.length, 0, 'no chips before main answers');
  assert.ok(calls.some((c) => c[0] === 'get'), 'asked');
  // main's answer for an HF-only rig (FLEX-8600M): one chip, 30 m, selected.
  push({ on: false, state: 'off', sentence: '', band: '30m', bands: ['30m'], modeLabel: 'USB', mhz: '', heard: 0, lastAt: 0, note: '' });
  const chips = dom.els['aprs-listen-bands'].children;
  assert.strictEqual(chips.length, 1);
  assert.strictEqual(chips[0].textContent, '30 m');
  assert.strictEqual(chips[0].attrs['aria-pressed'], 'true');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
