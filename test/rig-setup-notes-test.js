#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
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
const HTML = readSrc(path.join(ROOT, 'renderer', 'index.html'));
const APP = readSrc(path.join(ROOT, 'renderer', 'app.js'));
const MAIN = readSrc(path.join(ROOT, 'main.js'));
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
          // udev rules are literal ATTR{name} keys the operator types, not placeholders.
          assert.ok(!/\{\w+\}/.test(text.replace(/ATTR\{\w+\}/g, '')), `${n.id} for ${model || '(no model)'}/${radioType}/${platform}: ${text}`);
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
test('IC-7300 MK II on Icom Network: DATA MOD = LAN, or TX keys with no power (#221, KJ5CHK)', () => {
  const lan = note(resolve({ model: 'IC-7300 MK II', radioType: 'icom-network' }), 'icom-network-data-mod-lan');
  assert.ok(lan, 'LAN DATA MOD note missing for the MK II on Icom Network');
  assert.strictEqual(lan.level, 'required');
  assert.strictEqual(lan.feature, 'Audio');
  assert.ok(lan.steps[0].includes('MENU → SET → Connectors → MOD Input → DATA MOD → LAN'), lan.steps[0]);
  assert.ok(!/USB/.test(lan.steps.join(' ')), 'the LAN note must not say USB');
  assert.ok(!note(resolve({ model: 'IC-7300 MK II', radioType: 'icom' }), 'icom-network-data-mod-lan'), 'not on USB');
  assert.ok(!note(resolve({ model: 'IC-7300', radioType: 'icom-network' }), 'icom-network-data-mod-lan'), 'only models with a confirmed path');
});
test('USB data audio: DATA MOD = USB on the Icoms, per the manual of each (FM_12b p.126, FM_5 p.333, BM_10 p.58)', () => {
  const cases = [
    ['IC-7300', 'ic7300-data-mod-usb', 'MENU → SET → Connectors → DATA MOD → USB', 'required'],
    ['IC-7100', 'ic7100-data-mod-usb', 'Connectors → DATA MOD → USB', 'required'],
    ['IC-7610', 'ic7610-data1-mod-usb', 'MENU → SET → Connectors → MOD Input → DATA1 MOD → USB', 'required'],
    ['IC-7300 MK II', 'ic7300mk2-data-mod-usb', 'MENU → SET → Connectors → MOD Input → DATA MOD → USB', 'recommended'],
  ];
  for (const [model, id, path, level] of cases) {
    for (const radioType of ['icom', 'hamlib']) {
      const n = note(resolve({ model, radioType }), id);
      assert.ok(n, `${id} missing for ${model}/${radioType}`);
      assert.strictEqual(n.level, level, id);
      assert.strictEqual(n.feature, 'Audio', id + ' must reach the Station Setup audio steps');
      assert.ok(n.steps[0].includes(path), `${id}: ${n.steps[0]}`);
      assert.ok(/ p\.\d/.test(n.source), id + ' cites a manual page: ' + n.source);
    }
    // Over the network the audio is on the LAN: a USB note there is wrong.
    assert.ok(!note(resolve({ model, radioType: 'icom-network' }), id), id + ' leaked to Icom Network');
  }
  // Factory values the manuals give; the MK II's CI-V guide gives none, so its note claims none.
  assert.ok(/factory it is ACC/.test(note(resolve({ model: 'IC-7300', radioType: 'icom' }), 'ic7300-data-mod-usb').steps[0]));
  assert.ok(/factory it is ACC/.test(note(resolve({ model: 'IC-7100', radioType: 'icom' }), 'ic7100-data-mod-usb').steps[0]));
  assert.ok(!/factory/i.test(note(resolve({ model: 'IC-7300 MK II', radioType: 'icom' }), 'ic7300mk2-data-mod-usb').steps.join(' ')));
  // The original IC-7300 has no MOD Input level (FM_12b p.126, BM_12 p.64).
  assert.ok(!/MOD Input/.test(note(resolve({ model: 'IC-7300', radioType: 'icom' }), 'ic7300-data-mod-usb').steps.join(' ')));
  // The IC-7100's 9600 bps is DATA2 pin 3 only (FM_5 p.344).
  assert.ok(/9600bps Mode/.test(note(resolve({ model: 'IC-7100', radioType: 'icom' }), 'ic7100-data-mod-usb').steps.join(' ')));
  // No model borrows another model's note.
  assert.ok(!note(resolve({ model: 'IC-705', radioType: 'icom' }), 'ic7300-data-mod-usb'));
  assert.ok(!note(resolve({ model: 'IC-7300', radioType: 'icom' }), 'ic7300mk2-data-mod-usb'));
});
test('IC-7610: the note names DATA1, the data mode POTACAT selects (civ-codec 1A 06 01)', () => {
  const codec = readSrc(path.join(ROOT, 'lib', 'codecs', 'civ-codec.js'));
  assert.ok(/this\._dataByte = 0x01;/.test(codec), 'civ-codec no longer defaults to DATA1: update ic7610-data1-mod-usb');
  const n = note(resolve({ model: 'IC-7610', radioType: 'icom' }), 'ic7610-data1-mod-usb');
  assert.ok(/DATA1 MOD/.test(n.title) && /DATA2 or DATA3/.test(n.steps[1]), n.steps[1]);
});
test('FT-857 and FT-817/818: DIG MODE = USER-U, with each manual\'s own menu numbers', () => {
  const codec = readSrc(path.join(ROOT, 'lib', 'codecs', 'yaesu-legacy-codec.js'));
  assert.ok(/FT8: 0x0A/.test(codec), 'FT8 no longer goes to DIG: the DIG MODE notes no longer apply');
  const f857 = note(resolve({ model: 'FT-857', radioType: 'serialcat' }), 'ft857-dig-mode-user-u');
  assert.ok(f857 && f857.level === 'required' && f857.feature === 'Audio');
  const t857 = f857.steps.join(' ');
  assert.ok(/No-038 DIG MODE → USER-U/.test(t857) && /RTTY-L/.test(t857), t857);
  assert.ok(/No-037 DIG GAIN/.test(t857) && /No-073 PKT RATE/.test(t857) && /No-071 PKT1200/.test(t857), t857);
  assert.ok(/No-001 EXT MENU/.test(t857), 'the FT-857D needs EXT MENU on to reach No-038 (p.67)');
  const f818 = note(resolve({ model: 'FT-817/818', radioType: 'serialcat' }), 'ft818-dig-mode-user-u');
  assert.ok(f818 && f818.level === 'required' && f818.feature === 'Audio');
  const t818 = f818.steps.join(' ');
  assert.ok(/#26 DIG MODE → USER-U/.test(t818) && /#25 DIG MIC/.test(t818) && /#40 PKT RATE/.test(t818) && /#39 PKT MIC/.test(t818), t818);
  assert.ok(!/No-0\d\d/.test(t818), 'FT-857 menu numbers in the FT-818 note');
  assert.ok(/FT-817/.test(f818.steps[0]), 'says the numbers are the FT-818ND\'s');
  // The FT-897 shares the codec, but its manual has not been read.
  assert.ok(!note(resolve({ model: 'FT-897', radioType: 'serialcat' }), 'ft857-dig-mode-user-u'));
  assert.ok(!note(resolve({ model: 'FT-857', radioType: 'serialcat' }), 'ft818-dig-mode-user-u'));
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

console.log('\n=== linux-dialout names the login, never a word to replace ===');
test('the dialout command carries the real username when known, the shell\'s $USER otherwise', () => {
  const { resolveSetupNotes } = require('../lib/rig-setup-notes');
  const pick = (notes) => notes.find((n) => n.id === 'linux-dialout');
  const withUser = pick(resolveSetupNotes({ radioType: 'serialcat', platform: 'linux', linuxUser: 'douglas' }));
  assert.ok(withUser, 'note applies to a serial rig on linux');
  assert.ok(withUser.steps[0].includes('sudo usermod -aG dialout douglas'), withUser.steps[0]);
  assert.ok(/type exactly/.test(withUser.steps[0]), 'says to type it as shown');
  const without = pick(resolveSetupNotes({ radioType: 'serialcat', platform: 'linux' }));
  assert.ok(without.steps[0].includes('sudo usermod -aG dialout "$USER"'), without.steps[0]);
  assert.ok(!pick(resolveSetupNotes({ radioType: 'serialcat', platform: 'win32' })), 'not on Windows');
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  assert.ok(/linuxUser: \(\(\) => \{ try \{ return require\('os'\)\.userInfo\(\)\.username; \} catch \{ return ''; \} \}\)\(\),/.test(main), 'main passes the login name');
});

console.log(`\nRig setup notes: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
