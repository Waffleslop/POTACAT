#!/usr/bin/env node
'use strict';
// GitHub #242 (LZ3AW, TS-480): a custom CAT toggle showed OFF while the radio
// was already in SPLIT, so the first click re-sent ON and seemed to do
// nothing. Each toggle may now carry its own read command and an "ON when"
// rule; POTACAT reads it at connect, after a press and when the panel opens,
// never while transmitting. With no read and nothing sent, a toggle is
// UNKNOWN, not OFF.
// Run: node test/custom-cat-read-test.js
const { readSrc } = require('./_src');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const Follow = require('../lib/custom-cat-follow');
const { createCustomCatReader, AFTER_PRESS_MS, PANEL_MIN_MS } = require('../lib/custom-cat-read');
const { KenwoodCodec } = require('../lib/codecs/kenwood-codec');
const { RigController } = require('../lib/rig-controller');
const { RIG_MODELS } = require('../lib/rig-models');
const SF = require('../lib/settings-file');

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

// --- rule parsing and matching ---------------------------------------------

test('rule N=X: character N (first is 1) equals X; longer values compare a run', () => {
  const r = Follow.parseOnRule('3=1');
  assert.deepStrictEqual(r, { kind: 'char', pos: 3, value: '1' });
  assert.strictEqual(Follow.matchOnRule(r, 'AB1;'), true);
  assert.strictEqual(Follow.matchOnRule(r, 'AB0;'), false);
  assert.strictEqual(Follow.matchOnRule(Follow.parseOnRule(' 2 = BC '), 'ABCD;'), true, 'spaces around = are allowed');
  assert.strictEqual(Follow.matchOnRule(Follow.parseOnRule('2=BC'), 'ABXD;'), false);
});

test('rule /regex/: the reply matches; i flag honoured', () => {
  const r = Follow.parseOnRule('/^SP1/');
  assert.strictEqual(r.kind, 'regex');
  assert.strictEqual(Follow.matchOnRule(r, 'SP1;'), true);
  assert.strictEqual(Follow.matchOnRule(r, 'SP0;'), false);
  assert.strictEqual(Follow.matchOnRule(Follow.parseOnRule('/sp1/i'), 'SP1;'), true);
});

test('no answer, or a reply too short to hold the field, is unknown (null), never OFF', () => {
  const r = Follow.parseOnRule('33=1');
  assert.strictEqual(Follow.matchOnRule(r, null), null);
  assert.strictEqual(Follow.matchOnRule(r, ''), null);
  assert.strictEqual(Follow.matchOnRule(r, '?;'), null);
});

test('bad rules say why; an empty rule is no rule', () => {
  assert.strictEqual(Follow.parseOnRule(''), null);
  assert.strictEqual(Follow.parseOnRule(null), null);
  assert.ok(Follow.parseOnRule('/a(/').error, 'broken regex');
  assert.ok(Follow.parseOnRule('0=1').error, 'positions start at 1');
  assert.ok(Follow.parseOnRule('split on').error, 'free text');
});

test('a slot has a read only as a toggle with both a command and a valid rule', () => {
  assert.ok(Follow.slotRead({ type: 'toggle', readCommand: 'IF;', onWhen: '33=1' }));
  assert.strictEqual(Follow.slotRead({ type: 'toggle', readCommand: 'IF;' }), null);
  assert.strictEqual(Follow.slotRead({ type: 'toggle', onWhen: '33=1' }), null);
  assert.strictEqual(Follow.slotRead({ type: 'toggle', readCommand: 'IF;', onWhen: 'nope' }), null);
  assert.strictEqual(Follow.slotRead({ type: 'button', readCommand: 'IF;', onWhen: '33=1' }), null);
  assert.strictEqual(Follow.readKey({ type: 'toggle', readCommand: ' IF; ', onWhen: ' 33=1 ' }), 'IF;\n33=1');
});

// --- the TS-480 example, through the real Kenwood codec ---------------------
//
// The split flag's place in the IF; reply is taken from the codec, not
// guessed: the codec's IF; parser decides split, and the rule must agree with
// it on the reply queryRaw hands back.

function ts480() {
  const model = RIG_MODELS['TS-480'];
  const transport = new EventEmitter();
  transport.connect = () => {}; transport.disconnect = () => {}; transport.write = () => {};
  const writes = [];
  const codec = new KenwoodCodec(model, (d) => writes.push(String(d)));
  const rig = new RigController(model, transport, codec);
  rig.connected = true;
  return { rig, codec, writes };
}
// IF; reply, field by field (TS-480 manual): P1 freq(11) P2(4) P3(6) P4 P5 P6
// P7(2) P8 P9 P10 P11 P12 P13 P14(2) P15 — 37 characters before the ';'.
function ifFrame(split) {
  const f = 'IF' + '00014074000' + '0000' + '+00000' + '0' + '0' + '0' + '00' + '0' + '2' + '0' + '0' + (split ? '1' : '0') + '0' + '00' + '0';
  assert.strictEqual(f.length, 37);
  return f;
}

test('TS-480: the IF; reply character the codec reads as split is character 33', async () => {
  for (const split of [true, false]) {
    const { rig, codec } = ts480();
    const seen = [];
    codec.on('split', (v) => seen.push(v));
    const reply = rig.queryRaw('IF;');
    codec.onData(ifFrame(split) + ';');
    const got = await reply;
    assert.deepStrictEqual(seen, [split], 'the codec itself reads split ' + split);
    // Find the character that differs between the two replies: that is the
    // codec's split flag, and its 1-based position is what the rule names.
    const other = ifFrame(!split) + ';';
    const diff = [...got].findIndex((c, i) => c !== other[i]);
    assert.strictEqual(diff + 1, 33, 'split flag position');
    assert.strictEqual(Follow.matchOnRule(Follow.parseOnRule('33=1'), got), split);
  }
});

test('TS-480: a toggle with IF; / 33=1 lights ON for a radio already in split, and its click sends Off', () => {
  const slot = { type: 'toggle', name: 'SPLIT', command: 'FT1;', commandOff: 'FT0;', readCommand: 'IF;', onWhen: '33=1' };
  const state = { customCatStates: { [Follow.readKey(slot)]: true } };
  assert.deepStrictEqual(Follow.toggleView(slot, state, undefined), { on: true, fromRadio: true, nextCommand: 'off' });
  state.customCatStates[Follow.readKey(slot)] = false;
  assert.deepStrictEqual(Follow.toggleView(slot, state, true), { on: false, fromRadio: true, nextCommand: 'on' }, 'the read beats last-sent');
});

// --- unknown ------------------------------------------------------------------

test('no read command and nothing sent: unknown, not OFF; the click sends On', () => {
  assert.deepStrictEqual(Follow.toggleView({ type: 'toggle' }, {}, undefined), { on: null, fromRadio: false, nextCommand: 'on' });
  assert.deepStrictEqual(Follow.toggleView({ type: 'toggle' }, null, undefined), { on: null, fromRadio: false, nextCommand: 'on' });
});

test('a read that has not answered yet is unknown too; once something was sent, last-sent shows', () => {
  const slot = { type: 'toggle', readCommand: 'IF;', onWhen: '33=1' };
  assert.strictEqual(Follow.toggleView(slot, { customCatStates: {} }, undefined).on, null);
  assert.strictEqual(Follow.toggleView(slot, { customCatStates: { [Follow.readKey(slot)]: null } }, undefined).on, null);
  assert.deepStrictEqual(Follow.toggleView({ type: 'toggle' }, {}, true), { on: true, fromRadio: false, nextCommand: 'off' });
});

test('every surface paints unknown as "?", not Off', () => {
  const R = (f) => readSrc(path.join(__dirname, '..', 'renderer', f));
  assert.ok(/v\.on === null \? '\?' : \(v\.on \? 'On' : 'Off'\)/.test(R('app.js')), 'desktop');
  assert.ok(/v\.on === null \? '\?' : \(v\.on \? 'On' : 'Off'\)/.test(R('vfo-popout.html')), 'VFO pop-out');
  assert.ok(/v\.on === null \? '\?' : \(v\.on \? 'On' : 'Off'\)/.test(R('remote.js')), 'ECHOCAT Web');
});

// --- when reads happen -----------------------------------------------------

function harness(slots, opts = {}) {
  const sent = [];
  const timers = [];
  let tx = !!opts.tx;
  const changes = [];
  const reader = createCustomCatReader({
    getSlots: () => slots,
    query: (cmd) => { sent.push(cmd); return opts.reply ? opts.reply(cmd) : Promise.resolve(ifFrame(true) + ';'); },
    isTransmitting: () => tx,
    onChange: (s) => changes.push(s),
    now: () => (opts.clock ? opts.clock.t : 0),
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i !== -1) timers.splice(i, 1); },
  });
  return {
    reader, sent, changes, timers,
    setTx: (v) => { tx = v; },
    fire: () => { const due = timers.splice(0); for (const t of due) t.fn(); },
  };
}
const SPLIT = { type: 'toggle', name: 'SPLIT', command: 'FT1;', commandOff: 'FT0;', readCommand: 'IF;', onWhen: '33=1' };

test('connect reads every toggle with a read, once per distinct read', async () => {
  const twin = { ...SPLIT, name: 'SPL2' };
  const h = harness([SPLIT, twin, { type: 'toggle', command: 'NB1;' }, { type: 'button', command: 'IF;' }]);
  assert.strictEqual(h.reader.readAll('connect'), true);
  await tick(); await tick();
  assert.deepStrictEqual(h.sent, ['IF;'], 'one read for two toggles with the same read');
  assert.deepStrictEqual(h.reader.states(), { [Follow.readKey(SPLIT)]: true });
  assert.strictEqual(h.changes.length, 1, 'a change is reported once');
});

test('the read happens after a press of the toggle\'s On or Off command — not for other commands', async () => {
  const h = harness([SPLIT]);
  assert.strictEqual(h.reader.afterPress('FA00014074000;'), false, 'unrelated command: no read');
  assert.strictEqual(h.timers.length, 0);
  assert.strictEqual(h.reader.afterPress('FT0;'), true);
  assert.strictEqual(h.timers.length, 1);
  assert.strictEqual(h.timers[0].ms, AFTER_PRESS_MS, 'waits for the radio to act first');
  assert.deepStrictEqual(h.sent, [], 'not before the delay');
  h.fire(); await tick(); await tick();
  assert.deepStrictEqual(h.sent, ['IF;']);
});

test('no read while transmitting: it waits, then runs once the radio is back on receive', async () => {
  const h = harness([SPLIT], { tx: true });
  h.reader.readAll('connect');
  h.reader.afterPress('FT1;'); h.fire();
  await tick();
  assert.deepStrictEqual(h.sent, [], 'nothing sent during TX');
  h.reader.txEnded();
  assert.deepStrictEqual(h.sent, [], 'still keyed: still nothing');
  h.setTx(false);
  h.reader.txEnded();
  await tick(); await tick();
  assert.deepStrictEqual(h.sent, ['IF;'], 'one read after TX, the two requests merged');
});

test('no reply is unknown; link down resets every result to unknown', async () => {
  const h = harness([SPLIT], { reply: () => Promise.reject(new Error('timeout')) });
  h.reader.readAll('connect');
  await tick(); await tick();
  assert.deepStrictEqual(h.reader.states(), { [Follow.readKey(SPLIT)]: null });
  const g = harness([SPLIT]);
  g.reader.readAll('connect'); await tick(); await tick();
  g.reader.reset();
  assert.deepStrictEqual(g.reader.states(), {});
});

test('opening the panel reads, but not again within PANEL_MIN_MS', async () => {
  const clock = { t: 100000 };
  const h = harness([SPLIT], { clock });
  assert.strictEqual(h.reader.readAll('panel'), true);
  await tick(); await tick();
  clock.t += PANEL_MIN_MS - 1;
  assert.strictEqual(h.reader.readAll('panel'), false);
  clock.t += 1;
  assert.strictEqual(h.reader.readAll('panel'), true);
  await tick(); await tick();
  assert.deepStrictEqual(h.sent, ['IF;', 'IF;']);
});

test('no toggle with a read: nothing is ever sent', async () => {
  const h = harness([{ type: 'toggle', command: 'FT1;', commandOff: 'FT0;' }]);
  assert.strictEqual(h.reader.readAll('connect'), false);
  assert.strictEqual(h.reader.afterPress('FT1;'), false);
  await tick();
  assert.deepStrictEqual(h.sent, []);
});

// --- main.js wiring -----------------------------------------------------------

const MAIN = readSrc(path.join(__dirname, '..', 'main.js'));
test('main.js: reads through cat.queryRaw, never during TX, and after every custom CAT send', () => {
  assert.ok(/cat\.queryRaw\(cmd, \{ timeoutMs: 1200 \}\)/.test(MAIN), 'queryRaw transport');
  assert.ok(/isTransmitting: \(\) => _isEffectivelyTransmitting\(\) \|\| !!\(cat && cat\._transmitting\)/.test(MAIN), 'TX gate');
  assert.ok(/cat\.sendRaw\(cmd\);\n\s*\/\/[^\n]*\n\s*customCatReader\.afterPress\(cmd\);/.test(MAIN), 'read after press');
  assert.ok(/case 'custom-cat-read': \{[\s\S]{0,300}?if \(meta && meta\.guest\) break;\s*customCatReader\.readAll\('panel'\);/.test(MAIN), 'panel read, refused for a guest');
  assert.ok(/customCatLinkSeen\(!!\(s && s\.connected\)\);/.test(MAIN), 'connect read');
  assert.ok(/customCatReader\.txEnded\(\)/.test(MAIN), 'held reads run after TX');
  assert.strictEqual((MAIN.match(/customCatStates: customCatReader\.states\(\)/g) || []).length, 3, 'desktop, VFO pop-out and ECHOCAT state all carry it');
});

test('the desktop Custom tab and the VFO pop-out ask for a read when opened', () => {
  const APP = readSrc(path.join(__dirname, '..', 'renderer', 'app.js'));
  const VFO = readSrc(path.join(__dirname, '..', 'renderer', 'vfo-popout.html'));
  assert.ok(/if \(tab === 'custom'\) window\.api\.rigControl\(\{ action: 'custom-cat-read' \}\);/.test(APP));
  assert.ok(/window\.api\.rigControl\(\{ action: 'custom-cat-read' \}\);/.test(VFO));
});

// --- settings round trip --------------------------------------------------------

test('settings round-trip: readCommand and onWhen survive settings.json and the web editor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'potacat-242-'));
  try {
    const p = path.join(dir, 'settings.json');
    SF._resetForTests();
    SF.writeSettingsFile(p, { customCatButtons: [SPLIT] }, { now: 1000 });
    const back = SF.readSettingsFile(p).data.customCatButtons[0];
    assert.deepStrictEqual(back, SPLIT);
    assert.strictEqual(Follow.readKey(back), Follow.readKey(SPLIT), 'same key after the trip');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const APP = readSrc(path.join(__dirname, '..', 'renderer', 'app.js'));
  const REMOTE = readSrc(path.join(__dirname, '..', 'renderer', 'remote.js'));
  assert.ok(/customCatButtons\[i\]\.readCommand = rc; else delete customCatButtons\[i\]\.readCommand;/.test(APP), 'desktop saves readCommand');
  assert.ok(/customCatButtons\[i\]\.onWhen = ow; else delete customCatButtons\[i\]\.onWhen;/.test(APP), 'desktop saves onWhen');
  assert.ok(/next\.readCommand = readEl\.value\.trim\(\)/.test(REMOTE), 'web saves readCommand');
  assert.ok(/next\.onWhen = onWhenEl\.value\.trim\(\)/.test(REMOTE), 'web saves onWhen');
  for (const src of [APP, REMOTE]) {
    assert.ok(src.includes("'Read command'") && src.includes("'ON when'"), 'both editors label the two fields the same');
  }
});

Promise.all(pending).then(() => {
  console.log(`\nCustom CAT read state (#242): ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
});
