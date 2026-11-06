#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
/**
 * Rig-editor port pickers (stein_12464, Discord 2026-11-01): the COM port was
 * renumbered COM9 -> COM10; picking COM10 saved COM9 again, because the
 * missing saved port was copied into the "or type COM port" box and a typed
 * port always wins on save. fillPortSelect() keeps a missing port in the
 * list instead, and a list pick clears the box.
 *
 * Runs the REAL function from renderer/app.js against a small fake DOM.
 * Run: node test/port-picker-test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const APP = readSrc(path.join(__dirname, '..', 'renderer', 'app.js'));
function bodyOf(name) {
  const start = APP.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name + ' not found');
  // The body's brace, not a `{}` default parameter: the first ') {' after the name.
  let d = 0, i = APP.indexOf(') {', start) + 2;
  for (; i < APP.length; i++) { if (APP[i] === '{') d++; else if (APP[i] === '}' && --d === 0) break; }
  return APP.slice(start, i + 1);
}

// --- a fake <select> that behaves like the browser for what the code uses ---
function fakeOption() { return { value: '', textContent: '', selected: false, nextSibling: null }; }
function fakeSelect() {
  const sel = {
    options: [], dataset: {}, listeners: {},
    set innerHTML(html) {
      this.options = [];
      const m = /<option value="">([^<]*)<\/option>/.exec(html || '');
      if (m) { const o = fakeOption(); o.textContent = m[1]; this.options.push(o); }
    },
    get firstChild() { return this.options[0] || null; },
    appendChild(o) { this.options.push(o); this._links(); },
    insertBefore(o, ref) {
      const i = ref ? this.options.indexOf(ref) : -1;
      if (i < 0) this.options.push(o); else this.options.splice(i, 0, o);
      this._links();
    },
    _links() { this.options.forEach((o, i) => { o.nextSibling = this.options[i + 1] || null; }); },
    get value() { const s = this.options.find((o) => o.selected) || this.options[0]; return s ? s.value : ''; },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    pick(v) { this.options.forEach((o) => { o.selected = o.value === v; }); (this.listeners.change || []).forEach((f) => f()); },
  };
  return sel;
}
const document = { createElement: () => fakeOption() };
// eslint-disable-next-line no-new-func
const fillPortSelect = new Function('document', bodyOf('fillPortSelect') + '\nreturn fillPortSelect;')(document);
const effective = (manual, select) => manual.value.trim() || select.value;   // the getEffective*Port rule

const PORTS = [{ path: 'COM3', friendlyName: 'Bluetooth' }, { path: 'COM10', friendlyName: 'Silicon Labs CP210x' }];

test('a saved port that is gone stays in the list, selected, and the typed box is empty', () => {
  const sel = fakeSelect(); const manual = { value: 'stale' };
  fillPortSelect(sel, manual, PORTS, 'COM9');
  assert.strictEqual(manual.value, '');
  assert.strictEqual(sel.value, 'COM9');
  assert.ok(/COM9 \(not found/.test(sel.options[0].textContent));
});
test('picking the new port from the list is what gets saved (the reported bug)', () => {
  const sel = fakeSelect(); const manual = { value: '' };
  fillPortSelect(sel, manual, PORTS, 'COM9');
  sel.pick('COM10');
  assert.strictEqual(effective(manual, sel), 'COM10');
});
test('a list pick clears anything typed earlier', () => {
  const sel = fakeSelect(); const manual = { value: '' };
  fillPortSelect(sel, manual, PORTS, 'COM3');
  manual.value = 'COM42';
  sel.pick('COM10');
  assert.strictEqual(effective(manual, sel), 'COM10');
});
test('typing a port after the list still wins (virtual COM ports)', () => {
  const sel = fakeSelect(); const manual = { value: '' };
  fillPortSelect(sel, manual, PORTS, 'COM3');
  manual.value = 'COM42';
  assert.strictEqual(effective(manual, sel), 'COM42');
});
test('a present saved port is selected normally', () => {
  const sel = fakeSelect(); const manual = { value: '' };
  fillPortSelect(sel, manual, PORTS, 'COM10');
  assert.strictEqual(sel.value, 'COM10');
  assert.strictEqual(sel.options.length, 2);
});
test('PTT picker keeps its "none" entry first, and a missing port right after it', () => {
  const sel = fakeSelect(); const manual = { value: '' };
  fillPortSelect(sel, manual, PORTS, 'COM7', { noneLabel: '-- none (PTT via CAT) --' });
  assert.strictEqual(sel.options[0].value, '');
  assert.strictEqual(sel.options[1].value, 'COM7');
  assert.strictEqual(sel.value, 'COM7');
});
test('PTT picker with nothing saved stays on "none"', () => {
  const sel = fakeSelect(); const manual = { value: '' };
  fillPortSelect(sel, manual, PORTS, '', { noneLabel: '-- none (PTT via CAT) --' });
  assert.strictEqual(sel.value, '');
});
test('the change listener is wired once, however often the list is rebuilt', () => {
  const sel = fakeSelect(); const manual = { value: '' };
  fillPortSelect(sel, manual, PORTS, 'COM3');
  fillPortSelect(sel, manual, PORTS, 'COM3');
  assert.strictEqual((sel.listeners.change || []).length, 1);
});
test('all four rig-editor pickers use the helper; no saved port is copied into a typed box', () => {
  for (const call of [
    'fillPortSelect(setRigPort, setRigPortManual,',
    'fillPortSelect(setRigPttPort, setRigPttPortManual,',
    'fillPortSelect(portSelect, portManual,',
    'fillPortSelect(setSerialcatPort, setSerialcatPortManual,',
  ]) assert.ok(APP.includes(call), call);
  assert.ok(!/PortManual\.value = savedTarget\./.test(APP), 'a saved port must not go into the typed box');
  assert.ok(!/portManual\.value = savedTarget\./.test(APP));
});
test('typed-list port fields show the whole list on click', () => {
  assert.ok(/\['set-cw-key-port', 'set-winkeyer-port', 'set-nocat-ptt-port'\]\.forEach\(\(id\) => showWholePortListOnClick/.test(APP));
});

console.log(`\nPort pickers: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
