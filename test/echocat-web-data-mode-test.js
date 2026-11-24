#!/usr/bin/env node
'use strict';
// ECHOCAT Web's mode picker offers the radio's data sub-modes, DIGU and DIGL,
// as the ECHOCAT app does (a Xiegu G90 operator could pick DIGU on the phone
// but not in ECHOCAT Web). Same labels, same wire message as the app:
// {type:'set-mode', mode:'DIGU'|'DIGL'}. Shown only when the shack's
// capabilities.dataModes lists them (lib/data-mode-picker.js decides per rig).
// Run: node test/echocat-web-data-mode-test.js
const assert = require('assert');
const path = require('path');
const { readSrc } = require('./_src');
const DataModePicker = require('../lib/data-mode-picker');
const { RIG_MODELS } = require('../lib/rig-models');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { CivCodec } = require('../lib/codecs/civ-codec');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { normalizeRadioMode } = require('../lib/codecs/flrig-codec');

let passed = 0;
function t(name, fn) { fn(); passed++; console.log('  ok', name); }
const read = (p) => readSrc(path.join(__dirname, '..', p));
const html = read('renderer/remote.html');
const js = read('renderer/remote.js');
const main = read('main.js');

const BOTH = ['DIGU', 'DIGL'];
const HZ = 14074000;

// What getRigCapabilities feeds dataModesFor for a live Kenwood-protocol codec.
function kenwoodInput(rigType, model) {
  const codec = new KenwoodCodec(model, () => {});
  return { rigType, protocol: model.protocol, resolve: (m) => codec.resolveMode(m, HZ), hasDaCmd: !!codec._cmds.setDa };
}

console.log('ECHOCAT Web data modes');

// --- The buttons ---
t('remote.html has DIGU and DIGL picker buttons, hidden until caps say so', () => {
  for (const m of BOTH) {
    const re = new RegExp(`<button class="mp-btn hidden" data-mode="${m}" data-data-mode>${m}</button>`);
    assert.ok(re.test(html), `missing hidden ${m} button`);
  }
  // Next to USB/LSB, as the app's picker has them with the sidebands.
  assert.ok(html.indexOf('data-mode="LSB"') < html.indexOf('data-mode="DIGU"'));
  assert.ok(html.indexOf('data-mode="DIGL"') < html.indexOf('data-mode="CW"'));
});
t('pickerModes: nothing without caps, only DIGU/DIGL from caps.dataModes', () => {
  assert.deepStrictEqual(DataModePicker.pickerModes(undefined), []);
  assert.deepStrictEqual(DataModePicker.pickerModes({}), []);
  assert.deepStrictEqual(DataModePicker.pickerModes({ dataModes: [] }), []);
  assert.deepStrictEqual(DataModePicker.pickerModes({ dataModes: 'DIGU' }), []);
  assert.deepStrictEqual(DataModePicker.pickerModes({ dataModes: ['DIGU', 'DIGL'] }), BOTH);
  assert.deepStrictEqual(DataModePicker.pickerModes({ dataModes: ['DIGU', 'PKTFM'] }), ['DIGU']);
});
t('remote.js shows the data buttons from capabilities, hides them otherwise', () => {
  assert.ok(/DataModePicker\.pickerModes\(s\.capabilities\)/.test(js), 'capabilities handler must call pickerModes');
  assert.ok(/\.mp-btn\[data-data-mode\]/.test(js), 'must toggle the data-data-mode buttons');
});
t('a data button sends the app\'s message: set-mode with the mode string', () => {
  // The one send in the picker handler, unchanged: the button's data-mode.
  assert.ok(/ws\.send\(JSON\.stringify\(\{ type: 'set-mode', mode: newMode \}\)\)/.test(js));
  assert.ok(/const newMode = btn\.dataset\.mode;/.test(js));
});

// --- Which radios get them ---
t('G90 over rigctld (Hamlib 3088): DIGU and DIGL', () => {
  const g90 = RIG_MODELS.G90;
  assert.deepStrictEqual(DataModePicker.dataModesFor({ rigType: 'rigctld', protocol: g90.protocol }), BOTH);
});
t('Icom CI-V: both, none once the radio has refused the DATA flag', () => {
  assert.deepStrictEqual(DataModePicker.dataModesFor({ rigType: 'icom', protocol: 'civ' }), BOTH);
  assert.deepStrictEqual(DataModePicker.dataModesFor({ rigType: 'icom', protocol: 'civ', dataFlagUnsupported: true }), []);
});
t('Flex, TCI, DXLab Commander: both', () => {
  for (const rigType of ['flex', 'tci', 'commander']) {
    assert.deepStrictEqual(DataModePicker.dataModesFor({ rigType }), BOTH, rigType);
  }
});
t('Yaesu FT-710 / FT-891 / FT-991A (MD0C / MD08): both', () => {
  for (const name of ['FT-710', 'FT-891', 'FT-991/991A']) {
    assert.deepStrictEqual(DataModePicker.dataModesFor(kenwoodInput('yaesu', RIG_MODELS[name])), BOTH, name);
  }
});
t('Kenwood TS-590 (MD + DA1), TS-890 (OM D/C), Elecraft K3: both', () => {
  for (const name of ['TS-590S/SG', 'TS-890S', 'K3/K3S']) {
    assert.deepStrictEqual(DataModePicker.dataModesFor(kenwoodInput('kenwood', RIG_MODELS[name])), BOTH, name);
  }
});
t('FT-817/818 legacy CAT: none (one DIG mode, no sideband choice)', () => {
  const m = RIG_MODELS['FT-817/818'];
  assert.deepStrictEqual(DataModePicker.dataModesFor({ rigType: 'yaesu', protocol: m.protocol }), []);
});
t('(tr)uSDX (digital in plain USB): none; QMX (one DIGI mode): DIGU only', () => {
  assert.deepStrictEqual(DataModePicker.dataModesFor(kenwoodInput('kenwood', RIG_MODELS['(tr)uSDX'])), []);
  assert.deepStrictEqual(DataModePicker.dataModesFor(kenwoodInput('kenwood', RIG_MODELS.QMX)), ['DIGU']);
});
t('no CAT / unknown: none', () => {
  assert.deepStrictEqual(DataModePicker.dataModesFor({ rigType: 'unknown' }), []);
  assert.deepStrictEqual(DataModePicker.dataModesFor({}), []);
  assert.deepStrictEqual(DataModePicker.dataModesFor(null), []);
});
t('flrig: what the radio lists (unknown list = both)', () => {
  const tokens = (list) => list.map(normalizeRadioMode);
  assert.deepStrictEqual(DataModePicker.dataModesFor({ rigType: 'flrig' }), BOTH);
  assert.deepStrictEqual(DataModePicker.dataModesFor({ rigType: 'flrig', radioModes: tokens(['LSB', 'USB', 'CW', 'USB-D', 'LSB-D']) }), BOTH);
  assert.deepStrictEqual(DataModePicker.dataModesFor({ rigType: 'flrig', radioModes: tokens(['LSB', 'USB', 'CW', 'AM', 'FM']) }), []);
});
t('main.js advertises caps.dataModes from the one rule', () => {
  assert.ok(/caps\.dataModes = DataModePicker\.dataModesFor\(/.test(main), 'getRigCapabilities must set caps.dataModes');
});

// --- What each codec sends for set-mode DIGU / DIGL ---
t('G90 (rigctld): CI-V 06 USB/LSB at 0xA4, then M PKTUSB / PKTLSB', () => {
  for (const [mode, tok, byte] of [['DIGU', 'PKTUSB', '01'], ['DIGL', 'PKTLSB', '00']]) {
    const w = [];
    const c = new RigctldCodec(RIG_MODELS.G90, (d) => w.push(String(d)));
    assert.strictEqual(c.setMode(mode, HZ), tok);
    assert.ok(w[0].startsWith('w ') && w[0].toLowerCase().includes(`\\0xa4\\0xe0\\0x06\\0x${byte}`), JSON.stringify(w));
    assert.ok(w.some((l) => l.startsWith(`M ${tok} `)), JSON.stringify(w));
  }
});
t('Icom IC-7300 (CI-V): 06 USB/LSB, then 1A 06 with DATA on', () => {
  for (const [mode, mb] of [['DIGU', 0x01], ['DIGL', 0x00]]) {
    const frames = [];
    const c = new CivCodec(RIG_MODELS['IC-7300'], (b) => frames.push(Buffer.from(b).toString('hex')));
    c.setMode(mode, HZ);
    const hex = frames.join(' ');
    assert.ok(hex.includes('06' + mb.toString(16).padStart(2, '0')), hex);
    assert.ok(/1a0601/.test(hex), `DATA flag not set: ${hex}`);
  }
});
t('Yaesu FT-710: MD0C; / MD08;', () => {
  for (const [mode, md] of [['DIGU', 'MD0C;'], ['DIGL', 'MD08;']]) {
    const w = [];
    new KenwoodCodec(RIG_MODELS['FT-710'], (d) => w.push(String(d))).setMode(mode, HZ);
    assert.ok(w.join('').includes(md), `${mode}: ${w.join('')}`);
  }
});
t('Kenwood TS-590: MD2;DA1; / MD1;DA1;', () => {
  for (const [mode, md] of [['DIGU', 'MD2;'], ['DIGL', 'MD1;']]) {
    const w = [];
    new KenwoodCodec(RIG_MODELS['TS-590S/SG'], (d) => w.push(String(d))).setMode(mode, HZ);
    const s = w.join('');
    assert.ok(s.includes(md) && s.indexOf('DA1;') > s.indexOf(md), `${mode}: ${s}`);
  }
});

// --- The badge ---
t('badge: every data sub-mode name reads DIGU / DIGL', () => {
  for (const m of ['DIGU', 'PKTUSB', 'USB-D', 'USB-D1', 'DATA-U', 'DATA-USB', 'pktusb']) assert.strictEqual(DataModePicker.badge(m), 'DIGU', m);
  for (const m of ['DIGL', 'PKTLSB', 'LSB-D', 'LSB-D2', 'DATA-L', 'DATA-LSB']) assert.strictEqual(DataModePicker.badge(m), 'DIGL', m);
});
t('badge: an Icom in USB/LSB with the DATA flag on reads DIGU / DIGL', () => {
  assert.strictEqual(DataModePicker.badge('USB', true), 'DIGU');
  assert.strictEqual(DataModePicker.badge('LSB', true), 'DIGL');
  assert.strictEqual(DataModePicker.badge('USB', false), 'USB');
  assert.strictEqual(DataModePicker.badge('USB'), 'USB');
  assert.strictEqual(DataModePicker.badge('CW', true), 'CW');
});
t('badge: other modes unchanged (RADE, FT8, CW, empty)', () => {
  for (const m of ['RADE', 'FreeDV', 'FT8', 'CW', 'FM', 'RTTY']) assert.strictEqual(DataModePicker.badge(m), m);
  assert.strictEqual(DataModePicker.badge(''), '');
  assert.strictEqual(DataModePicker.badge(undefined), '');
});
t('remote.js draws the badge and the picker highlight through DataModePicker', () => {
  assert.ok(/modeBadge\.textContent = DataModePicker\.badge\(FreedvDisplayMode\.freedvBadge\(s\.mode\), currentModeData\)/.test(js));
  assert.ok(/DataModePicker\.dataModeOf\(currentMode, currentModeData\)/.test(js), 'picker highlight must follow the data mode');
});
t('main.js sends status.modeData from the Icom DATA flag', () => {
  assert.ok(/status\.modeData = /.test(main));
  assert.ok(/modeData/.test(read('docs/echocat-protocol.md')), 'protocol doc must describe modeData');
  assert.ok(/dataModes/.test(read('docs/echocat-protocol.md')), 'protocol doc must describe capabilities.dataModes');
});

// --- PTT stays on in the data sub-modes (G7-Chris, FreeDV and SSB-over-DATA) ---
t('PTT guard still counts DIGU/DIGL/PKTUSB/USB-D as voice-capable', () => {
  const i = js.indexOf('const isVoice = (mUp === \'SSB\'');
  assert.ok(i > 0);
  const guard = js.slice(i, js.indexOf('pttBtn.classList.toggle', i));
  for (const m of ['DIGU', 'DIGL', 'PKTUSB', 'PKTLSB', 'USB-D', 'LSB-D']) assert.ok(guard.includes(`'${m}'`), m);
});

// --- Inlined into ECHOCAT Web ---
t('lib/data-mode-picker.js is inlined into remote.html by remote-server', () => {
  assert.ok(html.includes('<!-- data-mode-picker-js -->'));
  assert.ok(read('lib/remote-server.js').includes("['data-mode-picker-js', 'data-mode-picker.js']"));
  const src = read('lib/data-mode-picker.js');
  assert.ok(/root\.DataModePicker = api/.test(src), 'dual-mode: window.DataModePicker');
  assert.ok(!/require\(['"]/.test(src), 'inlined module must not require() anything');
});

console.log(`echocat-web-data-mode: ${passed} passed`);
