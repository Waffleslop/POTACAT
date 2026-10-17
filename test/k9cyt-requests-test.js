#!/usr/bin/env node
'use strict';
// K9CYT's three requests (Discord 2026-10-04):
//  1. JTCAT logged a second QSO when he answered a repeated R-report with
//     another RR73 — lib/jtcat-relog-guard.js + jtcatAutoLog in main.js.
//  2. JS8: more of JS8Call's directed commands, and a message with no address
//     (identified the way JS8Call does it) — js8call-popout + js8-engine.
//  3. SSTV: "Save every picture", keeping weak decodes marked partial.
// Run: node test/k9cyt-requests-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/jtcat-relog-guard');
const V = require('../lib/js8-varicode');

const R = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

console.log('JTCAT re-log guard');

test('default window is 15 minutes; 0 turns it off; clamped to 120', () => {
  assert.strictEqual(G.cooldownMinutes(undefined), 15);
  assert.strictEqual(G.cooldownMinutes(''), 15);
  assert.strictEqual(G.cooldownMinutes(0), 0);
  assert.strictEqual(G.cooldownMinutes('30'), 30);
  assert.strictEqual(G.cooldownMinutes(999), 120);
  assert.strictEqual(G.cooldownMinutes(-4), 15);
});

test('the same call, band and mode inside the window is a re-log', () => {
  const m = new Map();
  const t0 = Date.UTC(2026, 9, 4, 18, 0, 0);
  const key = G.relogKey('S51DX', '20m', 'FT8');
  G.noteLogged(m, key, t0);
  const r = G.checkRelog(m, key, t0 + 90 * 1000, 15);   // three FT8 cycles later
  assert.strictEqual(r.skip, true);
  assert.strictEqual(r.agoMin, 1);
});

test('after the window, another band, or another mode, it logs', () => {
  const m = new Map();
  const t0 = 1e12;
  G.noteLogged(m, G.relogKey('S51DX', '20m', 'FT8'), t0);
  assert.strictEqual(G.checkRelog(m, G.relogKey('S51DX', '20m', 'FT8'), t0 + 15 * 60000, 15).skip, false);
  assert.strictEqual(G.checkRelog(m, G.relogKey('S51DX', '40m', 'FT8'), t0 + 60000, 15).skip, false);
  assert.strictEqual(G.checkRelog(m, G.relogKey('S51DX', '20m', 'FT4'), t0 + 60000, 15).skip, false);
});

test('window 0 never skips; a bracketed call is the same station', () => {
  const m = new Map();
  G.noteLogged(m, G.relogKey('K9CYT/8', '20m', 'FT8'), 1e12);
  assert.strictEqual(G.checkRelog(m, G.relogKey('<K9CYT/8>', '20m', 'FT8'), 1e12 + 1000, 15).skip, true);
  assert.strictEqual(G.checkRelog(m, G.relogKey('K9CYT/8', '20m', 'FT8'), 1e12 + 1000, 0).skip, false);
});

test('old entries are pruned past the longest window', () => {
  const m = new Map();
  G.noteLogged(m, 'A|20m|FT8', 0);
  G.noteLogged(m, 'B|20m|FT8', 121 * 60000);
  assert.strictEqual(m.has('A|20m|FT8'), false);
  assert.strictEqual(m.has('B|20m|FT8'), true);
});

test('main.js: the guard sits in jtcatAutoLog before the record is built, and remembers only a saved QSO', () => {
  const src = R('main.js');
  const fn = src.slice(src.indexOf('async function jtcatAutoLog('), src.indexOf('async function jtcatAutoLog(') + 12000);
  const check = fn.indexOf('RelogGuard.checkRelog(');
  const build = fn.indexOf('const qsoData = {');
  const note = fn.indexOf('RelogGuard.noteLogged(');
  const ok = fn.indexOf("console.log('[JTCAT] Auto-logged QSO:'");
  assert.ok(check > 0 && check < build, 'check before qsoData');
  assert.ok(note > ok, 'noteLogged after the save succeeded');
});

test('pop-out: the window is a gear-menu field saved as jtcatRelogCooldownMin', () => {
  assert.ok(R('renderer/jtcat-popout.html').includes('id="jp-relog-min"'));
  assert.ok(R('renderer/jtcat-popout.js').includes('saveSettings({ jtcatRelogCooldownMin: n })'));
});

console.log('JS8 composer');

test('free text with no address goes out identified, as JS8Call sends it', () => {
  const { frames } = V.buildMessageFrames({ mycall: 'K9CYT', mygrid: 'EN52', text: 'HELLO WORLD', forceIdentify: true, submode: 0 });
  const text = frames.map((f) => V.interpretFrame(f.frame, f.bits).message).join('');
  assert.strictEqual(text, 'K9CYT: HELLO WORLD');
});

test('the engine always asks for identification', () => {
  assert.ok(/forceIdentify: true/.test(R('lib/js8-engine.js')));
});

test('a directed message and a CQ are unchanged by identification', () => {
  const d = V.buildMessageFrames({ mycall: 'K9CYT', mygrid: 'EN52', text: 'KD2NGL SNR?', forceIdentify: true, submode: 0 });
  assert.ok(!d.frames.some((f) => /^K9CYT: $/.test(V.interpretFrame(f.frame, f.bits).message)), 'no extra identity frame on a directed message');
  const c = V.buildMessageFrames({ mycall: 'K9CYT', mygrid: 'EN52', text: 'CQ CQ', forceIdentify: true, submode: 0 });
  assert.strictEqual(c.frames.length, 1);
});

test('pop-out: No address is offered, sent as an empty recipient, and @ALLCALL stays the default', () => {
  const src = R('renderer/js8call-popout.js');
  assert.ok(src.includes("opts.unshift(NO_ADDRESS)"));
  assert.ok(src.includes("transmit(body, toValue())"));
  assert.ok(src.includes("(openCall || '@ALLCALL')"));
});

test('every chip is a command the encoder knows', () => {
  const src = R('renderer/js8call-popout.js');
  const chips = Array.from(src.matchAll(/\{ t: '([^']+)'/g)).map((m) => m[1].trim());
  assert.ok(chips.length >= 15, 'chips: ' + chips.length);
  for (const c of ['QUERY CALL', 'HW CPY?', 'STATUS?', 'HEARING?', 'AGN?']) assert.ok(chips.includes(c), c);
  const varicode = R('lib/js8-varicode.js');
  for (const c of chips) assert.ok(varicode.includes(`[' ${c}'`), 'encoder knows ' + c);
});

test('the preview never prefixes a CQ or HB, which already carry our call', () => {
  const src = R('renderer/js8call-popout.js');
  assert.ok(src.includes('var beacon = /^(CQ|HB|HEARTBEAT)' + String.fromCharCode(92) + 'b/i.test(body);'));
  assert.ok(!src.includes(String.fromCharCode(8)), 'no control characters in the source');
});

console.log('SSTV save every picture');

test('weak decodes are saved only when the switch is on, on both receive paths', () => {
  const src = R('main.js');
  assert.ok(src.includes('const saveWeak = data.weak && settings.sstvSaveAllDecodes === true;'));
  assert.ok(src.includes('(data.redecode || (data.weak && !saveWeak)) ? null : await saveSstvImage(data)'));
  assert.ok(src.includes('(data.weak && settings.sstvSaveAllDecodes !== true) ? null : await saveSstvImage(data)'));
});

test('a saved partial picture says so in its filename and sidecar', () => {
  const src = R('main.js');
  assert.ok(src.includes("data.weak ? 'partial' : ''"));
  assert.ok(src.includes('partial: !!data.weak,'));
});

test('the switch lives in the SSTV gear menu, off by default', () => {
  assert.ok(R('renderer/sstv-popout.html').includes('id="save-all-decodes"'));
  assert.ok(R('renderer/sstv-popout.js').includes('settings.sstvSaveAllDecodes === true'));
});

console.log(`\nK9CYT requests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
