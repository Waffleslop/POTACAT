#!/usr/bin/env node
'use strict';
// #359: the SSTV window's frequency box.
//  - the radio's frequency poll does not overwrite the box while the operator
//    is typing in it, or for a while after he typed without tuning (on 2 m and
//    70 cm, off the channel list, every poll overwrote it)
//  - it takes kHz or MHz: 437.550 is 437.550 MHz, not 437.55 kHz
//  - 2 m and up tunes in FM, not USB; HF keeps the voice-sideband rule
// Run: node test/sstv-freq-box-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const F = require('../lib/sstv-freq');

const ROOT = path.join(__dirname, '..');
const R = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

test('kHz or MHz: a number under 1000 is MHz', () => {
  const cases = [
    ['14230', 14230], ['14.230', 14230], ['14.23', 14230], ['7171', 7171], ['7.171', 7171],
    ['145.800', 145800], ['145.8', 145800], ['145800', 145800], ['437.550', 437550], ['437550', 437550],
    ['3845', 3845], ['3.845', 3845], ['28680', 28680], ['50.680', 50680], ['1810', 1810], ['1.810', 1810],
    ['  145.800  ', 145800], ['145,800', 145800], ['14230.5', 14230.5],
  ];
  for (const [text, want] of cases) assert.strictEqual(F.parseFreqKhz(text), want, JSON.stringify(text));
});

test('a unit typed after the number decides', () => {
  assert.strictEqual(F.parseFreqKhz('437.550 MHz'), 437550);
  assert.strictEqual(F.parseFreqKhz('437.550MHz'), 437550);
  assert.strictEqual(F.parseFreqKhz('145.8 mhz'), 145800);
  assert.strictEqual(F.parseFreqKhz('7171 kHz'), 7171);
  assert.strictEqual(F.parseFreqKhz('14230khz'), 14230);
  assert.strictEqual(F.parseFreqKhz('1.5 MHz'), 1500);
});

test('not a frequency: null', () => {
  for (const t of ['', '   ', 'abc', '14230x', '-14230', '0', '0.0', '14.2.3', 'MHz', '999 kHz', '2000 MHz', null, undefined]) {
    assert.strictEqual(F.parseFreqKhz(t), null, JSON.stringify(t));
  }
});

test('FM from 2 m up; below, the voice sideband (60 m USB, 6 m USB)', () => {
  const cases = [
    [3845, 'LSB'], [5357, 'USB'], [7171, 'LSB'], [14230, 'USB'], [21340, 'USB'], [28680, 'USB'],
    [50680, 'USB'], [143999, 'USB'], [144000, 'FM'], [145800, 'FM'], [145500, 'FM'], [437550, 'FM'], [1296000, 'FM'],
  ];
  for (const [khz, want] of cases) {
    assert.strictEqual(F.modeForKhz(khz), want, khz + ' kHz');
    assert.strictEqual(F.modeForKhz(String(khz)), want, khz + ' kHz as text');
  }
});

test('the radio may write the box only when the operator is not in it', () => {
  const now = 1_000_000;
  assert.strictEqual(F.radioMayWriteBox({ focused: false, editedAtMs: 0, nowMs: now }), true, 'nobody there');
  assert.strictEqual(F.radioMayWriteBox({ focused: true, editedAtMs: 0, nowMs: now }), false, 'the box has the keyboard');
  assert.strictEqual(F.radioMayWriteBox({ focused: true, editedAtMs: now - 60000, nowMs: now }), false, 'focused, however long ago he typed');
  assert.strictEqual(F.radioMayWriteBox({ focused: false, editedAtMs: now - 1000, nowMs: now }), false, 'typed a second ago and clicked away');
  assert.strictEqual(F.radioMayWriteBox({ focused: false, editedAtMs: now - F.EDIT_HOLD_MS + 1, nowMs: now }), false, 'just inside the hold');
  assert.strictEqual(F.radioMayWriteBox({ focused: false, editedAtMs: now - F.EDIT_HOLD_MS, nowMs: now }), true, 'the hold is over');
  assert.strictEqual(F.radioMayWriteBox(), true, 'no state: the radio follows');
});

// The SSTV window, driven: the box, the radio's poll, Enter and Tune.
function loadWindow() {
  const js = R('renderer/sstv-popout.js');
  const cut = (startMark, endMark) => {
    const i = js.indexOf(startMark); assert.ok(i >= 0, 'missing: ' + startMark);
    const j = js.indexOf(endMark, i); assert.ok(j > i, 'missing: ' + endMark);
    return js.slice(i, j);
  };
  const radioSync = cut('// --- Radio frequency sync ---', '// --- Theme ---');
  const selector = cut('// --- Frequency selector ---', '// --- Text Layer Editor ---');
  const listeners = (el) => { el._l = {}; el.addEventListener = (t, f) => { (el._l[t] = el._l[t] || []).push(f); }; el.fire = (t, ev) => (el._l[t] || []).forEach((f) => f(ev || {})); return el; };
  const freqInput = listeners({ value: '', id: 'freq-input' });
  const tuneBtn = listeners({ id: 'tune-btn' });
  const options = [{ value: '14230', dataset: { mode: 'USB' } }, { value: '7171', dataset: { mode: 'LSB' } }];
  const freqSelect = listeners({ options, selectedIndex: 0, get value() { return options[this.selectedIndex].value; }, querySelectorAll: () => [] });
  const document = {
    activeElement: null,
    getElementById: (id) => ({ 'freq-select': freqSelect, 'freq-input': freqInput, 'tune-btn': tuneBtn }[id]),
  };
  const tunes = [];
  let catCb = null;
  const statusBar = { textContent: '' };
  const window = {
    SsbSideband: require('../lib/ssb-sideband'),
    SstvFreq: F,
    api: { onCatFrequency: (cb) => { catCb = cb; }, tune: (f, m) => tunes.push([String(f), m]) },
  };
  const FreqDots = require('../lib/freq-dots');
  const clock = { now: 5_000_000 };
  const DateStub = { now: () => clock.now };
  new Function('window', 'document', 'statusBar', 'FreqDots', 'Date', 'sstvRigBands',
    radioSync + selector)(window, document, statusBar, FreqDots, DateStub, null);
  return { freqInput, tuneBtn, freqSelect, document, tunes, statusBar, clock, poll: (hz) => catCb(hz) };
}

test('window: a radio poll off the channel list does not overwrite what is being typed', () => {
  const w = loadWindow();
  w.poll(145800000);
  assert.strictEqual(String(w.freqInput.value), '145800', 'idle: the box follows the radio');
  w.document.activeElement = w.freqInput;
  w.freqInput.value = '437.5'; w.freqInput.fire('input');
  w.clock.now += 300;
  w.poll(145800000);
  assert.strictEqual(w.freqInput.value, '437.5', 'typing: the poll leaves it alone');
  w.freqInput.value = '437.550'; w.freqInput.fire('input');
  w.clock.now += 60000;
  w.poll(145800000);
  assert.strictEqual(w.freqInput.value, '437.550', 'still in the box a minute later');
  w.freqInput.fire('keydown', { key: 'Enter' });
  assert.deepStrictEqual(w.tunes.at(-1), ['437550', 'FM'], '437.550 typed as MHz tunes 437.550 MHz in FM');
  assert.match(w.statusBar.textContent, /437\.550\.00 MHz FM/);
});

test('window: typed then clicked away keeps the edit for a while, then follows the radio again', () => {
  const w = loadWindow();
  w.document.activeElement = w.freqInput;
  w.freqInput.value = '145.8'; w.freqInput.fire('input');
  w.document.activeElement = null;   // clicked elsewhere without tuning
  w.clock.now += 2000;
  w.poll(432100000);
  assert.strictEqual(w.freqInput.value, '145.8', 'an untuned edit is kept');
  w.clock.now += F.EDIT_HOLD_MS;
  w.poll(432100000);
  assert.strictEqual(String(w.freqInput.value), '432100', 'left alone long enough: the radio wins again');
});

test('window: after a tune the box follows the radio again at once', () => {
  const w = loadWindow();
  w.freqInput.value = '145.800'; w.freqInput.fire('input');
  w.tuneBtn.fire('click');
  assert.deepStrictEqual(w.tunes.at(-1), ['145800', 'FM'], 'Tune: 145.800 MHz FM, not USB');
  w.poll(145810000);
  assert.strictEqual(String(w.freqInput.value), '145810');
});

test('window: kHz still works; HF keeps its sideband; nonsense is refused with a line', () => {
  const w = loadWindow();
  w.freqInput.value = '7171'; w.freqInput.fire('keydown', { key: 'Enter' });
  assert.deepStrictEqual(w.tunes.at(-1), ['7171', 'LSB']);
  w.freqInput.value = '14.230'; w.freqInput.fire('keydown', { key: 'Enter' });
  assert.deepStrictEqual(w.tunes.at(-1), ['14230', 'USB']);
  const n = w.tunes.length;
  w.freqInput.value = '14.2.30'; w.freqInput.fire('keydown', { key: 'Enter' });
  assert.strictEqual(w.tunes.length, n, 'not tuned');
  assert.match(w.statusBar.textContent, /kHz or MHz/);
});

test('window: a poll on a listed channel picks it in the list and leaves the box alone', () => {
  const w = loadWindow();
  w.freqSelect.selectedIndex = 0;
  w.document.activeElement = w.freqInput;
  w.freqInput.value = '43'; w.freqInput.fire('input');
  w.poll(7171000);
  assert.strictEqual(w.freqSelect.selectedIndex, 1);
  assert.strictEqual(w.freqInput.value, '43');
});

test('the SSTV window loads lib/sstv-freq.js after lib/ssb-sideband.js, and says kHz or MHz', () => {
  const html = R('renderer/sstv-popout.html');
  const a = html.indexOf('<script src="../lib/ssb-sideband.js">');
  const b = html.indexOf('<script src="../lib/sstv-freq.js">');
  const c = html.indexOf('<script src="sstv-popout.js">');
  assert.ok(a > 0 && b > a && c > b, 'script order');
  assert.ok(/id="freq-input"[^>]*placeholder="kHz or MHz"/.test(html));
});

test('the top bar lights no HF band button on 2 m or 70 cm', () => {
  const js = R('renderer/sstv-popout.js');
  const line = js.split('\n').find((l) => /^const BAND_OF = /.test(l));
  assert.ok(line, 'BAND_OF');
  const BAND_OF = new Function(line.replace(/^const BAND_OF = /, 'return ').replace(/;\s*(\/\/.*)?$/, ''))();
  assert.strictEqual(BAND_OF(50680), '6');
  assert.strictEqual(BAND_OF(14230), '20');
  assert.strictEqual(BAND_OF(145800), '');
  assert.strictEqual(BAND_OF(437550), '');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
