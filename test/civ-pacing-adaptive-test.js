#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Adaptive CI-V pacing (Casey 2026-11-06, after reviewing 1feed09b): an Icom
// that works today keeps its old burst timing; only a radio seen DROPPING
// replies (answers frequency or DATA mode, never the mode or a wanted power
// read within ~10 s) switches to one command at a time. The rig editor can
// force it either way; a reconnect watches again; a rig found dropping stays
// paced for the session.
// Run: node test/civ-pacing-adaptive-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { CivCodec } = require('../lib/codecs/civ-codec');

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const MODEL = { brand: 'Icom', protocol: 'civ', civAddr: 0x94, caps: { txpower: true }, cw: {}, maxPower: 100 };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A fake IC-7300. dropping=true: a new frame mid-reply loses the reply (the field radio). */
function fakeRadio({ dropping }) {
  let codec = null;
  let pending = null;
  const writes = [];
  const reply = (cmd, sub, data) => Buffer.from([0xFE, 0xFE, 0xE0, 0x94, cmd, ...(sub != null ? [sub] : []), ...data, 0xFD]);
  function answer(f) {
    const cmd = f[4]; const sub = f.length > 6 ? f[5] : null;
    if (cmd === 0x03) return reply(0x03, null, [0x00, 0x40, 0x07, 0x14, 0x00]);
    if (cmd === 0x04) return reply(0x04, null, [0x01, 0x01]);
    if (cmd === 0x14 && sub === 0x0A) return reply(0x14, 0x0A, [0x00, 0x64]);
    if (cmd === 0x1A && sub === 0x06) return reply(0x1A, 0x06, [0x01, 0x01]);
    if (cmd === 0x15) return reply(0x15, sub, [0x01, 0x20]);
    if (cmd === 0x1C) return reply(0x1C, 0x00, [0x00]);
    return Buffer.from([0xFE, 0xFE, 0xE0, 0x94, 0xFB, 0xFD]);
  }
  const write = (buf) => {
    const f = Buffer.from(buf);
    writes.push(f.toString('hex'));
    if (dropping) {
      if (pending) { clearTimeout(pending); pending = null; }
      pending = setTimeout(() => { pending = null; codec.onData(answer(f)); }, 4);
    } else {
      setTimeout(() => codec.onData(answer(f)), 4);   // answers everything, in order
    }
  };
  return { write, writes, attach(c) { codec = c; } };
}
function burst(codec) {
  codec.getFrequency(); codec.getMode(); codec.getPtt(); codec.getSmeter(); codec.getPower(); codec.getDataMode();
}
function track(codec) {
  const got = { mode: 0, power: 0, logs: [], pacing: 0 };
  codec.on('mode', () => got.mode++);
  codec.on('power', () => got.power++);
  codec.on('log', (l) => got.logs.push(l));
  codec.on('pacing', () => got.pacing++);
  return got;
}
/** Simulated seconds of polling: one burst and one pacingCheck per "second". */
async function run(codec, seconds, t0 = 0) {
  for (let s = 0; s <= seconds; s++) {
    burst(codec);
    await wait(40);
    codec.pacingCheck(t0 + s * 1000);
  }
}

test('a radio that answers its bursts stays unpaced, with exactly the old write timing', async () => {
  const radio = fakeRadio({ dropping: false });
  const codec = new CivCodec(MODEL, radio.write, { pace: 'auto' });
  radio.attach(codec);
  const got = track(codec);
  // Every frame of a burst goes out synchronously, in order, as before 1feed09b.
  const ref = []; const old = new CivCodec(MODEL, (b) => ref.push(Buffer.from(b).toString('hex')));
  burst(old);
  burst(codec);
  assert.deepStrictEqual(radio.writes, ref, 'the same burst, written at once');
  await wait(40);
  await run(codec, 15, 1000);
  assert.strictEqual(codec.pacingState.paced, false);
  assert.strictEqual(got.pacing, 0);
  assert.ok(got.mode > 0 && got.power > 0);
  assert.ok(!got.logs.some((l) => /drops replies/.test(l)));
});

test('a radio that drops replies switches to paced within the window, then reports mode and power', async () => {
  const radio = fakeRadio({ dropping: true });
  const codec = new CivCodec(MODEL, radio.write, { pace: 'auto' });
  radio.attach(codec);
  const got = track(codec);
  await run(codec, 9);
  assert.strictEqual(codec.pacingState.paced, false, 'not before the window');
  assert.strictEqual(got.mode, 0);
  await run(codec, 2, 10000);
  assert.strictEqual(codec.pacingState.paced, true);
  assert.strictEqual(got.pacing, 1);
  assert.ok(got.logs.includes('[CAT] This radio drops replies to back-to-back CI-V commands (no mode reply in 10 s); sending them one at a time from now on.'));
  burst(codec);
  await wait(120);
  assert.ok(got.mode > 0, 'mode arrives once paced');
  assert.ok(got.power > 0, 'power arrives once paced');
  codec._pacer.reset();
});

test('a power read a pass is waiting for also triggers pacing', async () => {
  // A radio that answers mode (so the mode test never fires) but drops the
  // power read, as a burst would.
  const codec = new CivCodec(MODEL, () => {}, { pace: 'auto' });
  const got = track(codec);
  const feed = (bytes) => codec.onData(Buffer.from(bytes));
  codec.pacingCheck(0);
  feed([0xFE, 0xFE, 0xE0, 0x94, 0x03, 0x00, 0x40, 0x07, 0x14, 0x00, 0xFD]);
  feed([0xFE, 0xFE, 0xE0, 0x94, 0x04, 0x01, 0x01, 0xFD]);
  codec.notePowerWanted(1000);
  assert.strictEqual(codec.pacingCheck(9000), false);
  assert.strictEqual(codec.pacingCheck(11001), true);
  assert.ok(got.logs.some((l) => /\(no power reply in 10 s\)/.test(l)));
  codec._pacer.reset();
});

test('the override forces each way', async () => {
  const always = new CivCodec(MODEL, () => {}, { pace: 'always' });
  assert.strictEqual(always.pacingState.paced, true, 'Always: paced from the first frame');
  always._pacer.reset();
  const radio = fakeRadio({ dropping: true });
  const never = new CivCodec(MODEL, radio.write, { pace: 'never' });
  radio.attach(never);
  await run(never, 15);
  assert.strictEqual(never.pacingState.paced, false, 'Never: not even a dropping radio');
  const legacy = new CivCodec(MODEL, () => {});
  assert.deepStrictEqual(legacy.pacingState, { mode: 'never', paced: false }, 'no option = the old behaviour');
});

test('a reconnect watches again; a rig found dropping starts paced for the rest of the session', () => {
  const codec = new CivCodec(MODEL, () => {}, { pace: 'auto' });
  codec.pacingCheck(0);
  codec.onData(Buffer.from([0xFE, 0xFE, 0xE0, 0x94, 0x03, 0x00, 0x40, 0x07, 0x14, 0x00, 0xFD]));
  codec.rearmPacingDetection();                 // the cable came back
  assert.strictEqual(codec.pacingCheck(20000), false, 'the window starts again');
  assert.strictEqual(codec.pacingCheck(25000), false, 'and needs a reply on the new link');
  const ctl = readSrc(path.join(__dirname, '..', 'lib', 'rig-controller.js')).replace(/\r\n/g, '\n');
  assert.ok(/this\._transport\.on\('connect', \(\) => \{[\s\S]{0,700}this\._codec\.rearmPacingDetection\(\)/.test(ctl), 'the controller re-arms on every connect');
  assert.ok(/if \(typeof this\._codec\.pacingCheck === 'function'\) this\._codec\.pacingCheck\(\);\n\s+this\._checkModeSilence\(\);/.test(ctl), 'checked each tick, before the mode-silence note');
  // main: the per-rig memory and the editor's override.
  const main = readSrc(path.join(__dirname, '..', 'main.js'));
  const src = main.slice(main.indexOf('const _civPacedRigs = new Set();'), main.indexOf('function passApplyPowerCap('));
  const ctx = { settings: { activeRigId: 'r1' }, String };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.paceFor = civPaceFor; this.remember = civPaceRemember;', ctx);
  assert.strictEqual(ctx.paceFor({}), 'auto');
  const handlers = {};
  ctx.remember({ on: (ev, fn) => { handlers[ev] = fn; } });
  handlers.pacing({ reason: 'no mode reply' });
  assert.strictEqual(ctx.paceFor({}), 'always', 'remembered for this rig');
  ctx.settings.activeRigId = 'r2';
  assert.strictEqual(ctx.paceFor({}), 'auto', 'another rig is not');
  assert.strictEqual(ctx.paceFor({ civPace: 'never' }), 'never');
  ctx.settings.activeRigId = 'r1';
  assert.strictEqual(ctx.paceFor({ civPace: 'never' }), 'never', 'the editor wins over the memory');
});

test('the Icom and CI-V TCP rig editors carry the setting under Advanced', () => {
  const html = readSrc(path.join(__dirname, '..', 'renderer', 'index.html'));
  const app = readSrc(path.join(__dirname, '..', 'renderer', 'app.js'));
  for (const id of ['set-icom-civ-pace', 'set-civ-tcp-civ-pace']) {
    assert.ok(new RegExp('<summary>Advanced</summary>\\s*<label[^>]*>CI-V pacing:\\s*<select id="' + id + '">').test(html), id);
    assert.ok(app.includes("civPace: civPaceChoice('" + id + "')"), id + ' saved');
    assert.ok(app.includes("setCivPaceChoice('" + id + "'"), id + ' loaded');
  }
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
  }
  console.log(`\nAdaptive CI-V pacing: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
