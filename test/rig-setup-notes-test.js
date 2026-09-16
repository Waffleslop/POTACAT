#!/usr/bin/env node
'use strict';
// Rig setup notes (lib/rig-setup-notes.js) — the "Setup instructions" button
// in the rig editor.
//
// A wrong note is worse than no note: it sends the operator into the radio's
// menu to set the wrong value. These checks keep the table honest against the
// model table, the editor's radio types and the keying resolver the notes quote.
// Run: node test/rig-setup-notes-test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { NOTES, LEVELS, resolveSetupNotes, radioTypeFromCatTarget } = require('../lib/rig-setup-notes');
const { RIG_MODELS } = require('../lib/rig-models');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const RADIO_TYPES = [...HTML.matchAll(/name="radio-type" value="([^"]+)"/g)].map((m) => m[1]);
const BRANDS = new Set(Object.values(RIG_MODELS).map((m) => m.brand));
const PLATFORMS = ['win32', 'darwin', 'linux'];

const note = (list, id) => list.find((n) => n.id === id);
const resolve = (o) => resolveSetupNotes({ platform: 'win32', ...o, modelInfo: o.model ? RIG_MODELS[o.model] : null });

console.log('=== table shape ===');
test('the editor still offers the radio types the table scopes on', () => {
  assert.ok(RADIO_TYPES.length >= 8, 'found radio types: ' + RADIO_TYPES.join(','));
});
test('ids are unique and every note is complete', () => {
  const ids = new Set();
  for (const n of NOTES) {
    assert.ok(!ids.has(n.id), 'duplicate id ' + n.id);
    ids.add(n.id);
    assert.ok(LEVELS.includes(n.level), n.id + ': bad level ' + n.level);
    assert.ok(n.title && n.why && n.source && n.feature, n.id + ': missing title/why/source/feature');
    assert.ok(Array.isArray(n.steps) && n.steps.length, n.id + ': no steps');
    assert.ok(n.applies && Array.isArray(n.applies.radioTypes) && n.applies.radioTypes.length,
      n.id + ': must be scoped to radio types (rig-scoped UI rule)');
  }
});
test('every model, brand, radio type and platform named exists', () => {
  for (const n of NOTES) {
    const a = n.applies;
    for (const m of a.models || []) assert.ok(RIG_MODELS[m], n.id + ': unknown model ' + m);
    for (const b of a.brands || []) assert.ok(BRANDS.has(b), n.id + ': unknown brand ' + b);
    for (const t of a.radioTypes) assert.ok(RADIO_TYPES.includes(t), n.id + ': unknown radio type ' + t);
    for (const p of a.platforms || []) assert.ok(PLATFORMS.includes(p), n.id + ': unknown platform ' + p);
  }
});
test('no Flex note leaks to a serial rig and no serial note to a Flex', () => {
  for (const n of NOTES) {
    const t = n.applies.radioTypes;
    assert.ok(!(t.includes('flex') && t.some((x) => x !== 'flex')), n.id + ' mixes flex with other radio types');
  }
  assert.strictEqual(resolve({ radioType: 'flex', model: 'FLEX-6600/6600M' }).length, 0, 'a Flex got serial notes');
});

console.log('\n=== every placeholder fills for every model it can apply to ===');
test('no unfilled {placeholder} survives resolution', () => {
  for (const model of ['', ...Object.keys(RIG_MODELS)]) {
    for (const radioType of RADIO_TYPES) {
      for (const platform of PLATFORMS) {
        for (const n of resolve({ model, radioType, platform })) {
          const text = [n.title, n.why, ...n.steps].join(' ');
          assert.ok(!/\{\w+\}/.test(text), `${n.id} for ${model || '(no model)'}/${radioType}/${platform}: ${text}`);
        }
      }
    }
  }
});

console.log('\n=== the notes quote what POTACAT actually drives ===');
test('FTDX10: PC KEYING follows the CW keying line dropdown', () => {
  const auto = note(resolve({ model: 'FTDX10', radioType: 'serialcat' }), 'ftdx10-pc-keying');
  assert.ok(auto, 'FTDX10 note missing');
  assert.ok(/PC KEYING → DTR/.test(auto.steps[0]), 'auto should be the key-port default DTR: ' + auto.steps[0]);
  const rts = note(resolve({ model: 'FTDX10', radioType: 'serialcat', cwKeyLine: 'rts' }), 'ftdx10-pc-keying');
  assert.ok(/PC KEYING → RTS/.test(rts.steps[0]), 'rts override: ' + rts.steps[0]);
  assert.strictEqual(auto.level, 'required');
});
test('IC-7300: USB Keying (CW) uses the model main-port line, and the override', () => {
  const auto = note(resolve({ model: 'IC-7300', radioType: 'icom' }), 'icom-usb-keying-cw');
  assert.ok(/USB Keying \(CW\) → RTS/.test(auto.steps[0]), auto.steps[0]);
  const dtr = note(resolve({ model: 'IC-7300', radioType: 'icom', cwKeyLine: 'dtr' }), 'icom-usb-keying-cw');
  assert.ok(/→ DTR/.test(dtr.steps[0]), dtr.steps[0]);
});
test('the Icom pickers and the model table agree on every CI-V address the note quotes', () => {
  const opts = [...HTML.matchAll(/<option value="0x([0-9A-Fa-f]+)">(IC-[^<]+)<\/option>/g)];
  assert.ok(opts.length > 5, 'no Icom picker options found');
  for (const [, hex, name] of opts) {
    const m = RIG_MODELS[name];
    if (!m || m.civAddr == null) continue;
    assert.strictEqual(m.civAddr, parseInt(hex, 16), `${name}: picker 0x${hex} vs model 0x${m.civAddr.toString(16)}`);
  }
});
test('CI-V note names the model default the way the radio menu shows it', () => {
  const n = note(resolve({ model: 'IC-7760', radioType: 'icom-network' }), 'icom-civ-address');
  assert.ok(n && /at B2h$/.test(n.title), n && n.title);
});

console.log('\n=== scoping ===');
test('platform notes only on their platform', () => {
  assert.ok(note(resolve({ model: 'FT-710', radioType: 'serialcat', platform: 'linux' }), 'linux-dialout'));
  assert.ok(!note(resolve({ model: 'FT-710', radioType: 'serialcat', platform: 'win32' }), 'linux-dialout'));
  assert.ok(note(resolve({ model: 'FT-710', radioType: 'serialcat', platform: 'win32' }), 'windows-named-audio'));
});
test('pick-exact-model shows only when no model is chosen', () => {
  assert.ok(note(resolve({ model: '', radioType: 'serialcat' }), 'pick-exact-model'));
  assert.ok(!note(resolve({ model: 'FT-891', radioType: 'serialcat' }), 'pick-exact-model'));
});
test('required notes sort first, and done ticks come back', () => {
  const list = resolve({ model: 'FTDX10', radioType: 'serialcat', platform: 'linux', done: ['linux-dialout'] });
  const levels = list.map((n) => n.level);
  assert.deepStrictEqual(levels, [...levels].sort((a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b)));
  assert.strictEqual(note(list, 'linux-dialout').done, true);
  assert.strictEqual(note(list, 'ftdx10-pc-keying').done, false);
});
test('a saved catTarget maps to the editor radio type', () => {
  assert.strictEqual(radioTypeFromCatTarget({ type: 'serial' }), 'serialcat');
  assert.strictEqual(radioTypeFromCatTarget({ type: 'rigctld' }), 'hamlib');
  assert.strictEqual(radioTypeFromCatTarget({ type: 'tcp', host: '127.0.0.1', port: 5003 }), 'flex');
  assert.strictEqual(radioTypeFromCatTarget({ type: 'tcp', host: '192.168.1.9', port: 4532 }), 'tcpcat');
  assert.strictEqual(radioTypeFromCatTarget(null), 'flex');
});

console.log('\n=== wiring ===');
test('the editor persists ticks on both save paths and offers the button', () => {
  assert.ok(/id="rig-setup-btn"/.test(HTML), 'button missing from the rig editor');
  assert.ok(/rig\.setupDone = \[\.\.\.rigSetupDone\]/.test(APP), 'edit save drops setupDone');
  assert.ok(/setupDone: \[\.\.\.rigSetupDone\]/.test(APP), 'add save drops setupDone');
  assert.ok(/'\*\*Setup notes:\*\* '/.test(APP), 'bug report no longer lists setup notes');
});
test('every setup offers Discord and email for a setup we do not list', () => {
  assert.ok(/const RIG_SETUP_DISCORD_URL = 'https:\/\/discord\.gg\//.test(APP), 'Discord link missing from the panel footer');
  assert.ok(/const RIG_SETUP_EMAIL = 'k3sbp@potacat\.com'/.test(APP), 'email address missing from the panel footer');
  // open-external is a prefix allow-list that fails closed with no error.
  assert.ok(MAIN.includes("'mailto:k3sbp@potacat.com'"), 'mailto:k3sbp@potacat.com is not allowed by open-external');
  assert.ok(MAIN.includes("'https://discord.gg/'"), 'discord.gg is not allowed by open-external');
});
test('main keys the CW Key Port with the same resolver the notes quote', () => {
  assert.ok(/const kpPins = resolveKeyPortPins\(/.test(MAIN), 'key-port keying no longer uses resolveKeyPortPins');
  assert.ok(/ipcMain\.handle\('get-rig-setup-notes'/.test(MAIN), 'IPC handler missing');
});

console.log(`\nRig setup notes: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
