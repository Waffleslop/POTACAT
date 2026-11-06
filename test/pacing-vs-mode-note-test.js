#!/usr/bin/env node
'use strict';
// Pre-release check (1.14.0): the two diagnostics never stack.
//  - A radio that DROPS replies to back-to-back CI-V commands gets only the
//    10 s pacing line ("sending them one at a time"), never the 20 s "never
//    reported its MODE" note, because pacing makes the mode arrive.
//  - A radio that answers but whose mode never parses (a wrong model) gets
//    only the mode note, never the pacing line.
// Real RigController + CivCodec, a fake IC-7300, a controllable clock.
// Run: node test/pacing-vs-mode-note-test.js
const assert = require('assert');
const { EventEmitter } = require('events');
const { RigController } = require('../lib/rig-controller');
const { CivCodec } = require('../lib/codecs/civ-codec');

let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const realNow = Date.now;

function radio({ dropping, modeByte = 0x01 }) {
  let codec = null; let pending = null;
  const reply = (cmd, sub, data) => Buffer.from([0xFE, 0xFE, 0xE0, 0x94, cmd, ...(sub != null ? [sub] : []), ...data, 0xFD]);
  const answer = (f) => {
    const cmd = f[4]; const sub = f.length > 6 ? f[5] : null;
    if (cmd === 0x03) return reply(0x03, null, [0x00, 0x40, 0x07, 0x14, 0x00]);
    if (cmd === 0x04) return reply(0x04, null, [modeByte, 0x01]);
    if (cmd === 0x14 && sub === 0x0A) return reply(0x14, 0x0A, [0x00, 0x64]);
    if (cmd === 0x1A && sub === 0x06) return reply(0x1A, 0x06, [0x01, 0x01]);
    if (cmd === 0x15) return reply(0x15, sub, [0x01, 0x20]);
    if (cmd === 0x1C) return reply(0x1C, 0x00, [0x00]);
    if (cmd === 0x0F) return reply(0x0F, null, [0x00]);
    return Buffer.from([0xFE, 0xFE, 0xE0, 0x94, 0xFB, 0xFD]);
  };
  const write = (buf) => {
    const f = Buffer.from(buf);
    if (dropping) {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => { pending = null; codec.onData(answer(f)); }, 3);
    } else setTimeout(() => codec.onData(answer(f)), 3);
  };
  return { write, attach(c) { codec = c; } };
}

async function run(opts) {
  let clock = 1000000;
  Date.now = () => clock;
  try {
    const transport = new EventEmitter();
    transport.connect = () => {}; transport.disconnect = () => {};
    const r = radio(opts);
    transport.write = (d) => r.write(d);
    const model = { brand: 'Icom', protocol: 'civ', civAddr: 0x94, caps: { txpower: true }, cw: {}, maxPower: 100, pollIntervalMs: 60000 };
    const codec = new CivCodec(model, (d) => transport.write(d), { pace: 'auto' });
    r.attach(codec);
    const rc = new RigController(model, transport, codec);
    rc._debug = true;
    rc.connected = true; rc._target = { host: 'test' };
    const logs = [];
    rc.on('log', (l) => logs.push(l));
    for (let s = 0; s <= 30; s++) {
      rc._startPolling(); rc._stopPolling();     // one tick, now
      await wait(60);                             // replies land
      clock += 1000;
    }
    if (codec._pacer) codec._pacer.reset();
    return logs;
  } finally { Date.now = realNow; }
}
const pacingLine = (l) => /drops replies to back-to-back CI-V commands/.test(l);
const modeNote = (l) => /never reported its MODE/.test(l);

test('a radio that drops replies: the pacing line only, never the mode note', async () => {
  const logs = await run({ dropping: true });
  assert.strictEqual(logs.filter(pacingLine).length, 1, logs.filter((l) => /CAT|MODE/.test(l)).join('\n'));
  assert.strictEqual(logs.filter(modeNote).length, 0, 'no mode note: pacing brought the mode');
  assert.ok(logs.some((l) => /rig reports mode: USB/.test(l)));
});

test('a wrong-model radio (answers, mode never parses): the mode note only, never the pacing line', async () => {
  const logs = await run({ dropping: false, modeByte: 0x7E });
  assert.strictEqual(logs.filter(pacingLine).length, 0, 'the mode reply arrived, so no pacing');
  assert.strictEqual(logs.filter(modeNote).length, 1);
});

test('a radio that answers normally: neither', async () => {
  const logs = await run({ dropping: false });
  assert.strictEqual(logs.filter(pacingLine).length + logs.filter(modeNote).length, 0);
});

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; console.log('  ok  ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message)); }
  }
  console.log(`\nPacing line vs mode note: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
