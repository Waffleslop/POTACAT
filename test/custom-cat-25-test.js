#!/usr/bin/env node
'use strict';
// GitHub #164 (kg6odijohn, nj7n_nate, bmagedanz): up to 25 custom CAT buttons,
// a button may belong to one or more radios, and every surface shows only the
// buttons that are programmed for the radio in use.
//
// - The list is never padded (12 saved come back as 12) and is capped at 25.
// - slot.rigs: an optional list of rig ids. Absent or empty = every radio, so
//   saves from before #164 show everywhere, exactly as they did.
// - One filter, CustomCatFollow.visibleSlots (lib/custom-cat-follow.js, dual
//   mode: the main window, the VFO window and ECHOCAT Web all load it), used
//   by the Rig panel, the VFO window, ECHOCAT Web and the reader.
// Run: node test/custom-cat-25-test.js
const { readSrc } = require('./_src');
const assert = require('assert');
const path = require('path');
const Follow = require('../lib/custom-cat-follow');
const { createCustomCatReader } = require('../lib/custom-cat-read');

let pass = 0, fail = 0;
const pending = [];
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => { pass++; console.log('  ok  ' + name); },
        (e) => { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }));
      return;
    }
    pass++; console.log('  ok  ' + name);
  } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}
const tick = () => new Promise((r) => setImmediate(r));
const src = (...p) => readSrc(path.join(__dirname, '..', ...p));

const btn = (n, extra) => Object.assign({ name: 'B' + n, command: 'CMD' + n + ';' }, extra || {});

// --- the cap and no padding -------------------------------------------------

test('the most is 25', () => {
  assert.strictEqual(Follow.MAX_SLOTS, 25);
});

test('12 saved come back as 12: no padding to five', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => btn(i));
  const out = Follow.capSlots(twelve);
  assert.strictEqual(out.length, 12);
  assert.deepStrictEqual(out, twelve);
  assert.strictEqual(Follow.capSlots([btn(1), btn(2)]).length, 2, 'two stay two');
  assert.deepStrictEqual(Follow.capSlots([]), []);
});

test('more than 25 are cut to the first 25; junk is an empty list', () => {
  const thirty = Array.from({ length: 30 }, (_, i) => btn(i));
  const out = Follow.capSlots(thirty);
  assert.strictEqual(out.length, 25);
  assert.strictEqual(out[24].name, 'B24');
  assert.deepStrictEqual(Follow.capSlots(null), []);
  assert.deepStrictEqual(Follow.capSlots('x'), []);
});

// --- the rigs filter ----------------------------------------------------------

test('rigs absent or empty: All radios, also with no radio active', () => {
  for (const active of ['rig-a', 'rig-b', null, undefined]) {
    assert.strictEqual(Follow.showsForRig(btn(1), active), true, 'absent @ ' + active);
    assert.strictEqual(Follow.showsForRig(btn(1, { rigs: [] }), active), true, 'empty @ ' + active);
  }
});

test('one rig: shows only while that rig is active', () => {
  const b = btn(1, { rigs: ['rig-a'] });
  assert.strictEqual(Follow.showsForRig(b, 'rig-a'), true);
  assert.strictEqual(Follow.showsForRig(b, 'rig-b'), false);
  assert.strictEqual(Follow.showsForRig(b, null), false, 'no radio active: a radio-only button hides');
});

test('several rigs: shows for any of them', () => {
  const b = btn(1, { rigs: ['rig-a', 'rig-c'] });
  assert.strictEqual(Follow.showsForRig(b, 'rig-a'), true);
  assert.strictEqual(Follow.showsForRig(b, 'rig-c'), true);
  assert.strictEqual(Follow.showsForRig(b, 'rig-b'), false);
});

test('unknown ids: a button for a removed radio hides; an unknown active rig shows only All buttons', () => {
  assert.strictEqual(Follow.showsForRig(btn(1, { rigs: ['gone'] }), 'rig-a'), false);
  const list = [btn(0), btn(1, { rigs: ['rig-a'] })];
  assert.deepStrictEqual(Follow.visibleSlots(list, 'nobody-knows').map((v) => v.index), [0]);
  // A malformed rigs field is treated as absent, never as "no radio".
  assert.strictEqual(Follow.showsForRig(btn(1, { rigs: 'rig-a' }), 'rig-b'), true);
});

test('visibleSlots: only programmed buttons for the active rig, original positions kept', () => {
  const list = [
    btn(0),                                // all radios
    { name: '', command: '' },             // empty slot: never shown
    btn(2, { rigs: ['rig-a'] }),
    btn(3, { rigs: ['rig-b'] }),
    btn(4, { rigs: ['rig-a', 'rig-b'] }),
  ];
  assert.deepStrictEqual(Follow.visibleSlots(list, 'rig-a').map((v) => v.index), [0, 2, 4]);
  assert.deepStrictEqual(Follow.visibleSlots(list, 'rig-b').map((v) => v.index), [0, 3, 4]);
  assert.strictEqual(Follow.visibleSlots(list, 'rig-a')[1].slot, list[2], 'the slot itself, not a copy');
  assert.deepStrictEqual(Follow.visibleSlots(null, 'rig-a'), []);
});

test('old saves without rigs show everywhere (nothing changes for anyone)', () => {
  const old = [
    { name: 'TUNE', command: 'AC111;' },
    { name: 'SPLIT', command: 'FT1;', type: 'toggle', commandOff: 'FT0;' },
    { name: 'SQL', command: 'SQ0{v3};', type: 'slider', min: 0, max: 255 },
  ];
  for (const active of ['rig-a', 'rig-b', null]) {
    assert.deepStrictEqual(Follow.visibleSlots(old, active).map((v) => v.index), [0, 1, 2], '@ ' + active);
  }
});

// --- the reader reads only visible buttons ----------------------------------

function readerWith(slots, active) {
  const sent = [];
  let activeRigId = active;
  const r = createCustomCatReader({
    getSlots: () => slots,
    getActiveRigId: () => activeRigId,
    query: (cmd) => { sent.push(cmd); return Promise.resolve('X1;'); },
    isTransmitting: () => false,
    setTimeout: (fn) => { const t = {}; setImmediate(fn); return t; },
    clearTimeout: () => {},
  });
  return { r, sent, setActive: (id) => { activeRigId = id; } };
}
const tgl = (n, read, rigs) => Object.assign(btn(n, { type: 'toggle', commandOff: 'OFF' + n + ';', readCommand: read, onWhen: '2=1' }), rigs ? { rigs } : {});

test('reader: reads only the toggles shown for the active rig', async () => {
  const slots = [tgl(0, 'RA;', ['rig-a']), tgl(1, 'RB;', ['rig-b']), tgl(2, 'RALL;')];
  const h = readerWith(slots, 'rig-a');
  h.r.readAll('connect');
  for (let i = 0; i < 8; i++) await tick();
  assert.deepStrictEqual(h.sent.sort(), ['RA;', 'RALL;']);
  h.setActive('rig-b');
  h.sent.length = 0;
  h.r.reset();
  h.r.readAll('connect');
  for (let i = 0; i < 8; i++) await tick();
  assert.deepStrictEqual(h.sent.sort(), ['RALL;', 'RB;']);
});

test('reader: a press of a hidden button\'s command reads nothing for it', async () => {
  const slots = [tgl(0, 'RA;', ['rig-a']), tgl(1, 'RB;', ['rig-b'])];
  const h = readerWith(slots, 'rig-a');
  assert.strictEqual(h.r.afterPress('CMD1;'), false, 'rig-b toggle is not shown on rig-a');
  assert.strictEqual(h.r.afterPress('CMD0;'), true);
  for (let i = 0; i < 8; i++) await tick();
  assert.deepStrictEqual(h.sent, ['RA;']);
});

test('reader: old saves without rigs are all read, also with no active rig', async () => {
  const slots = [tgl(0, 'R0;'), tgl(1, 'R1;')];
  const h = readerWith(slots, null);
  h.r.readAll('connect');
  for (let i = 0; i < 8; i++) await tick();
  assert.deepStrictEqual(h.sent.sort(), ['R0;', 'R1;']);
});

test('reader: still one read at a time with 25 toggles, none during TX', async () => {
  const slots = Array.from({ length: 25 }, (_, i) => tgl(i, 'R' + i + ';'));
  let inFlight = 0, most = 0, tx = true;
  const resolvers = [];
  const sent = [];
  const r = createCustomCatReader({
    getSlots: () => slots,
    getActiveRigId: () => 'rig-a',
    query: (cmd) => { sent.push(cmd); inFlight++; most = Math.max(most, inFlight); return new Promise((res) => resolvers.push(() => { inFlight--; res('X1;'); })); },
    isTransmitting: () => tx,
  });
  r.readAll('connect');
  await tick();
  assert.strictEqual(sent.length, 0, 'nothing is read while transmitting');
  tx = false;
  r.txEnded();
  for (let n = 0; n < 25; n++) {
    await tick();
    const next = resolvers.shift();
    assert.ok(next, 'read ' + n + ' was sent');
    next();
    for (let i = 0; i < 4; i++) await tick();
  }
  assert.strictEqual(sent.length, 25);
  assert.strictEqual(most, 1, 'one read at a time');
});

// --- wiring -----------------------------------------------------------------

const APP = src('renderer', 'app.js');
const HTML = src('renderer', 'index.html');
const REMOTE = src('renderer', 'remote.js');
const VFO = src('renderer', 'vfo-popout.html');
const MAIN = src('main.js');
const CSS = src('renderer', 'styles.css');

test('no surface pads the list to five any more', () => {
  assert.ok(!/customCatButtons\.length < 5/.test(APP), 'app.js still pads to five');
  assert.ok(!/customCatData\.length < 5/.test(REMOTE), 'remote.js still pads to five');
  assert.ok(!/for \(var i = 0; i < 5; i\+\+\)/.test(REMOTE.slice(REMOTE.indexOf('function renderCustomCatEditor'), REMOTE.indexOf('function renderCustomCatEditor') + 1500)), 'the web editor shows only five rows');
});

test('Rig panel: header with "Custom CAT", the count and an Edit link; view and editor parts', () => {
  const tab = HTML.slice(HTML.indexOf('<div id="rig-tab-custom"'), HTML.indexOf('<div id="rig-tab-presets"'));
  assert.ok(/Custom CAT/.test(tab), 'header title');
  assert.ok(/id="rig-custom-count"/.test(tab), 'count');
  assert.ok(/id="rig-custom-edit"[^>]*>Edit</.test(tab), 'Edit link');
  assert.ok(/id="rig-custom-view"/.test(tab), 'view part');
  assert.ok(/id="rig-custom-editor"[^>]*class="[^"]*hidden/.test(tab), 'editor starts hidden: buttons by default');
  assert.ok(/id="rig-custom-slots"/.test(tab) && /id="rig-custom-add"/.test(tab), 'editor rows and + Add');
});

test('Rig panel: view uses the one filter; Edit becomes Done; count "n / 25"; "+ Add (n of 25)" off at 25', () => {
  assert.ok(/CustomCatFollow\.visibleSlots\(customCatButtons, customActiveRigId\)/.test(APP), 'view filters by the active rig');
  assert.ok(/rigCustomEditLink\.textContent = customCatEditing \? 'Done' : 'Edit'/.test(APP), 'Edit <-> Done');
  assert.ok(/customCatButtons\.length \+ ' \/ ' \+ CustomCatFollow\.MAX_SLOTS/.test(APP), 'n / 25');
  assert.ok(/'\+ Add \(' \+ customCatButtons\.length \+ ' of ' \+ CustomCatFollow\.MAX_SLOTS \+ '\)'/.test(APP), '+ Add (n of 25)');
  assert.ok(/rigCustomAddBtn\.disabled = customCatButtons\.length >= CustomCatFollow\.MAX_SLOTS/.test(APP), 'disabled at 25');
  assert.ok(/if \(customCatButtons\.length >= CustomCatFollow\.MAX_SLOTS\) return;/.test(APP), 'the click handler refuses a 26th');
});

test('Rig panel: toggles light as before; sliders take a row; per-button Radios with All', () => {
  const view = APP.slice(APP.indexOf('function renderCustomView('), APP.indexOf('function renderCustomView(') + 6000);
  assert.ok(/rig-custom-toggle-on/.test(view) && /rig-custom-toggle-unknown/.test(view), 'toggle lit and unknown styles');
  assert.ok(/CustomCatFollow\.toggleView\(/.test(view) && /nextCommand === 'on'/.test(view), 'paint and click from toggleView');
  assert.ok(/rig-custom-vslider/.test(view), 'slider row');
  assert.ok(/\.rig-custom-vslider \{[^}]*grid-column: 1 \/ -1/.test(CSS), 'a slider takes a whole row');
  assert.ok(/\.rig-custom-vbtn\.rig-custom-toggle-on[^{]*\{[^}]*#2a6e4e/.test(CSS) || /\.rig-custom-toggle-on[^{]*\{[^}]*#2a6e4e/.test(CSS), 'same green as today');
  const radios = APP.slice(APP.indexOf('function createRigsChoice('), APP.indexOf('function createRigsChoice(') + 3000);
  assert.ok(radios.length > 100, 'createRigsChoice exists');
  assert.ok(/'All'/.test(radios), 'All is a choice');
  assert.ok(/delete customCatButtons\[i\]\.rigs/.test(radios), 'All removes the field (absent = all)');
  assert.ok(/customCatButtons\[i\]\.rigs = /.test(radios), 'a pick writes rig ids');
  assert.ok(/createRigsChoice\(i\)/.test(APP), 'each editing row has it');
});

test('Rig panel: settings load keeps the saved list (capped), tracks rigs and the active rig', () => {
  const load = APP.slice(APP.indexOf('async function loadPrefs()'), APP.indexOf('async function loadPrefs()') + 12000);
  assert.ok(/customCatButtons = CustomCatFollow\.capSlots\(settings\.customCatButtons\)/.test(load));
  assert.ok(/customActiveRigId = settings\.activeRigId \|\| null/.test(load));
  assert.ok(/customRigChoices = /.test(load));
  assert.ok(/state\.activeRigId !== undefined/.test(APP), 'rig-state carries the active rig to the panel');
});

test('VFO window: the custom row is the visible list for the active rig', () => {
  const build = (VFO.match(/function buildCustomCatBtns\(\) \{[\s\S]*?\n\}/) || [''])[0];
  assert.ok(/CustomCatFollow\.visibleSlots\(customCatButtons, customActiveRigId\)/.test(build), build.slice(0, 400));
  assert.ok(/s\.activeRigId !== undefined/.test(VFO), 'the radio-state push updates the active rig');
});

test('ECHOCAT Web: only programmed buttons for the active radio; editor grows to 25 and keeps rigs', () => {
  const render = REMOTE.slice(REMOTE.indexOf('function renderCustomCatButtons('), REMOTE.indexOf('function renderCustomCatButtons(') + 1500);
  assert.ok(/CustomCatFollow\.visibleSlots\(customCatData, customActiveRigId\)/.test(render), 'web filters by the active rig');
  assert.ok(/customCatSetActiveRig\(activeRigId\)/.test(REMOTE.slice(REMOTE.indexOf('function updateRigSelect('))), 'the rigs message sets the active rig');
  assert.ok(/'\+ Add \(' \+ customCatData\.length \+ ' of ' \+ CUSTOM_MAX \+ '\)'/.test(REMOTE), 'web + Add (n of 25)');
  assert.ok(/hasOwnProperty\.call\(prev, k\)/.test(REMOTE), 'unknown fields such as rigs are kept on save');
});

test('main: reader filters by the active rig; VFO and rig-state carry it; saves and pushes are capped', () => {
  const reader = MAIN.slice(MAIN.indexOf('const customCatReader = createCustomCatReader({'), MAIN.indexOf('const customCatReader = createCustomCatReader({') + 800);
  assert.ok(/getActiveRigId: \(\) => \(settings && settings\.activeRigId\) \|\| null/.test(reader), 'reader knows the active rig');
  const vfoState = MAIN.slice(MAIN.indexOf('function sendVfoState() {'), MAIN.indexOf('function applyFreedvAudioMute('));
  assert.ok(/activeRigId: settings\.activeRigId \|\| null/.test(vfoState), 'VFO state carries activeRigId');
  assert.ok(/customCatButtons: CustomCatFollow\.capSlots\(settings\.customCatButtons\)/.test(vfoState), 'VFO list capped');
  const rigState = MAIN.slice(MAIN.indexOf("if (win && !win.isDestroyed()) win.webContents.send('rig-state', state);") - 6000, MAIN.indexOf("if (win && !win.isDestroyed()) win.webContents.send('rig-state', state);"));
  assert.ok(/activeRigId: settings\.activeRigId \|\| null/.test(rigState), 'main window rig-state carries activeRigId');
  assert.ok(/settings\.customCatButtons = CustomCatFollow\.capSlots\(buttons\);/.test(MAIN), 'a phone save is capped at 25');
  assert.ok(/customCatButtons: settings\.customCatButtons \? CustomCatFollow\.capSlots\(settings\.customCatButtons\) : null/.test(MAIN), 'the push to devices is capped');
});

test('protocol: the rigs field is documented, additive', () => {
  const doc = src('docs', 'echocat-protocol.md');
  const row = doc.split('\n').find((l) => l.startsWith('| `save-custom-cat-buttons`')) || '';
  assert.ok(/`rigs`/.test(row) && /#164/.test(row), row.slice(0, 200));
  assert.ok(/activeRigId/.test(row), 'names the field the filter compares against');
});

Promise.all(pending).then(() => {
  console.log(`\nCustom CAT 25 / per radio (#164): ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
});
